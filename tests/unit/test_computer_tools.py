"""Pure native computer-use validation and recording command tests."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/computer/src"))

from computer_tools import ffmpeg_argv, safe_recording_name, scale_point, validate_keys


def test_model_coordinates_scale_using_display_dimensions(monkeypatch):
    monkeypatch.setenv("DISPLAY_GEOMETRY", "1920x1200")
    assert scale_point(640, 400) == (960, 600)
    assert scale_point(640, 400, 1920, 1200) == (960, 600)
    assert scale_point(1279, 799, 1280, 800) == (1279, 799)
    for point in [(-1, 0), (1280, 0), (0, 800)]:
        try:
            scale_point(*point, 1920, 1200)
        except ValueError:
            continue
        raise AssertionError("out-of-range coordinates accepted")


def test_key_names_allow_short_combinations_and_reject_command_input():
    assert validate_keys(["Return", "ctrl+l", "alt+Left", "Tab"]) == ["Return", "ctrl+l", "alt+Left", "Tab"]
    for keys in [[], ["ctrl+semicolon"], ["$(touch x)"], ["Return"] * 9]:
        try:
            validate_keys(keys)
        except ValueError:
            continue
        raise AssertionError("invalid key list accepted")


def test_recording_names_and_ffmpeg_argv_are_bounded_and_shell_free():
    assert safe_recording_name("../My demo record") == "My-demo-record"
    assert safe_recording_name("...///") == "screen-recording"
    argv = ffmpeg_argv(3, 1920, 1200, "/workspace/recordings/demo.webm", 600)
    assert argv[:10] == ["ffmpeg", "-y", "-f", "x11grab", "-framerate", "5", "-video_size", "1920x1200", "-i", ":3.0"]
    assert "-an" in argv and "-t" in argv and "libvpx-vp9" in argv and argv[-1].endswith("demo.webm")
    h264 = ffmpeg_argv(1, 1280, 800, "capture.mp4", 20, "libx264")
    assert "ultrafast" in h264 and "-an" in h264
