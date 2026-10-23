import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('./shortcuts.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const { matchShortcut } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
test('matches requested essential, chat, and window shortcuts', () => {
  assert.equal(matchShortcut({ key: 'k', ctrlKey: true }), 'search');
  assert.equal(matchShortcut({ key: 'f', ctrlKey: true, shiftKey: true }), 'search');
  assert.equal(matchShortcut({ key: 'n', ctrlKey: true }), 'new-bot');
  assert.equal(matchShortcut({ key: 'ArrowDown', altKey: true }), 'next-bot');
  assert.equal(matchShortcut({ key: 'F11' }), 'fullscreen');
  assert.equal(matchShortcut({ key: 'x' }), null);
});
