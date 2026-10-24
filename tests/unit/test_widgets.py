import pytest
from services.agent import widgets
from services.agent.guard import widget_invalid_reason

def test_builders_and_bounds():
    item = widgets.card("status", "Status", "Ready")
    assert item["version"] == 1 and item["type"] == "card"
    with pytest.raises(ValueError): widgets.build("unknown", "x")
    with pytest.raises(ValueError): widgets.code("x", "txt", "x" * 24001)

def test_image_url_policy():
    assert widgets.build("image-grid", "images", images=[{"url": "https://example.com/a.png", "alt": "a"}])
    with pytest.raises(ValueError): widgets.build("image-grid", "images", images=[{"url": "javascript:alert(1)", "alt": "x"}])

def test_worker_guard_bounds_widget_tool_before_transport():
    assert widget_invalid_reason({"widget": widgets.card("ok", "Ready", "Done")}) is None
    assert widget_invalid_reason({"widget": {"version": 2, "id": "x", "type": "card"}}) == "unsupported_widget_version"
    assert widget_invalid_reason({"widget": {"version": 1, "id": "x", "type": "image-grid", "images": [{"url": "javascript:alert(1)"}]}}) == "unsafe_image_url"
