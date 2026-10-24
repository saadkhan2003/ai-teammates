import assert from "node:assert/strict";
import test from "node:test";
import {
  BLINK_PERIOD_S,
  DART_AMPLITUDE,
  DART_SNAP_S,
  REST_POSE,
  SPIN_PERIOD_S,
  blinkAmount,
  breatheScales,
  dartOffset,
  easeOutCubic,
  lastMessagePreview,
  lookVector,
  poseAt,
  resolveAvatarAppearance,
  spinDegrees,
} from "./avatar-motion";
import { avatarPreviewFor, publishAvatarPreview, subscribeAvatarPreview } from "./avatar-preview";

test("spin is a 40s clockwise loop that matches at the same time", () => {
  assert.equal(spinDegrees(0), 0);
  assert.equal(spinDegrees(10), 90);
  assert.equal(spinDegrees(20), 180);
  assert.equal(spinDegrees(SPIN_PERIOD_S), 0);
  assert.ok(spinDegrees(1) > spinDegrees(0));
  assert.deepEqual(poseAt(12.5), poseAt(12.5));
});

test("blinks once every 4.6s and shuts with a snappy close", () => {
  assert.ok(BLINK_PERIOD_S >= 4 && BLINK_PERIOD_S <= 5);
  assert.equal(blinkAmount(0), 1);
  assert.equal(blinkAmount(3), 1);
  assert.ok(blinkAmount(4.23) <= 0.12);
  assert.equal(blinkAmount(4.23), blinkAmount(4.23 + BLINK_PERIOD_S));
  assert.equal(blinkAmount(4.5), 1);
  const early = 1 - blinkAmount(4.15 + 0.07 * 0.3);
  assert.ok(early > 0.5, `close should be past halfway early in the blink, was ${early}`);
});

test("eye darts use snappy easing and hold left and right", () => {
  const snapStart = 0.55;
  const at = snapStart + DART_SNAP_S * 0.3;
  const value = dartOffset(at);
  const linear = -DART_AMPLITUDE * 0.3;
  assert.ok(value < linear, `dart ${value} should outrun linear ${linear}`);
  assert.ok(Math.abs(value) > DART_AMPLITUDE * 0.6);
  assert.equal(dartOffset(1), -DART_AMPLITUDE);
  assert.equal(dartOffset(1.7), DART_AMPLITUDE);
  assert.equal(dartOffset(2.6), 0);
  assert.equal(poseAt(1).dartY, 0);
});

test("breathing wobbles the silhouette without a large stretch", () => {
  const a = breatheScales(0);
  const b = breatheScales(0.7);
  assert.notEqual(a.scaleX, b.scaleX);
  assert.notEqual(a.scaleY, b.scaleY);
  for (let step = 0; step < 20; step += 1) {
    const scales = breatheScales(step * 0.37);
    assert.ok(Math.abs(scales.scaleX - 1) < 0.05);
    assert.ok(Math.abs(scales.scaleY - 1) < 0.05);
  }
});

test("reduced-motion rest pose is still", () => {
  assert.deepEqual(REST_POSE, { spinDeg: 0, scaleX: 1, scaleY: 1, blink: 1, dartX: 0, dartY: 0 });
});

test("ease-out cubic is ahead of linear before the end", () => {
  assert.ok(easeOutCubic(0.3) > 0.6);
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
});

test("eyes look toward the pointer and stay inside the face", () => {
  assert.deepEqual(lookVector(0, 0, 24, 24), { x: 0, y: 0 });
  const right = lookVector(200, 0, 24, 24);
  const left = lookVector(-200, 10, 24, 24);
  assert.equal(right.x, 4.4);
  assert.ok(left.x < 0);
  assert.ok(Math.abs(right.y) <= 3.1);
  assert.ok(Math.abs(left.y) <= 3.1);
});

test("appearance stays on our avatar shapes", () => {
  const appearance = resolveAvatarAppearance("blob4", "#ff3045", "atlas");
  assert.equal(appearance.shapeId, "blob4");
  assert.equal(appearance.fill, "#ff3045");
  assert.notEqual(appearance.path, appearance.altPath);
  const fallback = resolveAvatarAppearance("nope", "red", "atlas");
  assert.match(fallback.fill, /^#[0-9a-fA-F]{6}$/);
  assert.ok(fallback.path.length > 10);
});

test("last-message preview collapses to one line and ellipsizes", () => {
  assert.equal(lastMessagePreview("  hello   there  "), "hello there");
  assert.equal(lastMessagePreview(""), "");
  const long = lastMessagePreview("a".repeat(80), 72);
  assert.equal(long.length, 72);
  assert.ok(long.endsWith("…"));
  assert.equal(lastMessagePreview('```question\n{"prompt":"Which format should I use?","options":["A"]}\n```'), "Which format should I use?");
});

test("preview bus keeps the latest line per bot", () => {
  const seen: string[] = [];
  const stop = subscribeAvatarPreview("atlas", (preview) => seen.push(preview));
  publishAvatarPreview("atlas", "First");
  publishAvatarPreview("atlas", "First");
  publishAvatarPreview("pulse", "Other");
  publishAvatarPreview("atlas", "Second");
  assert.deepEqual(seen, ["", "First", "Second"]);
  assert.equal(avatarPreviewFor("atlas"), "Second");
  stop();
  publishAvatarPreview("atlas", "Third");
  assert.deepEqual(seen, ["", "First", "Second"]);
});
