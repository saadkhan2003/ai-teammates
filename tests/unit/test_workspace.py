"""Each bot workspace is a different directory. A path that leaves it is rejected."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "computer" / "src"))

import workspace


def test_sibling_workspace_is_not_readable(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "ws"))
    monkeypatch.setenv("STATE_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("HOME_ROOT", str(tmp_path / "home"))
    left = "a" * 32
    right = "b" * 32
    assert workspace.ensure(left) != workspace.ensure(right)
    monkeypatch.setenv("BOT_ROOT", str(workspace.root_for(left)))
    workspace.write_file("/workspace/notes/private.txt", "secret-a")
    monkeypatch.setenv("BOT_ROOT", str(workspace.root_for(right)))
    try:
        workspace.read_file("/workspace/notes/private.txt")
    except SystemExit as exc:
        assert exc.code == 2
    else:
        raise AssertionError("the other bot's public path resolved inside this workspace")
    sibling = workspace.root_for(left) / "notes" / "private.txt"
    try:
        workspace.locate(str(sibling))
    except PermissionError:
        pass
    else:
        raise AssertionError("locate followed a path into the other bot")
    try:
        workspace.locate("/workspace/../../bots/" + left + "/notes/private.txt")
    except PermissionError:
        pass
    else:
        raise AssertionError("dot segments escaped the workspace")
    left_home = workspace.home_for(left)
    assert left_home.is_dir()
    assert (left_home.stat().st_mode & 0o777) == 0o700
    workspace.wipe(left)
    assert not workspace.root_for(left).exists()
    assert not left_home.exists()
    assert workspace.root_for(right).exists()
