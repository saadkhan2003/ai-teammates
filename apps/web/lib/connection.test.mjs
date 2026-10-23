import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
globalThis.window = new EventTarget();
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const source = fs.readFileSync(new URL('./connection.ts', import.meta.url), 'utf8').replace(/^import .*react.*$/m, 'const useSyncExternalStore = () => null;');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('failure shows once, backs off, retry fires refresh, success clears', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let refreshes = 0;
  window.addEventListener(mod.REFRESH_EVENT, () => { refreshes += 1; });
  mod.reportFailure(); mod.reportFailure(); mod.reportFailure();
  assert.equal(mod.getConnectionState().failed, true);
  assert.equal(refreshes, 0);
  t.mock.timers.tick(1999); assert.equal(refreshes, 0);
  t.mock.timers.tick(1); assert.equal(refreshes, 1);
  assert.equal(mod.getConnectionState().attempt, 1);
  t.mock.timers.tick(3999); assert.equal(refreshes, 1);
  t.mock.timers.tick(1); assert.equal(refreshes, 2);
  mod.retryNow();
  assert.equal(refreshes, 3);
  assert.equal(mod.getConnectionState().attempt, 1);
  mod.reportSuccess();
  assert.equal(mod.getConnectionState().failed, false);
  t.mock.timers.tick(60000);
  assert.equal(refreshes, 3);
});

test('backoff is capped at 30s', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.deepEqual(mod.BACKOFF_MS.at(-1), 30000);
  mod.reportSuccess();
});
