"""Provider wire bugs the mock planner hid: parallel calls and placeholder ids."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "agent"))

from worker import _call_id, _tool_calls, _unanswered_calls


def test_every_parallel_call_stays_pending_until_it_has_output():
    assistant = {
        "role": "assistant",
        "toolCalls": [
            {"id": "call_del_9f2", "name": "delete_file", "arguments": {"path": "a"}},
            {"id": "call_ls_3ab", "name": "shell", "arguments": {"command": "ls"}},
        ],
    }
    assert [item["id"] for item in _unanswered_calls([assistant])] == ["call_del_9f2", "call_ls_3ab"]
    after_first = [
        assistant,
        {"role": "tool", "toolCallId": "call_del_9f2", "tool_call_id": "call_1", "content": "{}"},
    ]
    assert [item["id"] for item in _unanswered_calls(after_first)] == ["call_ls_3ab"]
    done = after_first + [{"role": "tool", "tool_call_id": "call_ls_3ab", "content": "{}"}]
    assert _unanswered_calls(done) == []


def test_missing_tool_id_is_not_the_placeholder():
    calls = _tool_calls({"toolCalls": [{"name": "ask_user", "arguments": {"prompt": "Delete?"}}]})
    assert calls[0]["id"] != "call_1"
    assert calls[0]["id"] == _call_id({"name": "ask_user"}, "ask_user", {"prompt": "Delete?"})


def test_disk_format_uses_the_image_mkfs():
    root = Path(__file__).resolve().parents[2]
    image = (root / "services" / "computer" / "Dockerfile").read_text()
    disk = (root / "src" / "Compute.Docker" / "LoopDisk.cs").read_text()
    assert "e2fsprogs" in image
    assert "/usr/sbin/mkfs.ext4" in disk
    nsenter = disk.split('"/usr/bin/nsenter"', 1)[1][:240]
    assert "mkfs" not in nsenter
