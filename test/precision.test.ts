import test from 'node:test';
import assert from 'node:assert/strict';
import {compressOutput} from '../src/compress.ts';
import {compressPassingTests} from '../src/runners.ts';
import {parseOptions} from '../src/config.ts';
import {pruneContext,PRUNED} from '../src/prune.ts';
import {requestIdentity} from '../src/cache.ts';
const options=parseOptions({minOutputChars:200,maxOutputLines:20,maxOutputChars:2500,minSavingsRatio:0.01});
function conversation(n=24,size=1000,name='shell', input={command:'git status'}) {
  const messages=[];
  for(let i=0;i<n;i++){
    messages.push({id:`assistant-${i}`,role:'assistant',content:[{type:'tool-call',id:`call-${i}`,name,input}]});
    messages.push({id:`result-${i}`,role:'tool',content:[{type:'tool-result',id:`call-${i}`,name,result:{value:`result ${i}\n${'x'.repeat(size)}`}}]});
  }
  return {sessionID:'one',model:{providerID:'x',id:'y'},messages};
}
test('vitest summary permits only passing progress line removal',()=>{
 const input=[...Array.from({length:100},(_,i)=>` ✓ src/test_${i}.test.ts (1 test)`),'Test Files 100 passed (100)','Tests 100 passed'].join('\n');
 const result=compressOutput({command:'pnpm exec vitest run',text:input,exitCode:0,options});
 assert.equal(result.changed,true);
 assert.match(result.text,/passing test progress lines omitted/);
 assert.match(result.text,/Test Files 100 passed/);
});
test('never drop passing rows without completed test signature',()=>{
 const text=Array.from({length:100},(_,i)=>` ✓ test ${i}`).join('\n');
 assert.equal(compressPassingTests('vitest',text).dropped,0);
});
test('test failure and unique error rows survive or entire report is kept',()=>{
 const text=[...Array.from({length:150},(_,i)=>`progress ${i}`),
 'FAIL src/a.test.ts','AssertionError: expected 5',' at src/a.test.ts:24:8',
 'FAIL src/b.test.ts','AssertionError: expected 7',' at src/b.test.ts:13:8',
 'Test Files 2 failed (2)'].join('\n');
 const result=compressOutput({command:'vitest run',text,exitCode:1,options});
 for(const s of ['FAIL src/a.test.ts','FAIL src/b.test.ts','AssertionError: expected 5','AssertionError: expected 7',' at src/b.test.ts:13:8'])assert.ok(result.text.includes(s));
});
test('do not truncate distinct git status or unknown command listing rows',()=>{
 for(const command of ['git status --short','custom-list']){
  const text=Array.from({length:210},(_,i)=>`file_${i.toString().padStart(3,'0')}.ts`).join('\n');
  const result=compressOutput({command,text,exitCode:0,options});
  assert.equal(result.changed,false);
  assert.equal(result.text,text);
 }
});
test('do not reclaim source instruction files even when huge and old',()=>{
 const event=conversation(30,2000,'read',{path:'docs/PROTOCOL.md'});
 const result=pruneContext(event,parseOptions({pruneAfterToolChars:10000,protectRecentMessages:4,keepRecentToolResults:1}));
 assert.equal(result.pruned,0);
});
test('do not reclaim shell outputs from a compound command with side effects',()=>{
 const event=conversation(30,2000,'shell',{command:'git status && rm -rf /tmp/thing'});
 assert.equal(pruneContext(event,parseOptions({pruneAfterToolChars:10000,protectRecentMessages:4,keepRecentToolResults:1})).pruned,0);
});
test('token protection floor preserves a substantial recent tail',()=>{
 const event=conversation(36,1300);
 const result=pruneContext(event,parseOptions({pruneAfterToolChars:10000,protectRecentMessages:4,keepRecentToolResults:1,protectRecentTokens:12000}));
 assert.ok(result.pruned>0);
 for(let i=25;i<36;i++)assert.notEqual(event.messages[i*2+1].content[0].result.value,PRUNED);
});
test('tool schema reordering does not cause a cache identity change',()=>{
 const a={model:{id:'m',providerID:'p'},messages:[],system:[],tools:{z:{description:'two',input:{first:1,second:2}},a:{description:'one'}}};
 const b={...a,tools:{a:{description:'one'},z:{description:'two',input:{first:1,second:2}}}};
 assert.equal(requestIdentity(a),requestIdentity(b));
});
