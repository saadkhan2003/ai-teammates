import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
const src = fs.readFileSync(new URL("./cron.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const { cronToWords } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

test("daily and weekly schedules read as words", () => {
  assert.equal(cronToWords("0 8 * * *"), "Every day at 8:00 AM");
  assert.equal(cronToWords("0 20 * * 0"), "Every Sunday at 8:00 PM");
  assert.equal(cronToWords("30 0 * * *"), "Every day at 12:30 AM");
  assert.equal(cronToWords("0 12 * * *"), "Every day at 12:00 PM");
  assert.equal(cronToWords("0 9 * * 1-5"), "Every weekday at 9:00 AM");
  assert.equal(cronToWords("0 9 * * 7"), "Every Sunday at 9:00 AM");
});

test("intervals, hourly and monthly", () => {
  assert.equal(cronToWords("0 * * * *"), "Every hour");
  assert.equal(cronToWords("15 * * * *"), "Every hour at :15");
  assert.equal(cronToWords("*/5 * * * *"), "Every 5 minutes");
  assert.equal(cronToWords("0 7 1 * *"), "Monthly on the 1st at 7:00 AM");
  assert.equal(cronToWords("0 7 22 * *"), "Monthly on the 22nd at 7:00 AM");
});

test("anything else is a custom schedule", () => {
  assert.equal(cronToWords("0 9 1 6 *"), "Custom schedule");
  assert.equal(cronToWords("0 9,17 * * *"), "Custom schedule");
  assert.equal(cronToWords("nonsense"), "Custom schedule");
  assert.equal(cronToWords(""), "Custom schedule");
  assert.equal(cronToWords(undefined), "Custom schedule");
});
