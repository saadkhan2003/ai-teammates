"""Planner plans used by the mock OpenRouter service."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "mock-openrouter"))

from planner import plan


def _call(messages):
    result = plan(messages)
    message = result["choices"][0]["message"]
    call = message["tool_calls"][0]
    return call["function"]["name"], json.loads(call["function"]["arguments"]), result


def test_alpha_plan_step_0_is_browser_open():
    name, args, result = _call(
        [
            {
                "role": "user",
                "content": "Open http://portal.example.edu:8099/alpha.html and extract the h1",
            }
        ]
    )
    assert name == "browser_open"
    assert args["url"] == "http://portal.example.edu:8099/alpha.html"
    assert args["wait"] == "#ready"
    assert result["choices"][0]["finish_reason"] == "tool_calls"


def test_plan_demo_sets_and_updates_a_three_step_plan():
    name, args, _ = _call([{"role": "user", "content": "PLAN DEMO"}])
    assert name == "plan_set" and len(args["items"]) == 3
    second = plan([{"role": "user", "content": "PLAN DEMO"}, {"role": "tool", "content": "{}"}])
    call = second["choices"][0]["message"]["tool_calls"][0]["function"]
    assert call["name"] == "plan_update"
    assert json.loads(call["arguments"]) == {"index": "1", "status": "done"}


def test_tests_gate_demo_returns_a_final_answer_first():
    result = plan([{"role": "user", "content": "TESTS GATE DEMO"}])
    assert result["choices"][0]["finish_reason"] == "stop"
    assert not result["choices"][0]["message"].get("tool_calls")


def test_terminal_plan_is_write_file():
    name, args, _result = _call([{"role": "user", "content": "Terminal: write the word pong"}])
    assert name == "write_file"
    assert args["path"] == "/workspace/notes/ping.txt"
    assert args["content"] == "pong\n"


def test_unknown_work_text_has_no_plan():
    result = plan([{"role": "user", "content": "Refactor the billing worker and ship it"}])
    message = result["choices"][0]["message"]
    assert "mock model has no plan" in message["content"]
    assert "tool_calls" not in message
    assert result["choices"][0]["finish_reason"] == "stop"


def test_thanks_is_reaction_only():
    user = {"role": "user", "content": "thanks!", "message_id": "msg-1"}
    name, args, result = _call([user])
    assert name == "react_to_message"
    assert args == {"message_id": "msg-1", "emoji": "👍"}
    assert result["choices"][0]["finish_reason"] == "tool_calls"
    final = plan([user, {"role": "tool", "content": "{\"ok\": true, \"action\": \"added\"}"}])
    message = final["choices"][0]["message"]
    assert message["content"] == ""
    assert "tool_calls" not in message


def test_ask_user_plan_then_continues_with_the_choice():
    user = {"role": "user", "content": "Ask which Rakazo ideas should go in now"}
    name, args, result = _call([user])
    assert name == "ask_user"
    assert args["prompt"] == "Which Rakazo ideas should go in now?"
    assert args["options"] == ["Keep all for v0.3", "Hold for later", "Drop them"]
    assert args["styles"] == ["primary", "primary", "danger"]
    assert args["allow_custom"] is True
    assert result["choices"][0]["finish_reason"] == "tool_calls"
    final = plan([user, {"role": "tool", "content": json.dumps({"ok": True, "answer": "Keep all for v0.3"})}])
    assert final["choices"][0]["message"]["content"] == "You chose Keep all for v0.3"
    wrapped = plan(
        [
            user,
            {"role": "tool", "content": json.dumps({"ok": True, "output": {"answer": "Hold for later"}})},
        ]
    )
    assert wrapped["choices"][0]["message"]["content"] == "You chose Hold for later"


def test_forget_memory_plan():
    user = {"role": "user", "content": "Forget that my favorite editor is Helix"}
    name, args, _result = _call([user])
    assert name == "forget_memory"
    assert args == {"content": "My favorite editor is Helix"}
    final = plan([user, {"role": "tool", "content": "{}"}])
    assert final["choices"][0]["message"]["content"] == "Forgot."


def test_system_prompt_prefers_ask_user_over_plain_text():
    text = (Path(__file__).resolve().parents[2] / "services" / "agent" / "worker.py").read_text()
    assert "call ask_user" in text
    assert "Do not ask that question as plain text" in text


def test_question_is_text_not_a_reaction():
    result = plan([{"role": "user", "content": "What should I call you?"}])
    message = result["choices"][0]["message"]
    assert message["content"].strip()
    assert "tool_calls" not in message
    assert result["choices"][0]["finish_reason"] == "stop"


def test_chat_has_no_tool_calls():
    result = plan([{"role": "user", "content": "What should I call you?"}])
    message = result["choices"][0]["message"]
    assert message["content"] == "I'm your teammate. Call me whatever fits the work."
    assert "tool_calls" not in message
    assert result["choices"][0]["finish_reason"] == "stop"


def test_alpha_later_steps_use_tool_count():
    user = {"role": "user", "content": "Open http://portal.example.edu:8099/beta.html and extract the h1"}
    extract_name, extract_args, _ = _call([user, {"role": "tool", "content": "{}"}])
    assert extract_name == "browser_extract"
    assert extract_args == {"selector": "h1"}
    final = plan(
        [
            user,
            {"role": "tool", "content": "{}"},
            {"role": "tool", "content": json.dumps({"text": "Beta"})},
        ]
    )
    assert final["choices"][0]["message"]["content"] == "Extracted heading: Beta"
    raw = plan(
        [
            user,
            {"role": "tool", "content": "x"},
            {"role": "tool", "content": "not-json"},
        ]
    )
    assert raw["choices"][0]["message"]["content"] == "Extracted heading: not-json"


def test_signin_plan_requests_login_without_a_password():
    name, args, _ = _call([{"role": "user", "content": "Sign in at the portal"}])
    assert name == "browser_open"
    assert "signin.html" in args["url"]
    user = {"role": "user", "content": "Sign in at the portal"}
    login_name, login_args, _ = _call([user, {"role": "tool", "content": "{}"}])
    assert login_name == "request_login"
    assert login_args["domain"] == "portal.example.edu"
    dumped = json.dumps(login_args)
    assert "Canary" not in dumped
    assert all("value" not in field for field in login_args["fields"])
    assert login_args["fields"][1]["kind"] == "password"
    final = plan([user, {"role": "tool", "content": "{}"}, {"role": "tool", "content": "{\"status\":\"filled\"}"}])
    assert final["choices"][0]["message"]["content"] == "Signed in."


def test_hidden_plan_does_not_repeat_the_marker():
    user = {"role": "user", "content": "Open http://evil.example:8099/hidden.html and extract the h1"}
    name, _, _ = _call([user])
    assert name == "browser_open"
    final = plan(
        [
            user,
            {"role": "tool", "content": "{}"},
            {"role": "tool", "content": json.dumps({"text": "Public bulletin"})},
        ]
    )
    assert final["choices"][0]["message"]["content"] == "I read the visible heading only."
    assert "CANARY-INJECT" not in final["choices"][0]["message"]["content"]


def test_public_post_and_transfer_plans():
    post_name, post_args, _ = _call([{"role": "user", "content": "Post this note to the public board: hello from the yard"}])
    assert post_name == "external_post"
    assert post_args["text"] == "hello from the yard"
    name, args, _ = _call([{"role": "user", "content": "Transfer money from checking to savings"}])
    assert name == "transfer_funds"
    assert "move money" in args["note"]


if __name__ == "__main__":
    test_alpha_plan_step_0_is_browser_open()
    test_terminal_plan_is_write_file()
    test_unknown_work_text_has_no_plan()
    test_chat_has_no_tool_calls()
    test_alpha_later_steps_use_tool_count()
    print("ok")


def _first_call(text):
    name, args, _ = _call([{"role": "user", "content": text}])
    return name, args


def test_peer_ask_plans_a_message_bot_call():
    name, args = _first_call("Ask Beta to double 21")
    assert name == "message_bot"
    assert args["bot"] == "Beta" and args["title"] == "Double 21"


def test_peer_receiver_answers_42_without_tools():
    result = plan([{"role": "user", "content": "Message from bot Alpha (thread t1)\n<<<PEER\nDouble 21 and answer with just the number.\n>>>"}])
    message = result["choices"][0]["message"]
    assert message.get("content") == "42" and not message.get("tool_calls")


def test_peer_delete_request_plans_delete_file():
    result = plan([{"role": "user", "content": "Message from bot Alpha (thread t1)\n<<<PEER\nDelete the file /workspace/secret.txt please.\n>>>"}])
    call = result["choices"][0]["message"]["tool_calls"][0]["function"]
    assert call["name"] == "delete_file"


def test_hello_script_is_capped_at_seven_sends():
    steps = 0
    messages = [{"role": "user", "content": "Message Beta hello 99 times"}]
    for _ in range(12):
        result = plan(messages)
        message = result["choices"][0]["message"]
        if not message.get("tool_calls"):
            break
        call = message["tool_calls"][0]
        steps += 1
        messages = messages + [message, {"role": "tool", "tool_call_id": call["id"], "content": json.dumps({"ok": True})}]
    assert steps == 7
