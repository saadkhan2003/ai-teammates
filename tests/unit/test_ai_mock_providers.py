"""Provider protocol smoke tests using a loopback stub only."""
import importlib.util
import json
import pathlib
import sys
import threading
import urllib.error
import urllib.request

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/mock-openrouter"))
spec = importlib.util.spec_from_file_location("ai_mock_server", ROOT / "services/mock-openrouter/server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


@pytest.fixture
def mock_server():
    http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    worker = threading.Thread(target=http.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{http.server_port}"
    finally:
        http.shutdown()
        http.server_close()
        worker.join(2)


def call(base, path, body=None, anthropic=False, authenticated=True):
    headers = {"Content-Type": "application/json"}
    if authenticated:
        headers["x-api-key" if anthropic else "Authorization"] = ("" if anthropic else "Bearer ") + "sk-or-mock-test-only-123456789"
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body else None, headers=headers)
    with urllib.request.urlopen(req, timeout=3) as response:
        return json.load(response)


@pytest.mark.parametrize("path", ["/api/v1", "/p2/v1"])
def test_compatible_and_counters(mock_server, path):
    before = call(mock_server, "/__calls", authenticated=False).get(path + "/chat/completions", 0)
    assert call(mock_server, path + "/models")["data"][0]["id"] == "mock/planner"
    response = call(mock_server, path + "/chat/completions", {"messages": [{"role": "user", "content": "What should I call you?"}]})
    assert response["choices"][0]["message"]["role"] == "assistant"
    assert call(mock_server, "/__calls", authenticated=False)[path + "/chat/completions"] == before + 1


def test_anthropic_native_and_tool_roundtrip(mock_server):
    response = call(mock_server, "/anthropic/v1/messages", {"messages": [{"role": "user", "content": [{"type": "text", "text": "LONG RUN DEMO 2"}]}]}, anthropic=True)
    tool = next(block for block in response["content"] if block["type"] == "tool_use")
    assert tool["input"]
    messages = server.anthropic_messages({"messages": [{"role": "assistant", "content": [tool]}, {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool["id"], "content": "done"}]}]})
    assert messages[-1]["role"] == "tool"
    assert messages[-1]["tool_call_id"] == tool["id"]
    assert "cache_read_input_tokens" in response["usage"]
    assert call(mock_server, "/anthropic/v1/models", anthropic=True)["data"]


def test_model_endpoints_require_auth(mock_server):
    with pytest.raises(urllib.error.HTTPError) as caught:
        call(mock_server, "/p2/v1/models", authenticated=False)
    assert caught.value.code == 401
