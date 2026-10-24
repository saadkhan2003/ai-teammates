"""Mock-only cache accounting, without HTTP or model calls."""
import importlib.util
import sys
from pathlib import Path


def _server():
    directory = Path(__file__).resolve().parents[2] / "services" / "mock-openrouter"
    sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location("speed_mock_server", directory / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_repeated_prefix_reports_deterministic_cache_share():
    mock = _server()
    prefix = [{"role": "system", "content": "test"}, {"role": "user", "content": "hello"}]
    assert mock.cached_usage(prefix, 12) == 0
    assert mock.cached_usage(prefix + [{"role": "assistant", "content": "reply"}], 12) == 9
    assert all(len(key) == 64 for key in mock._prefixes)


def test_mock_prefix_cache_is_bounded_and_does_not_keep_message_text():
    mock = _server()
    for i in range(1100):
        mock.cached_usage([{"role": "user", "content": f"private content {i}"}], 12)
    assert len(mock._prefixes) == 1024
    assert all(value is None for value in mock._prefixes.values())
