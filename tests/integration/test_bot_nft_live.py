"""Live check: per-bot nftables rules are applied inside a real computer container.

Needs `sudo docker` and the computer image (COMPUTER_IMAGE, default <COMPOSE_PROJECT>-computer:dev).
The container is a throwaway (never the stack's computers) with the same cap-drop-all
baseline as the compute provider plus NET_ADMIN for root, so root can load the rules.
"""
from __future__ import annotations

import json
import os
import subprocess
import uuid
from pathlib import Path
from stack import PROJECT

import pytest

HERE = Path(__file__).resolve().parent
IMAGE = os.environ.get("COMPUTER_IMAGE", f"{PROJECT}-computer:dev")
CAPS = ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER", "KILL"]


def _docker(*args, check=True, **kw):
    return subprocess.run(["sudo", "-n", "docker", *args], check=check, capture_output=True, text=True, **kw)


def _have_image() -> bool:
    try:
        return _docker("image", "inspect", IMAGE, check=False).returncode == 0
    except FileNotFoundError:
        return False


pytestmark = pytest.mark.skipif(not _have_image(), reason=f"docker or image {IMAGE} unavailable")


@pytest.fixture()
def container():
    names = []

    def start(mode: str, net_admin: bool = True):
        name = f"{PROJECT}-nftlive-{uuid.uuid4().hex[:8]}"
        args = ["run", "-d", "--name", name, "--entrypoint", "sleep", "--cap-drop", "ALL"]
        for cap in CAPS + (["NET_ADMIN"] if net_admin else []):
            args += ["--cap-add", cap]
        args += ["-e", f"COMPUTER_BOT_NFT={mode}", "-e", "WORKSPACE_ROOT=/tmp/ws", "-e", "STATE_ROOT=/tmp/st", "-e", "HOME_ROOT=/tmp/home", IMAGE, "300"]
        _docker(*args)
        names.append(name)
        _docker("cp", str(HERE / "bot_nft_probe.py"), f"{name}:/tmp/probe.py")
        return name

    yield start
    for name in names:
        _docker("rm", "-f", name, check=False)


def _probe(name: str) -> dict:
    out = _docker("exec", name, "python3", "/tmp/probe.py")
    return json.loads(out.stdout)


def test_rules_enforced_for_bots_and_not_for_root(container):
    result = _probe(container("required"))
    bot = result["bot_a"]
    assert bot["own_dev_server"] == "open"                  # the bot's localhost dev server works
    assert bot["egress_proxy"] == "open"                    # the proxy is reachable
    for blocked in ("other_bot_dev_server", "root_service_7700", "direct_internet", "metadata_ip", "docker_gateway"):
        assert bot[blocked] == "timeout", (blocked, bot)    # dropped: SYN never answered
    assert bot["dns_udp"] == "PermissionError"              # UDP is rejected at send
    assert result["root"]["to_bot_a_dev"] == "open"         # root services keep working


def test_control_without_rules_shows_the_probe_would_see_the_leaks(container):
    result = _probe(container("off"))
    bot = result["bot_a"]
    assert bot["own_dev_server"] == "open"
    assert bot["other_bot_dev_server"] == "open"
    assert bot["root_service_7700"] == "open"


def test_required_mode_fails_closed_without_net_admin(container):
    name = container("required", net_admin=False)
    result = _docker("exec", name, "python3", "/tmp/probe.py", check=False)
    assert result.returncode != 0
    assert "bot_firewall_not_applied" in result.stderr
