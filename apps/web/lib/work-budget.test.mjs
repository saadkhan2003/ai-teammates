import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./work-budget.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const budget = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

test("clamps work budgets to the documented limits", () => {
  assert.deepEqual(budget.clampWorkBudget(1, 0), { maxSteps: 4, maxMinutes: 1 });
  assert.deepEqual(budget.clampWorkBudget(1200, 500), { maxSteps: 1000, maxMinutes: 360 });
});

test("formats clamped work budgets", () => {
  assert.equal(budget.formatWorkBudget(10, 12), "10 steps · 12 min");
  assert.equal(budget.formatWorkBudget(1, 400), "4 steps · 360 min");
});
