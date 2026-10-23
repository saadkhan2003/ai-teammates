import test from "node:test";
import assert from "node:assert/strict";
import { formatAge, groupByDay } from "./library.mjs";

test("groups library entries into today, yesterday and dates", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  const items = ["2026-10-23T08:00:00Z", "2026-10-22T08:00:00Z", "2026-10-20T08:00:00Z"].map(createdAt => ({ createdAt }));
  assert.deepEqual(groupByDay(items, now).map(group => group.day), ["Today", "Yesterday", "October 20, 2026"]);
});

test("formats short relative ages", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  assert.equal(formatAge("2026-10-23T11:57:00Z", now), "3m");
  assert.equal(formatAge("2026-10-23T09:00:00Z", now), "3h");
  assert.equal(formatAge("2026-10-22T09:00:00Z", now), "1d");
});
