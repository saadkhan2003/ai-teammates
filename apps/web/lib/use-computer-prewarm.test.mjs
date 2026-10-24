import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('./use-computer-prewarm.ts', import.meta.url), 'utf8');
// This hook only returns a callback; exercise it without mounting a React tree.
const js = ts.transpileModule(source.replace('import { useCallback } from "react";', 'const useCallback = (callback: () => void) => callback;'),
  { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const hook = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('composer focus/input hints throttle across mounts and bot switches for 30 seconds', async (t) => {
  let now = 0;
  const requests = [];
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (...args) => { requests.push(args); return { ok: true }; });
  const focusA = hook.useComputerPrewarm('composer-a');
  focusA(); focusA();
  hook.useComputerPrewarm('composer-a')();
  assert.equal(requests.length, 1);
  hook.useComputerPrewarm('composer-b')();
  assert.equal(requests.length, 2);
  now = 29_999;
  hook.useComputerPrewarm('composer-a')();
  assert.equal(requests.length, 2);
  now = 30_000;
  focusA();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], ['/api/bots/composer-a/computer/prewarm', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
  }]);
});

test('a missing bot makes no request and failures remain best effort', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('offline'); });
  hook.useComputerPrewarm()();
  assert.equal(requests, 0);
  const focus = hook.useComputerPrewarm('offline-composer');
  assert.doesNotThrow(focus); focus();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
});
