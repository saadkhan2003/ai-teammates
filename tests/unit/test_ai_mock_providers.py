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


@pytest.mark.parametrize("path,anthropic", [("/api/v1/chat/completions", False), ("/p2/v1/chat/completions", False), ("/anthropic/v1/messages", True)])
def test_streaming_has_progressive_text_and_final_usage(mock_server, monkeypatch, path, anthropic):
    monkeypatch.setenv("MOCK_STREAM_DELAY_MS", "1")
    headers = {"Content-Type": "application/json", "x-api-key" if anthropic else "Authorization": ("" if anthropic else "Bearer ") + "sk-or-mock-test-only-123456789"}
    payload = {"stream": True, "messages": [{"role": "user", "content": "SPEED STREAM DEMO"}]}
    req = urllib.request.Request(mock_server + path, data=json.dumps(payload).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=3) as response:
        assert response.headers["Content-Type"] == "text/event-stream"
        frames = [line.decode().removeprefix("data: ").strip() for line in response if line.startswith(b"data:")]
    values = [json.loads(frame) for frame in frames if frame != "[DONE]"]
    if anthropic:
        assert values[0]["type"] == "message_start"
        assert sum(v["type"] == "content_block_delta" for v in values) > 5
        assert values[-1]["type"] == "message_stop"
        assert values[-2]["usage"]["output_tokens"] > 0
    else:
        assert sum(bool(v.get("choices") and v["choices"][0]["delta"].get("content")) for v in values) > 5
        assert values[-1]["usage"]["completion_tokens"] > 0
        assert frames[-1] == "[DONE]"


def test_tool_stream_has_name_before_incremental_arguments():
    response = {"choices": [{"message": {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "function": {"name": "read_file", "arguments": '{"path":"/workspace/a"}'}}]}}], "usage": {"prompt_tokens": 5, "completion_tokens": 2, "prompt_tokens_details": {"cached_tokens": 3}}}
    frames = list(server.stream_frames(response))
    calls = [f["choices"][0]["delta"]["tool_calls"][0] for f in frames if isinstance(f, dict) and f.get("choices") and "tool_calls" in f["choices"][0]["delta"]]
    assert calls[0]["function"]["name"] == "read_file"
    assert "name" not in calls[1]["function"]
    assert "".join(c["function"]["arguments"] for c in calls) == '{"path":"/workspace/a"}'
    native = list(server.stream_frames(response, True))
    assert native[0]["message"]["usage"]["input_tokens"] == 2
    assert native[0]["message"]["usage"]["cache_read_input_tokens"] == 3
    assert any(f.get("delta", {}).get("type") == "input_json_delta" for f in native)

def test_catalog_expiration_router_models_and_deterministic_judge(mock_server):
    catalog = call(mock_server, "/api/v1/models")["data"]
    assert any(m.get("expiration_date") for m in catalog)
    assert all("supported_parameters" in m and "context_length" in m for m in catalog)
    for model, expected in [("mock/planner", "4"), ("mock/weak", "incorrect")]:
        result = call(mock_server, "/api/v1/chat/completions", {"models": [model, "mock/retiring"], "messages": [{"role": "system", "content": "AI_GOLDEN_CASE:arithmetic"}]})
        assert result["model"] == model
        assert result["choices"][0]["message"]["content"] == expected
    result = call(mock_server, "/p2/v1/chat/completions", {"messages": [{"role": "system", "content": "AI_GOLDEN_JUDGE"}]})
    assert json.loads(result["choices"][0]["message"]["content"])["score"] == 1


def test_golden_cli_runner_uses_mock_completion_and_judge_without_network():
    spec = importlib.util.spec_from_file_location("ai_golden_eval", ROOT / "evals/eval_real.py")
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    cases = json.loads((ROOT / "evals/golden/core.json").read_text())
    answers = iter(["4", '{"ok":true}', "I cannot share private information."])
    result = runner.run_golden(cases, lambda _: next(answers), lambda c, a: 1)
    assert result["hard_pass"] and result["score"] == 1
    result = runner.run_golden(cases, lambda _: "incorrect", lambda c, a: 0.1)
    assert not result["hard_pass"] and result["score"] == pytest.approx(0.1)
    with pytest.raises(ValueError, match="judge score"):
        runner.run_golden(cases, lambda _: "4", lambda c, a: 2)
