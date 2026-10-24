import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "agent"))
from video_analysis import (audio_skip_reason, chunk_ranges, fits_tokens, sample_timestamps,
                            inspect_audio, inspect_video, extract_frames, analyze_video, summary_plan)
import asyncio
import shutil
import subprocess


def test_uniform_and_scene_sampling_is_deduped_and_capped():
    frames = sample_timestamps(120, [2, 3.25, 119.9])
    assert frames.count(2) == 1
    assert 3.25 in frames
    assert len(frames) <= 60
    assert frames == sorted(set(frames))


def test_sampling_short_video_gets_30_frames_per_minute_ceiling():
    assert len(sample_timestamps(20, range(20))) <= 10


@pytest.mark.parametrize(("args", "expected"), [
    ({"has_audio": False, "mean_volume_db": None, "speech_ratio": None}, "no_audio_stream"),
    ({"has_audio": True, "mean_volume_db": -55, "speech_ratio": .2}, "near_silence"),
    ({"has_audio": True, "mean_volume_db": -20, "speech_ratio": .01}, "music_only_heuristic"),
    ({"has_audio": True, "mean_volume_db": -20, "speech_ratio": .2}, None),
])
def test_audio_branching(args, expected):
    assert audio_skip_reason(**args) == expected


def test_audio_chunks_under_duration_limit():
    assert chunk_ranges(601) == [(0, 300), (300, 600), (600, 601)]


def test_conservative_token_estimate():
    assert fits_tokens("hello" * 100, 20)
    assert not fits_tokens("x" * 400_000, 60)


def test_planner_respects_five_minutes_sixty_frames_and_token_budget():
    frames = [{"timestamp": t, "data": "x"} for t in range(0, 1200, 2)]
    plan = summary_plan(600, "hello " * 400_000, frames)
    assert len(plan) == 2
    assert all(p["end"] - p["start"] <= 300 and len(p["frames"]) <= 60 for p in plan)
    assert all(fits_tokens(p["transcript"], len(p["frames"])) for p in plan)


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="ffmpeg/ffprobe not installed")
def test_ffmpeg_extracts_scaled_frames_and_audio_skip_branches(tmp_path):
    video = tmp_path / "fixture.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=4:duration=5", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-shortest", "-y", str(video)], check=True)
    duration, has_audio, _ = asyncio.run(inspect_video(video))
    assert duration == pytest.approx(5, abs=.2) and has_audio
    reason, stats = asyncio.run(inspect_audio(video, True))
    assert reason in {None, "music_only_heuristic"} and stats["mean_volume_db"] is not None
    frames = asyncio.run(extract_frames(video, tmp_path / "frames", duration))
    assert frames and len(frames) <= 3
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", str(frames[0]["path"])], capture_output=True, text=True, check=True)
    width, height = map(int, probe.stdout.strip().split("x"))
    assert max(width, height) <= 768
    quiet = tmp_path / "quiet.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=1:duration=2",
                    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=2", "-shortest", "-y", str(quiet)], check=True)
    reason, _ = asyncio.run(inspect_audio(quiet, True))
    assert reason == "near_silence"


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="ffmpeg/ffprobe not installed")
def test_music_band_heuristic_and_speech_band_fixture(tmp_path):
    outcomes = []
    for name, freq in (("music", 80), ("speech", 1000)):
        path = tmp_path / f"{name}.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=1:duration=2",
                        "-f", "lavfi", "-i", f"sine=frequency={freq}:duration=2", "-shortest", "-y", str(path)], check=True)
        outcomes.append(asyncio.run(inspect_audio(path, True))[0])
    assert outcomes == ["music_only_heuristic", None]


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="ffmpeg/ffprobe not installed")
def test_cache_hit_skips_all_model_calls(tmp_path):
    video = tmp_path / "fixture.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=1:duration=1", "-an", "-y", str(video)], check=True)
    async def forbidden(*_args):
        raise AssertionError("cache hit must make zero model calls")
    cached = {"summary": "already done", "transcript": "", "timeline": [], "frames": []}
    result = asyncio.run(analyze_video(video, forbidden, cached=cached))
    assert result["summary"] == "already done" and result["cacheHit"] is True


def test_transcription_request_has_pinned_model_and_provider(monkeypatch, tmp_path):
    # Request construction is tested without network or real transcription.
    from video_analysis import transcribe_chunks
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"test")
    calls = []
    class FakePath:
        pass
    async def fake_run(*args, **kwargs):
        # create the encoded chunk in the temporary destination named by ffmpeg argv
        Path(args[-1]).write_bytes(b"mock mp3")
        return b"", ""
    monkeypatch.setattr("video_analysis._run", fake_run)
    class Client:
        async def post(self, path, json, timeout):
            calls.append((path, json, timeout))
            class Response:
                def raise_for_status(self): pass
                def json(self): return {"text": "mock", "provider": "deepinfra"}
            return Response()
    monkeypatch.setenv("VIDEO_STT_MODEL", "test/whisper")
    monkeypatch.setenv("VIDEO_STT_PROVIDER", "mock-provider")
    result = asyncio.run(transcribe_chunks(audio, 1, Client()))
    assert calls[0][0] == "/audio/transcriptions"
    assert calls[0][1]["model"] == "test/whisper"
    assert calls[0][1]["provider"] == {"order": ["mock-provider"], "allow_fallbacks": False}
    assert len(calls[0][1]["input_audio"]["data"]) < 25_000_000
    assert result[0]["provider"] == "deepinfra"


def test_video_cache_schema_keeps_owner_and_bot_in_key():
    sql = (Path(__file__).resolve().parents[2] / "db" / "095_video_analyses.sql").read_text()
    assert "PRIMARY KEY (owner_id, bot_id, source_ref, content_sha256, settings_version)" in sql
