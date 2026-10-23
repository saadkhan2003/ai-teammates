import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / "services" / "agent"))
from snapshots import maybe_snapshot


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


def _repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.invalid")
    _git(repo, "config", "user.name", "Snapshot Test")
    (repo / "tracked.txt").write_text("base\n")
    _git(repo, "add", "tracked.txt")
    _git(repo, "commit", "-qm", "base")
    return repo


def test_snapshot_ref_preserves_head_index_and_worktree(tmp_path):
    repo = _repo(tmp_path)
    (repo / "tracked.txt").write_text("staged change\n")
    _git(repo, "add", "tracked.txt")
    (repo / "tracked.txt").write_text("working change\n")
    before_head = _git(repo, "rev-parse", "HEAD").stdout.strip()
    before_status = _git(repo, "status", "--porcelain").stdout
    result = maybe_snapshot(repo, "12345678-abcd", now=datetime(2026, 1, 1, tzinfo=timezone.utc))
    assert result and result["snapshotRef"] == "refs/teammates/checkpoints/12345678"
    assert _git(repo, "rev-parse", "HEAD").stdout.strip() == before_head
    assert _git(repo, "status", "--porcelain").stdout == before_status
    assert _git(repo, "show", result["snapshotRef"] + ":tracked.txt").stdout == "working change\n"


def test_interval_throttling_and_empty_snapshot(tmp_path):
    repo = _repo(tmp_path)
    assert maybe_snapshot(repo, "abcdefgh", now=datetime.now(timezone.utc)) is None
    (repo / "tracked.txt").write_text("change\n")
    old = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()
    assert maybe_snapshot(repo, "abcdefgh", last_snapshot_at=old, interval_seconds=300) is None


def test_no_repo_is_noop(tmp_path):
    assert maybe_snapshot(tmp_path, "abcdefgh") is None
