import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const src = ts.transpileModule(readFileSync(new URL("./perf.ts", import.meta.url), "utf8"), { compilerOptions: { module: "esnext", target: "es2022" } }).outputText;
const perf = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

test("measurements clamp finite values and reject NaN/infinity", () => {
  assert.equal(perf.clampMs(-1), 0); assert.equal(perf.clampMs(700000), 600000);
  assert.equal(perf.clampMs(12.5), 12.5); assert.equal(perf.clampMs(NaN), null); assert.equal(perf.clampMs(Infinity), null);
});
test("route templates never send identifiers or arbitrary page text", () => {
  assert.equal(perf.routeTemplate("/bots/1234"), "/bots/[id]");
  assert.equal(perf.routeTemplate("/unknown/sensitive"), "/");
  assert.equal(perf.routeTemplate("/settings"), "/settings");
});
test("SSR helpers are no-ops", () => {
  perf.initPerf(); perf.markPerf("send"); perf.paintedPerf("send", "echo_ms"); perf.recordPerf("echo_ms", 1);
});
test("paint measures consume once and retain a bounded numeric history", () => {
  globalThis.window = { __teammatesPerf: [] };
  globalThis.location = { pathname: "/bots/private-id" };
  const frames = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  try {
    perf.markPerf("once"); perf.paintedPerf("once", "echo_ms"); perf.paintedPerf("once", "echo_ms");
    while (frames.length) frames.shift()();
    assert.equal(window.__teammatesPerf.length, 1);
    for (let i = 0; i < 1100; i++) perf.recordPerf("echo_ms", i);
    assert.equal(window.__teammatesPerf.length, 1000);
    assert.deepEqual(Object.keys(window.__teammatesPerf[0]), ["name", "value_ms", "at"]);
  } finally { delete globalThis.window; delete globalThis.location; delete globalThis.requestAnimationFrame; }
});
