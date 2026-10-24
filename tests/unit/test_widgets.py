import pytest
from services.agent import widgets

def test_builders_and_bounds():
    item = widgets.card("status", "Status", "Ready")
    assert item["version"] == 1 and item["type"] == "card"
    with pytest.raises(ValueError): widgets.build("unknown", "x")
    with pytest.raises(ValueError): widgets.code("x", "txt", "x" * 24001)

def test_image_url_policy():
    assert widgets.build("image-grid", "images", images=[{"url": "https://example.com/a.png", "alt": "a"}])
    with pytest.raises(ValueError): widgets.build("image-grid", "images", images=[{"url": "javascript:alert(1)", "alt": "x"}])
