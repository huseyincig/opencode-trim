import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneContext, PRUNED } from '../src/prune.js';
import { parseOptions } from '../src/config.js';
const opts=parseOptions({protectRecentMessages:4,keepRecentToolResults:1,pruneAfterToolChars:10000,pruneMinResultChars:100});
function context(n=15, size=1000) {
 const messages=[];
 for (let i=0;i<n;i++) {
   messages.push({role:'assistant',content:[{type:'tool-call',id:`call-${i}`,name:'shell',input:{command:'echo hello'}}]});
   messages.push({role:'tool',content:[{type:'tool-result',id:`call-${i}`,name:'shell',result:{type:'text',value:`ok ${i}: `+'x'.repeat(size)}}]});
 }
 return {messages};
}
test('does not prune under budget',()=>{
  const event=context(4,1000);const before=structuredClone(event);
  assert.equal(pruneContext(event,opts).pruned,0);assert.deepEqual(event,before);
});
test('prunes oldest results; protects live tail and newest result',()=>{
  const event=context(20,1100);const last=event.messages.at(-1).content[0].result.value;
  const result=pruneContext(event,opts);
  assert.ok(result.pruned>=1);assert.equal(event.messages[1].content[0].result.value,PRUNED);
  assert.equal(event.messages.at(-1).content[0].result.value,last);
  assert.equal(event.messages[0].content[0].input.command,'echo hello');
});
test('idempotent projection',()=>{
 const event=context(20,1100);pruneContext(event,opts);
 const once=structuredClone(event);pruneContext(event,opts);assert.deepEqual(event,once);
});
test('error tool results never pruned',()=>{
 const event=context(20,1100);
 event.messages[1].content[0].result={type:'error',value:'fail: '+'x'.repeat(1100)};
 pruneContext(event,opts);assert.notEqual(event.messages[1].content[0].result.value,PRUNED);
});
test('failed diagnostics remain visible',()=>{
 const event=context(20,1100);
 event.messages[1].content[0].result.value='ERROR: cannot compile ' + 'x'.repeat(1200);
 pruneContext(event,opts);assert.match(event.messages[1].content[0].result.value,/ERROR/);
});
test('question, todo and memory tools are protected',()=>{
 const event=context(20,1100);
 for(const [i,name] of [[0,'question'],[2,'todowrite'],[4,'custom-mcp-tool']]) {
  event.messages[i].content[0].name=name;
  event.messages[i+1].content[0].name=name;
 }
 pruneContext(event,opts);
 for(const i of [1,3,5]) assert.notEqual(event.messages[i].content[0].result.value,PRUNED);
});
test('unknown tool results untouched',()=>{
 const event=context(20,1100);event.messages[1].content[0].name='remote_action';
 pruneContext(event,opts);assert.notEqual(event.messages[1].content[0].result.value,PRUNED);
});
test('write/edit tool results untouched even if allowlisted',()=>{
 const event=context(20,1100);event.messages[1].content[0].name='write';
 pruneContext(event,parseOptions({...opts,pruneEligibleTools:['shell','write']}));
 assert.notEqual(event.messages[1].content[0].result.value,PRUNED);
});
test('non-text/multimodal untouched',()=>{
 const event=context(20,1100);event.messages[1].content[0].result={type:'file',value:{url:'file:abc'}};
 pruneContext(event,opts);assert.equal(event.messages[1].content[0].result.type,'file');
});
test('unknown/shuffled messages do not throw',()=>{
 const event={messages:[null,{role:'assistant',content:'bad'},{role:'tool',content:[null,{type:'tool-result',result:{value:'hello'}}]},...context(20,1000).messages]};
 assert.doesNotThrow(()=>pruneContext(event,opts));
});
