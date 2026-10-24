import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "services" / "agent"))

from worker import parallel_limit  # noqa: E402


def test_default_is_four():
    assert parallel_limit({}) == 4


def test_raisable_to_eight_and_clamped():
    assert parallel_limit({"WORKER_PARALLEL_TASKS": "8"}) == 8
    assert parallel_limit({"WORKER_PARALLEL_TASKS": "20"}) == 8
    assert parallel_limit({"WORKER_PARALLEL_TASKS": "0"}) == 1
    assert parallel_limit({"WORKER_PARALLEL_TASKS": "nope"}) == 4


def test_legacy_variable_still_read():
    assert parallel_limit({"MAX_PARALLEL_TASKS": "3"}) == 3
