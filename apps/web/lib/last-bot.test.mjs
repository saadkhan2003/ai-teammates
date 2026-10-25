import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./last-bot.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const module = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

test("home route returns to the last bot, falls back to the first bot, and handles empty rosters", () => {
  const bots = [{ id: "first" }, { id: "last/with space" }];
  assert.equal(module.lastBotPath(bots, "last/with space"), "/bots/last%2Fwith%20space");
  assert.equal(module.lastBotPath(bots, "missing"), "/bots/first");
  assert.equal(module.lastBotPath([], "missing"), null);
});
