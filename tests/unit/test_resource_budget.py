"""Static resource budget for a 4 GB / 2 vCPU host.

CI does not boot the stack. These checks read the compose file and the
computer image so a later edit cannot quietly raise the defaults.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = (ROOT / "docker-compose.yml").read_text()
LOWEND = (ROOT / "deploy/compose.low-end.yml").read_text()
LOWEND_SH = (ROOT / "scripts/low-end.sh").read_text()
DESKTOPS = (ROOT / "services/computer/src/desktops.py").read_text()
DOCKERFILE = (ROOT / "services/computer/Dockerfile").read_text()
OPTIONS = (ROOT / "src/Compute.Docker/DockerComputeOptions.cs").read_text()
PROVIDER = (ROOT / "src/Compute.Docker/DockerComputeProvider.cs").read_text()
PROGRAM = (ROOT / "apps/api/Program.cs").read_text()
HOST = (ROOT / "apps/api/HostBudget.cs").read_text()
WEB = (ROOT / "apps/web/components/workspace.tsx").read_text()
PANE = (ROOT / "apps/web/components/computer-pane.tsx").read_text()
ROUTES = (ROOT / "apps/api/Routes.cs").read_text()

# Two computers at the default quota, plus the operating system, stay inside 4 GB.
HOST_MEMORY_MIB = 3600
HOST_CPUS = 2.0
COMPUTER_MEMORY_MIB = 640
COMPUTER_CPU_BURST = 4.0
COMPUTERS = 2


def service_blocks(text: str) -> dict[str, str]:
    blocks: dict[str, list[str]] = {}
    current: str | None = None
    in_services = False
    for line in text.splitlines():
        if line.startswith("services:"):
            in_services = True
            current = None
            continue
        if in_services and line and not line.startswith(" "):
            break
        if not in_services:
            continue
        if line.startswith("  ") and not line.startswith("    ") and line.rstrip().endswith(":"):
            current = line.strip()[:-1]
            blocks[current] = []
            continue
        if current is not None:
            blocks[current].append(line)
    return {name: "\n".join(lines) for name, lines in blocks.items()}


def mem_mib(token: str) -> int:
    raw = token.strip().strip('"').strip("'")
    if raw.endswith("m"):
        return int(raw[:-1])
    if raw.endswith("g"):
        return int(raw[:-1]) * 1024
    raise AssertionError(f"unexpected mem_limit {token}")


def test_every_long_running_service_has_a_cap():
    blocks = service_blocks(COMPOSE)
    assert "computer-image" in blocks
    assert "mem_limit:" not in blocks["computer-image"]
    long_running = [name for name in blocks if name != "computer-image"]
    assert long_running
    for name in long_running:
        assert "mem_limit:" in blocks[name], name
        assert "cpus:" in blocks[name], name


def always_on(blocks: dict[str, str]) -> dict[str, str]:
    return {
        name: body
        for name, body in blocks.items()
        if name != "computer-image" and "profiles:" not in body
    }


def totals(blocks: dict[str, str]) -> tuple[int, float]:
    memory = 0
    cpus = 0.0
    for body in blocks.values():
        for line in body.splitlines():
            stripped = line.strip()
            if stripped.startswith("mem_limit:"):
                memory += mem_mib(stripped.split(":", 1)[1])
            if stripped.startswith("cpus:"):
                cpus += float(stripped.split(":", 1)[1])
    return memory, cpus


def test_memory_caps_fit_a_4gb_host_and_infrastructure_cpu_is_bounded():
    memory, cpus = totals(always_on(service_blocks(COMPOSE)))
    memory += COMPUTERS * COMPUTER_MEMORY_MIB
    assert memory <= HOST_MEMORY_MIB, memory
    assert cpus <= HOST_CPUS, cpus


def test_three_computers_fit_an_8gb_host():
    memory, cpus = totals(always_on(service_blocks(COMPOSE)))
    memory += 3 * COMPUTER_MEMORY_MIB
    assert memory <= 7000, memory
    assert cpus <= 4.0, cpus


def test_platform_defaults_are_right_sized():
    assert "MAX_COMPUTERS: ${MAX_COMPUTERS:-}" in COMPOSE
    assert "IDLE_SUSPEND_MINUTES: ${IDLE_SUSPEND_MINUTES:-10}" in COMPOSE
    assert "IDLE_POWER: ${IDLE_POWER:-hibernate}" in COMPOSE
    assert "IDLE_HIBERNATE_MINUTES: ${IDLE_HIBERNATE_MINUTES:-30}" in COMPOSE
    assert 'DOTNET_gcServer: "0"' in COMPOSE
    assert "DOTNET_GCHeapHardLimit" in COMPOSE
    assert "shared_buffers=32MB" in COMPOSE
    assert "jit=off" in COMPOSE
    assert "GOMEMLIMIT:" in COMPOSE
    assert "640L * 1024 * 1024" in OPTIONS
    # Computer weights share the available CPUs; burst ceilings are not reservations.
    assert "CpuShares { get; init; } = 2048" in OPTIONS
    assert "NanoCpus { get; init; } = 4_000_000_000" in OPTIONS
    assert "COMPUTER_CPU_GUARANTEE: ${COMPUTER_CPU_GUARANTEE:-2}" in COMPOSE
    assert "COMPUTER_CPU_BURST: ${COMPUTER_CPU_BURST:-4}" in COMPOSE
    assert "ShmSize = 64L * 1024 * 1024" in PROVIDER
    assert "MemorySwap = host.Memory" in PROVIDER
    assert '["/tmp"] = "rw,nosuid,nodev,size=64m"' in PROVIDER
    assert "teammates.disk_backend" in PROVIDER
    assert "IdlePowerMode.Hibernate" in OPTIONS
    assert "EightGigabyteClass = 6L * 1024 * 1024 * 1024" in HOST
    # Overcommitted RAM: large hosts get one slot per 1.5 GiB, never fewer than 4 (> 3).
    assert "MinimumLargeHost = 4" in HOST
    assert "SlotBytes = 1536L * 1024 * 1024" in HOST
    assert "return 2" in HOST
    sample = PROGRAM.split("private async Task SampleComputers", 1)[1].split("private async Task", 1)[0]
    assert "ReadMemoryBytesAsync" in sample
    assert "GetMetricsAsync" not in sample
    assert "du" not in sample


def test_desktop_is_xfwm4_picom_and_a_plank_dock():
    panels = (ROOT / "services/computer/desktop/start-panels").read_text()
    assert "plank -n dock1" in panels
    assert "feh" in panels
    assert "xfce4-panel" not in panels and "tint2" not in panels
    assert "icon-size=48" in panels
    assert "theme='Transparent'" in panels
    assert "hide-mode='window-dodge'" in panels
    assert "position='bottom'" in panels
    for app in ("chromium", "files", "terminal"):
        assert app in panels
    wm = (ROOT / "services/computer/desktop/start-wm").read_text()
    assert "xfwm4 --compositor=off" in wm
    assert "picom" in wm and "--backend xrender" in wm
    assert "borderless_maximize" in wm and 'value="O|SHMC"' in wm
    assert "start-wm" in DESKTOPS and "start-panels" in DESKTOPS
    assert "xterm -geometry 80x18" not in DESKTOPS
    assert "1920x1200" in DOCKERFILE and "DISPLAY_DEPTH=24" in DOCKERFILE
    for package in ("xfwm4", "picom", "plank", "thunar", "xfce4-terminal"):
        assert package in DOCKERFILE
    assert "openbox" not in DOCKERFILE and "tint2" not in DOCKERFILE
    assert "exec thunar" in (ROOT / "services/computer/desktop/launch-files").read_text()
    assert "xfce4-terminal" in (ROOT / "services/computer/desktop/launch-terminal").read_text()
    assert not (ROOT / "services/computer/desktop/top.tint2rc").exists()


def test_computer_image_does_not_idle_a_vnc_stack():
    assert "/usr/lib/chromium/chromium" in DESKTOPS
    assert "--renderer-process-limit=1" in DESKTOPS
    assert "--disable-background-networking" in DESKTOPS
    assert "--disable-crash-reporter" in DESKTOPS
    assert "--in-process-gpu" in DESKTOPS
    assert "--disable-extensions" in DESKTOPS
    assert "--disable-sync" in DESKTOPS
    assert "--disk-cache-size=33554432" in DESKTOPS
    assert DESKTOPS.count("down=True") == 2
    assert "xfwm4" in (ROOT / "services/computer/desktop/start-wm").read_text()
    assert 'await _svc("-k", service)' in DESKTOPS
    assert "interval=30s" in DOCKERFILE
    bundle = ROOT / "services/computer/s6/user-bundles.d/user/contents.d/websockify"
    assert not bundle.exists()


def test_lowend_profile_simulates_a_4gb_host():
    assert 'profiles: ["lowend"]' in COMPOSE
    assert "cgroup_parent: /teammates-lowend" in LOWEND
    assert 'MAX_COMPUTERS: "2"' in LOWEND
    assert 'CGROUP_PARENT: /teammates-lowend' in LOWEND
    assert "IDLE_POWER: hibernate" in LOWEND
    assert "--profile lowend" in LOWEND_SH
    assert "4 * 1024 * 1024 * 1024" in LOWEND_SH
    assert "200000 100000" in LOWEND_SH


def test_hand_back_requeues_captcha_and_lease_waits_for_the_human():
    assert "captcha_or_mfa" in ROUTES
    assert "l.holder='human'" in ROUTES
    assert "lease_epoch=@epoch" in ROUTES
    assert "must not open a second websocket" in PANE
    worker = (ROOT / "services/agent/worker.py").read_text()
    assert "self.followups" in worker


def test_web_keeps_novnc_in_its_own_chunk():
    assert 'dynamic(() => import("@/components/computer-pane")' in WEB
    assert 'import("@novnc/novnc/lib/rfb.js")' in PANE
