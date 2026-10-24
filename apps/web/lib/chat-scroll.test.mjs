import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const src = ts.transpileModule(readFileSync(new URL('./chat-scroll.ts', import.meta.url), 'utf8'), {compilerOptions:{module:'esnext',target:'es2022'}}).outputText;
const {nearChatBottom, visibleChatAnchor, anchoredScrollTop, appendedAssistantText, VIRTUAL_CHAT_THRESHOLD} = await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
test('bottom following tolerates fractional pixels and overscroll but stops while reading history', () => {
  assert.equal(nearChatBottom(600.5, 1000, 400), true);
  assert.equal(nearChatBottom(620, 1000, 400), true);
  assert.equal(nearChatBottom(520, 1000, 400), false);
  assert.equal(VIRTUAL_CHAT_THRESHOLD, 50);
});
test('prepend restores the first partially visible row, preserving its intra-row offset', () => {
  const anchor = visibleChatAnchor([{id:'old',top:0,bottom:30},{id:'reading',top:30,bottom:200}], 45);
  assert.deepEqual(anchor,{id:'reading',offset:-15});
  assert.equal(anchoredScrollTop(500,45,330,anchor),800);
  assert.equal(anchoredScrollTop(800,45,30,anchor),800);
  assert.equal(visibleChatAnchor([],45),null);
});
test('resizing above a reading anchor corrects either direction without negative scrolling', () => {
  assert.equal(anchoredScrollTop(100,20,50,{id:'a',offset:0}),130);
  assert.equal(anchoredScrollTop(100,20,-10,{id:'a',offset:0}),70);
  assert.equal(anchoredScrollTop(0,20,-10,{id:'a',offset:0}),0);
});
test('announcements ignore initial history, prepends, replacements and user echo', () => {
  const m = (id,role='assistant') => ({id,role,content:id});
  assert.equal(appendedAssistantText([], [m('a')]),'');
  assert.equal(appendedAssistantText(['b'], [m('a'),m('b')]),'');
  assert.equal(appendedAssistantText(['b'], [m('b'),m('echo','user'),m('reply')]),'reply');
  assert.equal(appendedAssistantText(['gone'], [m('other')]),'');
});
