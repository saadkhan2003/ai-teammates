import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const src=ts.transpileModule(readFileSync(new URL('./event-patches.ts',import.meta.url),'utf8'),{compilerOptions:{module:'esnext',target:'es2022'}}).outputText;
const m=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
const workspace={bot:{id:'b',name:'Old'},tasks:[{id:'t',status:'queued'}],messages:[{id:'user',clientId:'c',content:'hi'}],approvals:[],holder:'agent'};
test('patch task and final message without losing local history or duplicating ids',()=>{
  const event={type:'task',botId:'b',task:{id:'t',status:'completed'},messages:[{id:'user',clientId:'c',content:'hi'},{id:'reply',content:'done'}]};
  const next=m.patchWorkspace(workspace,event); assert.equal(next.tasks[0].status,'completed'); assert.equal(next.messages.length,2);
  assert.equal(m.patchWorkspace(next,event).messages.length,2); assert.equal(workspace.tasks[0].status,'queued');
  assert.equal(m.patchWorkspace(workspace,{...event,botId:'other'}),workspace);
  assert.equal(m.patchWorkspace(workspace,{type:'stream.gap'}),null);
  assert.equal(m.patchWorkspace(workspace,{type:'unexpected'}),null);
});
test('known token activity needs no parent state update or refetch; roster applies small patches',()=>{
  assert.equal(m.patchWorkspace(workspace,{type:'message.delta',botId:'b',delta:'token'}),workspace);
  const roster=[{id:'b',name:'Old',attention:false}];
  assert.deepEqual(m.patchRoster(roster,{type:'task',bot:{id:'b',attention:true}}),[{id:'b',name:'Old',attention:true}]);
  assert.deepEqual(m.patchRoster(roster,{type:'bot.deleted',botId:'b'}),[]);
  assert.equal(m.patchRoster(roster,{type:'stream.gap'}),null);
});
test('tool deltas merge by index regardless of arrival order and assemble JSON arguments',()=>{
  let out=m.mergeToolDelta([],{index:1,id:'c1',name:'read_',arguments:'{"path":'});
  out=m.mergeToolDelta(out,{index:0,id:'c0',name:'search'});
  out=m.mergeToolDelta(out,{index:1,name:'file',arguments:'"a"}'});
  assert.deepEqual(out.map(t=>t.index),[0,1]); assert.equal(out[1].name,'read_file'); assert.equal(out[1].id,'c1'); assert.deepEqual(JSON.parse(out[1].arguments),{path:'a'});
});
test('delta batch schedules one frame, preserves order, and cancels unmounted work',()=>{
  const callbacks=new Map();let id=0;let requested=0;const commits=[];
  const batch=m.frameBatch(items=>commits.push(items),fn=>{requested++;callbacks.set(++id,fn);return id;},key=>callbacks.delete(key));
  batch.push('a');batch.push('b'); assert.equal(requested,1);callbacks.get(1)(); assert.deepEqual(commits,[['a','b']]);
  batch.push('c');assert.equal(requested,2);batch.stop();assert.equal(callbacks.has(2),false);assert.equal(commits.length,1);
});
test('browser.page events carry the tab list; approval patches keep relayed cards from the server list',()=>{
  const pages=[{targetId:'1',url:'u1',title:'a'},{targetId:'2',url:'u2',title:'b'}];
  const next=m.patchWorkspace({...workspace,pages:[]},{type:'browser.page',botId:'b',pages});
  assert.equal(next.pages.length,2);
  assert.equal(m.patchWorkspace({...workspace,pages:[]},{type:'browser.page',botId:'other',pages}).pages.length,0);
  const relayed=[{id:'a1',action:'delete_file',status:'pending',relayed:true,botName:'Beta'}];
  assert.equal(m.patchWorkspace(workspace,{type:'approval',botId:'b',task:{id:'t',status:'waiting_approval'},approvals:relayed}).approvals[0].relayed,true);
});
