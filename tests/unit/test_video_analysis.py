import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "agent"))
from video_analysis import audio_skip_reason, chunk_ranges, fits_tokens, sample_timestamps


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
