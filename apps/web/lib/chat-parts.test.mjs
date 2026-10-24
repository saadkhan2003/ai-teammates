import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const src = fs.readFileSync(new URL('./chat-parts.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const m = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('normalizeSelection trims, collapses newlines and cuts at a word boundary', () => {
  assert.deepEqual(m.normalizeSelection('  a\n\n\n\nb  '), { text: 'a\n\nb', truncated: false });
  const long = ('word '.repeat(1200)).trim();
  const r = m.normalizeSelection(long);
  assert.ok(r.truncated && r.text.length <= 4000 && r.text.endsWith('…'));
  assert.ok(!r.text.slice(0, -1).endsWith('wor'));
});

test('addQuote builds quote, comment, quote, comment in order; dedupes; limits', () => {
  let parts = m.initialParts();
  let r = m.addQuote(parts, 'one', 'm1');
  assert.ok(r.added); parts = r.parts;
  assert.deepEqual(parts.map(p => p.type), ['quote', 'text']);
  parts[1].text = 'my comment';
  r = m.addQuote(parts, 'two'); parts = r.parts;
  assert.deepEqual(parts.map(p => p.type), ['quote', 'text', 'quote', 'text']);
  assert.equal(m.addQuote(parts, 'one').reason, 'duplicate');
  let many = m.initialParts();
  for (let i = 0; i < 10; i++) many = m.addQuote(many, 'q' + i).parts;
  assert.equal(m.addQuote(many, 'extra').reason, 'limit');
});

test('payload and flatten match the server format', () => {
  let parts = m.addQuote(m.initialParts(), 'a\nb', 'x').parts;
  parts[1].text = ' yes ';
  assert.deepEqual(m.toPayload(parts), [{ type: 'quote', text: 'a\nb', sourceMessageId: 'x' }, { type: 'text', text: ' yes ' }]);
  assert.equal(m.flatten(m.toPayload(parts)), '> a\n> b\n\nyes');
  assert.ok(m.canSend(parts));
  assert.ok(!m.canSend(m.initialParts()));
});

test('removePart keeps a trailing text segment; setReply replaces', () => {
  let parts = m.addQuote(m.initialParts(), 'q').parts;
  parts = m.removePart(parts, parts[0].id);
  assert.deepEqual(parts.map(p => p.type), ['text']);
  parts = m.setReply(parts, { messageId: '1', author: 'You', excerpt: 'e' });
  parts = m.setReply(parts, { messageId: '2', author: 'You', excerpt: 'f' });
  assert.equal(parts.filter(p => p.type === 'reply').length, 1);
  assert.equal(parts[0].messageId, '2');
});

test('clamp, pill position and long-press rules', () => {
  assert.ok(!m.needsClamp(448) && m.needsClamp(460));
  const p = m.pillPosition({ left: 100, right: 300, top: 5, bottom: 20 }, { w: 120, h: 32 }, 800, 600, false);
  assert.ok(p.x >= 8 && p.y >= 8);
  const t = m.pillPosition({ left: 100, right: 300, top: 200, bottom: 220 }, { w: 120, h: 32 }, 800, 600, true);
  assert.ok(t.y > 220);
  assert.ok(m.cancelsLongPress(11, 0, false) && m.cancelsLongPress(0, 0, true) && !m.cancelsLongPress(3, 4, false));
});
