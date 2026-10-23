# @generated sha256:28fb83906ddd44d32cdd516e1f4d1cea713612a93391c207d3bf27686642ef2a
from __future__ import annotations

MAX_WINDOWS = 8
EXEC = 1337
PTY = 1338
WINDOW_ROUTER = 1339
HOST_GATEWAY = 1340
VNC_PRIMARY = 5900
NOVNC_PLAIN = 6080
NOVNC_TOKENED = 6081
EGRESS_TUNNEL_WS = 8790
EGRESS_PROXY = 8791
CDP_BASE = 9222
EXTERNAL_VIEW_BASE = 9400
TAILNET_CHROME_CDP = 9600
SCREEN = {"width":1920,"height":1200}
MODEL = {"width":1280,"height":800,"scale":1.5}
PATHS = {"novncTokens":"/tmp/box-novnc-tokens.d","windowTokens":"/tmp/box-window-tokens.d","windowUsed":"/tmp/box-window-used.d","egressFailClosed":"/tmp/box-egress-fail-closed"}
BINDS = {"exec":"internal","pty":"internal","windowRouter":"internal","hostGateway":"internal","vncPrimary":"loopback","novncPlain":"internal","novncTokened":"internal","egressTunnelWs":"internal","egressProxy":"loopback","cdp":"loopback","externalView":"loopback","tailnetChromeCdp":"loopback"}

def port_for(kind: str, display: int) -> int:
    if isinstance(display, bool) or not isinstance(display, int) or not 1 <= display <= MAX_WINDOWS:
        raise ValueError("display must be an integer between 1 and MAX_WINDOWS")
    bases = {"vnc":5900,"exec":14000,"pty":13600,"cdp":9222,"externalView":9400}
    try:
        return bases[kind] + display
    except KeyError as exc:
        raise ValueError("unknown port kind") from exc
