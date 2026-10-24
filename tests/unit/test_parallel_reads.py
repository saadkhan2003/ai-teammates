import asyncio
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services/agent"))
from parallel_reads import parallel_safe, run_calls


def test_reads_overlap_but_results_keep_call_order():
    async def check():
        active, peak, finished = 0, 0, []
        async def invoke(call):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(call["delay"])
            active -= 1
            finished.append(call["id"])
            return call["id"]
        calls = [{"id": "slow", "name": "read_file", "delay": .02}, {"id": "fast", "name": "search_memory", "delay": .001}]
        assert await run_calls(calls, invoke) == ["slow", "fast"]
        assert finished == ["fast", "slow"] and peak == 2
    asyncio.run(check())


def test_mixed_side_effect_desktop_browser_and_unknown_batches_stay_sequential():
    async def check():
        for name in ["write_file", "shell", "browser_extract", "browser_open", "computer_screenshot", "plugin_read_unknown"]:
            calls = [{"id": "a", "name": "read_file"}, {"id": "b", "name": name}]
            assert not parallel_safe(calls)
            order = []
            async def invoke(call):
                order.append(call["id"] + " start")
                await asyncio.sleep(0)
                order.append(call["id"] + " end")
            await run_calls(calls, invoke)
            assert order == ["a start", "a end", "b start", "b end"]
    asyncio.run(check())


def test_read_batch_waits_for_siblings_before_propagating_failure():
    async def check():
        finished = []
        async def invoke(call):
            if call["id"] == "a":
                raise ValueError("read failed")
            await asyncio.sleep(.01)
            finished.append("b")
        try:
            await run_calls([{"id":"a","name":"read_file"},{"id":"b","name":"read_file"}], invoke)
            assert False
        except ValueError:
            assert finished == ["b"]
    asyncio.run(check())


def test_real_worker_preserves_transcript_order_and_accounts_for_each_read():
    import copy
    from worker import Worker
    async def check():
        worker = Worker()
        task = {"id":"t", "botId":"b", "instruction":"read things", "epoch":1, "attempt":1, "_skill_catalog_added":True}
        transcript, finished, rounds = [], [], 0
        async def load(_task): return []
        async def save(_task, messages): transcript[:] = copy.deepcopy(messages)
        async def model(_task, messages):
            nonlocal rounds
            rounds += 1
            if rounds == 1:
                return {"role":"assistant","content":"","toolCalls":[{"id":"one","name":"read_file","arguments":{"path":"a"}},{"id":"two","name":"search_memory","arguments":{"query":"b"}}]}
            return {"role":"assistant","content":"Done."}
        async def invoke(isolated, call, **kwargs):
            assert kwargs["authorize"] is True
            assert isolated is not task
            await asyncio.sleep(.02 if call["id"] == "one" else .001)
            finished.append(call["id"])
            return {"ok":True}
        async def compact(*args, **kwargs): return False
        async def complete(*args): return None
        async def request(*args, **kwargs): return None
        worker._load_transcript=load;worker._put_transcript=save;worker._complete_model=model;worker._invoke=invoke
        worker._compact_if_needed=compact;worker._complete=complete;worker.request=request
        await worker.execute(task,asyncio.Event())
        assert finished == ["two","one"]
        assert [m["toolCallId"] for m in transcript if m["role"] == "tool"] == ["one","two"]
        assert task["_stepsUsed"] == 2
    asyncio.run(check())
