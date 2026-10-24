import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExpression as calc, sanitizeMarkdown, parsePage, rendererBundle, rendererCss, nextGridSort, isNumericColumn, formatPageNumber, barChartLayout } from './pages-renderer.mjs';

test('grid headers expose columnheader roles and cycle aria-sort none to ascending to descending', () => {
  const source = rendererBundle();
  assert.match(source, /setAttribute\("role", "columnheader"\)/);
  assert.match(source, /setAttribute\("aria-sort", "none"\)/);
  let state = { sort: -1, ascending: true, hasSorted: false };
  const ariaSort = ['none'];
  state = nextGridSort(state.sort, state.ascending, state.hasSorted, 0);
  ariaSort.push(state.ascending ? 'ascending' : 'descending');
  state = nextGridSort(state.sort, state.ascending, state.hasSorted, 0);
  ariaSort.push(state.ascending ? 'ascending' : 'descending');
  assert.deepEqual(ariaSort, ['none', 'ascending', 'descending']);
});

test('numeric table columns align and format values with locale separators', () => {
  const rows = [['2,400', 'North'], ['12500', 'South'], ['0', 'West']];
  assert.equal(isNumericColumn(rows, 0), true);
  assert.equal(isNumericColumn(rows, 1), false);
  assert.equal(isNumericColumn([['2'], ['']], 0), true);
  assert.equal(formatPageNumber(2400), '2,400');
  assert.equal(formatPageNumber('2,400'), '2,400');
  const source = rendererBundle();
  assert.match(rendererCss, /th\.numeric,td\.numeric\{text-align:right;font-variant-numeric:tabular-nums/);
});

test('bar layout retains every point, including zero values, with positive heights and a shared baseline', () => {
  const points = barChartLayout([10, 0, 4]);
  assert.equal(points.length, 3);
  assert.ok(points.every(point => point.height > 0 && point.baseline === 206));
  assert.ok(points[0].height > points[2].height);
  const source = rendererBundle();
  assert.match(source, /chart-label/);
  assert.match(source, /chart-value/);
  assert.match(source, /setAttribute\("stroke", "var\(--line\)"\)/);
});

test('calculator respects precedence, parentheses, unary signs and own numeric inputs', () => {
  assert.equal(calc('price * quantity * (1 + tax / 100)', { price: 20, quantity: 3, tax: 10 }), 66);
  assert.equal(calc('-2 + 3 * (4 - -2)'), 16);
  assert.equal(calc('.5 + 1e2 % 30'), 10.5);
  assert.equal(calc('a', { a: 0 }), 0);
});
test('calculator rejects code, globals, inherited names, coercion and non-finite math', () => {
  for (const code of ['fetch("/api/bots")', 'document.cookie', 'parent.document', 'top.location="/"', 'constructor', '__proto__', '1/0', '0/0', '1e999', '2 ** 30', '1;2', '', '1 2', 'a.b', 'Math.max(1,2)']) assert.throws(() => calc(code));
  assert.throws(() => calc('a', { a: '2' }));
  assert.throws(() => calc('a', Object.create({ a: 2 })));
  assert.throws(() => calc('('.repeat(40) + '1' + ')'.repeat(40)));
  assert.throws(() => calc('1'.repeat(513)));
});
test('sanitizer strips active HTML while fences accept JSON objects only', () => {
  const payload = '<script>fetch("/api/bots")</script><style>body{background:url(https://evil.test)}</style><img onerror="alert(1)" src=x><iframe src=x></iframe><form action=x>bad</form># Safe';
  assert.equal(sanitizeMarkdown(payload), '# Safe');
  assert.deepEqual(parsePage('```page\n{"type":"callout","text":"Hi"}\n```')[1], { type: 'callout', text: 'Hi' });
  for (const code of ['null', '[]', 'alert(1)', '<script>bad</script>']) assert.equal(parsePage('```page\n' + code + '\n```')[1].type, 'invalid');
});
test('renderer has no HTML insertion, evaluator or network primitives and checks sender origin', () => {
  const source = rendererBundle();
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(|new Function|\bfetch\s*\(|XMLHttpRequest|document\.cookie/);
  assert.match(source, /event.source !== parent/);
  assert.match(source, /event.origin !== window.location.origin/);
  assert.match(source, /Object.create\(null\)/);
});
