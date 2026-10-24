"""Regression checks for isolated stack/auth plumbing, without Docker or HTTP."""
import io
import json
import subprocess
from pathlib import Path

import pytest
from test_stack_scope import scope

ROOT = Path(__file__).resolve().parents[2]


def isolated(monkeypatch):
    return scope(monkeypatch, COMPOSE_PROJECT='v04m', BASE_URL='http://localhost:58080', API_URL='http://localhost:58081')


def test_computer_lookup_filters_stack_and_id(monkeypatch):
    stack = isolated(monkeypatch)
    calls = []
    def fake(args, **kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, stdout='scoped-computer\n')
    monkeypatch.setattr(subprocess, 'run', fake)
    assert stack['computer_container']('00000000-0000-0000-0000-000000000001') == 'scoped-computer'
    assert 'label=teammates.stack=v04m' in calls[0]
    assert 'label=teammates.computer_id=00000000-0000-0000-0000-000000000001' in calls[0]


@pytest.mark.parametrize('names', ['', 'one\ntwo\n'])
def test_missing_or_ambiguous_computer_never_yields_a_target(monkeypatch, names):
    stack = isolated(monkeypatch)
    monkeypatch.setattr(subprocess, 'run', lambda args, **kw: subprocess.CompletedProcess(args, 0, stdout=names))
    with pytest.raises(AssertionError):
        stack['computer_container']('00000000-0000-0000-0000-000000000001')


def test_stdio_worker_request_uses_selected_agent_when_host_has_no_credential(monkeypatch):
    stack = isolated(monkeypatch)
    monkeypatch.delenv('WORKER_TOKEN', raising=False)
    calls = []
    def fake(args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, stdout='[200, {"tools": []}]')
    monkeypatch.setattr(subprocess, 'run', fake)
    assert stack['worker_request']('GET', '/internal/bots/test/plugin-tools') == (200, {'tools': []})
    args, kwargs = calls[0]
    assert args[:6] == ['sudo', 'docker', 'exec', '-i', 'v04m-agent-1', 'python3']
    assert "os.environ['WORKER_TOKEN']" in args[-1]
    assert 'dev-worker-token' not in args[-1]
    assert json.loads(kwargs['input']) == ['GET', '/internal/bots/test/plugin-tools', None]


def test_worker_request_uses_explicit_bearer_without_owner_cookie(monkeypatch):
    stack = isolated(monkeypatch)
    monkeypatch.setenv('WORKER_TOKEN', 'unit-test-credential')
    import urllib.request
    calls = []
    class Reply(io.BytesIO):
        status = 200
    def fake(request, **kwargs):
        calls.append(request)
        return Reply(b'{"tools": []}')
    monkeypatch.setattr(urllib.request, 'urlopen', fake)
    assert stack['worker_request']('GET', '/internal/bots/test/plugin-tools')[0] == 200
    assert calls[0].full_url == 'http://localhost:58081/internal/bots/test/plugin-tools'
    assert calls[0].get_header('Authorization') == 'Bearer unit-test-credential'
    assert calls[0].get_header('Cookie') is None


@pytest.mark.parametrize('state,ready', [({'ready': False}, False), ({'ready': True, 'chrome': False}, False),
    ({'ready': True, 'chrome': True}, True)])
def test_recovery_probe_requires_desktop_and_browser_without_changing_lease(monkeypatch, state, ready):
    source = (ROOT / 'src/Compute.Docker/ComputerReadiness.cs').read_text()
    script = source.split('ProbeScript = """', 1)[1].split('""";', 1)[0]
    import textwrap
    import urllib.request
    monkeypatch.setenv('COMPUTER_ID', '00000000-0000-0000-0000-000000000001')
    monkeypatch.setenv('COMPUTER_TOKEN', 'unit-test-credential')
    monkeypatch.setattr('os.path.isdir', lambda path: True)
    requests = []
    def fake(request, **kwargs):
        requests.append(request)
        if isinstance(request, str) and request.endswith('/json/version'):
            return io.BytesIO(json.dumps({'webSocketDebuggerUrl': 'ws://127.0.0.1:9222/devtools/browser/x'}).encode())
        return io.BytesIO(json.dumps(state).encode())
    monkeypatch.setattr(urllib.request, 'urlopen', fake)
    if ready:
        exec(textwrap.dedent(script))
    else:
        with pytest.raises(AssertionError): exec(textwrap.dedent(script))
    body = json.loads(requests[0].data)
    assert body['botId'] == '00000000-0000-0000-0000-000000000001' and body['chrome'] is True
    assert 'epoch' not in body and 'holder' not in body
    assert requests[0].full_url.endswith('/desktops')
