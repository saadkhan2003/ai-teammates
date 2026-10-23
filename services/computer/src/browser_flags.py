"""Chrome flags that prevent direct DNS, QUIC, and WebRTC UDP egress."""
from __future__ import annotations

import box_contract


def chrome_egress_flags() -> tuple[str, ...]:
    return (
        f"--proxy-server=127.0.0.1:{box_contract.EGRESS_PROXY}",
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1 , EXCLUDE ::1",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    )
