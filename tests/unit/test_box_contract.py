from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/computer/src"))

from box_contract import MAX_WINDOWS, port_for


@pytest.mark.parametrize("display", range(1, MAX_WINDOWS + 1))
def test_per_display_ports_match_contract(display):
    assert port_for("vnc", display) == 5900 + display
    assert port_for("exec", display) == 14000 + display
    assert port_for("pty", display) == 13600 + display
    assert port_for("cdp", display) == 9222 + display
    assert port_for("externalView", display) == 9400 + display


@pytest.mark.parametrize("display", [0, -1, 9, True, 1.5])
def test_invalid_display_is_rejected(display):
    with pytest.raises((ValueError, TypeError)):
        port_for("vnc", display)


def test_unknown_port_kind_is_rejected():
    with pytest.raises(ValueError):
        port_for("unknown", 1)
