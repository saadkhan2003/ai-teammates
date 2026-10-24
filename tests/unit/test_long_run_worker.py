"""Run the real worker/resume logic with the deterministic provider in memory."""
import asyncio
import copy
import sys
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/agent"))
sys.path.insert(0, str(ROOT / "services/mock-openrouter"))
from planner import plan
from worker import Worker, _tool_calls


@pytest.mark.parametrize("prompt,budget,expected", [
    ("LONG RUN DEMO 30 SLOW", 200, "completed"),
    ("LONG RUN DEMO 30 SLOW", 6, "waiting_human"),
    ("SHELL APPEND DEMO", 200, "completed"),
])
def test_interrupted_worker_keeps_budget_and_verifies_side_effects(monkeypatch, prompt, budget, expected):
    monkeypatch.setenv("COMPACT_MAX_MESSAGES", "1000")
    monkeypatch.delenv("WORKER_FORCED_EXIT_AFTER_STEPS", raising=False)

    async def run():
        transcript, files, calls, states = [], {}, [], []
        worker = Worker()
        task = {"id": "task", "botId": "bot", "instruction": prompt, "attempt": 1, "epoch": 1,
                "budget": {"maxSteps": budget, "maxRounds": budget + 1, "maxRoundsCumulative": budget + 1}}
        interrupted = False

        async def request(method, path, body, **kwargs):
            nonlocal transcript
            if path.endswith("/transcript"):
                transcript = copy.deepcopy(body["messages"])
            elif path.endswith("/complete"):
                states.append(("completed", None))
            elif path.endswith("/status"):
                states.append((body["status"], body.get("reason")))
            elif path.endswith("/fail"):
                pytest.fail(str(body))
            return httpx.Response(200, request=httpx.Request(method, "http://unit.invalid"))

        async def request_json(method, path, body=None, **kwargs):
            if path.endswith("/transcript"):
                return {"messages": copy.deepcopy(transcript)}
            assert path == "/internal/model/complete"
            message = plan(body["messages"])["choices"][0]["message"]
            if message.get("tool_calls"):
                message["toolCalls"] = _tool_calls(message)
                del message["tool_calls"]
            return {"status": "ok", "message": message}

        async def invoke(task, pending, **kwargs):
            nonlocal interrupted
            name, args = pending["name"], pending["arguments"]
            calls.append((name, args))
            if name == "write_file":
                assert args["path"] not in files, "a landed write was repeated after resume"
                files[args["path"]] = args["content"]
            elif name == "read_file":
                return {"ok": True, "output": {"path": args["path"], "content": files[args["path"]]}}
            elif "echo x >>" in args.get("command", ""):
                path = "/workspace/shell-append-demo.log"
                files[path] = files.get(path, "") + "x\n"
            # Crash after the side effect, before its result is persisted.
            if not interrupted and (name == "write_file" or "echo x >>" in args.get("command", "")):
                interrupted = True
                raise asyncio.CancelledError()
            return {"ok": True, "output": {"exitCode": 0}}

        worker.request = request
        worker.request_json = request_json
        worker._invoke = invoke
        try:
            await worker.execute(task, asyncio.Event())
        except asyncio.CancelledError:
            pass
        assert interrupted and not states
        used = task["_stepsUsed"]
        task.update(attempt=2, epoch=2, checkpoint={"stepsUsed": used, "modelRounds": task["_modelRounds"]},
                    resume={"brief": "Continue safely.", "interrupted": True})
        await worker.execute(task, asyncio.Event())
        assert states[-1][0] == expected
        assert task["_stepsUsed"] >= used
        assert any("unknown_outcome" in m.get("content", "") for m in transcript if m["role"] == "tool")
        if expected == "waiting_human":
            assert states[-1][1] == "budget_reached" and task["_stepsUsed"] == budget
        elif prompt.startswith("LONG RUN"):
            assert len(files) == 30
            assert len([call for call in calls if call[0] == "write_file"]) == 30
            assert task["_modelRounds"] > 12
        else:
            assert files["/workspace/shell-append-demo.log"] == "x\n"
            assert len([call for call in calls if call[0] == "shell"]) == 1

    asyncio.run(run())
