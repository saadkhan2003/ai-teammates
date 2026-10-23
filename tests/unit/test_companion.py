import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / "companion"))
import teammates_companion as companion


class Fake(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0)); body = json.loads(self.rfile.read(length) or b"{}")
        if self.path.endswith("pair/complete"):
            result = {"id": "device-1", "deviceToken": "secret-token"}
        else:
            assert self.headers["Authorization"] == "Bearer secret-token"
            assert body == {"version": companion.VERSION}
            result = {"execution": "ask", "routeTraffic": False}
        encoded = json.dumps(result).encode(); self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(encoded))); self.end_headers(); self.wfile.write(encoded)
    def log_message(self, *_): pass


def test_pair_status_and_permissions(tmp_path, monkeypatch):
    server = HTTPServer(("127.0.0.1", 0), Fake)
    monkeypatch.setattr(companion, "config_path", lambda: tmp_path / "config.json")
    try:
        import threading
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}"
        assert companion.main(["pair", "--server", base, "--code", "ABC"]) == 0
        assert (tmp_path / "config.json").stat().st_mode & 0o777 == 0o600
        assert companion.main(["status"]) == 0
        assert json.loads((tmp_path / "config.json").read_text())["token"] == "secret-token"
    finally:
        server.shutdown()
