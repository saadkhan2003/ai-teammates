# Architecture chunk c3 report

Rows 10–11 add a loopback HTTP/CONNECT proxy with DNS pinning, SSRF blocks, policy checks, reloadable bounded policy files, local decision records, Chrome leak flags, and proxy variables for shell tools. The API has a bounded network-policy matcher and MCP outbound checks. A `--print` nftables generator emits default-drop rules and permits the contract proxy port.

Files: `apps/api/NetworkPolicy.cs`, `apps/api/PluginCatalog.cs`, `services/computer/src/browser.py`, `services/computer/src/desktops.py`, `services/computer/src/browser_flags.py`, `services/computer/src/egress/{__init__,policy,proxy,ssrf}.py`, `services/computer/s6/s6-rc.d/egress-proxy/{type,dependencies.d/base,run}`, `services/computer/s6/user-bundles.d/user/contents.d/egress-proxy`, `deploy/egress-firewall.py`, `tests/unit/NetworkPolicyTests.cs`, `tests/unit/test_egress_security.py`, `tests/unit/test_egress_firewall.py`.

Tests: Python unit suite 118 passed; C# unit suite 208 passed. No tests skipped. Existing unrelated warnings: Starlette `httpx` deprecation and nullable warnings in `BotMessaging.cs`.

Not complete: companion WSS attach/client stream splicing, per-user API policy route/Admin UI, API audit-chain integration, and end-to-end exit-IP/DNS/QUIC/WebRTC checks. The nftables rules were printed in tests only and not applied. SSRF checks include legacy numeric IPv4 forms and re-check DNS answers before connecting to the pinned address. Attach secrets are not yet wired to a tunnel endpoint.
