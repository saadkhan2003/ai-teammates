"""A stdio MCP server starts inside the bot computer, not on the API host."""
from __future__ import annotations

import json

from test_plugin_catalog import login
from stack import worker_request


def test_stdio_server_lists_and_stays_inside_caps():
    owner = login()
    status, catalog = owner.call(
        "POST",
        "/api/admin/plugins",
        {
            "name": "Sandbox echo",
            "kind": "mcp",
            "transport": "stdio",
            "authType": "none",
            "command": ["python3", "/opt/fixtures/mcp_echo.py"],
            "tools": [
                {"name": "echo", "description": "Echo text"},
                {"name": "probe", "description": "Report caps and network"},
            ],
        },
    )
    assert status == 200, catalog
    status, installed = owner.call("POST", "/api/plugins/install", {"catalogId": catalog["id"]})
    assert status == 200, installed
    status, bots = owner.call("GET", "/api/bots")
    assert status == 200 and bots, bots
    bot_id = bots[0]["id"]
    status, enabled = owner.call("PUT", f"/api/plugins/{installed['id']}/bots/{bot_id}", {"enabled": True})
    assert status == 200, enabled
    status, tools = worker_request("GET", f"/internal/bots/{bot_id}/plugin-tools")
    assert status == 200, tools
    prefix = "plugin_" + installed["id"].replace("-", "")[:8] + "_"
    names = [item["name"] for item in tools["tools"] if item["name"].startswith(prefix)]
    probe = next(name for name in names if name.endswith("_probe"))
    echo = next(name for name in names if name.endswith("_echo"))
    status, called = owner.call(
        "POST",
        f"/api/plugins/{installed['id']}/call",
        {"botId": bot_id, "tool": probe, "args": {}},
    )
    assert status == 200 and called["ok"] is True, called
    output = called["output"]
    if isinstance(output, dict) and output.get("replayed") and isinstance(output.get("output"), dict):
        output = output["output"]
    assert output["sandboxed"] is True, output
    assert output["exitCode"] == 0, output
    body = json.loads(output["body"])
    text = json.loads(body["result"]["content"][0]["text"])
    assert "echo" in text["tools"] and "probe" in text["tools"], text
    assert text["as_bytes"] <= 268435456, text
    assert text["nofile"] <= 64, text
    assert text["internal_blocked"] is True, text
    status, echoed = owner.call(
        "POST",
        f"/api/plugins/{installed['id']}/call",
        {"botId": bot_id, "tool": echo, "args": {"text": "stdio-ok"}},
    )
    assert status == 200 and echoed["ok"] is True, echoed
    echo_out = echoed["output"]
    if isinstance(echo_out, dict) and echo_out.get("replayed") and isinstance(echo_out.get("output"), dict):
        echo_out = echo_out["output"]
    assert "stdio-ok" in echo_out["body"], echo_out
