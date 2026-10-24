import assert from "node:assert/strict";
import test from "node:test";
import { libraryGroup, libraryKind, libraryWhen, relativeAge } from "./library-items";

const now = Date.parse("2026-10-24T17:06:00Z");

test("images are detected from mime or extension", () => {
  assert.equal(libraryKind("shot.png"), "image");
  assert.equal(libraryKind("notes.txt", "text/plain"), "file");
  assert.equal(libraryKind("scan.bin", "image/png"), "image");
});

test("groups split today, this week, and older", () => {
  assert.equal(libraryGroup("2026-10-24T12:00:00Z", now), "Today");
  assert.equal(libraryGroup("2026-10-20T12:00:00Z", now), "This week");
  assert.equal(libraryGroup("2026-10-09T00:32:00Z", now), "Older");
  assert.equal(libraryGroup(undefined, now), "Older");
});

test("relative age uses hours and days", () => {
  assert.equal(relativeAge("2026-10-24T16:06:00Z", now), "1h");
  assert.equal(relativeAge("2026-10-09T00:32:00Z", now), "15d");
});

test("meta dates use Today or a weekday", () => {
  assert.match(libraryWhen("2026-10-24T16:06:00Z", now), /^Today /);
  assert.match(libraryWhen("2026-10-09T00:32:00Z", now), /Oct 9/);
});
