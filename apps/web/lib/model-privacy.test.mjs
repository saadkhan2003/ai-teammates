import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? sources(resolve(dir, item.name)) : /\.(?:ts|tsx|js|jsx|json|css)$/.test(item.name) ? [resolve(dir, item.name)] : []);
}
test('user pages and components contain no provider branding or configured model slots', () => {
  for (const file of [...sources(resolve(root, 'app')), ...sources(resolve(root, 'components')), ...sources(resolve(root, 'lib')).filter(f => !f.endsWith(".test.mjs"))]) {
    const text = readFileSync(file, 'utf8');
    const strings = [];
    const visit = node => {
      if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) strings.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
    const visible = strings.join('\n');
    assert.doesNotMatch(visible, /(?:openrouter|anthropic|openai|gemini|claude|gpt-|deepseek|groq|llama|mistral|grok|powered by)/i, file);
    const mockSource = readFileSync(resolve(root, '../../services/mock-openrouter/server.py'), 'utf8');
    const catalog = mockSource.split('CATALOG = [')[1].split('\n]')[0];
    for (const match of catalog.matchAll(/\"id\":\s*\"([^\"]+)\"/g)) assert.ok(!visible.toLowerCase().includes(match[1].toLowerCase()), `${file}: configured model ID`);
    assert.doesNotMatch(text, /\{(?:row\.model|provider|payload\.modelLabel)[\s}]/, file);
    assert.doesNotMatch(text, /settings-model|bot\.model/, file);
  }
});
