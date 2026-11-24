import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../index.ts';
import {parseOptions} from '../src/config.ts';
import {compressOutput} from '../src/compress.ts';
import {programOf,applyLineFilters} from '../src/filters.ts';
import {pruneContext,PRUNED} from '../src/prune.ts';
import {resolveModelLimit,estimateRequest,discoverModelLimits} from '../src/pressure.ts';
import {ContextCache,requestIdentity} from '../src/cache.ts';

function history(n=25,size=2000,command='npm test') {
 const messages=[];
 for(let i=0;i<n;i++) {
  messages.push({id:`callmsg-${i}`,role:'assistant',content:[{type:'tool-call',id:`call-${i}`,name:'shell',input:{command}}]});
  messages.push({id:`resultmsg-${i}`,role:'tool',content:[{type:'tool-result',id:`call-${i}`,name:'shell',result:{type:'text',value:`batch ${i}: `+'x'.repeat(size)}}]});
 }
 return {sessionID:'s',agent:'main',model:{providerID:'test',id:'small',limit:{context:8000,output:2000}},tools:{},system:[],options:{},messages};
}
function result(e,i){return e.messages[i*2+1].content[0].result.value}

test('V2 Model.Ref (id/providerID/variant, no limit) resolves caps from the catalog entry',()=>{
 const e=history(1);e.model={id:'big',providerID:'test',variant:'high'};
 const catalog=new Map([['test/big',{context:30000,input:24000,output:6000}]]);
 assert.deepEqual(resolveModelLimit(e,catalog),{context:24000,output:6000,source:'model-catalog'});
 const pressure=estimateRequest(e,catalog,parseOptions());
 assert.equal(pressure.usableTokens,15808); // 24k - max(8192,6000)
 assert.equal(pressure.estimated,true);
});
test('catalog fallback uses provider/model key but refuses missing limits',async()=>{
 const map=await discoverModelLimits({model:{list:async()=>({data:[{providerID:'p',id:'m',limit:{context:123456}}]})}});
 assert.equal(resolveModelLimit({model:{providerID:'p',id:'m'}},map).context,123456);
 assert.equal(resolveModelLimit({model:{providerID:'p',id:'other'}},map).context,undefined);
});
test('pressure results retain no fake exact-token claims',()=>{
 const result=estimateRequest({messages:[{content:[{type:'media',value:'abc'}]}],model:{id:'none'}},new Map(),parseOptions());
 assert.equal(result.ratio,undefined);
 assert.equal(result.mediaPresent,true);
 assert.equal(result.modelSource,'unavailable');
});
test('cache avoids repeated fresh pruning until force band or identity change',()=>{
 const cache=new ContextCache(),opts=parseOptions();const e=history();
 const first=cache.begin(e,opts,{ratio:0.70});assert.equal(first.allowNewDrops,true);first.finish(['key']);
 const next=cache.begin(e,opts,{ratio:0.72});assert.equal(next.allowNewDrops,false);assert.ok(next.plannedDrops.has('key'));
 assert.equal(cache.begin(e,opts,{ratio:0.9}).allowNewDrops,true);
 const other=structuredClone(e);other.model.variant='new';
 assert.notEqual(requestIdentity(e),requestIdentity(other));
 assert.equal(cache.begin(other,opts,{ratio:0.7}).allowNewDrops,true);
 cache.clear();assert.equal(cache.sessions.size,0);
});
test('replay of planned old results is stable while new candidates are deferred',()=>{
 const e=history(),opts=parseOptions({pruneAfterToolChars:10000,protectRecentMessages:4,keepRecentToolResults:1});
 const cache=new ContextCache();let gate=cache.begin(e,opts,{ratio:0.7});
 const first=pruneContext(e,opts,{pressure:{ratio:0.7},...gate});gate.finish(first.plannedIds);
 assert.ok(first.pruned>0);const observed=e.messages.map(x=>x?.content?.[0]?.result?.value).filter(x=>x===PRUNED).length;
 assert.equal(observed,first.pruned);
 const untouched=history(); gate=cache.begin(untouched,opts,{ratio:0.71});
 const second=pruneContext(untouched,opts,{pressure:{ratio:0.71},...gate});
 assert.equal(second.pruned,first.pruned);
});
test('conservative supersession prunes duplicate read slices only, not other offsets',()=>{
 const e=history(18,2200);const make=(i,offset)=>{
  const c=e.messages[2*i].content[0],r=e.messages[2*i+1].content[0];
  c.name='read';c.input={path:'src/x.ts',offset,limit:80};r.name='read';
 }; make(0,0);make(1,80);make(2,0);
 const opts=parseOptions({pruneAfterToolChars:200000,protectRecentMessages:4,keepRecentToolResults:1,supersessionMinChars:100});
 pruneContext(e,opts);assert.equal(result(e,0),PRUNED);assert.notEqual(result(e,1),PRUNED);
});
test('system/user/assistant text and tool inputs stay intact when pruning',()=>{
 const e=history();e.messages.push({role:'user',content:[{type:'text',text:'Never delete files'}]});
 e.messages.push({role:'assistant',content:[{type:'text',text:'Decision: keep rollback enabled'}]});
 const before=structuredClone(e);
 const r=pruneContext(e,parseOptions({pruneAfterToolChars:10000,protectRecentMessages:4,keepRecentToolResults:1}),{pressure:{ratio:0.96}});
 assert.ok(r.pruned>0);
 for(let i=0;i<before.messages.length;i++){
  if(i%2===0&&i<50) assert.deepEqual(e.messages[i],before.messages[i]);
 }
 assert.deepEqual(e.messages.at(-1),before.messages.at(-1));
 assert.deepEqual(e.messages.at(-2),before.messages.at(-2));
});
test('custom filters are bounded and never drop diagnostic lines',()=>{
 const opts=parseOptions({filterRules:[{program:'npm',dropPrefixes:['skip me'],dropExact:['build cache']}]});
 const out=applyLineFilters('npm test','skip me regular\nbuild cache\nwarning: skip me error\nTests: 3 passed',opts);
 assert.equal(out.dropped,2);assert.match(out.text,/warning/);assert.match(out.text,/Tests/);
});
test('custom filters refuse malformed and oversized input',()=>{
 assert.throws(()=>parseOptions({filterRules:[{program:'npm',dropPrefixes:['\n'] }]}));
 assert.throws(()=>parseOptions({filterRules:Array(25).fill({program:'npm'})}));
 assert.throws(()=>parseOptions({pressureStartRatio:0.9,pressureForceRatio:0.7}));
});
test('packaged plugin defaults avoid any compaction summary operation',async()=>{
 const options=parseOptions();assert.equal(options.compactionInputPruning,false);
 const installed=[];const callbacks={};
 const ctx={options,model:{list:async()=>({data:[]})},tool:{hook:async(n,cb)=>{callbacks[n]=cb;installed.push(n);return{dispose:async()=>{}}}},session:{hook:async(n,cb)=>{callbacks[n]=cb;installed.push(n);return{dispose:async()=>{}}}}};
 const dispose=await plugin.setup(ctx);
 assert.deepEqual(installed,['execute.after','context','fork']);
 assert.equal('compaction' in callbacks,false);
 await dispose();
});
test('explicit compaction-input mode only prunes tool results; never synthesizes result',async()=>{
 const callbacks={};const registrations=[];
 const ctx={options:{compactionInputPruning:true,pruneAfterToolChars:10000,protectRecentMessages:4,keepRecentToolResults:1},
 model:{list:async()=>({data:[]})}, tool:{hook:async(n,fn)=>{callbacks[n]=fn;return{dispose:async()=>registrations.push(n)}}},session:{hook:async(n,fn)=>{callbacks[n]=fn;return{dispose:async()=>registrations.push(n)}}}};
 const stop=await plugin.setup(ctx);const e=history();await callbacks.compaction(e);
 assert.equal(e.result,undefined);assert.ok(e.messages.some((m)=>m.content.some((p)=>p?.result?.value===PRUNED)));
 await stop();assert.deepEqual(registrations,['fork','compaction','context','execute.after']);
});
test('no compression when failure signals would be lost',()=>{
 const opt=parseOptions({minOutputChars:200,maxOutputLines:20,maxOutputChars:2000,minSavingsRatio:0});
 const lines=Array.from({length:30},(_,i)=>`ERROR at src/${i}.ts:${i+1}:1`);
 const text=lines.join('\n')+'\nTests: 30 failed';
 const got=compressOutput({command:'npm test',text,exitCode:1,options:opt});
 assert.equal(got.changed,false);assert.equal(got.text,text);
});
test('script program identifier does not execute commands',()=>{
 assert.equal(programOf('pnpm exec eslint src/'), 'pnpm');
 assert.equal(programOf('python3 -m pytest tests/'), 'pytest');
});

test('non-shell list tools fold only identical lines and never trim distinct search hits',async()=>{
 const {processToolEvent}=await import('../src/plugin.ts');
 const opts=parseOptions({minOutputChars:200,minSavingsRatio:0.05});
 const e={status:'completed',tool:'grep',input:{pattern:'foo'},result:{content:'same row\n'.repeat(180)+'different hit at 42',metadata:{source:'another-plugin'}}};
 assert.equal(processToolEvent(e,opts),true);
 assert.match(e.result.content,/identical lines omitted/);
 assert.match(e.result.content,/different hit at 42/);
 assert.equal(e.result.metadata.source,'another-plugin');
 const unknown={...e,tool:'custom-mcp-tool',result:{content:'same row\n'.repeat(180)}};
 assert.equal(processToolEvent(unknown,opts),false);
 const many={...e,tool:'grep',result:{content:Array.from({length:200},(_,i)=>`file.ts:${i}:hit`).join('\n')}};
 assert.equal(processToolEvent(many,opts),false);
});
test('unpaired native tool results are kept even if allowlisted',()=>{
 const e=history();e.messages[0].content[0].id='unrelated';
 const before=result(e,0);pruneContext(e,parseOptions({pruneAfterToolChars:10000,protectRecentMessages:4,keepRecentToolResults:1}));
 assert.equal(result(e,0),before);
});
