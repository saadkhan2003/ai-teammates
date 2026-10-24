import test from "node:test";
import assert from "node:assert/strict";
import { barWidth, creditsLabel, elapsedLabel, isActiveJob, jobStatusLabel, onDemandOptions, percentLabel, resetsLabel, screenLastUsedLabel, showBackgroundPill } from "./usage-format.mjs";

test("percent and bar", () => {
  assert.equal(percentLabel(0), "0%");
  assert.equal(percentLabel(0.4), "<1%");
  assert.equal(percentLabel(67.8), "67%");
  assert.equal(barWidth(140), "100%");
  assert.equal(barWidth(-3), "0%");
  assert.equal(creditsLabel(1234.6), "1,235");
});

test("resets and on-demand", () => {
  assert.equal(resetsLabel(5), "Resets in 5 days");
  assert.equal(resetsLabel(1), "Resets in 1 day");
  assert.equal(resetsLabel(0), "Resets today");
  assert.deepEqual(onDemandOptions([10, 25]).map((o) => o.label), ["None", "$10", "$25"]);
});

test("jobs and screen labels", () => {
  assert.equal(elapsedLabel(65), "1m 5s");
  assert.equal(elapsedLabel(3700), "1h 1m");
  assert.equal(jobStatusLabel("timed_out"), "Timed out");
  assert.equal(jobStatusLabel("cancelled"), "Stopped");
  assert.ok(isActiveJob("running"));
  assert.ok(!isActiveJob("done"));
  const now = Date.parse("2026-10-24T12:00:00Z");
  assert.equal(screenLastUsedLabel("2026-10-24T11:48:00Z", now), "Screen last used 12 min ago");
  assert.equal(screenLastUsedLabel(null, now), null);
  assert.ok(showBackgroundPill(2, false));
  assert.ok(!showBackgroundPill(2, true));
  assert.ok(!showBackgroundPill(0, false));
});

test("storage and RAM labels", async () => {
  const { bytesLabel, coresLabel, storageTone } = await import("./usage-format.mjs");
  const GiB = 1024 ** 3;
  assert.equal(bytesLabel(0), "0 GB");
  assert.equal(bytesLabel(512 * 1024 * 1024), "512 MB");
  assert.equal(bytesLabel(1.25 * GiB), "1.3 GB");
  assert.equal(bytesLabel(50 * GiB), "50 GB");
  assert.equal(bytesLabel(1000), "<1 MB");
  assert.equal(coresLabel(1, 2), "1–2 CPU cores");
  assert.equal(coresLabel(2, 2), "2 CPU cores");
  assert.equal(coresLabel(0.5, 1), "0.5–1 CPU cores");
  assert.equal(storageTone("full"), "bg-clay");
  assert.equal(storageTone("warning"), "bg-amber-500");
  assert.equal(storageTone("ok"), "bg-[#1d9bf0]");
});
