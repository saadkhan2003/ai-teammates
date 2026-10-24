#!/usr/bin/env python3
"""Reinstall the isolation chain (TEAMS-ISO by default) when Docker has cleared DOCKER-USER.

This process shares the host network namespace. iptables-legacy here is the
host firewall. /ensure installs the rules only when they are missing, and
never removes them.
"""
from __future__ import annotations

import json
import os
import shlex
import socketserver
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler

from rules import CHAIN, rules

SOCKET = os.environ.get("ISOLATION_SOCKET", "/run/teammates/isolation.sock")
TOKEN = os.environ.get("ISOLATION_TOKEN", "")
SCRIPT = os.environ.get("ISOLATION_SCRIPT", "/opt/computer-isolation.sh")
_lock = threading.Lock()


def iptables() -> str:
    try:
        subprocess.check_call(
            ["iptables-legacy", "-S", "DOCKER-USER"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return "iptables-legacy"
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "iptables"


def rules_present() -> bool:
    ipt = iptables()
    try:
        user = subprocess.check_output([ipt, "-S", "DOCKER-USER"], text=True, stderr=subprocess.DEVNULL)
        chain = subprocess.check_output([ipt, "-S", CHAIN], text=True, stderr=subprocess.DEVNULL)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False
    if f"-j {CHAIN}" not in user:
        return False
    actual = [shlex.split(line)[2:] for line in chain.splitlines() if line.startswith(f"-A {CHAIN} ")]
    # Exact order also rejects stale DNS exceptions and broad private-range allows.
    try:
        return actual == rules()
    except ValueError:
        return False


def install() -> None:
    with _lock:
        if rules_present():
            return
        subprocess.check_call(["/bin/sh", SCRIPT])
        if not rules_present():
            raise RuntimeError(f"{CHAIN} is not installed")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] != "/status":
            self._send(404, {"ok": False, "error": "not_found"})
            return
        ok = rules_present()
        self._send(200 if ok else 503, {"ok": ok})

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/ensure":
            self._send(404, {"ok": False, "error": "not_found"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length:
            self.rfile.read(length)
        if not TOKEN or self.headers.get("Authorization", "") != f"Bearer {TOKEN}":
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        try:
            install()
        except Exception as exc:
            self._send(503, {"ok": False, "error": "install_failed", "detail": str(exc)})
            return
        self._send(200, {"ok": True, "installed": True})

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        print("isolation " + (fmt % args), flush=True)


class Server(socketserver.ThreadingUnixStreamServer):
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self) -> None:
        if os.path.exists(self.server_address):
            os.remove(self.server_address)
        os.makedirs(os.path.dirname(self.server_address) or ".", exist_ok=True)
        super().server_bind()
        os.chmod(self.server_address, 0o660)


def repair() -> None:
    while True:
        time.sleep(5)
        try:
            if not rules_present():
                print("isolation rules missing; reinstalling", flush=True)
                install()
        except Exception as exc:
            print(f"isolation repair failed: {exc}", flush=True)


def main() -> None:
    try:
        install()
        print("isolation rules installed", flush=True)
    except Exception as exc:
        print(f"isolation install failed: {exc}", flush=True)
    threading.Thread(target=repair, daemon=True).start()
    with Server(SOCKET, Handler) as server:
        print(f"isolation guard listening on {SOCKET}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
