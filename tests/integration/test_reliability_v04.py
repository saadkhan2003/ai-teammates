"""Live mock-stack regressions. No Docker CLI or paid provider requests."""
import time
import uuid

from test_acceptance import Client, OPENROUTER, login, submit, wait_task, worker_call


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


def test_key_save_and_rotation_resume_waiters_and_publish_safe_status():
    username = 'reliability-' + uuid.uuid4().hex[:12]
    password = 'unit-stack-password-123'
    worker_call('POST', '/internal/test/users', {'username': username, 'password': password})
    client = Client()
    assert client.call('POST', '/api/auth/login', {'username':username,'password':password})[0] == 200
    status, bot = client.call('POST', '/api/bots', {'name':'Reliability', 'role':'test'})
    assert status == 200, bot
    bot_id = bot['id']
    try:
        status, workspace = client.call('GET', f'/api/bots/{bot_id}/workspace')
        assert status == 200
        conversation = workspace['conversationId']
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
        client.call('DELETE', f'/api/bots/{bot_id}')


def test_browser_origin_requires_allow_once_on_each_run():
    client = login()
    # Only the local mock provider is used by this integration suite.
    assert client.call('POST','/api/secrets',{'namespace':'openrouter','name':'default','type':'API_KEY','value':OPENROUTER})[0] == 200
    status, bot = client.call('POST','/api/bots',{'name':'Origin consent','role':'test'})
    assert status == 200
    bot_id = bot['id']
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
        client.call('DELETE',f'/api/bots/{bot_id}')


def test_failure_has_safe_code_text_and_log():
    client = login()
    assert client.call('POST','/api/secrets',{'namespace':'openrouter','name':'default','type':'API_KEY','value':OPENROUTER})[0] == 200
    status, bot = client.call('POST','/api/bots',{'name':'Error surface','role':'test'})
    assert status == 200
    bot_id = bot['id']
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
        client.call('DELETE',f'/api/bots/{bot_id}')
