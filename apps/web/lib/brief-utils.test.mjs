import test from "node:test";
import assert from "node:assert/strict";
import { formatThought } from "./brief-utils.mjs";

test("formats brief thought durations", () => {
  assert.equal(formatThought(4), "Thought 4s");
  assert.equal(formatThought(65), "Thought 1m 5s");
  assert.equal(formatThought(60), "Thought 1m");
  assert.equal(formatThought(undefined), "");
});
