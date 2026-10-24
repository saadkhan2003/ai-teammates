// Low-end UI and host measurement. Run after scripts/low-end.sh.
//   node tests/perf/measure.mjs before /tmp/perf-before.json
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { chromium } from "../e2e/node_modules/playwright/index.mjs";

const label = process.argv[2] || "run";
const outPath = process.argv[3] || `/tmp/perf-${label}.json`;
const base = process.env.BASE_URL || "http://127.0.0.1:18080";
const owner = process.env.OWNER_USERNAME || "saad";
const password = process.env.OWNER_PASSWORD || "teammates-dev";

function sh(args) {
  const result = spawnSync("sudo", args, { encoding: "utf8" });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function stats() {
  const text = sh(["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"]);
  return text.split("\n").filter(Boolean).map((line) => {
    const [name, cpu, mem] = line.split("\t");
    return { name, cpu, mem };
  });
}

async function sampleStats(seconds) {
  const samples = [];
  for (let i = 0; i < seconds; i++) {
    samples.push(stats());
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return samples;
}

function bundleBytes() {
  const text = sh([
    "docker", "exec", "teammates-web-1", "sh", "-c",
    "find .next/static -type f \\( -name '*.js' -o -name '*.css' \\) -exec wc -c {} +",
  ]);
  const lines = text.split("\n").filter((line) => line.includes("."));
  let js = 0;
  let css = 0;
  const chunks = [];
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(\S+)/);
    if (!match) continue;
    const size = Number(match[1]);
    const file = match[2];
    if (file.endsWith(".js")) js += size;
    if (file.endsWith(".css")) css += size;
    if (size > 20_000) chunks.push({ file, bytes: size });
  }
  chunks.sort((a, b) => b.bytes - a.bytes);
  return { jsBytes: js, cssBytes: css, largeChunks: chunks.slice(0, 12) };
}

function limits() {
  const text = sh(["docker", "ps", "--format", "{{.Names}}"]);
  const names = text.split("\n").filter((name) => name.startsWith("teammates-") || name.startsWith("tm"));
  return names.map((name) => {
    const raw = sh(["docker", "inspect", "-f", "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.ShmSize}}", name]);
    const [nano, memory, shm] = raw.split(" ").map((part) => Number(part));
    return { name, cpus: nano ? nano / 1e9 : null, memoryBytes: memory || null, shmBytes: shm || null };
  });
}

function computerName() {
  return sh(["docker", "ps", "--filter", "label=teammates.managed=1", "--format", "{{.Names}}"]).split("\n").filter(Boolean)[0] || "";
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function navTimes(page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paints = Object.fromEntries(performance.getEntriesByType("paint").map((entry) => [entry.name, Math.round(entry.startTime)]));
    return {
      ttfbMs: nav ? Math.round(nav.responseStart) : null,
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      loadMs: nav ? Math.round(nav.loadEventEnd) : null,
      transferBytes: nav ? nav.transferSize : null,
      paints,
    };
  });
}

async function login(page) {
  await page.goto(`${base}/login`, { waitUntil: "load" });
  await page.getByTestId("login-username").fill(owner);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("new-bot").waitFor();
}

async function ensureTwoBots(page) {
  const response = await page.request.get(`${base}/api/bots`);
  const bots = await response.json();
  const list = Array.isArray(bots) ? bots : [];
  if (list.length < 2) {
    const created = await page.request.post(`${base}/api/bots`, {
      data: { name: "Perf clerk", role: "Second teammate", instructions: "Stay idle unless asked." },
    });
    if (!created.ok()) throw new Error(`bot create ${created.status()} ${await created.text()}`);
  }
  const again = await (await page.request.get(`${base}/api/bots`)).json();
  return (Array.isArray(again) ? again : []).map((bot) => ({ id: bot.id, name: bot.name }));
}

async function openBot(page, bot) {
  const link = page.locator(`[data-testid="sidebar"] a[href="/bots/${bot.id}"]`);
  const start = Date.now();
  await link.click();
  await page.getByTestId("bot-name-button").waitFor();
  await page.getByTestId("composer").waitFor();
  return Date.now() - start;
}

async function clickTab(page, name) {
  const pane = page.getByTestId("info-pane");
  if (!(await pane.isVisible().catch(() => false))) {
    await page.getByTestId("bot-name-button").click();
    await pane.waitFor();
  }
  const start = Date.now();
  const deadline = start + 20_000;
  let last = "unseen";
  while (Date.now() < deadline) {
    last = await page.evaluate((tabName) => {
      const root = document.querySelector('[data-testid="info-pane"]');
      if (!root) return "missing-pane";
      const tab = [...root.querySelectorAll('[role="tab"]')].find((el) => (el.textContent || "").trim() === tabName);
      if (!tab) return "missing-tab";
      if (tab.getAttribute("data-state") === "active") return "active";
      tab.scrollIntoView({ block: "nearest", inline: "center" });
      tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
      return tab.getAttribute("data-state") || "inactive";
    }, name).catch((error) => String(error));
    if (last === "active") return Date.now() - start;
    await page.waitForTimeout(60);
    const state = await page.evaluate((tabName) => {
      const root = document.querySelector('[data-testid="info-pane"]');
      const tab = root && [...root.querySelectorAll('[role="tab"]')].find((el) => (el.textContent || "").trim() === tabName);
      return tab ? tab.getAttribute("data-state") : "missing";
    }, name).catch(() => "missing");
    if (state === "active") return Date.now() - start;
  }
  throw new Error(`tab ${name} did not activate (${last})`);
}

async function timeTab(page, name, marker) {
  const start = Date.now();
  const activeMs = await clickTab(page, name);
  await page.getByTestId("info-pane").locator(marker).first().waitFor({ state: "visible", timeout: 30_000 });
  return { activeMs, contentMs: Date.now() - start };
}

async function sampleDuring(ms) {
  const samples = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    samples.push(stats());
    const left = end - Date.now();
    if (left <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, left)));
  }
  return samples;
}

async function measurePage(throttle) {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (throttle) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const scriptBytes = { bytes: 0 };
  cdp.on("Network.loadingFinished", (event) => {
    scriptBytes.bytes += event.encodedDataLength || 0;
  });
  const loginStart = Date.now();
  await page.goto(`${base}/login`, { waitUntil: "load" });
  await page.getByTestId("login-username").waitFor();
  const cold = { wallMs: Date.now() - loginStart, ...(await navTimes(page)), encodedBytes: scriptBytes.bytes };
  await login(page);
  const homeStart = Date.now();
  await page.reload({ waitUntil: "load" });
  await page.getByTestId("new-bot").waitFor();
  const home = { wallMs: Date.now() - homeStart, ...(await navTimes(page)) };
  const bots = await ensureTwoBots(page);
  await page.reload({ waitUntil: "load" });
  await page.getByTestId("new-bot").waitFor();
  const first = await openBot(page, bots[0]);
  const second = bots[1] ? await openBot(page, bots[1]) : null;
  if (!(await page.getByTestId("info-pane").isVisible().catch(() => false))) {
    await page.getByTestId("bot-name-button").click();
  }
  const tabs = {};
  for (const [name, marker] of [
    ["Overview", "text=Provider"],
    ["Routines", "[data-testid=routine-name]"],
    ["Files", "[data-testid=file-list]"],
    ["Skills", "[data-testid=skill-list]"],
    ["Memory", "[data-testid=memory-input]"],
    ["Tasks", "[data-testid=task-list]"],
    ["Computer", "[data-testid=computer-tab]"],
  ]) {
    tabs[name] = await timeTab(page, name, marker);
  }
  await browser.close();
  return { coldLogin: cold, homeReload: home, openFirstBotMs: first, switchBotMs: second, tabs, bots };
}

async function measureInteraction() {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const sse = [];
  const sockets = [];
  cdp.on("Network.eventSourceMessageReceived", () => sse.push(Date.now()));
  cdp.on("Network.webSocketFrameReceived", () => sockets.push(Date.now()));
  await login(page);
  const bots = await ensureTwoBots(page);
  await page.reload({ waitUntil: "load" });
  await openBot(page, bots[0]);
  const pollHits = [];
  let recording = true;
  const onPoll = (event) => {
    if (!recording) return;
    const url = event.request?.url || "";
    if (!url.includes("/api/")) return;
    pollHits.push(new URL(url).pathname);
  };
  cdp.on("Network.requestWillBeSent", onPoll);
  const duringOpenChat = await sampleDuring(6000);
  recording = false;
  const pollCounts = {};
  for (const path of pollHits) pollCounts[path] = (pollCounts[path] || 0) + 1;
  const beforeUser = await page.locator('[data-testid="message-item"][data-role="user"]').count();
  const beforeBot = await page.locator('[data-testid="message-item"][data-role="assistant"]').count();
  const sseMark = sse.length;
  const sendStart = Date.now();
  await page.getByTestId("composer").fill("What should I call you?");
  await page.getByTestId("send-chat").click();
  await page.locator('[data-testid="message-item"][data-role="user"]').nth(beforeUser).waitFor({ timeout: 20_000 });
  const userBubbleMs = Date.now() - sendStart;
  const sseDeadline = Date.now() + 15_000;
  while (sse.length <= sseMark && Date.now() < sseDeadline) await page.waitForTimeout(50);
  const firstSseMs = sse.length > sseMark ? sse[sseMark] - sendStart : null;
  const replyDeadline = Date.now() + 30_000;
  while ((await page.locator('[data-testid="message-item"][data-role="assistant"]').count()) <= beforeBot && Date.now() < replyDeadline) {
    await page.waitForTimeout(100);
  }
  const botReplyMs = (await page.locator('[data-testid="message-item"][data-role="assistant"]').count()) > beforeBot ? Date.now() - sendStart : null;

  const pane = page.getByTestId("info-pane");
  if (!(await pane.isVisible().catch(() => false))) await page.getByTestId("bot-name-button").click();
  const socketMark = sockets.length;
  const vncStart = Date.now();
  await clickTab(page, "Computer");
  await page.getByTestId("computer-tab").waitFor({ state: "visible" });
  const computerVisibleMs = Date.now() - vncStart;
  await page.getByTestId("computer-tab").getAttribute("data-vnc-state").catch(() => "");
  const connectedDeadline = Date.now() + 30_000;
  let connected = false;
  while (Date.now() < connectedDeadline) {
    if ((await page.getByTestId("computer-tab").getAttribute("data-vnc-state")) === "connected") {
      connected = true;
      break;
    }
    await page.waitForTimeout(100);
  }
  const vncConnectMs = connected ? Date.now() - vncStart : null;
  const controlStart = Date.now();
  await page.getByTestId("take-control").click();
  await page.getByText("The pointer is yours.").waitFor({ timeout: 20_000 });
  const takeControlMs = Date.now() - controlStart;
  const name = computerName();
  const viewMark = sockets.length;
  if (name) {
    spawnSync("sudo", ["docker", "exec", "-d", name, "sh", "-c", "DISPLAY=:1 xterm -geometry 40x8+40+40 -e 'i=0; while [ $i -lt 25 ]; do i=$((i+1)); echo tick $i; sleep 0.15; done'"], { stdio: "ignore" });
  }
  const duringLiveView = await sampleDuring(4000);
  const viewFrames = sockets.slice(viewMark);
  let paintLatencyMs = null;
  if (name) {
    const paintMark = sockets.length;
    const paintStart = Date.now();
    sh(["docker", "exec", name, "sh", "-c", "DISPLAY=:1 xsetroot -solid '#336699'"]);
    const paintDeadline = Date.now() + 3000;
    while (sockets.length === paintMark && Date.now() < paintDeadline) await page.waitForTimeout(20);
    paintLatencyMs = sockets.length > paintMark ? sockets[paintMark] - paintStart : null;
  }
  const gaps = [];
  for (let i = 1; i < viewFrames.length; i++) gaps.push(viewFrames[i] - viewFrames[i - 1]);
  await page.getByTestId("hand-back").click().catch(() => undefined);
  await page.getByText("The agent has the computer.").waitFor({ timeout: 10_000 }).catch(() => undefined);
  await browser.close();
  return {
    openChatRequests: { seconds: 6, total: pollHits.length, counts: pollCounts },
    duringOpenChat,
    duringLiveView,
    sendToUserBubbleMs: userBubbleMs,
    sendToFirstSseMs: firstSseMs,
    sendToBotReplyMs: botReplyMs,
    computerVisibleMs,
    vncConnectMs,
    takeControlMs,
    liveView: {
      seconds: 4,
      frames: viewFrames.length,
      fps: Math.round((viewFrames.length / 4) * 10) / 10,
      gapP50Ms: percentile(gaps, 50),
      gapP95Ms: percentile(gaps, 95),
      framesBeforeView: viewMark - socketMark,
      paintLatencyMs,
    },
  };
}

function lighthouse() {
  const result = spawnSync(
    "npx",
    [
      "--yes", "lighthouse@12.8.2", `${base}/login`,
      "--quiet",
      "--only-categories=performance",
      "--form-factor=desktop",
      "--screenEmulation.disabled",
      "--throttling-method=devtools",
      "--throttling.cpuSlowdownMultiplier=4",
      "--throttling.requestLatencyMs=0",
      "--throttling.downloadThroughputKbps=102400",
      "--throttling.uploadThroughputKbps=102400",
      "--chrome-flags=--headless=new --no-sandbox",
      "--output=json",
      `--output-path=/tmp/lh-${label}.json`,
    ],
    { encoding: "utf8", timeout: 180_000, env: { ...process.env, CHROME_PATH: "/opt/google/chrome/chrome" } },
  );
  if (result.status !== 0 || !fs.existsSync(`/tmp/lh-${label}.json`)) {
    return { error: `${result.stderr || result.stdout || "lighthouse failed"}`.slice(0, 500) };
  }
  const report = JSON.parse(fs.readFileSync(`/tmp/lh-${label}.json`, "utf8"));
  const audit = (id) => report.audits?.[id]?.numericValue ?? null;
  return {
    score: report.categories?.performance?.score ?? null,
    firstContentfulPaintMs: audit("first-contentful-paint"),
    largestContentfulPaintMs: audit("largest-contentful-paint"),
    totalBlockingTimeMs: audit("total-blocking-time"),
    speedIndexMs: audit("speed-index"),
    interactiveMs: audit("interactive"),
    transferredBytes: audit("total-byte-weight"),
  };
}

const report = { label, at: new Date().toISOString(), base, limits: limits() };
function save() {
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
}
try {
  report.bundle = bundleBytes();
  console.log("idle sample");
  report.idle = await sampleStats(4);
  save();
  console.log("throttled navigation");
  report.throttled4x = await measurePage(true);
  save();
  console.log("unthrottled navigation");
  report.unthrottled = await measurePage(false);
  save();
  console.log("interaction");
  report.interaction = await measureInteraction();
  save();
  console.log("busy sample");
  report.busy = await sampleStats(6);
  save();
  console.log("lighthouse");
  report.lighthouse = lighthouse();
  save();
} catch (error) {
  report.error = String(error && error.stack ? error.stack : error);
  save();
  throw error;
}
console.log(`wrote ${outPath}`);
console.log(JSON.stringify({
  label,
  bundleJs: report.bundle.jsBytes,
  cold: report.throttled4x.coldLogin,
  home: report.throttled4x.homeReload,
  switchBotMs: report.throttled4x.switchBotMs,
  tabs: report.throttled4x.tabs,
  interaction: report.interaction,
  lighthouse: report.lighthouse,
}, null, 2));
