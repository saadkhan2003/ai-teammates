import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
const src = fs.readFileSync(new URL("./tool-status.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const { toolLabel, workingStatus } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

test("maps tools to short human labels", () => {
  assert.equal(toolLabel("message_bot", { bot: "Scout" }), "Messaging Scout");
  assert.equal(toolLabel("message_bot", "{\"bot\":\"Scout\"}"), "Messaging Scout");
  assert.equal(toolLabel("shell", { command: "ls -la" }), "Running a command");
  assert.equal(toolLabel("shell", { command: "cd app && python3 -m pytest -q" }), "Running tests");
  assert.equal(toolLabel("shell", { command: "npm run test" }), "Running tests");
  assert.equal(toolLabel("browser_open", { url: "https://example.com" }), "Browsing the web");
  assert.equal(toolLabel("write_file", { path: "/workspace/notes/plan.md" }), "Writing plan.md");
  assert.equal(toolLabel("write_file", {}), "Writing a file");
  assert.equal(toolLabel("read_file", { path: "a/b.txt" }), "Reading b.txt");
});

test("unknown tools fall back to Working on it", () => {
  assert.equal(toolLabel("something_new", {}), "Working on it");
  assert.equal(toolLabel("", undefined), "Working on it");
});

test("working row: typing beats step, step beats tool, tool beats title, title beats fallback", () => {
  const tool = { type: "tool_call", tool: "message_bot", args: { bot: "Scout" } };
  assert.equal(workingStatus([tool], true), "Typing…");
  assert.equal(workingStatus([tool, { type: "status", text: "Planning the steps" }], false), "Planning the steps");
  assert.equal(workingStatus([{ type: "status", text: "Planning the steps" }, tool], false), "Messaging Scout");
  assert.equal(workingStatus([], false, "Fix the badge"), "Fix the badge");
  assert.equal(workingStatus([], false), "Working on it");
  assert.equal(workingStatus([{ type: "tool", tool: "weird" }], false), "Working on it");
});
