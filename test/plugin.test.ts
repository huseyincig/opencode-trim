import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../index.ts';
import { processToolEvent, setupTrim } from '../src/plugin.ts';
import { parseOptions } from '../src/config.ts';
import { PRUNED } from '../src/prune.ts';
function harness(options={}) {
 let toolCb,contextCb,compactionCb;const disposed=[];
 const ctx={options,tool:{hook:async (name,fn)=>{
   assert.equal(name,'execute.after');toolCb=fn;
   return {dispose:async()=>{disposed.push(name)}};
 }},session:{hook:async(name,fn)=>{
   if(name==='context') contextCb=fn;
   else if(name==='compaction') compactionCb=fn;
   else assert.fail(`unexpected session hook ${name}`);
   return {dispose:async()=>{disposed.push(name)}};
 }}};
 return {ctx, callbacks:()=>({toolCb,contextCb,compactionCb}), disposed};
}
function sampleEvent(content) { return {status:'completed',tool:'shell',input:{command:'npm test'},result:{content,metadata:{exitCode:0,unique:'keep-me'}}}; }
test('V2 loader contract',()=>{assert.equal(plugin.id,'opencode-trim');assert.equal(typeof plugin.setup,'function')});
test('hook registration, compression, teardown',async()=>{
 const h=harness({minOutputChars:200,maxOutputLines:25,maxOutputChars:2500,minSavingsRatio:0.05});
 const stop=await plugin.setup(h.ctx);
 const {toolCb,contextCb}=h.callbacks();assert.equal(typeof toolCb,'function');assert.equal(typeof contextCb,'function');
 const e=sampleEvent([...Array.from({length:180},(_,i)=>`status ${i}`),'Tests: 180 passed'].join('\n'));
 await toolCb(e);assert.match(e.result.content,/lines omitted/);assert.equal(e.result.metadata.unique,'keep-me');
 await stop();await stop();assert.deepEqual(h.disposed,['context','execute.after']);
});
test('array content preserves attachments and metadata',()=>{
 const e=sampleEvent([{type:'text',text:'ok\n'.repeat(200)}]);
 assert.equal(processToolEvent(e,parseOptions({minOutputChars:200,maxOutputLines:25,maxOutputChars:2500,minSavingsRatio:0.05})),true);
 assert.equal(e.result.content[0].type,'text');
});
test('does not mutate tool errors/cancellations',()=>{
 const e=sampleEvent('FAIL\n'.repeat(300));e.status='error';
 const old=structuredClone(e);assert.equal(processToolEvent(e,parseOptions()),false);assert.deepEqual(e,old);
});
test('does not mutate tool output from MCP or unknown tool',()=>{
 const e=sampleEvent('ok\n'.repeat(1000));e.tool='custom-mcp-tool';
 assert.equal(processToolEvent(e,parseOptions()),false);
});
test('does not change git diffs',()=>{
 const e=sampleEvent('diff --git a b\n'.repeat(300));e.input.command='git diff';
 assert.equal(processToolEvent(e,parseOptions()),false);
});
test('no command metadata leaves untouched',()=>{
 const e=sampleEvent('ok\n'.repeat(1000));delete e.input.command;
 assert.equal(processToolEvent(e,parseOptions()),false);
});
test('mixed media remains untouched',()=>{
 const e=sampleEvent([{type:'text',text:'ok\n'.repeat(1000)},{type:'image',data:'...'}]);
 assert.equal(processToolEvent(e,parseOptions()),false);
});
test('disabled plugin registers nothing',async()=>{
 const h=harness({enabled:false});const stop=await setupTrim(h.ctx);assert.equal(h.callbacks().toolCb,undefined);
 await stop();assert.deepEqual(h.disposed,[]);
});
test('missing host hook fails without silencing it',async()=>{
 await assert.rejects(setupTrim({options:{},tool:{hook:async()=>{}},session:{}}),/requires OpenCode V2/);
});
test('partial registration rollback',async()=>{
 let dispose=0;const ctx={options:{},tool:{hook:async()=>({dispose:async()=>dispose++})},session:{hook:async()=>{throw new Error('unavailable')}}};
 await assert.rejects(setupTrim(ctx),/unavailable/);assert.equal(dispose,1);
});
test('context event output is not persisted or sent to any MCP tool',async()=>{
 const h=harness({protectRecentMessages:4,pruneAfterToolChars:10000});await plugin.setup(h.ctx);
 const messages=[];
 for(let i=0;i<20;i++){
   messages.push({role:'assistant',content:[{type:'tool-call',id:`id${i}`,name:'shell',input:{command:'npm test'}}]});
   messages.push({role:'tool',content:[{type:'tool-result',id:`id${i}`,name:'shell',result:{value:'x'.repeat(1100)}}]});
 }
 const stored=structuredClone(messages);
 const outgoing=structuredClone(messages);
 await h.callbacks().contextCb({sessionID:'s1',model:{providerID:'test',id:'model'},messages:outgoing,tools:{},system:[],options:{}});
 assert.equal(outgoing[1].content[0].result.value,PRUNED);
 assert.equal(stored[1].content[0].result.value,'x'.repeat(1100));
});
