import test from "node:test";
import assert from "node:assert/strict";
import { detectKind, formatAge, groupForTimestamp, sanitizeName } from "./library.mjs";

test("detects known extensions before mime and falls back to mime for unknown extensions", () => {
  assert.equal(detectKind("photo.png", "text/plain"), "image");
  assert.equal(detectKind("sheet.unknown", "text/csv"), "sheet");
  assert.equal(detectKind("organize_documents.gs", "application/octet-stream"), "unknown");
});

test("sanitizes a display name to a safe basename", () => {
  assert.equal(sanitizeName("../../reports/hello\u0000.txt"), "hello.txt");
  assert.equal(sanitizeName("../.."), "file");
});

test("groups boundaries in Asia/Karachi around local midnight", () => {
  const now = new Date("2026-10-24T19:01:00Z"); // 00:01 in Karachi
  assert.equal(groupForTimestamp("2026-10-24T18:59:00Z", now, "Asia/Karachi"), "week");
  assert.equal(groupForTimestamp("2026-10-24T19:00:00Z", now, "Asia/Karachi"), "today");
});

test("groups the New York DST transition by local calendar date", () => {
  const afterMidnight = new Date("2026-03-08T05:01:00Z");
  assert.equal(groupForTimestamp("2026-03-08T04:59:00Z", afterMidnight, "America/New_York"), "week");
  assert.equal(groupForTimestamp("2026-03-08T05:00:00Z", afterMidnight, "America/New_York"), "today");
  const now = new Date("2026-03-08T07:01:00Z"); // 03:01 after spring-forward
  assert.equal(groupForTimestamp("2026-03-08T06:59:00Z", now, "America/New_York"), "today");
  assert.equal(groupForTimestamp("2026-03-02T05:01:00Z", now, "America/New_York"), "week");
  assert.equal(groupForTimestamp("2026-02-28T23:59:00-05:00", now, "America/New_York"), "older");
});

test("formats short relative ages", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  assert.equal(formatAge("2026-10-23T11:57:00Z", now), "3m");
  assert.equal(formatAge("2026-10-23T09:00:00Z", now), "3h");
  assert.equal(formatAge("2026-10-22T09:00:00Z", now), "1d");
});
