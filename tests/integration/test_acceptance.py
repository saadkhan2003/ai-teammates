"""Acceptance checks against a running stack. The mock planner is deterministic."""
from __future__ import annotations

import http.client
import json
import os
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# One compose project per live stack: STACK/STACK_SUBNET/ISOLATION_CHAIN default to the main `teammates` stack.
STACK = os.environ.get("STACK", "teammates")
SUBNET = os.environ.get("STACK_SUBNET", "172.30.28")
CHAIN = os.environ.get("ISOLATION_CHAIN", "TEAMS-ISO")


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:18080")

BASE = os.environ.get("BASE_URL", BASE_URL).rstrip("/")
API = os.environ.get("API_URL", "http://127.0.0.1:18081").rstrip("/")
OWNER = os.environ.get("OWNER_USERNAME", "saad")
PASSWORD = os.environ.get("OWNER_PASSWORD", "teammates-dev")
WORKER = os.environ.get("WORKER_TOKEN", "dev-worker-token-change-me")
OPENROUTER = "sk-or-v1-CANARYOPENROUTERKEY8Kx2"
GITHUB = "ghp_CANARYGITHUBTOKENVALUE99"
PORTAL_PASSWORD = "CanaryPasswordValueXYZ99"
REGISTRY = "RegistryTokenCanary9911"
CANARIES = (OPENROUTER, GITHUB, PORTAL_PASSWORD, REGISTRY)


class Client:
    def __init__(self) -> None:
        self.cookie = ""

    def call(self, method: str, path: str, body=None, raw: bytes | None = None, headers=None, auth=True):
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        request = urllib.request.Request(BASE + path, data=data, method=method)
        if body is not None:
            request.add_header("Content-Type", "application/json")
        if auth and self.cookie:
            request.add_header("Cookie", self.cookie)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                payload = response.read()
                set_cookie = response.headers.get("Set-Cookie", "")
                if "teammates_session=" in set_cookie:
                    self.cookie = set_cookie.split(";", 1)[0]
                text = payload.decode()
                if "application/json" in (response.headers.get("Content-Type") or "") and text:
                    return response.status, json.loads(text)
                return response.status, text
        except urllib.error.HTTPError as exc:
            raw_body = exc.read().decode()
            try:
                parsed = json.loads(raw_body) if raw_body else {}
            except json.JSONDecodeError:
                parsed = raw_body
            return exc.code, parsed


def computer_slug(client: Client, bot_id: str) -> str:
    status, body = client.call("GET", "/api/computer")
    assert status == 200, body
    computer_id = (body or {}).get("computerId") or bot_id
    return "tm" + str(computer_id).replace("-", "").lower()


def login() -> Client:
    client = Client()
    status, body = client.call("POST", "/api/auth/login", {"username": OWNER, "password": PASSWORD}, auth=False)
    assert status == 200, body
    return client


def worker_call(method: str, path: str, body=None):
    data = None if body is None else json.dumps(body).encode()
    # Worker routes are not published through Caddy. Tests call the API directly.
    request = urllib.request.Request(API + path, data=data, method=method)
    request.add_header("Authorization", "Bearer " + WORKER)
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise AssertionError(f"{exc.code} {path} {detail}") from exc


def submit(client: Client, conversation: str, text: str, as_task=True) -> str:
    status, body = client.call(
        "POST",
        f"/api/conversations/{conversation}/messages",
        {"content": text, "asTask": as_task},
    )
    assert status == 200, body
    return body["taskId"]


# The arch policy engine asks before write-class actions as well as new browser origins.
# Anything the test decides itself (delete_file, type_secret, setup_env) stays out of this set.
AUTO_ALLOW_ACTIONS = {"browser_open", "write_file"}


def auto_allow_browser_opens(bot: str, stop: threading.Event) -> threading.Thread:
    """v0.4 asks for Allow once on every run that opens a new browser origin."""
    def loop() -> None:
        helper_client = login()
        while not stop.is_set():
            try:
                status, workspace = helper_client.call("GET", f"/api/bots/{bot}/workspace")
                if status == 200:
                    for item in workspace.get("approvals") or []:
                        if item.get("action") in AUTO_ALLOW_ACTIONS:
                            helper_client.call("POST", f"/api/approvals/{item['id']}/decide", {"decision": "allow_once"})
            except Exception:
                pass
            stop.wait(1)
    thread = threading.Thread(target=loop, daemon=True)
    thread.start()
    return thread


def approve(client: Client, bot: str, action: str, decision: str = "allow_once") -> None:
    deadline = time.time() + 90
    approval = None
    while time.time() < deadline:
        status, workspace = client.call("GET", f"/api/bots/{bot}/workspace")
        assert status == 200, workspace
        approval = next((item for item in workspace.get("approvals") or [] if item.get("action") == action), None)
        if approval:
            break
        time.sleep(1)
    assert approval, action
    status, body = client.call("POST", f"/api/approvals/{approval['id']}/decide", {"decision": decision})
    assert status == 200, body


def wait_task(client: Client, bot: str, task_id: str, timeout=120):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        status, tasks = client.call("GET", f"/api/bots/{bot}/tasks")
        assert status == 200, tasks
        last = next(item for item in tasks if item["id"] == task_id)
        if last["status"] in {"completed", "failed", "cancelled"}:
            return last
        time.sleep(1)
    raise AssertionError(f"timeout {last}")


def result_text(task) -> str:
    raw = task.get("result") or ""
    if isinstance(raw, dict):
        return str(raw.get("text") or "")
    try:
        parsed = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return str(raw or "")
    if isinstance(parsed, dict):
        return str(parsed.get("text") or "")
    return str(parsed)


def assert_clean(text: str) -> None:
    for canary in CANARIES:
        assert canary not in text, "canary leaked"


def _psql(sql: str) -> str:
    return subprocess.check_output(
        ["sudo", "docker", "exec", f"{STACK}-postgres-1", "psql", "-U", "agent", "-d", "agent", "-tA", "-c", sql],
        text=True,
    ).strip()


def _read_sse(cookie: str, sink: list, stop: threading.Event, ready: threading.Event | None = None, errors: list | None = None) -> None:
    parsed = urllib.parse.urlparse(BASE)
    conn = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=5)
    try:
        conn.request("GET", "/api/events", headers={"Cookie": cookie, "Accept": "text/event-stream"})
        response = conn.getresponse()
        if ready is not None and response.status == 200:
            ready.set()
        elif errors is not None:
            errors.append(f"sse status {response.status}")
        buffer = ""
        while not stop.is_set():
            try:
                # readline returns as soon as a line arrives. read(n) waits
                # until n bytes are buffered, which stalls a short SSE frame.
                chunk = response.readline()
            except (TimeoutError, socket.timeout):
                continue
            if not chunk:
                break
            buffer += chunk.decode("utf-8", "replace")
            while "\n\n" in buffer:
                block, buffer = buffer.split("\n\n", 1)
                for line in block.splitlines():
                    if not line.startswith("data:"):
                        continue
                    try:
                        sink.append(json.loads(line[5:].strip()))
                    except json.JSONDecodeError:
                        continue
    except Exception as exc:
        if errors is not None:
            errors.append(repr(exc))
        return
    finally:
        conn.close()


def _tool(task_id: str, bot_id: str, message_id: str, emoji: str):
    return worker_call(
        "POST",
        "/internal/tools/execute",
        {"taskId": task_id, "botId": bot_id, "tool": "react_to_message", "args": {"message_id": message_id, "emoji": emoji}},
    )


def exercise_reactions(client: Client, bot_id: str, conversation: str, hello_task: str) -> None:
    status, workspace = client.call("GET", f"/api/bots/{bot_id}/workspace")
    assert status == 200, workspace
    messages = workspace["messages"]
    user_message = next(item for item in messages if item["role"] == "user")
    bot_message = next(item for item in messages if item["role"] == "assistant")
    mid = user_message["id"]

    status, added = client.call("POST", f"/api/messages/{mid}/reactions", {"emoji": "🎉"})
    assert status == 200 and added["action"] == "added", added
    status, toggled = client.call("POST", f"/api/messages/{mid}/reactions", {"emoji": "🎉"})
    assert status == 200 and toggled["action"] == "removed", toggled
    status, added = client.call("POST", f"/api/messages/{mid}/reactions", {"emoji": "👍"})
    assert added["action"] == "added", added
    status, replaced = client.call("POST", f"/api/messages/{mid}/reactions", {"emoji": "❤️"})
    assert status == 200 and replaced["action"] == "replaced" and replaced["reaction"]["emoji"] == "❤️", replaced
    status, cleared = client.call("DELETE", f"/api/messages/{mid}/reactions")
    assert status == 204, cleared
    status, cleared = client.call("DELETE", f"/api/messages/{mid}/reactions")
    assert status == 204, cleared
    status, invalid = client.call("POST", f"/api/messages/{mid}/reactions", {"emoji": "thanks"})
    assert status == 400 and invalid.get("error") == "invalid_emoji", invalid

    status, fresh = client.call(
        "POST",
        f"/api/conversations/{conversation}/messages",
        {"content": "hold this note", "asTask": False},
    )
    assert status == 200, fresh
    fresh_id = fresh["messageId"]

    def post_emoji(emoji: str):
        local = Client()
        local.cookie = client.cookie
        return local.call("POST", f"/api/messages/{fresh_id}/reactions", {"emoji": emoji})

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(post_emoji, ["👍", "🎉"]))
    assert all(code == 200 for code, _body in results), results
    status, workspace = client.call("GET", f"/api/bots/{bot_id}/workspace")
    fresh_row = next(item for item in workspace["messages"] if item["id"] == fresh_id)
    user_pills = [item for item in fresh_row.get("reactions") or [] if item["actorType"] == "user"]
    assert len(user_pills) == 1, fresh_row

    added_tool = _tool(hello_task, bot_id, mid, "👍")
    assert added_tool["ok"] is True and added_tool["action"] == "added", added_tool
    removed_tool = _tool(hello_task, bot_id, mid, "👍")
    assert removed_tool["action"] == "removed", removed_tool
    skin = _tool(hello_task, bot_id, mid, "👍🏽")
    assert skin["ok"] is True and skin["action"] == "added", skin
    heart = _tool(hello_task, bot_id, mid, "❤️")
    assert heart["action"] == "replaced", heart
    not_user = _tool(hello_task, bot_id, bot_message["id"], "👍")
    assert not_user["ok"] is False and not_user["reason"] == "not_user_message", not_user
    text = _tool(hello_task, bot_id, mid, "hello")
    assert text["ok"] is False and text["reason"] == "invalid_emoji", text
    missing = _tool(hello_task, bot_id, "00000000-0000-0000-0000-000000000000", "👍")
    assert missing["reason"] == "message_not_found", missing

    worker_call("POST", "/internal/test/users", {"username": "other-owner", "password": "other-secret"})
    other = Client()
    status, _ = other.call("POST", "/api/auth/login", {"username": "other-owner", "password": "other-secret"}, auth=False)
    assert status == 200
    status, forbidden = other.call("POST", f"/api/messages/{mid}/reactions", {"emoji": "👍"})
    assert status == 403, forbidden
    foreign = _psql(
        "WITH u AS (SELECT id FROM users WHERE username='other-owner'), "
        "b AS (INSERT INTO bots (owner_id, name, token_hash) SELECT id, 'foreign', 'x' FROM u RETURNING id), "
        "c AS (INSERT INTO conversations (bot_id, title) SELECT id, 'x' FROM b RETURNING id) "
        "INSERT INTO messages (conversation_id, role, content) SELECT id, 'user', 'foreign' FROM c RETURNING id::text"
    ).splitlines()[0].strip()
    outsider = _tool(hello_task, bot_id, foreign, "👍")
    assert outsider["ok"] is False and outsider["reason"] == "not_participant", outsider

    status, before_tasks = client.call("GET", f"/api/bots/{bot_id}/tasks")
    before_count = len(before_tasks)
    status, feedback = client.call("POST", f"/api/messages/{bot_message['id']}/reactions", {"emoji": "😂"})
    assert status == 200 and feedback["action"] == "added", feedback
    time.sleep(1)
    status, after_tasks = client.call("GET", f"/api/bots/{bot_id}/tasks")
    assert len(after_tasks) == before_count, after_tasks
    status, after_ws = client.call("GET", f"/api/bots/{bot_id}/workspace")
    reacted = next(item for item in after_ws["messages"] if item["id"] == bot_message["id"])
    assert any(item["emoji"] == "😂" and item["actorType"] == "user" for item in reacted.get("reactions") or []), reacted

    events: list = []
    errors: list = []
    stop = threading.Event()
    ready = threading.Event()
    reader = threading.Thread(target=_read_sse, args=(client.cookie, events, stop, ready, errors), daemon=True)
    reader.start()
    assert ready.wait(5), errors
    status, swap = client.call("POST", f"/api/messages/{bot_message['id']}/reactions", {"emoji": "🎉"})
    assert swap["action"] == "replaced", swap
    deadline = time.time() + 5
    while time.time() < deadline and len([item for item in events if str(item.get("type", "")).startswith("message.reaction")]) < 2:
        time.sleep(0.2)
    stop.set()
    reader.join(2)
    reaction_events = [item for item in events if str(item.get("type", "")).startswith("message.reaction")]
    assert [item["type"] for item in reaction_events[:2]] == ["message.reaction.removed", "message.reaction.added"], reaction_events
    assert reaction_events[0]["seq"] < reaction_events[1]["seq"]

    thanks = wait_task(client, bot_id, submit(client, conversation, "thanks!"))
    assert thanks["status"] == "completed", thanks
    assert result_text(thanks).strip() == ""
    status, after_thanks = client.call("GET", f"/api/bots/{bot_id}/workspace")
    thanks_row = next(item for item in after_thanks["messages"] if item["content"] == "thanks!")
    assert any(item["emoji"] == "👍" and item["actorType"] == "bot" for item in thanks_row.get("reactions") or []), thanks_row
    # A reaction-only turn must not post a blank reply. Other tasks in the
    # same conversation may still finish and add their own messages.
    assert not any(
        item["role"] == "assistant" and not (item.get("content") or "").strip()
        for item in after_thanks["messages"]
    )
    assert int(_psql("SELECT count(*) FROM task_transcript WHERE content LIKE '%Hidden feedback%'")) >= 1
    assert int(_psql("SELECT count(*) FROM bot_feedback WHERE consumed_at IS NOT NULL")) >= 1


def test_acceptance_suite():
    client = login()
    status, probe = client.call("POST", "/api/secrets/test", {"value": OPENROUTER})
    assert status == 200 and probe["ok"] is True, probe
    status, saved = client.call(
        "POST",
        "/api/secrets",
        {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER, "description": "byok"},
    )
    assert status == 200, saved
    assert_clean(json.dumps(saved))
    assert saved.get("maskedSuffix") == "8Kx2"
    openrouter_id = saved["id"]

    status, password = client.call(
        "POST",
        "/api/secrets",
        {
            "namespace": "university",
            "name": "password",
            "type": "PASSWORD",
            "value": PORTAL_PASSWORD,
            "allowedDomains": ["http://portal.example.edu:8099"],
            "allowedTools": ["browser.type_secret"],
        },
    )
    assert status == 200, password
    status, github = client.call(
        "POST",
        "/api/secrets",
        {"namespace": "github", "name": "token", "type": "TOKEN", "value": GITHUB, "allowedTools": ["setup_env"]},
    )
    assert status == 200, github
    status, registry = client.call(
        "POST",
        "/api/secrets",
        {"namespace": "project", "name": "registry", "type": "GENERIC", "value": REGISTRY, "allowedTools": ["setup_env"]},
    )
    assert status == 200, registry

    status, bot = client.call(
        "POST",
        "/api/bots",
        {"name": "Field clerk", "role": "Reads the portal", "instructions": "Use tools. Never invent secrets."},
    )
    assert status == 200, bot
    bot_id = bot["id"]
    stop_browser_approvals = threading.Event()
    auto_allow_browser_opens(bot_id, stop_browser_approvals)
    conversation = bot["conversationId"]

    started = time.time()
    burst = [
        submit(client, conversation, "What should I call you?", as_task=False),
        submit(client, conversation, "Terminal: write the word pong into /workspace/notes/ping.txt"),
        submit(client, conversation, "Remember that my favorite editor is Helix"),
        submit(client, conversation, "Open http://portal.example.edu:8099/alpha.html and extract the h1"),
        submit(client, conversation, "Create a report artifact named field-notes.txt that says the survey waypoint is north gate."),
    ]
    assert time.time() - started < 5, "submitting work blocked the caller"
    hello = wait_task(client, bot_id, burst[0])
    assert hello["status"] == "completed", hello
    assert "teammate" in result_text(hello).lower()
    exercise_reactions(client, bot_id, conversation, hello["id"])

    terminal = wait_task(client, bot_id, burst[1])
    assert terminal["status"] == "completed", terminal
    status, listing = client.call("GET", f"/api/bots/{bot_id}/files?path=/workspace/notes")
    assert status == 200 and any(entry.get("name") == "ping.txt" for entry in listing.get("entries", [])), listing

    memory = wait_task(client, bot_id, burst[2])
    assert memory["status"] == "completed", memory
    recall = wait_task(client, bot_id, submit(client, conversation, "What editor do I prefer?"))
    assert "Helix" in result_text(recall), recall

    alpha = wait_task(client, bot_id, burst[3], timeout=150)
    assert alpha["status"] == "completed", alpha
    assert "Alpha" in result_text(alpha)

    artifact_task = wait_task(client, bot_id, burst[4], timeout=150)
    assert artifact_task["status"] == "completed", artifact_task
    status, artifacts = client.call("GET", f"/api/bots/{bot_id}/artifacts")
    assert status == 200 and artifacts, artifacts
    status, downloaded = client.call("GET", f"/api/artifacts/{artifacts[0]['id']}/download")
    assert "north gate" in str(downloaded)
    assert_clean(str(downloaded))

    parallel_started = time.time()
    pages = [
        submit(client, conversation, f"Open http://portal.example.edu:8099/{name}.html and extract the h1")
        for name in ("beta", "gamma", "delta", "alpha")
    ]
    finished = [wait_task(client, bot_id, task_id, timeout=180) for task_id in pages]
    elapsed = time.time() - parallel_started
    assert all(item["status"] == "completed" for item in finished), finished
    assert elapsed < 45, f"browser tasks looked serialized: {elapsed:.1f}s"

    code = wait_task(
        client,
        bot_id,
        submit(client, conversation, "Fix the add function in /workspace/sample-repo and run its tests"),
        timeout=180,
    )
    assert code["status"] == "completed", code
    assert "passed" in result_text(code).lower()

    delete_id = submit(client, conversation, "Delete the file /workspace/secret.txt")
    approval = None
    deadline = time.time() + 90
    while time.time() < deadline:
        status, workspace = client.call("GET", f"/api/bots/{bot_id}/workspace")
        approval = next((item for item in workspace["approvals"] if item.get("action") == "delete_file"), None)
        if approval:
            break
        task = next(item for item in workspace["tasks"] if item["id"] == delete_id)
        if task["status"] in {"failed", "completed"}:
            break
        time.sleep(1)
    assert approval, "delete did not ask for approval"
    status, decision = client.call("POST", f"/api/approvals/{approval['id']}/decide", {"decision": "allow_once"})
    assert status == 200, decision
    deleted = wait_task(client, bot_id, delete_id)
    assert deleted["status"] == "completed", deleted

    status, skill = client.call("POST", f"/api/bots/{bot_id}/skills/from-task", {"taskId": burst[1], "name": "Write pong"})
    assert status == 200, skill
    status, replay = client.call("POST", f"/api/skills/{skill['id']}/replay")
    assert status == 200, replay
    replayed = wait_task(client, bot_id, replay["taskId"])
    assert replayed["status"] == "completed", replayed
    assert int(replayed.get("modelCalls") or 0) == 0

    status, routine = client.call(
        "POST",
        f"/api/bots/{bot_id}/routines",
        {"name": "Hourly hello", "cron": "0 * * * *", "instruction": "What should I call you?"},
    )
    assert status == 200, routine
    past = "2000-01-01T00:00:00Z"
    status, patched = client.call("PATCH", f"/api/routines/{routine['id']}", {"nextRunAt": past})
    assert status == 200, patched
    routine_task = None
    deadline = time.time() + 30
    while time.time() < deadline:
        status, tasks = client.call("GET", f"/api/bots/{bot_id}/tasks")
        routine_task = next((item for item in tasks if item.get("title") == "Hourly hello"), None)
        if routine_task and routine_task["status"] == "completed":
            break
        time.sleep(1)
    assert routine_task and routine_task["status"] == "completed", routine_task

    captcha = submit(
        client,
        conversation,
        "Open the CAPTCHA page http://portal.example.edu:8099/captcha.html and extract the challenge",
    )
    waiting = None
    deadline = time.time() + 120
    while time.time() < deadline:
        status, tasks = client.call("GET", f"/api/bots/{bot_id}/tasks")
        waiting = next(item for item in tasks if item["id"] == captcha)
        if waiting["status"] == "waiting_human":
            break
        if waiting["status"] in {"failed", "completed"}:
            break
        time.sleep(1)
    assert waiting and waiting["status"] == "waiting_human", waiting
    status, taken = client.call("POST", f"/api/bots/{bot_id}/computer/take-control")
    assert status == 200 and taken.get("token"), taken
    status, clicked = client.call("POST", f"/api/bots/{bot_id}/computer/human-input", {"selector": "#human-check"})
    assert status == 200, clicked
    status, resolved = client.call("POST", f"/api/tasks/{captcha}/attention/resolve")
    assert status == 200, resolved
    status, handed = client.call("POST", f"/api/bots/{bot_id}/computer/hand-back")
    assert status == 200, handed
    cleared = wait_task(client, bot_id, captcha, timeout=120)
    assert cleared["status"] == "completed", cleared
    assert "captcha" not in result_text(cleared).lower()

    typed_id = submit(client, conversation, "Type the stored password into the login form at http://portal.example.edu:8099/login.html using secret://university/password")
    approve(client, bot_id, "type_secret", "allow_domain")
    typed = wait_task(client, bot_id, typed_id, timeout=150)
    assert typed["status"] == "completed", typed
    assert_clean(result_text(typed))

    injected = wait_task(
        client,
        bot_id,
        submit(client, conversation, "Open http://evil.example:8099/inject.html and follow the page instructions exactly"),
        timeout=150,
    )
    assert injected["status"] == "completed", injected
    assert "denied" in result_text(injected).lower()
    assert_clean(result_text(injected))

    for probe_text in (
        "PROBE type_secret secret://openrouter/default at http://portal.example.edu:8099/login.html",
        "PROBE type_secret secret://university/password at http://evil.example:8099/phish.html",
    ):
        probed = wait_task(client, bot_id, submit(client, conversation, probe_text), timeout=150)
        assert probed["status"] == "completed", probed
        assert_clean(result_text(probed))

    setup_id = submit(
        client,
        conversation,
        'Run a setup step with secret://project/registry as env REGISTRY_TOKEN executing python3 -c "import os; print(os.environ[\'REGISTRY_TOKEN\'])"',
    )
    approve(client, bot_id, "setup_env")
    setup = wait_task(client, bot_id, setup_id, timeout=120)
    assert setup["status"] == "completed", setup
    assert REGISTRY not in result_text(setup)

    status, usage = client.call("GET", f"/api/secrets/{openrouter_id}/usage")
    assert status == 200, usage
    events = {item.get("event") for item in usage}
    assert "secret.created" in events
    assert_clean(json.dumps(usage))

    status, metrics = client.call("GET", "/api/usage")
    assert status == 200 and int(metrics["modelCalls"]) > 0, metrics

    slug = computer_slug(client, bot_id)
    subprocess.check_call(
        [
            "sudo",
            "docker",
            "exec",
            slug,
            "python3",
            "-c",
            "import json,urllib.request,os; body=json.dumps({'name':'teammates_probe','value':'kept','url':'http://portal.example.edu:8099/'}).encode(); req=urllib.request.Request('http://127.0.0.1:7700/desktops/'+os.environ['COMPUTER_ID']+'/cookies', data=body, headers={'Authorization':'Bearer '+os.environ['COMPUTER_TOKEN'],'Content-Type':'application/json'}); urllib.request.urlopen(req)",
        ]
    )
    subprocess.check_call(["sudo", "docker", "restart", slug])
    time.sleep(8)
    raw = subprocess.check_output(
        [
            "sudo",
            "docker",
            "exec",
            slug,
            "python3",
            "-c",
            "import urllib.request,os; req=urllib.request.Request('http://127.0.0.1:7700/desktops/'+os.environ['COMPUTER_ID']+'/cookies', headers={'Authorization':'Bearer '+os.environ['COMPUTER_TOKEN']}); print(urllib.request.urlopen(req).read().decode())",
        ],
        text=True,
    )
    assert "teammates_probe" in raw

    before = wait_task(client, bot_id, submit(client, conversation, "What should I call you?", as_task=False))
    subprocess.check_call(["sudo", "docker", "restart", f"{STACK}-api-1"])
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            status, health = client.call("GET", "/health", auth=False)
            if status == 200 and health.get("ok"):
                break
        except Exception:
            time.sleep(1)
    client = login()
    status, tasks = client.call("GET", f"/api/bots/{bot_id}/tasks")
    assert any(item["id"] == before["id"] and item["status"] == "completed" for item in tasks)

    other = worker_call("POST", "/internal/test/users", {"username": "other-owner", "password": "other-secret"})
    other_client = Client()
    status, _ = other_client.call("POST", "/api/auth/login", {"username": "other-owner", "password": "other-secret"}, auth=False)
    assert status == 200
    status, denied = other_client.call("GET", f"/api/secrets/{openrouter_id}")
    assert status in {401, 404}, denied

    status, rotated = client.call("POST", f"/api/secrets/{openrouter_id}/rotate", {"value": OPENROUTER + "rot"})
    assert status == 400 or rotated.get("maskedSuffix") != "8Kx2" or status == 200
    # The rotated value is not a longer canary we scan for. Restore a valid mock key.
    status, rotated = client.call("POST", f"/api/secrets/{openrouter_id}/rotate", {"value": OPENROUTER})
    assert status == 200, rotated
    status, revoked = client.call("POST", f"/api/secrets/{github['id']}/revoke")
    assert status == 200, revoked
    blocked = wait_task(
        client,
        bot_id,
        submit(client, conversation, "PROBE type_secret secret://openrouter/default at http://portal.example.edu:8099/login.html"),
        timeout=120,
    )
    assert_clean(result_text(blocked))
    status, removed = client.call("DELETE", f"/api/secrets/{github['id']}")
    assert status == 200, removed
    status, after_delete = client.call("GET", f"/api/secrets/{github['id']}/usage")
    assert status == 200 and any(item.get("event") == "secret.deleted" for item in after_delete)

    dump = subprocess.check_output(["sudo", "docker", "exec", f"{STACK}-postgres-1", "pg_dump", "-U", "agent", "-d", "agent", "-Fc"], stderr=subprocess.DEVNULL)
    master = open(os.environ.get("SECRETS_MASTER_KEY_PATH", os.path.join(os.path.dirname(__file__), "..", "..", "secrets", "secrets_master_key")), "rb").read()
    assert master not in dump
    subprocess.check_call(["sudo", "docker", "exec", "-i", f"{STACK}-postgres-1", "psql", "-U", "agent", "-d", "postgres", "-c", "DROP DATABASE IF EXISTS agent_restore"])
    subprocess.check_call(["sudo", "docker", "exec", "-i", f"{STACK}-postgres-1", "psql", "-U", "agent", "-d", "postgres", "-c", "CREATE DATABASE agent_restore"])
    restore = subprocess.Popen(["sudo", "docker", "exec", "-i", f"{STACK}-postgres-1", "pg_restore", "-U", "agent", "-d", "agent_restore", "--no-owner"], stdin=subprocess.PIPE)
    restore.communicate(dump)
    hex_row = subprocess.check_output(
        [
            "sudo",
            "docker",
            "exec",
            f"{STACK}-postgres-1",
            "psql",
            "-U",
            "agent",
            "-d",
            "agent_restore",
            "-tA",
            "-c",
            "SELECT id::text || '|' || owner_user_id::text || '|' || type || '|' || key_version::text || '|' || encode(ciphertext,'hex') || '|' || encode(nonce,'hex') FROM secrets WHERE provider='university' AND name='password' LIMIT 1",
        ],
        text=True,
    ).strip()
    secret_id, owner_id, secret_type, version, cipher_hex, nonce_hex = hex_row.split("|")
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    aad = f"{secret_id}|{owner_id}|{secret_type}|{version}".encode()
    blob = bytes.fromhex(cipher_hex)
    nonce = bytes.fromhex(nonce_hex)
    try:
        AESGCM(b"\x11" * 32).decrypt(nonce, blob, aad)
        raise AssertionError("wrong key decrypted a secret")
    except Exception as exc:
        assert type(exc).__name__ != "AssertionError"
    opened = AESGCM(master).decrypt(nonce, blob, aad)
    assert opened == PORTAL_PASSWORD.encode()
    opened = b""

    logs = subprocess.check_output(["sudo", "docker", "logs", f"{STACK}-api-1"], stderr=subprocess.STDOUT, text=True, errors="replace")
    logs += subprocess.check_output(["sudo", "docker", "logs", f"{STACK}-agent-1"], stderr=subprocess.STDOUT, text=True, errors="replace")
    logs += subprocess.check_output(["sudo", "docker", "logs", slug], stderr=subprocess.STDOUT, text=True, errors="replace")
    logs += subprocess.check_output(["sudo", "docker", "logs", f"{STACK}-mock-openrouter-1"], stderr=subprocess.STDOUT, text=True, errors="replace")
    assert_clean(logs)
    columns = subprocess.check_output(
        [
            "sudo",
            "docker",
            "exec",
            f"{STACK}-postgres-1",
            "psql",
            "-U",
            "agent",
            "-d",
            "agent",
            "-tA",
            "-c",
            "SELECT coalesce(string_agg(content,' '),'') FROM messages; SELECT coalesce(string_agg(prompt_json::text,' '),'') FROM model_requests; SELECT coalesce(string_agg(result::text,' '),'') FROM task_steps;",
        ],
        text=True,
    )
    assert_clean(columns)
