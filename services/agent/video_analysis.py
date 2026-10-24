"""Bounded video preprocessing helpers used by the agent worker.

No URL fetching is performed here. Callers must supply an already-authorized local file.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import os
import tempfile
from pathlib import Path

SETTINGS_VERSION = "video-v1"
MAX_FRAMES_PER_MINUTE = 30
FRAME_INTERVAL_SECONDS = 2
MAX_FRAME_SIDE = 768


def sample_timestamps(duration: float, scene_times=(), *, cap_per_minute=MAX_FRAMES_PER_MINUTE) -> list[float]:
    """Uniform 2s samples plus scene changes, capped evenly at 30/minute."""
    if duration <= 0:
        return []
    points = {round(t, 3) for t in [*range(0, int(duration) + 1, FRAME_INTERVAL_SECONDS), *scene_times]
              if isinstance(t, (int, float)) and 0 <= t < duration}
    cap = max(1, math.ceil(duration / 60 * cap_per_minute))
    ordered = sorted(points)
    if len(ordered) <= cap:
        return ordered
    if cap == 1:
        return [ordered[0]]
    return [ordered[round(i * (len(ordered) - 1) / (cap - 1))] for i in range(cap)]


def chunk_ranges(duration: float, seconds=300):
    return [(start, min(duration, start + seconds)) for start in range(0, int(duration + seconds - 1), seconds)]


def fits_tokens(text: str, frame_count: int, *, budget=100_000) -> bool:
    # Conservative rough estimate: 4 chars/token plus 1,500 tokens per frame.
    return len(text) / 4 + frame_count * 1500 < budget


def audio_skip_reason(*, has_audio: bool, mean_volume_db: float | None, speech_ratio: float | None,
                      silence_threshold=-50.0, music_ratio_threshold=0.08) -> str | None:
    if not has_audio:
        return "no_audio_stream"
    if mean_volume_db is None or mean_volume_db <= silence_threshold:
        return "near_silence"
    if speech_ratio is not None and speech_ratio < music_ratio_threshold:
        return "music_only_heuristic"
    return None


async def _run(*args, timeout=180):
    proc = await asyncio.create_subprocess_exec(*map(str, args), stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill(); await proc.wait()
        raise RuntimeError("video processing timed out")
    if proc.returncode:
        raise RuntimeError("video processing failed")
    return out, err.decode(errors="replace")


async def inspect_video(path: Path, *, max_size=1_000_000_000, max_duration=3600):
    if path.stat().st_size > max_size:
        raise ValueError("video_size_limit")
    out, _ = await _run("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path, timeout=20)
    meta = json.loads(out)
    duration = float(meta.get("format", {}).get("duration", 0))
    if duration <= 0 or duration > max_duration:
        raise ValueError("video_duration_limit")
    return duration, any(s.get("codec_type") == "audio" for s in meta.get("streams", [])), meta


async def extract_frames(path: Path, dest: Path, duration: float, *, timeout=180):
    """Extract every 2s and scene changes, scaling to 768px; returns timestamped JPEGs."""
    dest.mkdir(parents=True, exist_ok=True)
    # scene timestamps are obtained from ffmpeg metadata; -vsync vfr keeps only selected frames.
    _, scene_log = await _run("ffmpeg", "-hide_banner", "-i", path, "-vf", "select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-", timeout=timeout)
    import re
    scenes = [float(x) for x in re.findall(r"pts_time:([0-9.]+)", scene_log)]
    stamps = sample_timestamps(duration, scenes)
    result = []
    for index, stamp in enumerate(stamps):
        target = dest / f"frame-{index:03d}.jpg"
        await _run("ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", stamp, "-i", path, "-frames:v", "1",
                   "-vf", "scale='if(gt(iw,ih),768,-2)':'if(gt(iw,ih),-2,768)'", "-q:v", "4", target, timeout=timeout)
        result.append({"timestamp": stamp, "path": target})
    return result


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


async def transcribe_chunks(path: Path, duration: float, client, *, model=None, provider=None, max_chunk_seconds=600):
    """OpenRouter audio endpoint; caller supplies an authorized client carrying the API key."""
    model = model or os.getenv("VIDEO_STT_MODEL", "openai/whisper-large-v3-turbo")
    provider = provider or os.getenv("VIDEO_STT_PROVIDER", "deepinfra")
    outputs = []
    with tempfile.TemporaryDirectory(prefix="video-stt-") as raw:
        root = Path(raw)
        for index, (start, end) in enumerate(chunk_ranges(duration, max_chunk_seconds)):
            chunk = root / f"chunk-{index}.mp3"
            await _run("ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", start, "-i", path, "-t", end-start,
                       "-vn", "-ac", "1", "-b:a", "48k", chunk, timeout=120)
            if chunk.stat().st_size > 24_000_000:
                raise ValueError("audio_chunk_size_limit")
            body = {"model": model, "input_audio": {"data": base64.b64encode(chunk.read_bytes()).decode(), "format": "mp3"},
                    "provider": {"order": [provider], "allow_fallbacks": False}}
            response = await client.post("/audio/transcriptions", json=body, timeout=55)
            response.raise_for_status()
            data = response.json()
            outputs.append({"offset": start, "text": data.get("text", ""), "provider": data.get("provider")})
    return outputs
