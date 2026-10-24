import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "agent"))
from video_analysis import (audio_skip_reason, chunk_ranges, fits_tokens, sample_timestamps,
                            inspect_audio, inspect_video, extract_frames, analyze_video, summary_plan,
                            estimate_total)
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


def test_scene_dense_minute_cannot_borrow_later_minutes_frame_budget():
    frames = sample_timestamps(125, [stamp / 10 for stamp in range(600)])
    assert len([stamp for stamp in frames if stamp < 60]) <= 30
    assert len([stamp for stamp in frames if 60 <= stamp < 120]) <= 30
    assert len([stamp for stamp in frames if stamp >= 120]) <= 3


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


def test_token_budget_is_per_chunk_and_frames_are_trimmed_evenly():
    frames = [{"timestamp": t, "data": "x"} for t in range(0, 300, 2)]
    plan = summary_plan(300, "transcript " * 100_000, frames, budget=20_000)
    assert len(plan) == 1
    assert estimate_total(plan[0]["transcript"], plan[0]["frames"]) < 20_000
    assert plan[0]["frames"] == sorted(plan[0]["frames"], key=lambda frame: frame["timestamp"])


def test_analyzer_makes_one_vision_request_per_chunk(monkeypatch, tmp_path):
    import video_analysis as video

    async def inspect(*args, **kwargs):
        return 601, False, {}

    async def frames(path, dest, duration, **kwargs):
        dest.mkdir(parents=True)
        result = []
        for index, timestamp in enumerate((0, 299, 300, 599, 600)):
            frame = dest / f"{index}.jpg"
            frame.write_bytes(b"frame")
            result.append({"timestamp": timestamp, "path": frame})
        return result

    async def audio(*args, **kwargs):
        return "no_audio_stream", {"mean_volume_db": None, "speech_ratio": None}

    monkeypatch.setattr(video, "inspect_video", inspect)
    monkeypatch.setattr(video, "extract_frames", frames)
    monkeypatch.setattr(video, "inspect_audio", audio)
    monkeypatch.setattr(video, "file_hash", lambda _path: "a" * 64)
    calls = []

    async def model_call(kind, content):
        calls.append((kind, content))
        return {"content": '{"summary":"part","timeline":[]}'}

    result = asyncio.run(analyze_video(tmp_path / "unused.mp4", model_call))
    assert len(calls) == 3
    assert all(kind == "summary" for kind, _ in calls)
    assert result["summary"] == "part\n\npart\n\npart"
    assert result["audioSkipReason"] == "no_audio_stream"


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="ffmpeg/ffprobe not installed")
def test_ffmpeg_extracts_scaled_frames_and_audio_skip_branches(tmp_path):
    video = tmp_path / "fixture.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=4:duration=5", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-shortest", "-y", str(video)], check=True)
    duration, has_audio, _ = asyncio.run(inspect_video(video))
    assert duration == pytest.approx(5, abs=.2) and has_audio
    reason, stats = asyncio.run(inspect_audio(video, True))
    assert reason in {None, "music_only_heuristic"} and stats["mean_volume_db"] is not None
    progress_events = []
    async def progress(_event=None):
        progress_events.append(True)
    frames = asyncio.run(extract_frames(video, tmp_path / "frames", duration, progress=progress))
    assert frames and len(frames) <= 3
    assert len(progress_events) > len(frames)  # scene scan and each completed frame renew the watchdog
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", str(frames[0]["path"])], capture_output=True, text=True, check=True)
    width, height = map(int, probe.stdout.strip().split("x"))
    assert max(width, height) <= 768
    quiet = tmp_path / "quiet.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=1:duration=2",
                    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=2", "-shortest", "-y", str(quiet)], check=True)
    reason, _ = asyncio.run(inspect_audio(quiet, True))
    assert reason == "near_silence"


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="ffmpeg/ffprobe not installed")
def test_scene_cut_frames_and_long_fixture_chunk_ranges(tmp_path):
    from video_analysis import chunk_ranges
    scene = tmp_path / "scene.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=2:d=1",
        "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=2:d=1", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0",
        "-y", str(scene),
    ], check=True)
    duration, _, _ = asyncio.run(inspect_video(scene))
    frames = asyncio.run(extract_frames(scene, tmp_path / "scene-frames", duration))
    assert any(0.8 <= frame["timestamp"] <= 1.2 for frame in frames)

    long_video = tmp_path / "long.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=1:duration=301",
        "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", str(long_video),
    ], check=True)
    long_duration, _, _ = asyncio.run(inspect_video(long_video))
    assert long_duration >= 300
    assert chunk_ranges(long_duration) == [(0, 300), (300, long_duration)]


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


def test_transcription_resplits_until_parts_are_strictly_under_25mb(monkeypatch, tmp_path):
    from video_analysis import transcribe_chunks
    from types import SimpleNamespace
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"fixture")
    durations = []
    async def fake_run(*args, **kwargs):
        durations.append(float(args[args.index("-t") + 1]))
        Path(args[-1]).write_bytes(b"small encoded part")
        return b"", ""
    monkeypatch.setattr("video_analysis._run", fake_run)
    real_stat = Path.stat
    sizes = iter((26_000_000, 25_000_000, 24_999_999, 100))
    def fake_stat(path, *args, **kwargs):
        actual = real_stat(path, *args, **kwargs)
        if path.suffix == ".mp3":
            return SimpleNamespace(st_size=next(sizes))
        return actual
    monkeypatch.setattr(Path, "stat", fake_stat)
    async def client(_kind, _body):
        return {"text": "part"}
    result = asyncio.run(transcribe_chunks(audio, 30, client, max_chunk_seconds=30))
    assert durations[:3] == [30, 15, 7.5]
    assert len(durations) == 4
    assert result[0]["offset"] == 0
    assert result[1]["offset"] == pytest.approx(durations[2])


def test_video_cache_schema_keeps_owner_and_bot_in_key():
    sql = (Path(__file__).resolve().parents[2] / "db" / "042_video_analyses.sql").read_text()
    assert "PRIMARY KEY (owner_id, bot_id, source_ref, content_sha256, settings_version)" in sql


def test_long_sparse_video_still_uses_five_minute_summary_ranges():
    plan = summary_plan(900, "short transcript", [{"timestamp": 0, "data": "mock"}])
    assert len(plan) == 3
    assert all(section["end"] - section["start"] <= 300 for section in plan)


def test_preprocessing_settings_change_cache_identity(monkeypatch):
    from video_analysis import processing_settings
    monkeypatch.setenv("VIDEO_STT_CHUNK_SECONDS", "300")
    original = processing_settings()
    monkeypatch.setenv("VIDEO_STT_CHUNK_SECONDS", "600")
    assert processing_settings() != original


def test_cancelled_video_subprocess_is_reaped(monkeypatch):
    from video_analysis import _run
    async def run():
        started = asyncio.Event()
        processes = []
        real_create = asyncio.create_subprocess_exec
        async def create(*args, **kwargs):
            process = await real_create(*args, **kwargs)
            processes.append(process)
            started.set()
            return process
        monkeypatch.setattr(asyncio, "create_subprocess_exec", create)
        task = asyncio.create_task(_run(sys.executable, "-c", "import time; time.sleep(30)"))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert processes[0].returncode is not None
    asyncio.run(run())
