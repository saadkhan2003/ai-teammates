import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const src = fs.readFileSync(new URL('./memory-notes.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const m = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('memory notice parser retains actions, ids, kinds, previous content and reason', () => {
  assert.deepEqual(m.parseMemoryNotice({ type: 'memory', action: 'updated', memoryId: 'm1', kind: 'rule', content: 'new', previous: 'old' }), { action: 'updated', memoryId: 'm1', kind: 'rule', content: 'new', previous: 'old', reason: undefined });
  assert.equal(m.parseMemoryNotice({ type: 'memory', action: 'blocked', reason: 'notes_full' }).action, 'blocked');
  assert.equal(m.parseMemoryNotice({ type: 'image' }), null);
});

test('memory undo window applies only to reversible notice actions', () => {
  for (const action of ['saved', 'updated', 'forgot']) assert.equal(m.undoableMemoryAction(action), true);
  for (const action of ['blocked', 'suggested']) assert.equal(m.undoableMemoryAction(action), false);
});

test('blocked memory reasons use friendly text without echoing values', () => {
  assert.equal(m.memoryReason('credential_shaped'), 'Not saved: it looked like a secret');
  assert.equal(m.memoryReason('use_vault'), 'Not saved: contact details are not kept in notes');
  assert.equal(m.memoryReason('unsafe_rule'), 'Not saved: approval and security rules cannot be changed by notes');
  assert.equal(m.memoryReason('notes_full'), 'Not saved: notes are full');
});

test('filters, search and both paged and legacy memory shapes normalize', () => {
  const rows = m.normalizeMemoryRows({ items: [{ id: 'r', kind: 'rule', content: 'Use short answers', status: 'active' }, { id: 'p', kind: 'profile', content: 'Likes tea', pinned: true }, { id: 's', kind: 'fact', content: 'Pending item', status: 'pending' }], nextCursor: 'c', counts: {} });
  assert.equal(rows.length, 3); assert.equal(m.normalizeMemoryRows([{ content: 'legacy' }])[0].content, 'legacy');
  assert.deepEqual(m.filterMemoryRows(rows, '', 'rule').map(x => x.id), ['r']);
  assert.deepEqual(m.filterMemoryRows(rows, 'tea', 'all').map(x => x.id), ['p']);
  assert.deepEqual(m.filterMemoryRows(rows, '', 'pinned').map(x => x.id), ['p']);
  assert.deepEqual(m.filterMemoryRows(rows, '', 'suggested').map(x => x.id), ['s']);
});
