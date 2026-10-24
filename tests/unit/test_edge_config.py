"""Default and production Caddy configs do not publish worker or metrics routes."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _text(name: str) -> str:
    return (ROOT / name).read_text()


def test_default_caddyfile_hides_internal_and_metrics():
    text = _text("Caddyfile")
    assert "handle /internal/*" not in text
    assert "handle /metrics" not in text
    assert "handle /api/*" in text
    assert "handle /vnc/*" in text
    assert "reverse_proxy api:8080" in text


def test_production_caddyfile_is_https_and_still_closed():
    text = _text("deploy/Caddyfile.production")
    assert "handle /internal/*" in text and "respond 404" in text
    assert "handle /metrics" in text and "respond 404" in text
    assert "example.com" in text
    assert "email admin@example.com" in text
    assert "issuer acme" in text
    assert "Strict-Transport-Security" in text
    assert "Content-Security-Policy" in text
    assert "connect-src 'self'" in text
    assert "/vnc/websockify" in text or "noVNC" in text
    assert "worker-src 'self' blob:" in text
    assert "request_body {" in text
    assert "max_size 32MB" in text
    assert "header {" in text
    assert "reverse_proxy api:8080 {" in text
    assert "rate limit" in text.lower() or "rate limiter" in text.lower()


def test_production_compose_refuses_the_dev_owner_password():
    text = _text("deploy/compose.production.yml")
    assert "REQUIRE_OWNER_PASSWORD" in text
    assert "${OWNER_PASSWORD:?" in text
    assert "teammates-dev" not in text
    assert "ENABLE_TEST_HOOKS" in text
    dev = _text("docker-compose.yml")
    assert "OWNER_PASSWORD: ${OWNER_PASSWORD:-teammates-dev}" in dev


def test_test_caddyfile_is_opt_in():
    text = _text("deploy/Caddyfile.test")
    assert "handle /internal/*" in text
    assert "handle /metrics" in text
    assert "ENABLE_TEST_HOOKS" in text
    compose = _text("docker-compose.yml")
    assert "${CADDYFILE:-./Caddyfile}" in compose
    override = _text("deploy/compose.test.yml")
    assert "127.0.0.1:18081:8080" in override
    makefile = _text("Makefile")
    assert "deploy/compose.test.yml" in makefile
    assert "API_URL" in makefile


def test_production_caddy_explicitly_hides_internal_metrics_and_keeps_streams_alive():
    text = _text("deploy/Caddyfile.production")
    assert "handle /internal/*" in text and "respond 404" in text
    assert "handle /metrics" in text and "respond 404" in text
    assert "stream_timeout" in text
    assert "keepalive" in text
    assert "KeepAliveInterval" in _text("apps/api/Program.cs")
    assert "flush_interval -1" in text


def test_production_compose_does_not_publish_vnc_or_novnc_ports():
    text = _text("deploy/compose.production.yml")
    assert "5900:" not in text and "6080:" not in text
