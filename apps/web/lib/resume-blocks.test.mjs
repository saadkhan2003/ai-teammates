import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

function loadModule(path, dependencyUrl) {
  let source = fs.readFileSync(new URL(path, import.meta.url), "utf8");
  if (dependencyUrl) source = source.replaceAll('"@/lib/resume-blocks"', `"${dependencyUrl}"`);
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

const resume = await loadModule("./resume-blocks.ts");
const blocks = await loadModule("./message-blocks.ts", `data:text/javascript;base64,${Buffer.from(ts.transpileModule(fs.readFileSync(new URL("./resume-blocks.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText).toString("base64")}`);
const time = "2026-10-24T12:00:00Z";
const notice = { type: "resume", event: "resumed", count: 3, attempt: 4, reason: "lease_expired", stepsUsed: 12, current: "Write report", firstAt: time, lastAt: time };
const card = { type: "resume_card", reason: "budget_reached", state: "open", taskId: "123e4567-e89b-42d3-a456-426614174000", stepsUsed: 20, maxSteps: 50, secondsUsed: 90, maxSeconds: 300, current: "Write report" };

test("parses resume notices and clamps bounded numeric values", () => {
  assert.deepEqual(resume.parseResumeBlock(notice), { kind: "resume", count: 3, attempt: 4, reason: "lease_expired", stepsUsed: 12, current: "Write report", firstAt: time, lastAt: time });
  assert.equal(resume.parseResumeBlock({ ...notice, count: 999999 }).count, 10_000);
  assert.equal(resume.parseResumeBlock({ ...notice, stepsUsed: 100000000 }).stepsUsed, 1_000_000);
});

test("rejects unknown reasons and malformed resume cards", () => {
  assert.equal(resume.parseResumeBlock({ ...notice, reason: "unknown" }), null);
  assert.equal(resume.parseResumeBlock({ ...card, reason: "unknown" }), null);
  assert.equal(resume.parseResumeBlock({ ...card, taskId: "internal-id" }), null);
});

test("formats notice copy for one and repeated interruptions", () => {
  assert.equal(resume.resumeText({ ...resume.parseResumeBlock({ ...notice, count: 1 }), kind: "resume" }), "Resumed after an interruption (attempt 4). Continuing: Write report");
  assert.equal(resume.resumeText(resume.parseResumeBlock(notice)), "Resumed 3 times in the last 12 min. Continuing: Write report");
});

test("provides the specified resume card copy", () => {
  assert.equal(resume.cardCopy("budget_reached"), "I reached my step or time budget and paused. Continue to give me more.");
  assert.equal(resume.cardCopy("no_progress"), "I stopped after two attempts with no progress, so I don't loop. Tell me what to do or continue.");
  assert.equal(resume.cardCopy("resume_exhausted"), "I was restarted too many times this hour and stopped. Continue when you're ready.");
});

test("messageBlocks parses resume JSON as a single block", () => {
  assert.deepEqual(blocks.messageBlocks(JSON.stringify(notice)), [resume.parseResumeBlock(notice)]);
  assert.deepEqual(blocks.messageBlocks(JSON.stringify(card)), [resume.parseResumeBlock(card)]);
});
