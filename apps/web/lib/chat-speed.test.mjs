import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const src = ts.transpileModule(readFileSync(new URL('./chat-speed.ts', import.meta.url), 'utf8'), { compilerOptions: { module: 'esnext', target: 'es2022' } }).outputText;
const { Lru, mergeOptimistic } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
test('optimistic replacement dedupes server and client ids, preserving failures', () => {
  assert.deepEqual(mergeOptimistic([{id:'server',clientId:'client',content:'real'}], [{id:'client',clientId:'client'}, {id:'failed'}]), [{id:'server',clientId:'client',content:'real'}, {id:'failed'}]);
  assert.deepEqual(mergeOptimistic([{id:'client'}], [{id:'client'}]), [{id:'client'}]);
});
test('LRU reads refresh recency, updates do not evict an extra entry, and capacity is bounded', () => {
  const cache = new Lru(2); cache.set('a',1); cache.set('b',2); assert.equal(cache.get('a'),1);
  cache.set('c',3); assert.equal(cache.get('b'),undefined); cache.set('a',4); assert.equal(cache.get('c'),3);
  assert.equal(cache.get('a'),4); cache.clear(); assert.equal(cache.get('a'),undefined);
});
