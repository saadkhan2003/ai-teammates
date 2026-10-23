import asyncio
import importlib.util
import io
import json
from pathlib import Path
import sys
import contextlib
import httpx
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services/agent'))
from workspace_shell import prepare_command
from retry import send_with_retry


def test_workspace_mapping_and_boundaries(tmp_path):
    assert prepare_command('cat /workspace/a /workspace/b', tmp_path) == f'cat {tmp_path}/a {tmp_path}/b'
    assert prepare_command('echo /workspace-other', tmp_path) == 'echo /workspace-other'
    assert prepare_command('cd /workspace; pwd', tmp_path) == f'cd {tmp_path}; pwd'


@pytest.mark.parametrize('command', ['cat /workspace/../other/a', 'cat ../a', 'cat /workspace/a/../../a', 'cat x/../a'])
def test_traversal_refused(tmp_path, command):
    with pytest.raises(PermissionError):
        prepare_command(command, tmp_path)


def test_symlink_escape_refused(tmp_path):
    root = tmp_path / 'bot'
    root.mkdir()
    (root / 'link').symlink_to(tmp_path)
    for command in ['cat /workspace/link/file', 'cat link/file', 'cat link']:
        with pytest.raises(PermissionError):
            prepare_command(command, root)


@pytest.mark.parametrize('safe,expected', [(True,4), (False,1)])
def test_side_effect_retry_needs_trusted_idempotency(safe, expected):
    async def run():
        calls, sleeps = [], []
        async def pause(delay): sleeps.append(delay)
        def handler(request):
            calls.append(request)
            return httpx.Response(503, headers={'X-Idempotency-Safe': 'true'} if safe else {})
        async with httpx.AsyncClient(base_url='http://api', transport=httpx.MockTransport(handler)) as client:
            await send_with_retry(client, 'POST', '/internal/tools/execute', {'tool':'plugin_checkout', 'idempotencyKey':'stable-key'}, sleep=pause)
        assert len(calls) == expected
        assert sleeps == ([0.5,1,2] if safe else [])
        assert all(json.loads(c.content)['idempotencyKey'] == 'stable-key' for c in calls)
    asyncio.run(run())


@pytest.mark.parametrize('status', [400,401,403,409,422])
def test_permanent_errors_never_retry(status):
    async def run():
        calls = []
        def handler(request):
            calls.append(request)
            return httpx.Response(status, headers={'X-Idempotency-Safe':'true'})
        async with httpx.AsyncClient(base_url='http://api', transport=httpx.MockTransport(handler)) as client:
            await send_with_retry(client, 'POST', '/internal/tools/execute', {'idempotencyKey':'key'})
        assert len(calls) == 1
    asyncio.run(run())


def test_seed_does_not_leak_and_only_seeds_once():
    spec = importlib.util.spec_from_file_location('seed', Path(__file__).resolve().parents[2] / 'scripts/seed-openrouter.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fake_key = 'fake-canary-value-for-installer'
    class Reply:
        def __init__(self, body): self.body = body
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self): return json.dumps(self.body).encode()
    class Fake:
        def __init__(self): self.saved = []
        def open(self, request, **kwargs):
            if request.full_url.endswith('/llm-status'): return Reply({'hasKey':bool(self.saved)})
            if request.full_url.endswith('/secrets'):
                if request.get_method() == 'GET': return Reply(self.saved)
                self.saved.append(json.loads(request.data))
            return Reply({})
    fake = Fake()
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        for _ in range(2):
            assert module.seed({'OPENROUTER_API_KEY':fake_key}, opener=fake, credentials=lambda _:('owner','fake-password')) == 0
    assert len(fake.saved) == 1 and fake.saved[0]['value'] == fake_key
    assert fake_key not in output.getvalue() and 'fake-password' not in output.getvalue()


def test_checkout_retries_acknowledged_transient_results_then_stops_on_success():
    async def run():
        calls, sleeps = [], []
        async def pause(delay): sleeps.append(delay)
        def handler(request):
            calls.append(json.loads(request.content))
            return httpx.Response(200, json={'ok':True, 'output':{'status':503 if len(calls)<3 else 200, 'retrySafe':True}})
        async with httpx.AsyncClient(base_url='http://api', transport=httpx.MockTransport(handler)) as client:
            response = await send_with_retry(client,'POST','/internal/tools/execute',{'tool':'plugin_checkout','idempotencyKey':'same-key'}, sleep=pause)
        assert response.json()['output']['status'] == 200
        assert len(calls) == 3 and sleeps == [0.5,1]
        assert {c['idempotencyKey'] for c in calls} == {'same-key'}
    asyncio.run(run())


def test_ambiguous_purchase_timeout_never_retries():
    async def run():
        calls = []
        def handler(request):
            calls.append(request)
            raise httpx.ReadTimeout('ambiguous', request=request)
        async with httpx.AsyncClient(base_url='http://api', transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(httpx.ReadTimeout):
                await send_with_retry(client,'POST','/internal/tools/execute',{'tool':'plugin_checkout','idempotencyKey':'same-key'})
        assert len(calls) == 1
    asyncio.run(run())
