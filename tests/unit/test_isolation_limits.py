from pathlib import Path
import pytest

def test_compose_isolation_override_yaml():
    yaml = pytest.importorskip("yaml", reason="PyYAML unavailable")
    path = Path(__file__).parents[2] / "deploy/compose.isolation-limits.yml"
    value = yaml.safe_load(path.read_text())
    assert value["services"]["computer-template"]["deploy"]["resources"]["limits"]["pids"] > 0
