import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

function load(path) {
  const source = fs.readFileSync(new URL(path, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

const chat = await load("./chat-ui.ts");
const blocks = await load("./message-blocks.ts");

test("job count, subtitle, and live step follow status", () => {
  assert.equal(chat.jobCountLabel([{ status: "running" }, { status: "finished" }]), "2 agents");
  assert.equal(chat.jobCountLabel([{ status: "finished" }]), "1 job");
  assert.equal(chat.jobCountLabel([{ status: "merged" }, { status: "failed" }]), "2 jobs");
  assert.equal(chat.jobSubtitle({ status: "finished", prNumber: null }), "Finished");
  assert.equal(chat.jobSubtitle({ status: "finished", prNumber: 7 }), "Ready for review · #7");
  assert.equal(chat.jobSubtitle({ status: "merged", prNumber: 4 }), "Merged · #4");
  assert.equal(chat.jobSubtitle({ status: "failed", prNumber: null }), "Failed");
  assert.equal(chat.jobSubtitle({ status: "running", prNumber: null }), null);
  assert.equal(chat.jobSubtitle({ status: "tests", prNumber: 7 }), "Ready for review · #7");
  assert.equal(chat.jobIconKind({ status: "running", prNumber: 7, prUrl: "" }), "spinner");
  assert.equal(chat.jobIconKind({ status: "finished", prNumber: 7, prUrl: "" }), "pr");
  assert.equal(chat.jobIconKind({ status: "finished", prNumber: null, prUrl: "" }), "finished");
  assert.equal(chat.jobIconKind({ status: "merged", prNumber: 4, prUrl: "" }), "merged");
  assert.equal(chat.jobIconKind({ status: "failed", prNumber: null, prUrl: "" }), "failed");
  assert.equal(chat.controlActionLabel("view", false), "Take control");
  assert.equal(chat.controlActionLabel("control", false), "Stop");
  assert.equal(chat.controlActionLabel("control", true), "I'm done");
  assert.equal(chat.copyBotName("Atlas"), "Atlas copy");
  assert.equal(chat.copyBotName("Atlas copy"), "Atlas copy");
  assert.equal(chat.templateShareUrl("https://app.example/", "bot-1"), "https://app.example/bots/bot-1?template=1");
  const running = { id: "a", title: "UI batch", status: "tests", step: "", prNumber: null, prUrl: "" };
  assert.equal(chat.liveStepText(running), "Running test suites");
  assert.equal(chat.liveStepText({ ...running, step: "Editing the composer", status: "running" }), "Editing the composer");
  assert.equal(chat.liveJob([{ ...running, status: "finished" }, { ...running, id: "b", status: "queued", updatedAt: "2" }])?.id, "b");
  assert.equal(chat.liveJob([{ ...running, status: "merged" }]), null);
});

test("apply, mentions, accent, reply, and schedule helpers", () => {
  const next = chat.applyCodingJob([], { id: "a", title: "UI", status: "running", step: "Go", prNumber: null, prUrl: "" });
  assert.equal(chat.applyCodingJob(next, { id: "a", title: "UI", status: "merged", step: "", prNumber: 4, prUrl: "" })[0].status, "merged");
  assert.equal(chat.readableAccent("#ffffff"), "#111111");
  assert.equal(chat.readableAccent("#ff3045"), "#ff3045");
  assert.equal(chat.reactionTooltip("bot", "Ada", "👍"), "Ada reacted with 👍");
  assert.deepEqual(
    chat.visibleReactions("assistant", [
      { actorType: "bot", emoji: "👍" },
      { actorType: "user", emoji: "❤️" },
    ]),
    [{ actorType: "user", emoji: "❤️" }],
  );
  assert.equal(chat.visibleReactions("user", [{ actorType: "bot", emoji: "👍" }]).length, 1);
  assert.equal(chat.replySnippet("```code``` **Hello** there"), "Hello there");
  assert.deepEqual(chat.splitJobMentions("See [[job:11111111-1111-4111-8111-111111111111]] now"), [
    { kind: "text", text: "See " },
    { kind: "job", id: "11111111-1111-4111-8111-111111111111" },
    { kind: "text", text: " now" },
  ]);
  assert.equal(chat.routineSchedule("0 8 * * *"), "Every day at 8:00 AM");
  assert.equal(chat.routineSchedule("30 15 * * 1"), "Every Monday at 3:30 PM");
  assert.equal(chat.jobOpenHref("bot", { id: "job", prUrl: "" }), "/bots/bot/jobs/job");
  assert.equal(chat.safeHref("javascript:alert(1)"), null);
  assert.equal(chat.safeHref("/settings/usage"), "/settings/usage");
  assert.equal(chat.isExternalHref("https://cursor.com/agents/abc"), true);
  assert.equal(chat.isAppHref("/bots/abc/jobs/1"), true);
  assert.equal(chat.linkDisplayUrl("https://cursor.com/agents/bc-a34805ab-19fd-5b59-913c-7cde9ebbae92"), "cursor.com/agents/bc-a34805ab-19fd-5b59-913c-7cde9ebbae92");
  assert.equal(chat.linkDisplayUrl("/settings/usage"), "/settings/usage");
  const finished = chat.normalizeCodingJob({ title: "Ship", status: "merged", branch: "cursor/bot-app-awareness", prNumber: 6, files_changed: "31", additions: 1113, deletions: 26 });
  assert.equal(finished.filesChanged, 31);
  assert.equal(finished.additions, 1113);
  assert.equal(chat.showsJobResult(finished), true);
  assert.equal(chat.showsJobResult({ status: "queued", branch: "", prNumber: null, prUrl: "" }), false);
  assert.equal(chat.showsJobResult({ status: "running", branch: "main", prNumber: null, prUrl: "" }), true);
  assert.equal(chat.showsJobResult({ status: "failed", branch: "", prNumber: null, prUrl: "" }), true);
  assert.equal(chat.filesChangedLabel(1), "1 file changed");
  assert.equal(chat.filesChangedLabel(31), "31 files changed");
});

test("chat message helpers for quotes, reactions, questions, and links", () => {
  assert.equal(chat.QUOTE_HIGHLIGHT_MS, 3000);
  assert.deepEqual([...chat.QUICK_REACTIONS], ["👍", "👎", "❤️", "😂", "🎉"]);
  assert.equal(chat.pickerSide(80), "below");
  assert.equal(chat.pickerSide(20), "above");
  assert.equal(chat.pickerSide(47, 40), "above");
  assert.equal(chat.optionLetter(0), "A");
  assert.equal(chat.optionLetter(2), "C");
  assert.equal(chat.optionLetter(-1), "");
  assert.equal(chat.newMessagesLabel(1), "↓ 1 new message");
  assert.equal(chat.newMessagesLabel(4), "↓ 4 new messages");
  assert.equal(chat.quotePlacement("user"), "above");
  assert.equal(chat.quotePlacement("assistant"), "inside");
  const truncated = chat.truncateUrl("https://cursor.com/agents/bc-theme-fixes-and-more-than-fits");
  assert.equal(truncated.endsWith("…"), true);
  assert.equal(truncated.length, 36);
  assert.equal(chat.truncateUrl("https://cursor.com/agents/bc"), "cursor.com/agents/bc");
  assert.equal(chat.isExternalHref("https://cursor.com/agents/bc"), true);
  assert.equal(chat.isExternalHref("/bots/ada"), false);
  const jobs = [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Theme fixes", prUrl: "https://example.com/pull/7" }];
  assert.equal(chat.linkTitle("https://example.com/pull/7", "its live page", jobs), "Theme fixes");
  assert.equal(chat.linkTitle("/bots/ada/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "job", jobs), "Theme fixes");
  assert.equal(chat.linkTitle("/bots/ada", "Library", jobs), "Library");
});

test("message blocks keep coding jobs and video", () => {
  const jobs = blocks.messageBlocks('{"type":"coding-jobs"}');
  assert.equal(jobs[0].kind, "coding-jobs");
  const video = blocks.messageBlocks("```video\n{\"name\":\"clip.mp4\",\"url\":\"/clip.mp4\"}\n```");
  assert.equal(video[0].kind, "video");
  const page = fs.readFileSync(new URL("../app/dev/prompt-injection/page.tsx", import.meta.url), "utf8");
  const fixture = fs.readFileSync(new URL("../../../services/computer/fixtures/inject.html", import.meta.url), "utf8");
  assert.match(fixture, /Team notes/);
  assert.match(page, /Ignore your previous instructions/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(page, /<script/);
});
