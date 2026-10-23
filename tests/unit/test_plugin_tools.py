"""The worker only offers plugin tools that are enabled for the bot."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "agent"))

from plugins import MAX_TOOLS, bound_tools, call_allowed, enabled_names


def test_bound_tools_drop_builtins_and_cap_the_list():
    tools = [{"name": "shell"}] + [{"name": f"plugin_tool_{index}"} for index in range(MAX_TOOLS + 5)]
    kept = bound_tools(tools)
    assert len(kept) == MAX_TOOLS
    assert all(item["name"].startswith("plugin_") for item in kept)
    assert call_allowed("shell", {item["name"] for item in kept})
    assert call_allowed(kept[0]["name"], {item["name"] for item in kept})
    assert not call_allowed("plugin_not_enabled", {item["name"] for item in kept})


def test_enabled_names_are_not_capped_at_the_prompt_limit():
    tools = [{"name": f"plugin_tool_{index}", "description": "x" * 500} for index in range(MAX_TOOLS + 5)]
    names = enabled_names(tools)
    assert len(names) == MAX_TOOLS + 5
    assert call_allowed(names[-1], set(names))
    assert call_allowed("search_tools", set(names))
