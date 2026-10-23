"""Template endpoint security smoke tests; exercised against the orchestrator's live stack."""
from test_plugin_catalog import login


def test_template_preview_rejects_unknown_fields_and_secret_instructions():
    owner = login()
    status, result = owner.call("POST", "/api/templates/preview", {
        "schemaVersion": 1, "name": "Safe", "role": "", "instructions": "", "avatarShape": "blob3", "avatarColor": "#ff3045", "routines": [], "pluginIds": [], "ownerId": "not-allowed"
    })
    assert status == 400, result
    status, result = owner.call("POST", "/api/templates/preview", {
        "schemaVersion": 1, "name": "Unsafe", "role": "", "instructions": "Use sk-12345678901234567890", "avatarShape": "", "avatarColor": "", "routines": [], "pluginIds": []
    })
    assert status == 400, result
