"""Dependency-injected health probes and authenticated window routing."""
import asyncio
import importlib.util
import importlib.machinery
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    source_root = str(ROOT / "services/computer/src")
    if source_root not in sys.path:
        sys.path.insert(0, source_root)
    path = ROOT / "services/computer/src" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_doctor_reports_each_check_and_fails_clock_skew():
    doctor = load("doctor")
    checks = doctor.run_checks(
        machine_id=lambda: "machine-test", chrome=lambda: True, fd_ratio=lambda: .2,
        egress=lambda: True, clock_skew=lambda: 61, display=lambda: True, rfb=lambda: True,
    )
    assert set(checks) == {"machineId", "chrome", "fdRatio", "egress", "clockSkew", "display", "rfb"}
    assert checks["clockSkew"]["ok"] is False
    assert checks["machineId"]["ok"] is True


def test_supervisor_records_probe_state_and_failure_threshold(tmp_path):
    supervisor = load("supervisor")
    events = []
    status = supervisor.Supervisor(tmp_path / "status.json", probe=lambda: False,
                                   restart=lambda: events.append("restart"), threshold=2)
    assert status.tick() is False
    assert status.tick() is False
    assert events == ["restart"]
    result = __import__("json").loads((tmp_path / "status.json").read_text())
    assert result["healthy"] is False and result["restarted"] is True


def test_window_router_rejects_wrong_owner_without_upstream_call(tmp_path):
    router = load("window_router")
    token_dir = tmp_path / "tokens"
    token_dir.mkdir(mode=0o700)
    (token_dir / "1").write_text("secret-owner-token")
    calls = []
    route = router.WindowRouter(token_dir, upstream=lambda port: calls.append(port) or "ok")
    assert route.handle("1", "wrong-secret-owner-token") == (403, None)
    assert calls == []
    assert route.handle("1", "secret-owner-token") == (200, "ok")
    assert calls == [14001]


def test_router_display_one_uses_primary_contract_port():
    router = load("window_router")
    assert router.upstream_port(1) == 14001
    with pytest.raises(ValueError):
        router.upstream_port(9)


def test_owner_tokens_are_written_private_and_marker_tracks_route(tmp_path):
    router = load("window_router")
    token_dir = tmp_path / "tokens"
    token_file = router.write_owner_token(token_dir, 1, "a" * 32)
    assert token_file.stat().st_mode & 0o777 == 0o600
    marker_dir = tmp_path / "used"
    route = router.WindowRouter(token_dir, marker_dir=marker_dir, upstream=lambda _: "ok", clock=lambda: 100)
    assert route.handle("1", "a" * 32) == (200, "ok")
    assert (marker_dir / "1").stat().st_mtime == 100
    (marker_dir / "1").unlink()
    route.heartbeat()
    assert (marker_dir / "1").exists()
    assert len(router.new_owner_token()) >= 43


def test_router_compares_fixed_size_buffers_for_prefix_mismatches(tmp_path, monkeypatch):
    router = load("window_router")
    token_dir = tmp_path / "tokens"
    token_dir.mkdir()
    (token_dir / "1").write_text("a" * 43)
    sizes = []
    compare = router.hmac.compare_digest
    monkeypatch.setattr(router.hmac, "compare_digest", lambda left, right: sizes.append((len(left), len(right))) or compare(left, right))
    gate = router.WindowRouter(token_dir, upstream=lambda _: pytest.fail("upstream must not be called"))
    gate.handle("1", "b" + "a" * 42)
    gate.handle("1", "a" * 42 + "b")
    assert sizes == [(512, 512), (512, 512)]


def test_bounded_log_trims_aggregate_to_cap(tmp_path):
    source = ROOT / "services/computer/scripts/box-bounded-log"
    spec = importlib.util.spec_from_loader("bounded_log", importlib.machinery.SourceFileLoader("bounded_log", str(source)))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    (tmp_path / "one.log").write_bytes(b"a" * 80)
    (tmp_path / "two.log").write_bytes(b"b" * 80)
    assert module.enforce(tmp_path, 100) <= 100
    assert sum(p.stat().st_size for p in tmp_path.iterdir()) <= 100


def test_cdp_proxy_routes_by_display_header_and_rejects_out_of_range(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "services/computer/src"))
    proxy = load("cdp_proxy")
    assert proxy._display_of(b"GET /json/version HTTP/1.1\r\nHost: box\r\n") == 1
    assert proxy._display_of(b"GET /json/version HTTP/1.1\r\nX-Display: 3\r\n") == 3
    assert proxy._display_of(b"GET / HTTP/1.1\r\nX-Display: 9\r\n") is None


def test_computer_doctor_endpoint_is_authenticated_and_structured(monkeypatch):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    monkeypatch.syspath_prepend(str(ROOT / "services/computer/src"))
    for name in ("workspace", "pure", "desktops", "browser", "fixtureserver", "server"):
        sys.modules.pop(name, None)
    import server
    checks = {"clockSkew": {"ok": False, "value": 61}}
    monkeypatch.setattr(load("doctor"), "run_checks", lambda: checks)
    monkeypatch.setenv("COMPUTER_TOKEN", "unit-test-only")
    client = TestClient(server.app)
    assert client.post("/doctor").status_code == 401
    response = client.post("/doctor", headers={"Authorization": "Bearer unit-test-only"})
    assert response.status_code == 200
    assert response.json() == {"ok": False, "checks": checks}


@pytest.mark.skipif(not shutil.which("Xvfb") or not shutil.which("x11vnc"),
                    reason="real Xvfb and x11vnc binaries are required")
def test_real_xvfb_x11vnc_rfb_handshake():
    xvfb = subprocess.Popen(["Xvfb", "-displayfd", "1", "-screen", "0", "640x480x24", "-nolisten", "tcp", "-ac"],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    vnc = None
    try:
        ready, _, _ = __import__("select").select([xvfb.stdout], [], [], 5)
        assert ready, "Xvfb did not publish a display"
        display = int(xvfb.stdout.readline().strip())
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            port = reserved.getsockname()[1]
        vnc = subprocess.Popen(["x11vnc", "-display", f":{display}", "-localhost", "-forever", "-shared",
                                "-nopw", "-rfbport", str(port), "-noxdamage"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=.3) as client:
                    assert client.recv(12) == b"RFB 003.008\n"
                    return
            except OSError:
                if vnc.poll() is not None:
                    pytest.fail("x11vnc exited before its RFB handshake")
                time.sleep(.1)
        pytest.fail("x11vnc did not answer the RFB handshake")
    finally:
        for process in (vnc, xvfb):
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)


def test_supervisor_probes_the_x_socket_not_the_on_demand_vnc_port():
    # x11vnc is down until a viewer connects; probing its port restarted Xvfb every 10 s.
    source = (Path(__file__).parents[2] / "services/computer/src/supervisor.py").read_text()
    assert "_display_probe" in source and "/tmp/.X11-unix/X" in source
    assert "_rfb_probe" not in source and "create_connection" not in source
