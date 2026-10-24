"""Exercise the generated compose, including the second API and dynamic computers."""
from pathlib import Path
import os
import subprocess
import yaml
import pytest

ROOT = Path(__file__).resolve().parents[2]


def generate(tmp_path, *extra, **env):
    out = tmp_path / 'stack.yml'
    variables = {k: v for k, v in os.environ.items() if k != 'MAX_COMPUTERS'}
    variables.update(env)
    subprocess.run(['python3', str(ROOT / 'scripts/gen-stack-compose.py'), 'v04m', '--subnet', '172.30.58',
        '--http', '58080', '--api', '58081', '--api2', '58082', '--out', str(out), *extra],
        check=True, capture_output=True, env=variables)
    return yaml.safe_load(out.read_text())


def test_generated_stack_computer_defaults_and_cpu_override(tmp_path):
    doc = generate(tmp_path, '--no-cpu-limits')
    assert doc['name'] == 'v04m'
    for name in ('api', 'api2'):
        cfg = doc['services'][name]['environment']
        assert cfg['MAX_COMPUTERS'] == '5'
        assert cfg['COMPUTE_STACK'] == 'v04m'
        assert cfg['ENABLE_TEST_HOOKS'] == 'true'
        assert cfg['COMPUTER_NO_CPU_LIMITS'] == 'true'
        assert cfg['COMPUTER_CPU_GUARANTEE'] == '${COMPUTER_CPU_GUARANTEE:-2}'
        assert cfg['COMPUTER_CPU_BURST'] == '${COMPUTER_CPU_BURST:-4}'
    assert all('cpus' not in service for service in doc['services'].values())
    assert doc['services']['caddy']['ports'] == ['127.0.0.1:58080:80']


@pytest.mark.parametrize('args,env,expected', [([], {}, '5'), ([], {'MAX_COMPUTERS': '7'}, '7'),
    (['--max-computers', '9'], {'MAX_COMPUTERS': '7'}, '9')])
def test_generated_computer_cap_can_be_overridden(tmp_path, args, env, expected):
    doc = generate(tmp_path, *args, **env)
    assert doc['services']['api']['environment']['MAX_COMPUTERS'] == expected
    assert doc['services']['api2']['environment']['MAX_COMPUTERS'] == expected


def test_production_test_hooks_are_opt_in():
    doc = yaml.safe_load((ROOT / 'docker-compose.yml').read_text())
    cfg = doc['services']['api']['environment']
    assert cfg['ENABLE_TEST_HOOKS'] == '${ENABLE_TEST_HOOKS:-false}'
    assert cfg['MAX_COMPUTERS'] == '${MAX_COMPUTERS:-}'
