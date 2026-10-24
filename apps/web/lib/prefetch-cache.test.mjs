import test from "node:test";
import assert from "node:assert/strict";
import { get, put } from "./prefetch-cache.mjs";

test("prefetch cache returns a fresh value and expires it at the TTL boundary", () => {
  put("/api/bots/one/workspace", { name: "warm" }, 500, 1000);
  assert.deepEqual(get("/api/bots/one/workspace", 1499), { name: "warm" });
  assert.equal(get("/api/bots/one/workspace", 1500), undefined);
});

test("prefetch cache replaces a key and evicts the oldest entry at capacity", () => {
  put("replace", 1, 5000, 0);
  put("replace", 2, 5000, 0);
  assert.equal(get("replace", 1), 2);
  for (let i = 0; i < 65; i++) put(`entry-${i}`, i, 5000, 0);
  assert.equal(get("replace", 1), undefined);
  assert.equal(get("entry-64", 1), 64);
});
