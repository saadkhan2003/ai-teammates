"""A bot computer can use the internet and cannot open platform services."""
from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _docker(*args: str) -> str:
    return subprocess.check_output(["sudo", "docker", *args], text=True).strip()


def _computers() -> list[str]:
    raw = _docker("ps", "--filter", "label=teammates.role=user-computer", "--format", "{{.Names}}")
    return [line.strip() for line in raw.splitlines() if line.strip()]


def _probe(container: str, postgres_ip: str, seaweed_ip: str, api_ip: str, agent_ip: str) -> dict[str, str]:
    script = r"""
import json, socket, urllib.error, urllib.request
postgres_ip, seaweed_ip, api_ip, agent_ip = json.loads(input())

def tcp(host, port, timeout=2.0):
    sock = socket.socket()
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        return "open"
    except Exception as exc:
        return type(exc).__name__
    finally:
        sock.close()

def http(url, timeout=3.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return f"open {response.status}"
    except urllib.error.HTTPError as exc:
        return f"open {exc.code}"
    except Exception as exc:
        return type(exc).__name__

report = {
    "postgres": tcp(postgres_ip, 5432),
    "seaweed": tcp(seaweed_ip, 8333),
    "api": tcp(api_ip, 8080),
    "agent": tcp(agent_ip, 7710),
    "internal": http(f"http://{api_ip}:8080/internal/tasks/lease"),
    "health": http(f"http://{api_ip}:8080/health"),
    "local": http("http://127.0.0.1:7700/health"),
    "internet": http("https://example.com", timeout=12),
}
print(json.dumps(report))
"""
    payload = json.dumps([postgres_ip, seaweed_ip, api_ip, agent_ip]) + "\n"
    completed = subprocess.run(
        ["sudo", "docker", "exec", "-i", container, "python3", "-c", script],
        input=payload,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stderr or completed.stdout)
    return json.loads(completed.stdout.strip().splitlines()[-1])


def test_bot_computer_cannot_reach_postgres_seaweed_or_internal_api():
    subprocess.check_call(["sudo", "bash", str(ROOT / "deploy/computer-isolation.sh")])
    names = _computers()
    assert names, "no user computer is running"
    postgres_ip = _docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", "teammates-postgres-1")
    seaweed_ip = _docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", "teammates-object-store-1")
    api_ip = "172.30.28.10"
    agent_ip = "172.30.28.11"
    assert postgres_ip and seaweed_ip

    for name in names:
        nets = _docker("inspect", "-f", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}", name).split()
        assert nets == ["teammates-computers"], (name, nets)
        report = _probe(name, postgres_ip, seaweed_ip, api_ip, agent_ip)
        for key in ("postgres", "seaweed", "api", "agent", "internal", "health"):
            assert report[key] != "open" and not str(report[key]).startswith("open "), (name, key, report)
        assert report["local"].startswith("open "), (name, report)
        assert report["internet"].startswith("open "), (name, report)


def _ipt() -> str:
    if subprocess.call(["sudo", "iptables-legacy", "-S", "DOCKER-USER"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0:
        return "iptables-legacy"
    return "iptables"


def _rules_present() -> bool:
    ipt = _ipt()
    user = subprocess.check_output(["sudo", ipt, "-S", "DOCKER-USER"], text=True)
    if "-j TEAMS-ISO" not in user:
        return False
    chain = subprocess.check_output(["sudo", ipt, "-S", "TEAMS-ISO"], text=True)
    return "REJECT --reject-with tcp-reset" in chain and "-s 172.30.28.0/24" in chain


def _flush_rules() -> None:
    ipt = _ipt()
    while True:
        listing = subprocess.check_output(["sudo", ipt, "-S", "DOCKER-USER"], text=True)
        if "-j TEAMS-ISO" not in listing:
            break
        subprocess.check_call(["sudo", ipt, "-D", "DOCKER-USER", "-j", "TEAMS-ISO"])
    subprocess.call(["sudo", ipt, "-F", "TEAMS-ISO"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _running(name: str) -> bool:
    return _docker("inspect", "-f", "{{.State.Running}}", name) == "true"


def _isolation_name() -> str:
    raw = _docker("ps", "-a", "--filter", "label=com.docker.compose.service=isolation", "--format", "{{.Names}}")
    names = [line.strip() for line in raw.splitlines() if line.strip()]
    assert names, "isolation guard is not deployed"
    return names[0]


def _api(method: str, path: str, cookie: str, body: dict | None = None, timeout: float = 60):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request("http://127.0.0.1:18080" + path, data=data, method=method)
    if body is not None:
        request.add_header("Content-Type", "application/json")
    if cookie:
        request.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode() or "{}")
            set_cookie = response.headers.get("Set-Cookie", "")
            if "teammates_session=" in set_cookie:
                cookie = set_cookie.split(";", 1)[0]
            return response.status, payload, cookie
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"raw": raw}
        return exc.code, payload, cookie


def _wait_rules(timeout: float = 20) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists("/run/teammates/isolation.sock") and _rules_present():
            return
        time.sleep(0.25)
    raise AssertionError("isolation rules did not return")


def test_flushed_chain_refuses_start_until_rules_return():
    """Flush TEAMS-ISO with the guard stopped. Start must fail closed, and Postgres stays closed after the rules return."""
    subprocess.check_call(["sudo", "bash", str(ROOT / "deploy/computer-isolation.sh")])
    assert _rules_present()
    guard = _isolation_name()
    status, login, cookie = _api("POST", "/api/auth/login", "", {"username": "saad", "password": "teammates-dev"})
    assert status == 200, login
    status, computer, cookie = _api("GET", "/api/computer", cookie)
    assert status == 200 and computer.get("computerId"), computer
    owned = _docker("ps", "-a", "--filter", f"label=teammates.computer_id={computer['computerId']}", "--format", "{{.Names}}")
    assert owned, computer
    names = _computers()
    assert owned in names or owned in _docker("ps", "-a", "--filter", "label=teammates.role=user-computer", "--format", "{{.Names}}")
    postgres_ip = _docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", "teammates-postgres-1")
    seaweed_ip = _docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", "teammates-object-store-1")
    assert postgres_ip and seaweed_ip
    stopped: list[str] = []
    try:
        subprocess.check_call(["sudo", "docker", "stop", "-t", "2", guard])
        _flush_rules()
        assert not _rules_present()
        for name in names:
            assert _running(name), name
            report = _probe(name, postgres_ip, seaweed_ip, "172.30.28.10", "172.30.28.11")
            assert report["postgres"] != "open" and not str(report["postgres"]).startswith("open "), (name, report)
            assert report["api"] == "open", (name, report)
        for name in names:
            subprocess.check_call(["sudo", "docker", "stop", "-t", "3", name])
            stopped.append(name)
            assert not _running(name), name
        status, refused, cookie = _api("POST", "/api/computer/restart", cookie, {}, timeout=20)
        assert status == 503, refused
        assert refused.get("error") == "computer_isolation_missing", refused
        assert "No computer was started" in refused.get("message", ""), refused
        deadline = time.time() + 8
        while time.time() < deadline:
            assert not _running(owned), "computer started while isolation rules were missing"
            time.sleep(0.5)
        status, health, cookie = _api("GET", "/api/admin/health", cookie)
        assert status == 200, health
        assert health["computerIsolation"] is False, health
        assert health["ok"] is False, health
        assert health["postgres"] is True, health
        subprocess.check_call(["sudo", "docker", "start", guard])
        _wait_rules()
        started = {}
        status = 0
        for _ in range(3):
            status, started, cookie = _api("POST", "/api/computer/restart", cookie, {}, timeout=90)
            if status == 200 or started.get("error") == "computer_recovering":
                break
            time.sleep(1)
        assert status in {200, 503}, started
        if status == 503:
            assert started.get("error") == "computer_recovering", started
        deadline = time.time() + 60
        while time.time() < deadline and not _running(owned):
            time.sleep(1)
        assert _running(owned), started
        deadline = time.time() + 45
        report = {}
        while time.time() < deadline:
            try:
                report = _probe(owned, postgres_ip, seaweed_ip, "172.30.28.10", "172.30.28.11")
            except AssertionError:
                time.sleep(1)
                continue
            if report.get("postgres") and report.get("api"):
                break
            time.sleep(1)
        assert report["postgres"] != "open" and not str(report["postgres"]).startswith("open "), report
        assert report["api"] != "open" and not str(report["api"]).startswith("open "), report
        status, health, cookie = _api("GET", "/api/admin/health", cookie)
        assert status == 200 and health["ok"] is True and health["computerIsolation"] is True, health
    finally:
        subprocess.call(["sudo", "docker", "start", guard], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.call(["sudo", "bash", str(ROOT / "deploy/computer-isolation.sh")])
        for name in stopped:
            if not _running(name):
                subprocess.call(["sudo", "docker", "start", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
