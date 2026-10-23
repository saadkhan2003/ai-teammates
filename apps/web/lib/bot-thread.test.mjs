import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
const src = fs.readFileSync(new URL("./bot-thread.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const { parseBotRow, threadRowText, threadStatusLabel, actionRowText } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

test("parses a thread row and words it by direction", () => {
  const row = parseBotRow("bot_thread", JSON.stringify({ type: "bot_thread", threadId: "t1", direction: "out", peerName: "Scout", title: "Double 21" }));
  assert.equal(row?.type, "bot_thread");
  assert.deepEqual(threadRowText(row), { lead: "Messaged Scout", title: "Double 21" });
  const inbound = parseBotRow("bot_thread", JSON.stringify({ threadId: "t1", direction: "in", peerName: "Scout", title: "Hi" }));
  assert.equal(threadRowText(inbound).lead, "Scout messaged you");
});

test("ignores other kinds and bad json", () => {
  assert.equal(parseBotRow("text", "{}"), null);
  assert.equal(parseBotRow("bot_thread", "not json"), null);
  assert.equal(parseBotRow("bot_thread", "{}"), null);
});

test("labels statuses and actions", () => {
  assert.equal(threadStatusLabel("approval"), "Waiting for your approval");
  assert.equal(threadStatusLabel("zzz"), "Working");
  assert.equal(actionRowText(parseBotRow("bot_action", JSON.stringify({ action: "update_bot", targetName: "", summary: "" }))), "Updated its bio");
  assert.equal(actionRowText(parseBotRow("bot_action", JSON.stringify({ action: "create_bot", targetName: "Scout" }))), "Created teammate Scout");
});
