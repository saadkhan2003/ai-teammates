import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "computer" / "src"))
from recorder import Recorder, RecorderConflict, build_action_recording_command, build_teach_command


class FakeProcess:
    pid = 321
    def __init__(self):
        self.dead = False
        self.terminated = False
    def poll(self):
        return -9 if self.dead else None
    def terminate(self):
        self.terminated = True
        self.dead = True
    def wait(self, timeout=None):
        return -9 if self.dead else 0


class FakeRunner:
    def __init__(self):
        self.commands = []
        self.process = FakeProcess()
    def start(self, argv):
        self.commands.append(argv)
        return self.process


def test_teach_command_matches_architecture_x11grab_arguments(tmp_path):
    command = build_teach_command(3, tmp_path / "demo.mp4")
    assert command == ["ffmpeg", "-y", "-v", "error", "-f", "x11grab", "-video_size", "1920x1200", "-i", ":3", "-framerate", "15", "-t", "600", "-c:v", "libx264", "-preset", "ultrafast", "-g", "75", "-pix_fmt", "yuv420p", "-an", str(tmp_path / "demo.mp4")]


def test_action_recording_is_all_intra_crf17_proxy(tmp_path):
    command = build_action_recording_command(3, tmp_path / "proxy.mp4")
    assert command[command.index("-crf") + 1] == "17"
    assert "keyint=1:min-keyint=1:scenecut=0:bframes=0" in command
    assert "-an" not in command


def test_teach_requires_private_window_and_rejects_second_session(tmp_path):
    runner = FakeRunner()
    clock = [100.0]
    recorder = Recorder(tmp_path, runner=runner, clock=lambda: clock[0])
    with pytest.raises(PermissionError):
        recorder.start(3, private_window=False)
    session = recorder.start(3, private_window=True)
    assert json.loads((Path(session["directory"]) / "session.json").read_text())["ffmpegPid"] == 321
    with pytest.raises(RecorderConflict):
        recorder.start(4, private_window=True)


def test_teach_auto_stops_at_cap_and_writes_metadata(tmp_path):
    runner = FakeRunner()
    clock = [100.0]
    recorder = Recorder(tmp_path, runner=runner, clock=lambda: clock[0])
    session = recorder.start(3, private_window=True)
    clock[0] = 700.1
    assert recorder.reap_expired() == [session["id"]]
    metadata = json.loads((Path(session["directory"]) / "session.json").read_text())
    assert metadata["endReason"] == "max_duration"
    assert metadata["maxDurationMs"] == 600000
    assert runner.process.terminated


def test_killed_ffmpeg_marks_failed_and_cleans_partial_video(tmp_path):
    runner = FakeRunner()
    recorder = Recorder(tmp_path, runner=runner, clock=lambda: 100.0)
    session = recorder.start(3, private_window=True)
    video = Path(session["videoPath"])
    video.write_bytes(b"partial")
    runner.process.dead = True
    recorder.reap()
    metadata = json.loads((Path(session["directory"]) / "session.json").read_text())
    assert metadata["status"] == "failed"
    assert metadata["endReason"] == "process_exited"
    assert not video.exists()


def test_stop_detects_a_process_killed_before_stop_request(tmp_path):
    runner = FakeRunner()
    recorder = Recorder(tmp_path, runner=runner, clock=lambda: 100.0)
    session = recorder.start(3, private_window=True)
    video = Path(session["videoPath"])
    video.write_bytes(b"partial")
    runner.process.dead = True
    with pytest.raises(RuntimeError):
        recorder.stop(session["id"])
    metadata = json.loads((Path(session["directory"]) / "session.json").read_text())
    assert metadata["status"] == "failed"
    assert not video.exists()


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="ffmpeg and ffprobe are required")
def test_real_ffmpeg_lavfi_output_is_playable_video_without_audio(tmp_path):
    video = tmp_path / "demo.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=5",
                    "-t", "0.4", "-c:v", "libx264", "-preset", "ultrafast", "-g", "75",
                    "-pix_fmt", "yuv420p", "-an", str(video)], check=True, timeout=20)
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-show_entries",
                            "format=duration", "-of", "json", str(video)], check=True, capture_output=True,
                           text=True, timeout=10)
    metadata = json.loads(probe.stdout)
    assert [stream["codec_type"] for stream in metadata["streams"]] == ["video"]
    assert float(metadata["format"]["duration"]) <= 600
