import test from "node:test";
import assert from "node:assert/strict";
import { controlLabel, nextComputerView, shouldRefreshPreview, COMPUTER_PREVIEW_REFRESH_MS } from "./computer-state.mjs";

test("computer view switches between compact and full", () => {
  assert.equal(nextComputerView("compact"), "full");
  assert.equal(nextComputerView("full"), "compact");
});

test("computer control label follows the holder", () => {
  assert.equal(controlLabel("human"), "You're in control");
  assert.equal(controlLabel("agent"), "Take control");
});

test("preview refreshes only while compact and visible every three seconds", () => {
  assert.equal(shouldRefreshPreview(true, true), true);
  assert.equal(shouldRefreshPreview(true, false), false);
  assert.equal(shouldRefreshPreview(false, true), false);
  assert.equal(COMPUTER_PREVIEW_REFRESH_MS, 3000);
});
