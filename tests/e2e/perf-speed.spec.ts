import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { autoAllowBrowserOpens, createBot, login } from "./helpers";

type Summary = { runs: number[]; p50: number; p95: number; target_p50: number | null; target_p95: number | null };
const targets: Record<string, [number | null, number | null]> = {
  echo_ms: [50, 100], ack_ms: [1000, 1500], first_token_screen_ms: [1000, 2000], tool_chip_ms: [300, 600],
  chat_switch_ms: [100, 200], cold_chat_switch_ms: [null, null], lcp_ms: [1500, 2500], inp_proxy_ms: [100, 200],
};
const percentile = (runs: number[], p: number) => {
  const values = [...runs].sort((a, b) => a - b); const at = (values.length - 1) * p;
  return values[Math.floor(at)] + (values[Math.ceil(at)] - values[Math.floor(at)]) * (at % 1);
};

// All send clocks, including the action, live in the page. No new instrumentation is required in the old build.
async function sendMeasurements(page: Page, prompt: string): Promise<Record<string, number>> {
  return page.evaluate(async prompt => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]');
    if (!input) throw new Error("Composer missing");
    const oldMessages = new Set(document.querySelectorAll('[data-testid="message-item"]'));
    const oldTools = new Set(document.querySelectorAll('[data-testid="tool-call-card"]'));
    const result: Record<string, number> = {};
    const visible = (node: Element | null) => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
    const t0 = performance.now();
    return new Promise<Record<string, number>>((resolve, reject) => {
      let stopped = false;
      let frame = 0;
      const scheduled = new Set<string>();
      const finish = () => { stopped = true; observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(timeout); };
      const painted = (key: string) => {
        if (scheduled.has(key)) return;
        scheduled.add(key);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (stopped) return;
          result[key] = performance.now() - t0;
          if (Object.keys(result).length === 4) { finish(); resolve(result); }
        }));
      };
      const poll = () => {
        if (stopped) return;
        const fresh = [...document.querySelectorAll('[data-testid="message-item"]')].filter(n => !oldMessages.has(n) && visible(n));
        if (fresh.some(n => n.getAttribute("data-role") === "user" && n.textContent?.includes(prompt))) painted("echo_ms");
        const assistant = fresh.some(n => n.getAttribute("data-role") === "assistant" && !!n.querySelector('[data-testid="message-body"]')?.textContent?.trim());
        // Older UI versions use markdown without message-body; exclude the toolbar's action labels.
        const assistantText = assistant || fresh.some(n => n.getAttribute("data-role") === "assistant" && [...n.children].some(c => c.getAttribute("role") !== "toolbar" && !!c.textContent?.trim()));
        const delta = visible(document.querySelector('[data-testid="streaming-text"]')) && !!document.querySelector('[data-testid="streaming-text"]')?.textContent?.trim();
        const tools = [...document.querySelectorAll('[data-testid="tool-call-card"]')].some(n => !oldTools.has(n) && visible(n));
        if (visible(document.querySelector('[data-testid="working-row"]')) || assistantText || delta || tools) painted("ack_ms");
        if (assistantText || delta) painted("first_token_screen_ms");
        if (tools) painted("tool_chip_ms");
      };
      const observer = new MutationObserver(poll); observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      // Older UIs never render tool chips in the chat; after a 3 s grace past the first token, record it as unmeasured.
      const tick = () => {
        poll();
        if (!stopped && result.first_token_screen_ms !== undefined && result.echo_ms !== undefined && result.ack_ms !== undefined
          && !scheduled.has("tool_chip_ms") && performance.now() - t0 > result.first_token_screen_ms + 3000) { finish(); resolve(result); return; }
        if (!stopped) frame = requestAnimationFrame(tick);
      };
      const timeout = setTimeout(() => { finish(); reject(new Error(`Missing send measurements: ${Object.keys(result).join(",")}`)); }, 120000);
      // Native setter updates React's controlled textarea tracker. Let input commit before dispatching Enter.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, prompt);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      requestAnimationFrame(() => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
        tick();
      });
    });
  }, prompt);
}
async function switchMeasurement(page: Page, botId: string, messageId: string): Promise<number> {
  return page.evaluate(({ botId, messageId }) => new Promise<number>((resolve, reject) => {
    const anchor = [...document.querySelectorAll<HTMLAnchorElement>(`a[href="/bots/${botId}"]`)].find(n => n.getClientRects().length > 0);
    if (!anchor) throw new Error("Sidebar target missing");
    const t0 = performance.now(); let done = false; let frame = 0;
    const finish = () => { done = true; observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(timeout); };
    const poll = () => {
      const target = document.querySelector(`[data-message-id="${messageId}"]`);
      if (location.pathname === `/bots/${botId}` && target && target.getClientRects().length && !done) {
        finish(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
      }
    };
    const observer = new MutationObserver(poll); observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    const timeout = setTimeout(() => { finish(); reject(new Error("Chat switch timed out")); }, 30000);
    const tick = () => { poll(); if (!done) frame = requestAnimationFrame(tick); };
    anchor.click(); tick();
  }), { botId, messageId });
}
async function waitIdle(page: Page, botId: string) {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/bots/${botId}/tasks`);
    expect(response.ok()).toBeTruthy();
    const tasks = await response.json();
    return tasks.every((t: { status: string }) => ["completed", "failed", "cancelled"].includes(t.status));
  }, { timeout: 120000 }).toBe(true);
  await expect(page.getByTestId("working-row")).toHaveCount(0);
}
async function seed(page: Page, botId: string, text: string): Promise<string> {
  const ws = await (await page.request.get(`/api/bots/${botId}/workspace`)).json();
  const response = await page.request.post(`/api/conversations/${ws.conversationId}/messages`, { data: { content: text, asTask: false } });
  expect(response.ok()).toBeTruthy();
  await waitIdle(page, botId);
  const final = await (await page.request.get(`/api/bots/${botId}/workspace`)).json();
  return final.messages.at(-1).id;
}

test.describe("speed baseline @perf", () => {
  test("page-side clocks, ten runs per metric", async ({ page }) => {
    test.skip(process.env.LLM_PROVIDER !== "mock", "Perf tasks require explicit LLM_PROVIDER=mock");
    test.setTimeout(1200000);
    await login(page);
    const owned: string[] = [];
    const runs: Record<string, number[]> = Object.fromEntries(Object.keys(targets).map(key => [key, []]));
    const clientMarks: unknown[] = [];
    const captureMarks = async () => {
      const marks = await page.evaluate(() => {
        const w = window as Window & { __teammatesPerf?: unknown[] };
        const result = [...(w.__teammatesPerf ?? [])];
        if (w.__teammatesPerf) w.__teammatesPerf.length = 0;
        return result;
      });
      clientMarks.push(...marks);
    };
    let stopApprovals = () => {};
    let createdSecret: string | null = null;
    try {
      // Explicit mock guard above prevents a provider call on a real-provider run.
      const llmStatus = await (await page.request.get("/api/system/llm-status")).json();
      if (!llmStatus.hasKey) {
        const saved = await page.request.post("/api/secrets", { data: { namespace: "openrouter", name: "default", type: "API_KEY", value: `sk-or-v1-perf-mock-only-${Date.now()}` } });
        expect(saved.ok(), "Configure mock fixture").toBeTruthy();
        createdSecret = (await saved.json()).id;
      }
      const a = await createBot(page, `Perf A ${Date.now()}`); owned.push(a.id);
      const b = await createBot(page, `Perf B ${Date.now()}`); owned.push(b.id);
      const bLast = await seed(page, b.id, "What should I call you?");
      await page.goto(`/bots/${a.id}`);
      await expect(page.getByTestId("composer")).toBeEnabled();
      stopApprovals = autoAllowBrowserOpens(page, a.id, ["write_file"]);
      for (let i = 0; i < 10; i++) {
        await waitIdle(page, a.id);
        const measurements = await sendMeasurements(page, `Terminal: write the word pong into /workspace/notes/ping.txt [perf ${i}]`);
        for (const [key, ms] of Object.entries(measurements)) runs[key].push(ms);
        await waitIdle(page, a.id);
      }
      stopApprovals();
      const aWs = await (await page.request.get(`/api/bots/${a.id}/workspace`)).json();
      const aLast = aWs.messages.at(-1).id;
      // Prime B once. Each timed switch below returns to a previously visited chat.
      await switchMeasurement(page, b.id, bLast);
      for (let i = 0; i < 10; i++) {
        runs.chat_switch_ms.push(await switchMeasurement(page, a.id, aLast));
        await switchMeasurement(page, b.id, bLast);
      }
      for (let i = 0; i < 10; i++) {
        const cold = await createBot(page, `Perf cold ${Date.now()} ${i}`); owned.push(cold.id);
        const last = await seed(page, cold.id, `Perf cold message ${i}`);
        // A new bot has never been visited. Reload the origin chat to refresh the old build's roster.
        await captureMarks(); await page.goto(`/bots/${b.id}`);
        await expect(page.locator(`a[href="/bots/${cold.id}"]`).first()).toBeVisible();
        runs.cold_chat_switch_ms.push(await switchMeasurement(page, cold.id, last));
        await captureMarks(); await page.goto(`/bots/${b.id}`);
        const removed = await page.request.delete(`/api/bots/${cold.id}`);
        expect(removed.ok()).toBeTruthy(); owned.splice(owned.indexOf(cold.id), 1);
      }
      await captureMarks();
      await page.addInitScript(() => {
        const state = window as Window & { __perfLcp?: number; __perfEvents?: number[] };
        state.__perfEvents = [];
        new PerformanceObserver(list => { for (const e of list.getEntries()) state.__perfLcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
        // The trusted click below exposes EventTiming. Browsers without it use the page-side rAF proxy.
        new PerformanceObserver(list => { for (const e of list.getEntries()) if (e.name === "click") state.__perfEvents!.push(e.duration); }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
      });
      for (let i = 0; i < 10; i++) {
        await page.reload();
        await expect(page.getByTestId("composer")).toBeVisible();
        await page.waitForTimeout(1000); // Allow fonts/images to become LCP candidates.
        const lcp = await page.evaluate(() => (window as Window & { __perfLcp?: number }).__perfLcp);
        expect(lcp, "LCP observer must produce a measurement").toBeGreaterThan(0); runs.lcp_ms.push(lcp!);
        // Dispatch + rAF inside one evaluate; synthetic clicks are absent from EventTiming, so label as proxy.
        const rafProxy = await page.evaluate(() => new Promise<number>(resolve => {
          const target = document.querySelector<HTMLElement>('[data-testid="composer-plus"]')!;
          const t0 = performance.now(); target.click();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
        }));
        // A trusted interaction records native event timing when Chrome emits entries (>=16ms).
        await page.keyboard.press("Escape");
        await page.evaluate(() => { (window as Window & { __perfEvents?: number[] }).__perfEvents = []; });
        await page.getByTestId("composer-plus").click();
        await page.waitForTimeout(100); // Observer delivery does not change the browser's event duration.
        const eventDurations = await page.evaluate(() => (window as Window & { __perfEvents?: number[] }).__perfEvents ?? []);
        runs.inp_proxy_ms.push(eventDurations.length ? Math.max(...eventDurations) : rafProxy);
        await page.keyboard.press("Escape");
        await captureMarks();
      }
    } finally {
      stopApprovals();
      await captureMarks().catch(() => {});
      const results: Record<string, Summary | unknown[]> = {};
      for (const [key, values] of Object.entries(runs)) results[key] = {
        runs: values, p50: values.length ? percentile(values, .5) : NaN, p95: values.length ? percentile(values, .95) : NaN,
        target_p50: targets[key][0], target_p95: targets[key][1],
      };
      results.client_marks = clientMarks;
      const label = (process.env.PERF_LABEL || "run").replace(/[^a-zA-Z0-9_.-]/g, "_");
      const directory = path.resolve(__dirname, "../../test-results/perf"); mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, `${label}.json`), JSON.stringify(results, null, 2) + "\n");
      console.table(Object.entries(results).filter(([key]) => key !== "client_marks").map(([metric, value]) => {
        const s = value as Summary; return { metric, runs: s.runs.length, p50: s.p50, p95: s.p95, target_p95: s.target_p95 };
      }));
      for (const id of owned.reverse()) {
        const response = await page.request.delete(`/api/bots/${id}`);
        expect(response.ok() || response.status() === 404).toBeTruthy();
      }
      if (createdSecret) expect((await page.request.delete(`/api/secrets/${createdSecret}`)).ok()).toBeTruthy();
      if (process.env.PERF_ENFORCE === "1") for (const key of Object.keys(targets)) {
        const s = results[key] as Summary;
        if (s.target_p95 !== null && s.runs.length) expect.soft(s.p95, `${key} p95`).toBeLessThanOrEqual(s.target_p95);
      }
    }
    // tool_chip_ms is absent on UIs that do not render tool chips; with PERF_ENFORCE=1 it is required.
    for (const [key, values] of Object.entries(runs)) {
      if (key === "tool_chip_ms" && !values.length && process.env.PERF_ENFORCE !== "1") continue;
      expect(values, key).toHaveLength(10);
    }
  });
});
