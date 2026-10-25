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


def _snippet(text: str, name: str) -> str:
    token = f"({name}) {{"
    start = text.index(token)
    depth = 0
    for index, char in enumerate(text[start:], start):
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    raise AssertionError(name)


def test_admin_site_is_separate_and_allowlisted():
    for name in ("Caddyfile", "deploy/Caddyfile.production", "deploy/Caddyfile.test"):
        text = _text(name)
        block = _snippet(text, "admin_routes")
        assert "ADMIN_ALLOWLIST" in block
        assert "remote_ip" in block
        assert "reverse_proxy admin:3000" in block
        assert "reverse_proxy api:8080" in block
        assert "/internal" not in block
        assert "/metrics" not in block
        assert "handle /vnc" not in block
    assert ":8081" in _text("Caddyfile")
    assert ":8081" in _text("deploy/Caddyfile.test")
    assert "admin.example.com" in _text("deploy/Caddyfile.production")
    compose = _text("docker-compose.yml")
    assert '127.0.0.1:${ADMIN_PORT:-18082}:8081' in compose
    assert "context: ./apps/admin" in compose
    assert "cgroup_parent: /teammates-lowend" in _text("deploy/compose.low-end.yml")
    assert "\n  admin:\n" in _text("deploy/compose.low-end.yml")


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


def test_caddy_referrer_policy_is_a_default_and_renderer_headers_survive():
    for name in ("Caddyfile", "deploy/Caddyfile.test", "deploy/Caddyfile.production"):
        text = _text(name)
        user_routes = text.split("(routes) {", 1)[1].split("\n}", 1)[0]
        assert "?Referrer-Policy same-origin" in user_routes
        assert "\n\t\tReferrer-Policy same-origin" not in user_routes
        assert "X-Frame-Options SAMEORIGIN" in text
    renderer = _text("apps/web/app/page-renderer/route.ts")
    assert '"Referrer-Policy": "no-referrer"' in renderer
    assert '"Content-Security-Policy":' in renderer
    assert "frame-ancestors 'self'" in renderer
    production = _text("deploy/Caddyfile.production")
    user_routes = production.split("(routes) {", 1)[1].split("\n}", 1)[0]
    assert '?Content-Security-Policy "default-src \'self\'' in user_routes
    assert "\n\t\tContent-Security-Policy " not in user_routes
    assert "X-Frame-Options SAMEORIGIN" in production


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


def test_compression_excludes_event_and_vnc_paths_on_public_and_admin_listeners():
    for name in ("Caddyfile", "deploy/Caddyfile.production", "deploy/Caddyfile.test"):
        text = _text(name)
        assert text.count("@compress not path /api/events /vnc/*") == 2
        assert text.count("encode @compress zstd gzip") == 2
        assert text.index("handle /api/events") < text.index("handle /api/*")
        assert "flush_interval -1" in text.split("handle /vnc/*", 1)[1]
