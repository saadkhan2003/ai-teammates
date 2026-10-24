"""The in-computer half of workspace sync (apps/api/workspace_sync.py), run against a temp BOT_ROOT."""
import json, os, subprocess, sys, tarfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "apps" / "api" / "workspace_sync.py"


def run(root, *args):
    out = subprocess.run([sys.executable, str(SCRIPT), *args], env={"BOT_ROOT": str(root), "PATH": "/usr/bin:/bin"},
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_manifest_lists_regular_files_and_skips_caches_links_and_temp(tmp_path):
    (tmp_path / "notes").mkdir()
    (tmp_path / "notes" / "a.md").write_text("hi")
    (tmp_path / ".cache").mkdir(); (tmp_path / ".cache" / "x").write_text("c")
    (tmp_path / "node_modules").mkdir(); (tmp_path / "node_modules" / "m.js").write_text("m")
    (tmp_path / "half.part").write_text("p")
    (tmp_path / "link").symlink_to("/etc/passwd")
    (tmp_path / ".sync-in-abc").mkdir(); (tmp_path / ".sync-in-abc" / "s").write_text("s")
    got = run(tmp_path, "manifest")
    assert [f[0] for f in got["files"]] == ["notes/a.md"]
    assert got["files"][0][1] == 2 and got["token"] == "" and got["truncated"] is False


def test_pack_keeps_mtime_and_refuses_symlinks_and_escapes(tmp_path):
    (tmp_path / "a.txt").write_text("hello")
    os.utime(tmp_path / "a.txt", ns=(1_700_000_000_123_456_789, 1_700_000_000_123_456_789))
    (tmp_path / "evil").symlink_to("/etc/passwd")
    want = tmp_path / ".sync-want-1.json"
    want.write_text(json.dumps(["a.txt", "evil", "../outside", "/etc/passwd"]))
    got = run(tmp_path, "pack", want.name)
    try:
        assert got["files"] == 1 and not want.exists()
        assert got["tar"].startswith(str(tmp_path) + "/.sync-out-")
        assert [f[0] for f in run(tmp_path, "manifest")["files"]] == ["a.txt"]  # request/result files are never synced
        assert oct(os.stat(got["tar"]).st_mode & 0o777) == "0o600"
        with tarfile.open(got["tar"]) as tar:
            members = tar.getmembers()
            assert [m.name for m in members] == ["a.txt"]
            assert members[0].pax_headers["mtime_ns"] == "1700000000123456789"
            assert tar.extractfile(members[0]).read() == b"hello"
    finally:
        os.unlink(got["tar"])


def test_place_moves_staged_files_sets_mtime_writes_token_and_keeps_newer_local_copies(tmp_path):
    stage = tmp_path / ".sync-in-1"
    (stage / "docs").mkdir(parents=True)
    (stage / "docs" / "r.md").write_text("restored")
    (stage / "kept.md").write_text("old copy")
    (tmp_path / "kept.md").write_text("new local")
    os.utime(tmp_path / "kept.md", ns=(9_000_000_000_000_000_000, 9_000_000_000_000_000_000))
    (stage / ".meta.json").write_text(json.dumps({"docs/r.md": 1_600_000_000_000_000_000, "kept.md": 1_600_000_000_000_000_000, "../x": 1}))
    got = run(tmp_path, "place", ".sync-in-1", "tok-1")
    assert got["placed"] == 1
    assert (tmp_path / "docs" / "r.md").read_text() == "restored"
    assert os.stat(tmp_path / "docs" / "r.md").st_mtime_ns == 1_600_000_000_000_000_000
    assert (tmp_path / "kept.md").read_text() == "new local"
    assert not stage.exists()
    assert (tmp_path / ".sync" / "token").read_text() == "tok-1"
    assert run(tmp_path, "manifest")["token"] == "tok-1"


def test_place_rejects_a_stage_outside_the_bot_dir(tmp_path):
    out = subprocess.run([sys.executable, str(SCRIPT), "place", "../elsewhere", "t"], env={"BOT_ROOT": str(tmp_path)}, capture_output=True, text=True)
    assert out.returncode != 0 and "bad stage" in out.stderr


def test_pack_refuses_want_files_outside_the_root(tmp_path):
    for bad in ("/tmp/x.json", "../.sync-want-1.json", "want.json"):
        out = subprocess.run([sys.executable, str(SCRIPT), "pack", bad], env={"BOT_ROOT": str(tmp_path), "PATH": "/usr/bin:/bin"}, capture_output=True, text=True)
        assert out.returncode != 0


def test_manifest_splits_mtime_so_no_number_looks_like_a_card(tmp_path):
    # Exec output passes a card-number redactor; a 19-digit mtime_ns that passes Luhn came back as [REDACTED].
    (tmp_path / "a.md").write_text("x")
    os.utime(tmp_path / "a.md", ns=(1761330000123456789, 1761330000123456789))
    row = run(tmp_path, "manifest")["files"][0]
    assert row[0] == "a.md" and row[2] * 1_000_000_000 + row[3] == 1761330000123456789
    assert all(len(str(v)) < 13 for v in row[1:])
