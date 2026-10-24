"""Generated isolated stacks opt in to one safe template without changing the live stack."""
from pathlib import Path
import os
import subprocess

import yaml

ROOT = Path(__file__).resolve().parents[2]


def _generate(tmp_path, *extra):
    output = tmp_path / "stack.yml"
    result = subprocess.run(["python3", str(ROOT / "scripts/gen-stack-compose.py"), "speedconfig",
                             "--subnet", "172.30.88", "--http", "38080", "--api", "38081",
                             "--out", str(output), *extra], cwd=ROOT, capture_output=True, text=True,
                            env={key: value for key, value in os.environ.items() if key != "MAX_COMPUTERS"})
    return result, yaml.safe_load(output.read_text()) if output.exists() else None


def test_pool_is_disabled_by_default_in_production_and_enabled_in_test_generator(tmp_path):
    compose = yaml.safe_load((ROOT / "docker-compose.yml").read_text())
    assert compose["services"]["api"]["environment"]["WARM_POOL_SIZE"] == "${WARM_POOL_SIZE:-0}"
    result, generated = _generate(tmp_path)
    assert result.returncode == 0
    env = generated["services"]["api"]["environment"]
    assert env["WARM_POOL_SIZE"] == "1" and env["MAX_COMPUTERS"] == "5"
    assert env["COMPUTE_STACK"] == "speedconfig"
    assert env["COMPUTE_NETWORK"] == "speedconfig-computers"
    assert generated["services"]["isolation"]["environment"]["ISOLATION_CHAIN"] == "SPEEDCONFIG-ISO"


def test_pool_config_override_and_secondary_api_never_reaps_primary_templates(tmp_path):
    result, generated = _generate(tmp_path, "--warm-pool-size", "2", "--api2", "38082")
    assert result.returncode == 0
    assert generated["services"]["api"]["environment"]["WARM_POOL_SIZE"] == "2"
    secondary = generated["services"]["api2"]["environment"]
    assert secondary["WARM_POOL_SIZE"] == "0" and secondary["WARM_POOL_MAINTENANCE"] == "false"


def test_negative_pool_size_is_rejected(tmp_path):
    result, generated = _generate(tmp_path, "--warm-pool-size", "-1")
    assert result.returncode != 0 and generated is None
