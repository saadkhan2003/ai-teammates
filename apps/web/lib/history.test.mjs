import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const src = ts.transpileModule(readFileSync(new URL("./history.ts", import.meta.url), "utf8"), { compilerOptions: { module: "esnext", target: "es2022" } }).outputText;
const m = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

test("mergeHistory puts older first and drops duplicates", () => {
  const out = m.mergeHistory([{ id: "a" }, { id: "b" }, { id: "b" }, { id: "c" }], [{ id: "c", v: 1 }, { id: "d" }]);
  assert.deepEqual(out.map(x => x.id), ["a", "b", "c", "d"]);
  assert.equal(out[2].v, 1);
});

test("loadUntil pages back until the message appears or history ends", async () => {
  const have = new Set(["x"]);
  let pages = 0;
  const found = await m.loadUntil("t", id => have.has(id), async () => { pages++; if (pages === 3) have.add("t"); return true; });
  assert.equal(found, true); assert.equal(pages, 3);
  let calls = 0;
  const missing = await m.loadUntil("zz", () => false, async () => { calls++; return calls < 2; });
  assert.equal(missing, false); assert.equal(calls, 2);
  let capped = 0;
  assert.equal(await m.loadUntil("zz", () => false, async () => { capped++; return true; }, 5), false);
  assert.equal(capped, 5);
});

test("highlight holds 3 s then fades 600 ms; reduced motion is a brief static hold", () => {
  assert.deepEqual(m.highlightPlan(false), [{ phase: "on", after: 0 }, { phase: "fade", after: 3000 }, { phase: "off", after: 3600 }]);
  const r = m.highlightPlan(true);
  assert.equal(r.some(s => s.phase === "fade"), false);
  assert.ok(r[1].after <= 1500);
});
