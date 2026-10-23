"""Bounded, private-window desktop recordings used by Teach."""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Protocol

MAX_DURATION = 600
MAX_DURATION_MS = MAX_DURATION * 1000


class RecorderConflict(RuntimeError):
    """A Teach session is already active."""


class Process(Protocol):
    pid: int
    def poll(self): ...
    def terminate(self): ...
    def wait(self, timeout=None): ...


class ProcessRunner:
    def start(self, argv: list[str]) -> Process:
        return subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)


def build_teach_command(display: int, output: str | os.PathLike[str]) -> list[str]:
    if not isinstance(display, int) or not 1 <= display <= 8:
        raise ValueError("private display must be between 1 and 8")
    return ["ffmpeg", "-y", "-v", "error", "-f", "x11grab", "-video_size", "1920x1200",
            "-i", f":{display}", "-framerate", "15", "-t", "600", "-c:v", "libx264",
            "-preset", "ultrafast", "-g", "75", "-pix_fmt", "yuv420p", "-an", str(output)]


def build_action_recording_command(display: int, output: str | os.PathLike[str], framerate: int = 60) -> list[str]:
    if not isinstance(display, int) or not 1 <= display <= 8 or not 1 <= framerate <= 60:
        raise ValueError("invalid display or frame rate")
    return ["ffmpeg", "-y", "-v", "error", "-f", "x11grab", "-video_size", "1920x1200",
            "-draw_mouse", "0", "-framerate", str(framerate), "-i", f":{display}", "-vf",
            "scale=1920:-2:lanczos,fps=60", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
            "-pix_fmt", "yuv420p", "-profile:v", "high", "-x264-params",
            "keyint=1:min-keyint=1:scenecut=0:bframes=0", "-movflags", "+faststart", "-tune",
            "fastdecode", str(output)]


class Recorder:
    def __init__(self, root: str | os.PathLike[str], *, runner=None, clock: Callable[[], float] | None = None):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.runner = runner or ProcessRunner()
        self.clock = clock or time.monotonic
        self._lock = threading.RLock()
        self._active: dict | None = None

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def _write(self, session: dict) -> None:
        target = session["directory"] / "session.json"
        temp = target.with_suffix(".json.tmp")
        temp.write_text(json.dumps(session["metadata"], separators=(",", ":")), encoding="utf-8")
        os.replace(temp, target)

    def start(self, display: int, *, private_window: bool) -> dict:
        if not private_window:
            raise PermissionError("Teach recording requires a private desktop monitor")
        with self._lock:
            self.reap()
            if self._active is not None:
                raise RecorderConflict("Teach recording is already active")
            session_id = "teach-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex
            directory = (self.root / session_id).resolve()
            if directory.parent != self.root:
                raise ValueError("invalid recording session path")
            directory.mkdir(mode=0o700)
            video = directory / "demo.mp4"
            metadata = {"startedAt": self._utc_now(), "display": f":{display}", "maxDurationMs": MAX_DURATION_MS,
                        "videoPath": str(video), "ffmpegPid": None, "endedAt": None, "endReason": None,
                        "status": "starting"}
            session = {"id": session_id, "directory": directory, "video": video, "metadata": metadata,
                       "process": None, "started": self.clock()}
            self._active = session
            try:
                process = self.runner.start(build_teach_command(display, video))
                session["process"] = process
                metadata["ffmpegPid"] = int(process.pid)
                metadata["status"] = "recording"
                session["watch_stop"] = threading.Event()
                self._write(session)
                threading.Thread(target=self._watch, args=(session,), name="teach-recorder-watch", daemon=True).start()
            except Exception:
                self._active = None
                self._clean_video(session)
                raise
            return {"id": session_id, "directory": str(directory), "videoPath": str(video), "ffmpegPid": metadata["ffmpegPid"]}

    def stop(self, session_id: str | None = None, *, reason: str = "user_stop") -> dict:
        with self._lock:
            session = self._active
            if session is None or (session_id is not None and session["id"] != session_id):
                raise KeyError("recording session not found")
            process = session["process"]
            session.get("watch_stop", threading.Event()).set()
            if process.poll() is not None and self.clock() - session["started"] < MAX_DURATION and reason != "max_duration":
                session["metadata"].update(status="failed", endedAt=self._utc_now(), endReason="process_exited")
                self._clean_video(session)
                self._write(session)
                self._active = None
                raise RuntimeError("recording process exited unexpectedly")
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except Exception:
                    kill = getattr(process, "kill", None)
                    if kill:
                        kill()
                    process.wait(timeout=5)
            session["metadata"].update(status="finished", endedAt=self._utc_now(), endReason=reason)
            self._write(session)
            self._active = None
            return {"id": session["id"], "videoPath": str(session["video"]), "metadata": dict(session["metadata"])}

    def reap(self) -> list[str]:
        with self._lock:
            session = self._active
            if session is None:
                return []
            process = session["process"]
            if self.clock() - session["started"] >= MAX_DURATION:
                self.stop(session["id"], reason="max_duration")
                return [session["id"]]
            if process.poll() is not None:
                session.get("watch_stop", threading.Event()).set()
                session["metadata"].update(status="failed", endedAt=self._utc_now(), endReason="process_exited")
                self._clean_video(session)
                self._write(session)
                self._active = None
                return [session["id"]]
            return []

    def reap_expired(self) -> list[str]:
        return self.reap()

    def _watch(self, session: dict) -> None:
        stopped = session["watch_stop"]
        while not stopped.wait(0.5):
            if self._active is not session:
                return
            self.reap()

    @staticmethod
    def _clean_video(session: dict) -> None:
        try:
            session["video"].unlink(missing_ok=True)
        except OSError:
            pass
