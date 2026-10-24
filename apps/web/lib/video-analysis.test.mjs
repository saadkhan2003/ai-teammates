import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const src = fs.readFileSync(new URL('./video-analysis.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const m = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('reads a video analysis card payload and formats timeline timestamps', () => {
  const value = m.readVideoAnalysis(JSON.stringify({ videoAnalysis: { summary: 'A person walks.', timeline: [{ timestamp: 65, summary: 'A person walks.' }] } }));
  assert.equal(value.summary, 'A person walks.');
  assert.equal(value.timeline.length, 1);
  assert.equal(m.timestampLabel(value.timeline[0].timestamp), '1:05');
  assert.equal(m.readVideoAnalysis('not-json'), null);
});
