import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const load = f => import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText).toString('base64')}`);
const { accentVars, accentFill, contrast, accentForeground } = await load('./accent.ts');
const src = fs.readFileSync(new URL('./avatars.ts', import.meta.url), 'utf8');
const swatches = [...src.matchAll(/name: "(\w+)", hex: "(#[0-9a-f]{6})"/gi)].map(m => ({ name: m[1], hex: m[2] }));

test('picker has the 14 swatches', () => assert.equal(swatches.length, 14));

test('swatch audit: every swatch keeps AA text on the accent and AA accent text/3:1 ring on the page, in dark and light', () => {
  for (const { name, hex } of swatches) {
    for (const mode of ['dark', 'light']) {
      const v = accentVars(hex, mode);
      const bg = mode === 'dark' ? '#141414' : '#fafafa';
      assert.ok(contrast(v['--bot-accent'], v['--bot-accent-fg']) >= 4.5, `${name}/${mode}: foreground on accent`);
      assert.ok(contrast(v['--bot-accent-text'], bg) >= 4.5, `${name}/${mode}: accent text on page`);
      assert.ok(contrast(v['--bot-accent-ring'], bg) >= 3, `${name}/${mode}: ring on page`);
      assert.equal(v['--user-bubble'], accentFill(hex));
      assert.equal(v['--primary-foreground'], v['--bot-accent-fg']);
    }
  }
});

test('white and yellow get dark text, black and blue get white text', () => {
  assert.equal(accentForeground('#ffffff'), '#111111');
  assert.equal(accentForeground('#facc15'), '#111111');
  assert.equal(accentForeground('#111111'), '#ffffff');
  assert.equal(accentForeground('#4f46e5'), '#ffffff');
});
