"""Enabled plugin tools the worker may offer the model. No process is started here."""

from __future__ import annotations

PREFIX = "plugin_"
MAX_TOOLS = 24


def bound_tools(tools: list) -> list[dict]:
    """Keep only plugin tools, and only up to the model cap."""
    kept: list[dict] = []
    if not isinstance(tools, list):
        return kept
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = str(tool.get("name") or "")
        if not name.startswith(PREFIX):
            continue
        kept.append(tool)
        if len(kept) >= MAX_TOOLS:
            break
    return kept


def enabled_names(tools: list) -> list[str]:
    """Every enabled plugin name. The model index is separate and stays small."""
    names: list[str] = []
    if not isinstance(tools, list):
        return names
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = str(tool.get("name") or "")
        if name.startswith(PREFIX):
            names.append(name)
    return names


def call_allowed(name: str, enabled: set[str]) -> bool:
    """Built-in tools are unchanged. A plugin tool must be in the enabled set."""
    if not str(name).startswith(PREFIX):
        return True
    return name in enabled
