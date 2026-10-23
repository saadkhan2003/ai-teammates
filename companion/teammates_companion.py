#!/usr/bin/env python3
"""Small, dependency-free Teammates companion client."""

import argparse
import getpass
import http.client
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

VERSION = "0.4.0"
HEARTBEAT_SECONDS = 30


def config_path() -> Path:
    root = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return root / "teammates-companion" / "config.json"


def load_config() -> dict:
    path = config_path()
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit("Not paired. Run: teammates-companion pair --server URL --code CODE")


def save_config(value: dict) -> None:
    path = config_path()
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)


def request(server: str, method: str, path: str, body: dict | None = None, token: str | None = None) -> dict:
    url = urlsplit(server)
    if url.scheme not in ("http", "https") or not url.netloc:
        raise ValueError("server must be an http(s) URL")
    conn = (http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection)(url.netloc, timeout=15)
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    payload = json.dumps(body).encode() if body is not None else None
    conn.request(method, (url.path.rstrip("/") + path) or path, payload, headers)
    response = conn.getresponse()
    raw = response.read()
    if response.status >= 400:
        raise RuntimeError(f"server returned HTTP {response.status}")
    return json.loads(raw or b"{}")


def pair(args: argparse.Namespace) -> int:
    result = request(args.server, "POST", "/api/devices/pair/complete", {
        "code": args.code, "name": args.name or platform.node() or "companion",
        "os": platform.system(), "version": VERSION,
    })
    device_id = result.get("id", result.get("deviceId"))
    token = result.get("deviceToken", result.get("token"))
    if not device_id or not token:
        raise RuntimeError("pair response did not contain device credentials")
    save_config({"server": args.server.rstrip("/"), "deviceId": device_id, "token": token, "version": VERSION})
    print(f"Paired device {device_id}.")
    return 0


def heartbeat(config: dict) -> dict:
    return request(config["server"], "POST", f"/api/devices/{config['deviceId']}/heartbeat",
                   {"version": VERSION}, config["token"])


def status(_: argparse.Namespace) -> int:
    result = heartbeat(load_config())
    print(json.dumps(result, indent=2))
    return 0


def run_command(command: str, mode: str) -> int:
    if mode == "off":
        print("Device execution is disabled.", file=sys.stderr)
        return 1
    if mode == "ask" and input(f"Run command {command!r}? [y/N] ").strip().lower() not in ("y", "yes"):
        print("Command not run.")
        return 1
    return subprocess.run(command, shell=True, check=False).returncode


def run(args: argparse.Namespace) -> int:
    config = load_config()
    while True:
        state = heartbeat(config)
        mode = state.get("execution", "off")
        if args.command:
            return run_command(args.command, mode)
        print(f"heartbeat: execution={mode} routeTraffic={state.get('routeTraffic', False)}", flush=True)
        if args.once:
            return 0
        time.sleep(HEARTBEAT_SECONDS)


def unpair(_: argparse.Namespace) -> int:
    path = config_path()
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    print("Unpaired this companion.")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="teammates-companion")
    commands = parser.add_subparsers(dest="action", required=True)
    p = commands.add_parser("pair"); p.add_argument("--server", required=True); p.add_argument("--code", required=True); p.add_argument("--name"); p.set_defaults(func=pair)
    p = commands.add_parser("status"); p.set_defaults(func=status)
    p = commands.add_parser("run"); p.add_argument("--command"); p.add_argument("--once", action="store_true"); p.set_defaults(func=run)
    p = commands.add_parser("unpair"); p.set_defaults(func=unpair)
    try:
        args = parser.parse_args(argv)
        return args.func(args)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
