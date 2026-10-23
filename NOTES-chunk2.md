# Chunk 2 handoff: computer image, DNS/isolation, second display

Implemented only the assigned compute/computer/deploy/contract/test areas and this note. No Docker daemon, iptables command, paid API, credential file, or git mutation was used.

## Configuration and rollout

- `COMPUTER_DNS` defaults to `1.1.1.1,8.8.8.8`. Compose supplies the same value to API and isolation guard. DockerComputeOptions reads the environment directly, so no API Program.cs change is required. HostConfig.Dns is explicit at container creation; recreate existing computers to apply a changed DNS setting.
- Resolver configuration accepts comma-separated IPv4 literals only, rejects empty entries/names/CIDRs/IPv6, and deduplicates. The bridge is IPv4-only. Private resolvers such as `10.0.0.2` are supported through destination-specific UDP/TCP port 53 rules. Docker's container-local `127.0.0.11` is included in the rule policy, not added as an upstream resolver.
- `deploy/isolation-guard/rules.py` is the shared pure policy generator. The host shell installer now requires Python 3 (already in the guard image). When running the shell installer manually, export the same COMPUTER_DNS as the deployed guard; it deliberately does not source a credential-bearing dotenv file.
- The guard checks the complete ordered chain, including DNS exceptions, and repairs old/missing/reordered/overbroad policies. Existing controller exemptions, connection tracking, and private TCP/UDP blocking remain. Catch-all private-range drops also cover ICMP and other protocols.
- Rebuild the computer and isolation images and API; recreate computers to get image and HostConfig changes. Run the live network integration test, including with a private DNS override, on the orchestrator host.

## Desktop and display interface

- Repository SVG wallpaper is rasterized at image build time; runtime downloads are unnecessary. Existing tint2/Openbox components supply dark top clock/date/link-status bar, bottom launchers, maximized undecorated normal windows, and dark terminal. The second desktop starts without Chromium; its browser launcher starts a separate lean browser profile on demand.
- Node 24 LTS comes from the official x64 tarball with a pinned SHA-256. Only node and npm/npx are extracted. uv/uvx are copied from a pinned official Astral image. Image build includes executable version smoke checks. The existing image's s6 architecture remains x86_64.
- `COMPUTER_SECOND_DISPLAY=true` is the default; false disables display 2. Secondary desktops start lazily through the existing dynamic s6 supervisor (`xvfb-2`, `wm-2`, `panels-2`, view/control VNC services for the normal single-primary case). No second Chromium process is started by default. A computer/container restart returns secondary readiness to false.
- Authenticated computer API: GET or POST `/desktops/{botId}/displays`; POST `/desktops/{botId}/screenshot?display=1|2`; POST `/desktops/{botId}/click?display=1|2` with `{x,y,button?}`; POST `/desktops/{botId}/type?display=1|2` with `{text}`. Omitted display selects 1. Screenshot returns PNG; inputs return JSON. Existing browser endpoints remain unchanged.
- Viewer/control endpoints accept an optional body `display` (default 1). The returned status includes the actual selected view/control port. Allocation is serialized across bots to prevent collisions. Each bot's secondary uses the same workspace/UID and a shared human takeover/fencing state. Native subprocesses drop to the bot UID and receive a small environment without computer service credentials; typed text travels over stdin.
- `DesktopAccess` adds optional `Display=1`; Docker/Fake providers implement `IComputerDisplays`. Proto changes are additive fields/messages only. Existing gRPC sketch is still not served.
- For frontend/API chunks: noVNC already sets `scaleViewport=true`. `apps/web/components/computer-pane.tsx` still uses the old light RFB background; the frontend owner can use `#0b1220` and confirm the viewport container has no padding/letterbox gaps. No web file was edited by this chunk. Display selection is available at compute/computer-service level; adding a public UI selector is outside this chunk.

## Validation

- `COMPUTE_CONTRACT_DOCKER=0 dotnet test tests/compute-contract`: 19 passed, 0 failed.
- `dotnet test tests/unit`: 151 passed, 0 failed on the latest full run. An earlier concurrent snapshot had two policy expectation failures; the latest shared-tree run resolved them without edits to policy files by this chunk.
- Full Python unit suite: run with the temporary `/tmp/chunk2-check` environment, which adds the computer image's FastAPI/uvicorn plus pytest/httpx to system packages. Latest count recorded below. The native HTTP route test skips when FastAPI/uvicorn are unavailable; pure display/isolation tests still run with ordinary system pytest.
- `buf lint contracts` and `buf breaking contracts --against /tmp/chunk2-proto-baseline`: passed; baseline files were read from HEAD using git show into a temporary directory.
- Both Dockerfiles parsed; all RUN commands and shell launch/service scripts passed `sh -n`; desktop XML/SVG parsed; computer/isolation Python and live network test compiled; assigned-file `git diff --check` passed.
- Orchestrator still needs Docker image builds, container recreation, Docker-backed compute contracts (`COMPUTE_CONTRACT_DOCKER=1`), full live integration/e2e, and visual inspection of primary/secondary desktops at narrow/wide viewport sizes. Image build/runtime and firewall installation were not executable in this sandbox.
