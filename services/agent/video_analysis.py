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
import re
import tempfile
import shutil
from pathlib import Path

SETTINGS_VERSION = "video-v1"
MAX_FRAMES_PER_MINUTE = 30
FRAME_INTERVAL_SECONDS = 2
MAX_FRAME_SIDE = 768


def processing_settings() -> str:
    return json.dumps({"version": SETTINGS_VERSION, "sttChunkSeconds": min(600, max(30, int(os.getenv("VIDEO_STT_CHUNK_SECONDS", "300")))),
                       "maxSize": int(os.getenv("VIDEO_MAX_SIZE_BYTES", "1000000000")),
                       "maxDuration": int(os.getenv("VIDEO_MAX_DURATION_SECONDS", "3600"))}, sort_keys=True)


def sample_timestamps(duration: float, scene_times=(), *, cap_per_minute=MAX_FRAMES_PER_MINUTE) -> list[float]:
    """Uniform 2s samples plus scene changes, capped evenly at 30/minute."""
    if duration <= 0:
        return []
    scenes = {round(t, 3) for t in scene_times if isinstance(t, (int, float)) and 0 <= t < duration}
    uniform = {float(t) for t in range(0, int(duration) + 1, FRAME_INTERVAL_SECONDS) if t < duration}
    ordered = sorted(scenes | uniform)
    selected = []
    for start in range(0, math.ceil(duration), 60):
        minute = [stamp for stamp in ordered if start <= stamp < start + 60]
        minute_scenes = [stamp for stamp in sorted(scenes) if start <= stamp < start + 60]
        cap = max(1, math.ceil(min(60, duration - start) / 60 * cap_per_minute))
        if len(minute) <= cap:
            selected.extend(minute)
        else:
            if len(minute_scenes) >= cap:
                selected.extend(minute_scenes[round(i * (len(minute_scenes) - 1) / max(1, cap - 1))] for i in range(cap))
                continue
            selected.extend(minute_scenes)
            fill = cap - len(minute_scenes)
            candidates = [stamp for stamp in minute if stamp not in scenes]
            if fill and candidates:
                selected.extend(candidates[round(i * (len(candidates) - 1) / max(1, fill - 1))] for i in range(fill))
    return sorted(set(selected))


def chunk_ranges(duration: float, seconds=300):
    if duration <= 0:
        return []
    return [(start, min(duration, start + seconds)) for start in range(0, math.ceil(duration), seconds) if start < duration]


def fits_tokens(text: str, frame_count: int, *, budget=100_000) -> bool:
    return len(text) / 4 + frame_count * 2000 < budget


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
    except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        if isinstance(exc, asyncio.CancelledError):
            raise
        raise RuntimeError("video processing timed out") from None
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


async def extract_frames(path: Path, dest: Path, duration: float, *, timeout=180, progress=None):
    """Extract every 2s and scene changes, scaling to 768px; returns timestamped JPEGs."""
    dest.mkdir(parents=True, exist_ok=True)
    # scene timestamps are obtained from ffmpeg metadata; -vsync vfr keeps only selected frames.
    _, scene_log = await _run("ffmpeg", "-hide_banner", "-i", path, "-vf", "select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-", timeout=timeout)
    if progress:
        await progress({"stage": "Preparing video"})
    scenes = [float(x) for x in re.findall(r"pts_time:([0-9.]+)", scene_log)]
    stamps = sample_timestamps(duration, scenes)
    result = []
    for index, stamp in enumerate(stamps):
        target = dest / f"frame-{index:03d}.jpg"
        await _run("ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", stamp, "-i", path, "-frames:v", "1",
                   "-vf", "scale='if(gt(iw,ih),768,-2)':'if(gt(iw,ih),-2,768)'", "-q:v", "4", target, timeout=timeout)
        result.append({"timestamp": stamp, "path": target})
        if progress:
            await progress({"stage": "Reading frames", "current": index + 1, "total": len(stamps)})
    return result


async def inspect_audio(path: Path, has_audio: bool, *, timeout=90) -> tuple[str | None, dict]:
    """Cheap mean-volume and speech-band energy check. Speech ratio is 300-3400Hz / 80-8000Hz."""
    if not has_audio:
        return "no_audio_stream", {"mean_volume_db": None, "speech_ratio": None}
    _, log = await _run("ffmpeg", "-hide_banner", "-i", path, "-vn", "-af", "volumedetect", "-f", "null", "-", timeout=timeout)
    match = re.search(r"mean_volume:\s*(-?[0-9.]+) dB", log)
    mean = float(match.group(1)) if match else None
    # astats has per-band RMS unavailable on all ffmpeg builds; use a band-pass RMS comparison.
    # Conservative heuristic: very little energy between 300 and 3400Hz often indicates instrumental music.
    _, speech = await _run("ffmpeg", "-hide_banner", "-i", path, "-vn", "-af", "bandpass=f=1800:width_type=h:w=3100,volumedetect", "-f", "null", "-", timeout=timeout)
    full_match = match
    band_match = re.search(r"mean_volume:\s*(-?[0-9.]+) dB", speech)
    ratio = None
    if full_match and band_match:
        # dB difference mapped to an energy ratio.
        ratio = 10 ** ((float(band_match.group(1)) - float(full_match.group(1))) / 10)
    reason = audio_skip_reason(has_audio=True, mean_volume_db=mean, speech_ratio=ratio)
    return reason, {"mean_volume_db": mean, "speech_ratio": ratio}


def summary_plan(duration: float, transcript: str, frames: list[dict], *, budget=100_000):
    """Plan <=5min/60-frame inputs and keep every individual request under budget."""
    if duration <= 300 and len(transcript) / 4 + len(frames) * 1500 < budget and len(frames) <= 60:
        return [{"start": 0, "end": duration, "transcript": transcript, "frames": frames}]
    plans = []
    for start, end in chunk_ranges(duration, 300):
        selected = [f for f in frames if start <= float(f["timestamp"]) < end][:60]
        text = transcript_for_range(transcript, start, end)
        plans.append({"start": start, "end": end, "transcript": text, "frames": selected})
    # Budget images conservatively, then reduce images evenly before transcript text.
    # This is per request: several small requests may exceed 100k tokens in total.
    for plan in plans:
        while estimate_total(plan["transcript"], plan["frames"]) >= budget and len(plan["frames"]) > 1:
            plan["frames"] = plan["frames"][::2]
        if estimate_total(plan["transcript"], plan["frames"]) >= budget:
            plan["transcript"] = plan["transcript"][:max(0, int((budget - len(plan["frames"]) * 2000) * 4))]
    return plans


def transcript_for_range(transcript: str, start: float, end: float) -> str:
    # Timestamped transcript lines are produced by the worker; preserve matching lines only.
    lines = []
    for line in transcript.splitlines():
        match = re.match(r"\[(\d+(?:\.\d+)?)\]", line)
        if match and start <= float(match.group(1)) < end:
            lines.append(line)
    return "\n".join(lines) or transcript[:max(0, int((end-start) * 40))]


def estimate_total(transcript: str, frames: list[dict]) -> float:
    # 768px image tokens vary by provider; 2,000 is a conservative planning estimate.
    return len(transcript) / 4 + len(frames) * 2000


def normalize_summary(value) -> dict:
    text = value.get("content", "") if isinstance(value, dict) else str(value)
    if isinstance(text, dict):
        parsed = text
    else:
        try:
            parsed = json.loads(text)
        except (TypeError, json.JSONDecodeError):
            parsed = {"summary": str(text), "timeline": []}
    if not isinstance(parsed, dict):
        parsed = {"summary": str(parsed), "timeline": []}
    timeline = parsed.get("timeline", [])
    return {"summary": str(parsed.get("summary") or parsed.get("overall_summary") or ""),
            "timeline": timeline if isinstance(timeline, list) else []}


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


async def transcribe_chunks(path: Path, duration: float, client, *, model=None, provider=None, max_chunk_seconds=None, progress=None):
    """OpenRouter audio endpoint; caller supplies an authorized client carrying the API key."""
    model = model or os.getenv("VIDEO_STT_MODEL", "openai/whisper-large-v3-turbo")
    provider = provider or os.getenv("VIDEO_STT_PROVIDER", "DeepInfra")
    if max_chunk_seconds is None:
        max_chunk_seconds = min(600, max(30, int(os.getenv("VIDEO_STT_CHUNK_SECONDS", "300"))))
    outputs = []
    with tempfile.TemporaryDirectory(prefix="video-stt-") as raw:
        root = Path(raw)
        index = 0
        for start, end in chunk_ranges(duration, max_chunk_seconds):
            cursor = start
            while cursor < end:
                part_seconds = end - cursor
                chunk = root / f"chunk-{index}.mp3"
                while True:
                    await _run("ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", cursor, "-i", path, "-t", part_seconds,
                               "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", chunk, timeout=120)
                    size = chunk.stat().st_size
                    if size < 25_000_000:
                        break
                    chunk.unlink(missing_ok=True)
                    # Always re-encode the half-sized part and check its actual byte size.
                    # Bitrate and container overhead vary, so one estimate cannot guarantee
                    # the strict provider limit.
                    part_seconds *= 0.5
                    if part_seconds < 1:
                        raise ValueError("audio_chunk_size_limit")
                body = {"model": model, "audio_seconds": part_seconds, "input_audio": {"data": base64.b64encode(chunk.read_bytes()).decode(), "format": "mp3"},
                        "provider": {"order": [provider], "allow_fallbacks": False}}
                if callable(client):
                    data = await client("stt", body)
                else:
                    response = await client.post("/audio/transcriptions", json=body, timeout=55)
                    response.raise_for_status()
                    data = response.json()
                outputs.append({"offset": cursor, "text": data.get("text", ""), "segments": data.get("segments"), "provider": data.get("provider")})
                cursor = min(end, cursor + part_seconds)
                index += 1
                if progress:
                    await progress({"stage": "Listening", "current": index, "total": "audio parts"})
    return outputs


async def analyze_video(path: Path, model_call, *, cached=None, max_size=None, max_duration=None,
                        stt_model=None, stt_provider=None, progress=None):
    """Run bounded preprocessing and summarize through caller's authenticated model bridge."""
    max_size = max_size or int(os.getenv("VIDEO_MAX_SIZE_BYTES", "1000000000"))
    max_duration = max_duration or int(os.getenv("VIDEO_MAX_DURATION_SECONDS", "3600"))
    duration, has_audio, meta = await inspect_video(path, max_size=max_size, max_duration=max_duration)
    digest = file_hash(path)
    if cached:
        return {**cached, "cacheHit": True}
    with tempfile.TemporaryDirectory(prefix="video-analysis-") as raw:
        root = Path(raw)
        if progress:
            await progress({"stage": "Preparing video"})
        frames = await extract_frames(path, root / "frames", duration, progress=progress)
        audio_reason, audio_stats = await inspect_audio(path, has_audio)
        chunks = []
        if has_audio and audio_reason is None:
            chunks = await transcribe_chunks(path, duration, model_call, model=stt_model, provider=stt_provider, progress=progress)
        transcript = "\n".join(f"[{c['offset'] + float(seg.get('start', 0)):.1f}] {seg.get('text', '')}" for c in chunks for seg in (c.get("segments") or [{"text": c.get("text", "")}]))
        if progress and chunks:
            await progress({"stage": "Listening"})
        frame_payload = []
        for frame in frames:
            frame_payload.append({"timestamp": frame["timestamp"], "data": base64.b64encode(frame["path"].read_bytes()).decode("ascii")})
        plan = summary_plan(duration, transcript, frame_payload)
        selected_frames = {f["timestamp"]: f for section in plan for f in section["frames"]}
        summaries = []
        for chunk_index, section in enumerate(plan, 1):
            if progress:
                await progress({"stage": "Watching part", "current": chunk_index, "total": len(plan)})
            content = [{"type": "text", "text": f"Summarize video segment {section['start']:.1f}-{section['end']:.1f}s. Return JSON with summary and timeline entries using absolute video timestamps in seconds and summary (what is shown/said). Transcript:\n{section['transcript']}"}]
            for frame in section["frames"]:
                content += [{"type": "text", "text": f"Frame at {frame['timestamp']} seconds"}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + frame["data"]}}]
            summaries.append(normalize_summary(await model_call("summary", content)))
        # One vision request per chunk. Combining already-bounded text locally avoids
        # an extra model call that would otherwise make long videos unexpectedly costly.
        summary = {
            "summary": "\n\n".join(part["summary"] for part in summaries if part["summary"]),
            "timeline": sorted((entry for part in summaries for entry in part["timeline"]
                                if isinstance(entry, dict)),
                               key=lambda entry: float(entry.get("timestamp", 0) or 0)),
        }
        result = {"videoId": digest, "duration": duration, "summary": summary["summary"], "transcript": transcript,
                  "timeline": summary["timeline"], "frames": list(selected_frames.values()),
                  "audioSkipReason": audio_reason, "audioStats": audio_stats, "sttProvider": [c.get("provider") for c in chunks if c.get("provider")],
                  "sttSeconds": duration if chunks else 0, "frameCount": len(frames), "cacheHit": False}
        return result


async def answer_video_question(analysis: dict, question: str, model_call, around_ts: float | None = None):
    timeline = analysis.get("timeline", [])
    transcript_lines = analysis.get("transcript", "").splitlines()
    frames = analysis.get("frames", [])
    targets = [around_ts] if around_ts is not None else []
    if not targets:
        keywords = {w.lower() for w in re.findall(r"[a-zA-Z0-9]{4,}", question)}
        matches = []
        for line in transcript_lines:
            stamp = re.match(r"\[(\d+(?:\.\d+)?)\]", line)
            words = {w.lower() for w in re.findall(r"[a-zA-Z0-9]{4,}", line)}
            score = len(keywords & words)
            if stamp and score:
                matches.append((score, float(stamp.group(1))))
        targets = [t for _, t in sorted(matches, reverse=True)[:3]]
        if not targets and frames:
            targets = [float(frames[i]["timestamp"]) for i in range(0, len(frames), max(1, len(frames) // 8))][:8]
    relevant = []
    for target in targets:
        candidates = [f for f in frames if abs(float(f.get("timestamp", 0)) - target) <= 15]
        if not candidates and frames:
            candidates = [min(frames, key=lambda f: abs(float(f.get("timestamp", 0)) - target))]
        relevant.extend(candidates[:4])
    seen = set()
    relevant = [f for f in relevant if not (f.get("timestamp") in seen or seen.add(f.get("timestamp")))]
    if targets:
        transcript = "\n".join(line for line in transcript_lines
                                 if (lambda m: m and any(abs(float(m.group(1)) - target) <= 30 for target in targets))(re.match(r"\[(\d+(?:\.\d+)?)\]", line)))
    else:
        transcript = "\n".join(transcript_lines)
    transcript = transcript[:64_000]
    payload = [{"type": "text", "text": f"Answer using only this video analysis. Question: {question}\nTranscript: {transcript}\nTimeline: {json.dumps(timeline)}"}]
    for frame in relevant:
        if frame.get("data"):
            payload.extend([{"type": "text", "text": f"Frame at {frame['timestamp']} seconds"},
                            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + frame["data"]}}])
    return await model_call("summary", payload)
