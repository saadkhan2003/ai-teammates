"""Small, deterministic builders for version 1 chat widgets."""
from __future__ import annotations
import json
import re
from typing import Any

VERSION = 1
MAX_BYTES = 48_000
MAX_DEPTH = 8
_TYPES = {"card", "list", "table", "form", "buttons", "badges", "key-value", "progress", "image-grid", "chart", "flow", "code"}
_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")

def validate(widget: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(widget, dict) or len(json.dumps(widget, separators=(",", ":"), ensure_ascii=False).encode()) > MAX_BYTES:
        raise ValueError("widget exceeds maximum size")
    if _depth(widget) > MAX_DEPTH:
        raise ValueError("widget exceeds maximum depth")
    if widget.get("version") != VERSION or widget.get("type") not in _TYPES or not _ID.fullmatch(str(widget.get("id", ""))):
        raise ValueError("invalid widget envelope")
    if widget["type"] == "code" and (len(str(widget.get("code", ""))) > 24000 or len(str(widget.get("original", ""))) > 24000):
        raise ValueError("code widget exceeds maximum source length")
    if widget["type"] == "code" and (len(str(widget.get("code", ""))) > 24000 or len(str(widget.get("original", ""))) > 24000):
        raise ValueError("code widget exceeds maximum source length")
    if widget["type"] == "image-grid":
        for image in widget.get("images", []):
            url = image.get("url", "")
            if not (url.startswith("https://") or re.match(r"^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$", url, re.I)):
                raise ValueError("unsafe image url")
    return widget

def _depth(value: Any, depth: int = 0) -> int:
    if isinstance(value, dict): return max([depth] + [_depth(v, depth + 1) for v in value.values()])
    if isinstance(value, list): return max([depth] + [_depth(v, depth + 1) for v in value])
    return depth

def build(kind: str, widget_id: str, **fields: Any) -> dict[str, Any]:
    return validate({"version": VERSION, "id": widget_id, "type": kind, **fields})

def card(widget_id: str, title: str, body: str, **fields: Any) -> dict[str, Any]: return build("card", widget_id, title=title, body=body, **fields)
def list_widget(widget_id: str, items: list[Any], **fields: Any) -> dict[str, Any]: return build("list", widget_id, items=items, **fields)
def table(widget_id: str, columns: list[str], rows: list[list[Any]], **fields: Any) -> dict[str, Any]: return build("table", widget_id, columns=columns, rows=rows, **fields)
def buttons(widget_id: str, actions: list[dict[str, Any]], **fields: Any) -> dict[str, Any]: return build("buttons", widget_id, actions=actions, **fields)
def form(widget_id: str, fields: list[dict[str, Any]], submit: dict[str, Any], **kw: Any) -> dict[str, Any]: return build("form", widget_id, fields=fields, submit=submit, **kw)
def chart(widget_id: str, chart_type: str, data: list[dict[str, Any]], **kw: Any) -> dict[str, Any]: return build("chart", widget_id, chart=chart_type, data=data, **kw)
def flow(widget_id: str, nodes: list[dict[str, Any]], edges: list[dict[str, Any]], **kw: Any) -> dict[str, Any]: return build("flow", widget_id, nodes=nodes, edges=edges, **kw)
def code(widget_id: str, language: str, source: str, **kw: Any) -> dict[str, Any]: return build("code", widget_id, language=language, code=source, **kw)

def badges(widget_id: str, items: list[dict[str, Any]], **kw: Any) -> dict[str, Any]: return build("badges", widget_id, items=items, **kw)
def key_value(widget_id: str, items: list[dict[str, Any]], **kw: Any) -> dict[str, Any]: return build("key-value", widget_id, items=items, **kw)
def progress(widget_id: str, value: float, **kw: Any) -> dict[str, Any]: return build("progress", widget_id, value=value, **kw)
def image_grid(widget_id: str, images: list[dict[str, Any]], **kw: Any) -> dict[str, Any]: return build("image-grid", widget_id, images=images, **kw)
