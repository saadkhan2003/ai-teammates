import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const load = f => import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText).toString('base64')}`);
const { judgeFrames, isBlankFrame, formatTimer, lumaOf } = await load('./recording.ts');
const flat = v => Array(576).fill(v);
const noisy = seed => Array.from({ length: 576 }, (_, i) => (i * 7 + seed * 40) % 200);

test('a uniform black or white screen is blank', () => {
  assert.equal(isBlankFrame(flat(0)), true);
  assert.equal(judgeFrames([flat(0), flat(0), flat(0), flat(0)]).verdict, 'blank');
  assert.equal(judgeFrames([flat(255), flat(255), flat(255)]).verdict, 'blank');
});
test('an unchanging screen is idle', () => {
  const frame = noisy(1);
  assert.equal(judgeFrames([frame, frame, frame, frame, frame]).verdict, 'idle');
  assert.equal(judgeFrames([frame]).verdict, 'idle');
});
test('a screen that changes is a real demonstration', () => {
  const r = judgeFrames([noisy(1), noisy(2), noisy(3), noisy(4)]);
  assert.equal(r.verdict, 'ok');
  assert.ok(r.changes >= 2);
});
test('tiny cursor jitter alone does not count', () => {
  const a = noisy(1); const b = a.slice(); b[10] += 20;
  assert.equal(judgeFrames([a, b, a, b]).verdict, 'idle');
});
test('timer and luma helpers', () => {
  assert.equal(formatTimer(75_000), '01:15');
  assert.equal(formatTimer(-5), '00:00');
  assert.deepEqual(lumaOf([255, 255, 255, 255]).map(Math.round), [255]);
});
