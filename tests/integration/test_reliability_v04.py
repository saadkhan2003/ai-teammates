"""Live mock-stack regressions. No Docker CLI or paid provider requests."""
import time
import uuid

from test_acceptance import Client, OPENROUTER, _psql, login, submit, wait_task, worker_call
from test_bot_messaging import _cleanup


def until(client, bot, task, state, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status, tasks = client.call('GET', f'/api/bots/{bot}/tasks')
        assert status == 200
        row = next(t for t in tasks if t['id'] == task)
        if row['status'] == state:
            return row
        time.sleep(0.25)
    raise AssertionError(f'task did not reach {state}: {row}')


def test_key_save_and_rotation_resume_waiters_and_publish_safe_status(bot_factory):
    username = 'reliability-' + uuid.uuid4().hex[:12]
    password = 'unit-stack-password-123'
    worker_call('POST', '/internal/test/users', {'username': username, 'password': password})
    client = Client()
    assert client.call('POST', '/api/auth/login', {'username':username,'password':password})[0] == 200
    bot_id = bot_factory(client, 'Reliability')
    try:
        status, workspace = client.call('GET', f'/api/bots/{bot_id}/workspace')
        assert status == 200
        conversation = workspace['conversationId']
        # An admin-managed provider (AI models page) carries its own key, so users need none;
        # the missing-key wait only applies while the stack runs on env bootstrap.
        status, ai = login().call('GET', '/api/admin/ai')
        assert status == 200
        if not ai['bootstrap']:
            task = submit(client, conversation, 'What should I call you?')
            assert wait_task(client, bot_id, task)['status'] == 'completed'
            return
        task = submit(client, conversation, 'What should I call you?')
        row = until(client, bot_id, task, 'waiting_resource')
        assert row['errorCode'] == 'no_openrouter_key'
        assert 'Settings > Vault' in row['error']
        status, metadata = client.call('POST', '/api/secrets', {'namespace':'openrouter','name':'default','type':'API_KEY','value':OPENROUTER})
        assert status == 200
        secret_id = metadata['id']
        assert client.call('POST', f'/api/secrets/{secret_id}/rotate', {'value':OPENROUTER})[0] == 200
        done = wait_task(client, bot_id, task)
        assert done['status'] == 'completed', done
        status, info = client.call('GET', '/api/system/llm-status')
        assert status == 200 and info['hasKey'] is True and info['secretId'] == secret_id
        assert 'value' not in info
        status, events = client.call('GET', f'/api/tasks/{task}/log')
        assert status == 200 and any(e['type']=='resource_resumed' for e in events)
        assert any(e['type']=='grounding' for e in events)
    finally:
        _cleanup(client, bot_id)


def test_browser_origin_requires_allow_once_on_each_run(bot_factory):
    client = login()
    # Only the local mock provider is used by this integration suite.
    assert client.call('POST','/api/secrets',{'namespace':'openrouter','name':'default','type':'API_KEY','value':OPENROUTER})[0] == 200
    bot_id = bot_factory(client, 'Origin consent')
    try:
        _, workspace = client.call('GET',f'/api/bots/{bot_id}/workspace')
        for _ in range(2):
            task = submit(client,workspace['conversationId'],'Open http://portal.example.edu:8099/alpha.html and extract the h1')
            until(client,bot_id,task,'waiting_approval')
            _, state = client.call('GET',f'/api/bots/{bot_id}/workspace')
            approval = next(a for a in state['approvals'] if a['action']=='browser_open')
            assert client.call('POST',f"/api/approvals/{approval['id']}/decide",{'decision':'allow_once'})[0] == 200
            assert wait_task(client,bot_id,task)['status'] == 'completed'
    finally:
        _cleanup(client, bot_id)


def test_failure_has_safe_code_text_and_log(bot_factory):
    client = login()
    assert client.call('POST','/api/secrets',{'namespace':'openrouter','name':'default','type':'API_KEY','value':OPENROUTER})[0] == 200
    bot_id = bot_factory(client, 'Error surface')
    try:
        _, workspace = client.call('GET',f'/api/bots/{bot_id}/workspace')
        task = submit(client, workspace['conversationId'], 'Unrecognized mock planner request quux 1902')
        done = wait_task(client,bot_id,task)
        assert done['status'] == 'failed', done
        assert done['errorCode'] and done['error']
        assert 'Traceback' not in done['error'] and 'Exception' not in done['error']
        status, events = client.call('GET',f'/api/tasks/{task}/log')
        assert status == 200 and any(e['type']=='error' for e in events)
    finally:
        _cleanup(client, bot_id)


def test_unused_computer_stop_requires_owner_session_and_refuses_live_bots(bot_factory):
    client = login()
    bot_factory(client, 'Computer stop guard')
    status, before = client.call('GET', '/api/computer')
    assert status == 200
    assert Client().call('POST', '/api/computer/stop', {})[0] == 401
    status, body = client.call('POST', '/api/computer/stop', {})
    assert status == 409 and body['error'] == 'computer_in_use'
    status, computer = client.call('GET', '/api/computer')
    assert status == 200 and computer['status'] == before['status']
    assert computer['computerId'] == before['computerId']


def test_desktop_reconciliation_does_not_wake_a_stopped_unused_computer(bot_factory):
    active = login()
    bot_factory(active, 'Active reconciliation sentinel')
    status, active_computer = active.call('GET', '/api/computer')
    assert status == 200
    active_id = str(uuid.UUID(active_computer['computerId']))

    username = 'stop-regression-' + uuid.uuid4().hex[:12]
    password = 'unit-stack-password-123'
    worker_call('POST', '/internal/test/users', {'username': username, 'password': password})
    client = Client()
    assert client.call('POST', '/api/auth/login', {'username': username, 'password': password})[0] == 200
    bot = bot_factory(client, 'Unused reconciliation regression')
    _cleanup(client, bot)
    status, stopped = client.call('GET', '/api/computer')
    assert status == 200 and stopped['status'] == 'stopped'
    stopped_id = str(uuid.UUID(stopped['computerId']))
    stopped_lease = _psql(f"SELECT updated_at::text FROM desktop_lease WHERE computer_id='{stopped_id}' AND display=1")

    # Observe real housekeeping passes through the active desktop, instead of
    # assuming a sleep was long enough for reconciliation to run.
    previous = _psql(f"SELECT updated_at::text FROM desktop_lease WHERE computer_id='{active_id}' AND display=1")
    passes = 0
    deadline = time.monotonic() + 30
    while passes < 2 and time.monotonic() < deadline:
        current = _psql(f"SELECT updated_at::text FROM desktop_lease WHERE computer_id='{active_id}' AND display=1")
        if current != previous:
            passes += 1
            previous = current
        status, computer = client.call('GET', '/api/computer')
        assert status == 200 and computer['status'] == 'stopped', computer
        assert _psql(f"SELECT updated_at::text FROM desktop_lease WHERE computer_id='{stopped_id}' AND display=1") == stopped_lease
        time.sleep(0.25)
    assert passes >= 2, 'desktop reconciliation did not run twice'
