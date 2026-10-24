import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { COMPUTER_STACK_FILTER, computerContainer } from "./containers";
import { expect, test } from "@playwright/test";

const CYCLES = 20;

function capture(args: string[], timeout = 30_000): string {
  const result = spawnSync("sudo", args, { encoding: "utf8", timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout || "").slice(0, 400)}`);
  }
  return result.stdout ?? "";
}

function tcpStats(container: string) {
  const text = capture(["docker", "exec", container, "sh", "-c", "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null || true"]);
  let closeWait = 0;
  let established = 0;
  let listen: number[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || parts[0] === "sl") continue;
    const local = parts[1] ?? "";
    const portHex = local.split(":").pop() ?? "";
    const port = Number.parseInt(portHex, 16);
    if (!Number.isFinite(port) || port < 5900 || port > 5915) continue;
    const state = (parts[3] ?? "").toUpperCase();
    if (state === "08") closeWait += 1;
    else if (state === "01") established += 1;
    else if (state === "0A") listen.push(port);
  }
  return { closeWait, established, listen };
}

function restartViewer(container: string) {
  const script = `
for svc in /run/service/vncview-*; do
  [ -e "$svc" ] || continue
  /command/s6-svc -k "$svc" 2>/dev/null || s6-svc -k "$svc" 2>/dev/null || true
  sleep 0.3
  /command/s6-svc -u "$svc" 2>/dev/null || s6-svc -u "$svc" 2>/dev/null || true
done
# A wedged x11vnc ignores SIGTERM. One kill is only the starting point for this run.
if ! python3 - <<'PY'
import os, socket, time
time.sleep(0.4)
ok = False
for port in range(5900, 5916):
    s = socket.socket()
    s.settimeout(1)
    try:
        s.connect(("127.0.0.1", port))
        ok = True
    except Exception:
        pass
    finally:
        s.close()
raise SystemExit(0 if ok else 1)
PY
then
  kill -9 $(pidof x11vnc) 2>/dev/null || true
  sleep 0.4
  for svc in /run/service/vncview-*; do
    [ -e "$svc" ] || continue
    /command/s6-svc -u "$svc" 2>/dev/null || s6-svc -u "$svc" 2>/dev/null || true
  done
fi
`;
  capture(["docker", "exec", container, "sh", "-c", script], 20_000);
}

test("opening and closing the computer view does not pile up x11vnc sockets", async ({ page }) => {
  test.setTimeout(360_000);
  const botsResponse = await page.request.get("/api/bots");
  expect(botsResponse.ok()).toBeTruthy();
  const bots = (await botsResponse.json()) as { id?: string; name?: string }[];
  const bot = bots.find((item) => item.name === "Field clerk" && item.id) ?? bots.find((item) => item.id);
  expect(bot?.id, "a teammate to open").toBeTruthy();
  const computerResponse = await page.request.get("/api/computer");
  expect(computerResponse.ok()).toBeTruthy();
  const computer = (await computerResponse.json()) as { computerId?: string };
  const candidates = [computerContainer(computer.computerId || bot!.id!)];
  // Earlier specs may have stopped or recreated the computer. Ask for it and wait until it runs, so this spec does not depend on order.
  let container: string | undefined;
  const upDeadline = Date.now() + 120_000;
  while (Date.now() < upDeadline) {
    const names = capture(["docker", "ps", "--filter", COMPUTER_STACK_FILTER, "--format", "{{.Names}}"]).split("\n").map((name) => name.trim()).filter(Boolean);
    container = candidates.find((name) => names.includes(name));
    if (container) break;
    await page.request.post("/api/computer/restart", { data: {}, timeout: 90_000 }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  expect(container, `computer container from ${candidates.join(", ")}`).toBeTruthy();

  let preconditionRestart = false;
  const before = tcpStats(container!);
  if (before.closeWait > 0) {
    preconditionRestart = true;
    restartViewer(container!);
    const started = Date.now();
    let drained = tcpStats(container!);
    while (drained.closeWait > 0 && Date.now() - started < 8_000) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      drained = tcpStats(container!);
    }
    expect(drained.closeWait, "precondition restart left CLOSE_WAIT").toBe(0);
  }

  let openSockets = 0;
  let peakSockets = 0;
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/vnc/websockify")) return;
    openSockets += 1;
    peakSockets = Math.max(peakSockets, openSockets);
    ws.on("close", () => {
      openSockets = Math.max(0, openSockets - 1);
    });
  });

  await page.goto(`/bots/${bot!.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("bot-name-button")).toBeVisible();

  async function paneOpen() {
    return page.getByTestId("info-pane").isVisible().catch(() => false);
  }

  async function closePane() {
    if (!(await paneOpen())) return;
    await page.getByTestId("info-pane-close").click();
    await expect(page.getByTestId("info-pane")).toBeHidden();
  }

  async function openPane() {
    if (!(await paneOpen())) await page.getByTestId("bot-name-button").click();
    await expect(page.getByTestId("info-pane")).toBeVisible();
    await expect(page.getByTestId("computer-tab")).toBeVisible();
  }

  async function waitClosed() {
    await expect.poll(() => openSockets, { timeout: 15_000, message: "view websocket still open after the pane closed" }).toBe(0);
  }

  async function settledCloseWait() {
    const started = Date.now();
    let last = tcpStats(container!).closeWait;
    while (Date.now() - started < 4_000) {
      last = tcpStats(container!).closeWait;
      if (last === 0) return 0;
      await page.waitForTimeout(200);
    }
    return last;
  }

  await closePane();
  await waitClosed();

  const samples: number[] = [];
  let maxEstablished = 0;
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    await openPane();
    await expect(page.getByTestId("computer-tab")).toHaveAttribute("data-vnc-state", "connected", { timeout: 30_000 });
    expect(openSockets, `cycle ${cycle} preview`).toBe(1);
    maxEstablished = Math.max(maxEstablished, tcpStats(container!).established);

    const computerTab = page.getByTestId("info-pane").getByRole("tab", { name: "Computer", exact: true });
    await computerTab.click();
    await expect(computerTab).toHaveAttribute("data-state", "active");
    await expect(page.getByTestId("computer-tab")).toHaveAttribute("data-vnc-state", "connected");
    expect(openSockets, `cycle ${cycle} computer tab`).toBe(1);

    const overview = page.getByTestId("info-pane").getByRole("tab", { name: "Overview", exact: true });
    await overview.click();
    await expect(overview).toHaveAttribute("data-state", "active");
    await expect(page.getByTestId("computer-tab")).toHaveAttribute("data-vnc-state", "connected");
    expect(openSockets, `cycle ${cycle} leave computer tab`).toBe(1);

    await closePane();
    await waitClosed();
    const closeWait = await settledCloseWait();
    samples.push(closeWait);
    expect(closeWait, `cycle ${cycle} CLOSE_WAIT`).toBe(0);
  }

  await openPane();
  await expect(page.getByTestId("computer-tab")).toHaveAttribute("data-vnc-state", "connected", { timeout: 30_000 });
  const finalStats = tcpStats(container!);
  const report = {
    cycles: CYCLES,
    container,
    preconditionRestart,
    closeWaitBefore: before.closeWait,
    closeWaitSamples: samples,
    maxCloseWait: Math.max(0, ...samples),
    finalCloseWait: finalStats.closeWait,
    finalEstablished: finalStats.established,
    maxEstablished,
    peakSockets,
    listen: finalStats.listen,
  };
  fs.mkdirSync("/workspace/docs/evidence/desktop", { recursive: true });
  fs.writeFileSync("/workspace/docs/evidence/desktop/vnc-lifecycle.json", JSON.stringify(report, null, 2));
  expect(peakSockets, "more than one live view websocket").toBeLessThanOrEqual(1);
  expect(finalStats.closeWait, "CLOSE_WAIT after the view connected again").toBe(0);
  expect(finalStats.established, "view connection missing after the cycles").toBeGreaterThan(0);
  expect(Math.max(0, ...samples), "CLOSE_WAIT built up across pane toggles").toBe(0);
});
