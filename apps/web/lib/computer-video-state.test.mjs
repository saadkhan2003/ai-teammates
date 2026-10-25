import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('./computer-video-state.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const { computerVideoProgress } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const task = { id: 'video-task', title: 'Watch attached video', status: 'running' };
const progress = { type: 'video_progress', taskId: task.id, stage: 'Watching part', current: 1, total: 1 };

test('a video task suppresses desktop startup before progress arrives', () => {
  assert.equal(computerVideoProgress([task], [], false).stage, 'Preparing video');
  assert.equal(computerVideoProgress([{ ...task, title: 'Work', kind: 'video' }], [], false).taskId, task.id);
});

test('video progress wins without a desktop, including events arriving before the task snapshot', () => {
  assert.equal(computerVideoProgress([task], [progress], false), progress);
  assert.equal(computerVideoProgress([], [progress], false), progress);
  const latest = { ...progress, current: 2, total: 2 };
  assert.equal(computerVideoProgress([task], [progress, latest], false), latest);
});

test('established desktops retain normal connection and Retry behavior during video work', () => {
  assert.equal(computerVideoProgress([task], [progress], true), null);
});

test('finished video work and ordinary desktop tasks retain normal desktop behavior', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    assert.equal(computerVideoProgress([{ ...task, status }], [progress], false), null);
  }
  assert.equal(computerVideoProgress([{ ...task, title: 'Open the browser' }], [], false), null);
});
