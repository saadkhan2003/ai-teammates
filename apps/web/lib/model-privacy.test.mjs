import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? sources(resolve(dir, item.name)) : /\.tsx$/.test(item.name) ? [resolve(dir, item.name)] : []);
}
test('user pages and components contain no provider branding or configured model slots', () => {
  for (const file of [...sources(resolve(root, 'app')), ...sources(resolve(root, 'components'))]) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\b(?:OpenRouter|Anthropic|OpenAI|Gemini|Powered by|claude-[\w.-]+|gpt-[\w.-]+)\b/, file);
    assert.doesNotMatch(text, /\{(?:row\.model|provider|payload\.modelLabel)[\s}]/, file);
    assert.doesNotMatch(text, /settings-model|bot\.model/, file);
  }
});
