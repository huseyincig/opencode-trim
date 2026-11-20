import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOptions} from '../src/config.js';
import {ContextCache,MAX_PLANNED} from '../src/cache.js';
import {pruneContext,PRUNED,protectedShell,MAX_PARTS_PER_MESSAGE} from '../src/prune.js';

const opts=parseOptions({protectRecentMessages:4,keepRecentToolResults:1,pruneAfterToolChars:10000,pruneMinResultChars:100});
function arcs(n,size=1100,{name='shell',input={command:'echo hi'},inputOf,sid='s',extra={}}={}){
  const messages=[];
  for(let i=0;i<n;i++){
    const inp=inputOf?inputOf(i):input;
    messages.push({id:`a-${i}`,role:'assistant',content:[{type:'tool-call',id:`c-${i}`,name,input:inp}]});
    messages.push({id:`r-${i}`,role:'tool',content:[{type:'tool-result',id:`c-${i}`,name,...extra,result:{type:'text',value:`out ${i}\n`+'x'.repeat(size)}}]});
  }
  return {sessionID:sid,model:{providerID:'p',id:'m'},tools:{},system:[],messages};
}
const val=(e,i)=>e.messages[i*2+1].content[0].result.value;
const run=(e,o=opts)=>pruneContext(e,o,{allowNewDrops:true,plannedDrops:new Set()});

test('absolute-budget need admits drops with unmeasurable ratio, replays, and does not churn',()=>{
  const cache=new ContextCache();
  const small=arcs(4,1000);
  let gate=cache.begin(small,opts,{ratio:undefined});
  const r0=pruneContext(small,opts,{pressure:{ratio:undefined},...gate});
  assert.equal(r0.pruned,0);gate.finish(r0.plannedIds);

  const big=arcs(20,1100);
  gate=cache.begin(big,opts,{ratio:undefined});
  assert.equal(gate.allowNewDrops,true);
  const r1=pruneContext(big,opts,{pressure:{ratio:undefined},...gate});
  assert.ok(r1.pruned>0);
  assert.equal(val(big,0),PRUNED);
  gate.finish(r1.plannedIds);
  const committed=[...r1.plannedIds];
  assert.ok(committed.length>0);
  assert.ok(committed[0].startsWith('shell:c-0:'));

  // Same history again: no new admission, but committed ids replay identically.
  const again=arcs(20,1100);
  gate=cache.begin(again,opts,{ratio:undefined});
  assert.equal(gate.allowNewDrops,false);
  for(const id of committed)assert.ok(gate.plannedDrops.has(id));
  const r2=pruneContext(again,opts,{pressure:{ratio:undefined},...gate});
  assert.deepEqual(r2.plannedIds,committed);
  // Small growth (< quarter budget) also does not re-admit.
  const grown=arcs(21,1100);
  assert.equal(cache.begin(grown,opts,{ratio:undefined}).allowNewDrops,false);
});

const contentShape=e=>{
  for(let i=0;i<e.messages.length;i++){
    const r=e.messages[i].content[0];
    if(r.type==='tool-result')r.result={type:'content',value:[{type:'text',text:'x'.repeat(1100)}]};
  }
  return e;
};

test('real V2 content-array shell results count toward absolute-budget admission',()=>{
  const cache=new ContextCache();
  const small=contentShape(arcs(4,1000));
  let gate=cache.begin(small,opts,{ratio:undefined});
  assert.equal(gate.allowNewDrops,true); // first sight of a session is a natural bust
  gate.finish([]);
  const later=contentShape(arcs(4,1000));
  assert.equal(cache.begin(later,opts,{ratio:undefined}).allowNewDrops,false);

  const big=contentShape(arcs(20,1100));
  gate=cache.begin(big,opts,{ratio:undefined});
  assert.equal(gate.allowNewDrops,true);
  // Single-text content arrays are safely prunable.
  assert.ok(pruneContext(big,opts,{pressure:{ratio:undefined},...gate}).pruned>0);
  // result.content text parts count too.
  const alt=arcs(20,1100);
  for(const m of alt.messages)if(m.role==='tool')m.content[0].result={type:'content',content:[{type:'text',text:'x'.repeat(1100)}]};
  assert.equal(new ContextCache().begin(alt,opts,{ratio:undefined}).allowNewDrops,true);
  const alt2=structuredClone(alt);alt2.sessionID='s2';
  const c2=new ContextCache();c2.begin(arcs(4,1000,{sid:'s2'}),opts,{ratio:undefined});
  assert.equal(c2.begin(alt2,opts,{ratio:undefined}).allowNewDrops,true);
});

test('size mark resets when provider identity changes',()=>{
  const cache=new ContextCache();
  cache.begin(arcs(4,1000),opts,{ratio:undefined});
  assert.equal(cache.begin(arcs(20,1100),opts,{ratio:undefined}).allowNewDrops,true); // mark=22000
  const other=arcs(4,1000);other.model.id='other';
  assert.equal(cache.begin(other,opts,{ratio:undefined}).allowNewDrops,true); // natural bust
  const grown=arcs(20,1100);grown.model.id='other';
  grown.messages[1].content[0].result.value+='y'.repeat(500); // +500 < quarter budget over the old mark
  assert.equal(cache.begin(grown,opts,{ratio:undefined}).allowNewDrops,true);
});

test('mutating shell commands are never pruned; read-only forms stay eligible',()=>{
  const bad=['find /tmp -type f -delete','find /tmp -type f -exec true','eslint --fix src','biome check --write .',
    'prettier --write .','cargo clippy --fix','git branch -D feature','git branch newbranch','git diff --output=x'];
  for(const command of bad){
    const e=arcs(20,1100,{input:{command}});
    assert.equal(run(e).pruned,0,command);assert.notEqual(val(e,0),PRUNED,command);
  }
  for(const command of ['find /tmp -type f -name x','eslint src','git branch --list','git log --oneline']){
    const e=arcs(20,1100,{input:{command}});
    assert.ok(run(e).pruned>0,command);assert.equal(val(e,0),PRUNED,command);
  }
});

test('supersession respects workdir and query options',()=>{
  const o=parseOptions({...opts,supersessionMinChars:100,pruneAfterToolChars:2000000});
  const cases=[
    ['shell',{command:'git log --oneline',workdir:'/repoA'},{command:'git log --oneline',workdir:'/repoB'}],
    ['shell',{command:'git log --oneline',cwd:'/repoA'},{command:'git log --oneline',cwd:'/repoB'}],
    ['grep',{pattern:'foo',path:'.',i:true},{pattern:'foo',path:'.'}],
    ['grep',{pattern:'foo',include:'*.js'},{pattern:'foo',include:'*.ts'}],
    ['glob',{pattern:'*.js',type:'file'},{pattern:'*.js',type:'dir'}],
    ['grep',{pattern:'foo',workdir:'/a'},{pattern:'foo',workdir:'/b'}],
  ];
  for(const [name,a,b] of cases){
    const e=arcs(20,1100,{name,inputOf:i=>i===0?a:i===1?b:{pattern:`z${i}`,command:`echo ${i}`}});
    const out=pruneContext(e,o,{allowNewDrops:true,plannedDrops:new Set()});
    assert.equal(out.pruned,0,JSON.stringify([a,b]));
  }
  // Identical effective input still supersedes.
  const same=arcs(20,1100,{name:'grep',inputOf:i=>i<2?{pattern:'foo',include:'*.js',timeout:i}:{pattern:`z${i}`}});
  const out=pruneContext(same,o,{allowNewDrops:true,plannedDrops:new Set()});
  assert.ok(out.pruned>=1);assert.equal(val(same,0),PRUNED);
});

test('unknown option keys use own-property check',()=>{
  for(const key of ['constructor','toString','__proto__']){
    const options=JSON.parse(`{${JSON.stringify(key)}:1}`);
    assert.throws(()=>parseOptions(options),/unknown options/,key);
  }
});

test('accessor never invokes a setter or replaces a non-data property',()=>{
  const e=arcs(20,1100);
  let called=0;
  const result=e.messages[1].content[0].result;
  const text=result.value;
  delete result.value;
  Object.defineProperty(result,'value',{enumerable:true,configurable:true,get:()=>text,set:()=>{called++;throw new Error('setter');}});
  assert.doesNotThrow(()=>run(e));
  assert.equal(called,0);
  const frozen=arcs(20,1100);Object.freeze(frozen.messages[1].content[0].result);
  assert.doesNotThrow(()=>run(frozen));
  assert.notEqual(val(frozen,0),PRUNED);
});

test('large write-style input is size-bounded and does not throw',()=>{
  const e=arcs(20,1100);
  e.messages[0].content[0].input={command:'echo hi',content:'y'.repeat(50_000_000)};
  const cyc={};cyc.self=cyc;e.messages[2].content[0].input=cyc;
  const t=Date.now();
  assert.doesNotThrow(()=>run(e));
  assert.ok(Date.now()-t<2000);
});

test('process/command exit notices mark results as failures',()=>{
  for(const notice of ['Process exited with code 2','Command exited with code 127']){
    const e=arcs(20,1100);
    e.messages[1].content[0].result={type:'content',value:[{type:'text',text:'x'.repeat(1100)},{type:'text',text:notice}]};
    const e2=arcs(20,1100);
    e2.messages[1].content[0].result.value+=`\n${notice}`;
    run(e);run(e2);
    assert.equal(e.messages[1].content[0].result.type,'content',notice);
    assert.notEqual(val(e2,0),PRUNED,notice);
  }
  const ok=arcs(20,1100);ok.messages[1].content[0].result.value+='\nProcess exited with code 0';
  run(ok);assert.equal(val(ok,0),PRUNED);
});

test('loosely tagged results carrying attachment/file fields are untouched',()=>{
  for(const field of ['attachments','files','file','image']){
    const e=arcs(20,1100);
    delete e.messages[1].content[0].result.type;
    e.messages[1].content[0].result[field]=field==='file'||field==='image'?{url:'file:x'}:[{url:'file:x'}];
    run(e);
    assert.notEqual(val(e,0),PRUNED,field);
  }
  const top=arcs(20,1100,{extra:{attachments:[{url:'f'}]}});
  run(top);assert.notEqual(val(top,0),PRUNED);
  const plain=arcs(20,1100);delete plain.messages[1].content[0].result.type;
  run(plain);assert.equal(val(plain,0),PRUNED);
});

test('plannedDrops is bounded by evicting only the oldest ids (explicit limitation)',()=>{
  const cache=new ContextCache();const e=arcs(1);
  const gate=cache.begin(e,opts,{ratio:0});
  const ids=Array.from({length:MAX_PLANNED+10},(_,i)=>`id-${i}`);
  gate.finish(ids);
  assert.equal(gate.plannedDrops.size,MAX_PLANNED);
  assert.equal(gate.plannedDrops.has('id-0'),false); // oldest beyond the bound may resurrect
  assert.equal(gate.plannedDrops.has('id-10'),true);  // everything newer is retained
  assert.equal(gate.plannedDrops.has(`id-${MAX_PLANNED+9}`),true);
  assert.equal(cache.begin(e,opts,{ratio:0}).plannedDrops.size,MAX_PLANNED);
});

const sup=parseOptions({...opts,supersessionMinChars:100,pruneAfterToolChars:2000000});
const runSup=e=>pruneContext(e,sup,{allowNewDrops:true,plannedDrops:new Set()});

test('non-read later query with smaller limit/offset/count/range never supersedes a broader one',()=>{
  const pairs=[
    ['grep',{pattern:'foo',limit:100},{pattern:'foo',limit:5}],
    ['glob',{pattern:'*.js',offset:0},{pattern:'*.js',offset:50}],
    ['search',{query:'foo',count:50},{query:'foo',count:10}],
    ['find',{pattern:'foo',startLine:1,endLine:500},{pattern:'foo',startLine:1,endLine:10}],
    ['ls',{path:'/d',limit:100},{path:'/d',limit:5}],
    ['list',{path:'/d',offset:0},{path:'/d',offset:20}],
  ];
  for(const [name,a,b] of pairs){
    const e=arcs(20,1100,{name,inputOf:i=>i===0?a:i===1?b:{pattern:`z${i}`,path:`/z${i}`,query:`z${i}`}});
    assert.equal(runSup(e).pruned,0,name);
    assert.notEqual(val(e,0),PRUNED,name);
  }
  // Identical query (same limit) still supersedes; read range coverage is kept.
  const same=arcs(20,1100,{name:'grep',inputOf:i=>i<2?{pattern:'foo',limit:7}:{pattern:`z${i}`}});
  assert.ok(runSup(same).pruned>=1);assert.equal(val(same,0),PRUNED);
  const cover=arcs(20,1100,{name:'read',inputOf:i=>i===0?{path:'/f',offset:10,limit:10}:i===1?{path:'/f',offset:0,limit:100}:{path:`/z${i}`}});
  assert.ok(runSup(cover).pruned>=1);assert.equal(val(cover,0),PRUNED);
  const narrow=arcs(20,1100,{name:'read',inputOf:i=>i===0?{path:'/f',offset:0,limit:100}:i===1?{path:'/f',offset:10,limit:10}:{path:`/z${i}`}});
  assert.equal(runSup(narrow).pruned,0);assert.notEqual(val(narrow,0),PRUNED);
});

test('exit failures are detected in plain string, result.value and state.output',()=>{
  const texts=['exit code: 2','Process exited with code: 2','Command exited with code: 127'];
  for(const t of texts){
    const plain=arcs(20,1100);
    plain.messages[1].content[0].result=`out\n${'x'.repeat(1100)}\n${t}`;
    const keep=plain.messages[1].content[0].result;
    run(plain);
    assert.equal(plain.messages[1].content[0].result,keep,`plain ${t}`);
    const v=arcs(20,1100);v.messages[1].content[0].result.value+=`\n${t}`;
    run(v);assert.notEqual(val(v,0),PRUNED,`value ${t}`);
    const st=arcs(20,1100);
    st.messages[1].content[0]={type:'tool',id:'c-0',tool:'shell',state:{status:'completed',input:{command:'echo hi'},output:`out\n${'x'.repeat(1100)}\n${t}`}};
    const o=st.messages[1].content[0].state.output;
    run(st);assert.equal(st.messages[1].content[0].state.output,o,`state ${t}`);
  }
  // Zero exit stays eligible in every shape.
  const plain=arcs(20,1100);plain.messages[1].content[0].result=`out\n${'x'.repeat(1100)}\nexit code: 0`;
  run(plain);assert.equal(plain.messages[1].content[0].result,PRUNED);
  const st=arcs(20,1100);
  st.messages[1].content[0]={type:'tool',id:'c-0',tool:'shell',state:{status:'completed',input:{command:'echo hi'},output:`out\n${'x'.repeat(1100)}\nProcess exited with code: 0`}};
  run(st);assert.equal(st.messages[1].content[0].state.output,PRUNED);
});

test('measured low ratio admits absolute-budget drops; stable history does not re-admit; unmeasurable does',()=>{
  const cache=new ContextCache();
  cache.begin(arcs(4,1000),opts,{ratio:0.1});
  const big=arcs(20,1100);
  const gate=cache.begin(big,opts,{ratio:0.1});
  assert.equal(gate.allowNewDrops,true);
  const r=pruneContext(big,opts,{pressure:{ratio:0.1},...gate});
  assert.ok(r.pruned>0);assert.equal(val(big,0),PRUNED);
  // stable over-budget history (same size) must not re-admit
  assert.equal(cache.begin(arcs(20,1100),opts,{ratio:0.1}).allowNewDrops,false);
  const c2=new ContextCache();c2.begin(arcs(4,1000),opts,{ratio:undefined});
  assert.equal(c2.begin(arcs(20,1100),opts,{ratio:undefined}).allowNewDrops,true);
});

test('mutating package scripts and tool flags are never pruned; safe forms stay eligible',()=>{
  const bad=['npm run lint:fix','pnpm run test:update','bun run format:write','npm run db:migrate','npm run clean','npm run reset',
    'npm test -- --updateSnapshot','npm test -- -u','npm test -- --update-snapshot','pnpm test --update-snapshots','bun test --update-snapshots','vitest run --update-snapshot','vitest --update-snapshots','tsc --init','eslint --init','jest --init','biome init','biome migrate',
    'pytest --cache-clear','pytest --basetemp=/tmp/x','jest --clearCache','jest --clear-cache','tree -oOUT','tree -aoOUT','tree -o out.txt'];
  for(const command of bad){
    const e=arcs(20,1100,{input:{command}});
    assert.equal(run(e).pruned,0,command);assert.notEqual(val(e,0),PRUNED,command);
  }
  for(const command of ['npm run lint','npm test','pnpm run typecheck','bun run build','tsc --noEmit','jest --coverage','biome check .','pytest -q','tree -L 2']){
    const e=arcs(20,1100,{input:{command}});
    assert.ok(run(e).pruned>0,command);assert.equal(val(e,0),PRUNED,command);
  }
});

test('huge option values and many keys produce no key and do not throw',()=>{
  const many={};for(let i=0;i<5000;i++)many[`k${i}`]=i;
  const deep={a:{b:{c:{d:{e:{f:1}}}}}};
  const inputs=[{pattern:'foo',opt:'y'.repeat(50_000_000)},{pattern:'foo',opt:{big:'y'.repeat(50_000_000)}},
    {pattern:'foo',opt:Array.from({length:100000},()=>'a')},{pattern:'foo',...many},{pattern:'foo',opt:deep},
    {pattern:'foo',opt:Object.fromEntries(Array.from({length:1000},(_,i)=>[`k${i}`,i]))}];
  const t=Date.now();
  for(const input of inputs){
    const e=arcs(20,1100,{name:'grep',inputOf:i=>i<2?input:{pattern:`z${i}`}});
    assert.doesNotThrow(()=>runSup(e));
    assert.equal(runSup(arcs(20,1100,{name:'grep',inputOf:i=>i<2?input:{pattern:`z${i}`}})).pruned,0);
  }
  for(const name of ['read','ls']){
    const e=arcs(20,1100,{name,inputOf:i=>i<2?{path:'/p'.repeat(100_000),extra:'y'.repeat(600)}:{path:`/z${i}`}});
    assert.equal(runSup(e).pruned,0,name);
  }
  assert.ok(Date.now()-t<5000);
  // Message token walk with a huge content array and object keys must stay bounded.
  const e=arcs(20,1100);
  e.messages[0].content[0].input=Object.fromEntries(Array.from({length:100000},(_,i)=>[`k${i}`,'v']));
  e.messages.push({id:'big',role:'user',content:Array.from({length:100000},()=>({type:'text',text:'t'}))});
  assert.doesNotThrow(()=>run(e));
});

test('concurrent live replacement of the result is observed and not overwritten',()=>{
  for(const mode of ['value','plain','state']){
    const e=arcs(20,1100);
    const text=`out\n${'x'.repeat(1100)}`;
    if(mode==='plain')e.messages[1].content[0].result=text;
    else if(mode==='state')e.messages[1].content[0]={type:'tool',id:'c-0',tool:'shell',state:{status:'completed',input:{command:'echo hi'},output:text}};
    const part=e.messages[1].content[0];
    const target=()=>mode==='plain'?part.result:mode==='state'?part.state.output:part.result.value;
    const swapIn=()=>{
      if(mode==='plain')part.result='REPLACED';
      else if(mode==='state')part.state.output='REPLACED';
      else part.result.value='REPLACED';
    };
    // A later hook swaps the text in the middle of our pass (during another entry's read).
    const swap='REPLACED';
    // The own-data guard rejects a Proxy messages array outright (fail closed):
    // nothing is a candidate, so nothing can be rewritten.
    const proxied={...e,messages:new Proxy(e.messages,{})};
    assert.equal(run(proxied).pruned,0,`${mode} proxy rejected`);
    assert.notEqual(target(),swap,mode);
    assert.equal(target().length>=1100,true,`${mode} untouched`);
    // Deterministic swap after candidate capture and before commit: pruneContext
    // consults plannedDrops.has(id) per entry after candidates() captured the
    // text, so a Set subclass on plain data is a compatible mutation hook.
    let fired=0;
    class HookSet extends Set{
      has(id){
        if(!fired&&id.startsWith('shell:c-0:')){fired++;swapIn();}
        return super.has(id);
      }
    }
    const out=pruneContext(e,opts,{allowNewDrops:true,plannedDrops:new HookSet()});
    assert.equal(fired,1,`${mode} hook fired between capture and commit`);
    assert.equal(target(),swap,`${mode} swapped text survives`);
    assert.ok(!out.plannedIds.some(id=>id.startsWith('shell:c-0:')),mode);
    // // replacement before the pass: live getter must see it, original no longer matches
    run(e);
    assert.equal(target(),swap,mode);
  }
});

test('massive workdir/cwd and huge top-level key names give no key, no false supersession, bounded time',()=>{
  const big='/w'.repeat(25_000_000);
  const huge={pattern:'foo',['k'.repeat(20_000_000)]:1};
  const cases=[
    ['grep',{pattern:'foo',workdir:big}],['grep',{pattern:'foo',cwd:big}],
    ['shell',{command:'git log --oneline',workdir:big}],['read',{path:'/p',cwd:big}],
    ['grep',huge],['glob',huge],['read',{path:'/p',...huge}],
  ];
  const t=Date.now();
  for(const [name,input] of cases){
    const mk=()=>arcs(20,1100,{name,inputOf:i=>i<2?input:{pattern:`z${i}`,path:`/z${i}`,command:`echo ${i}`}});
    assert.doesNotThrow(()=>runSup(mk()),name);
    const e=mk();
    assert.equal(runSup(e).pruned,0,name);assert.notEqual(val(e,0),PRUNED,name);
  }
  assert.ok(Date.now()-t<5000);
});

test('a huge tail message has a bounded token walk and stays conservative',()=>{
  const e=arcs(20,1100);
  const huge='é'.repeat(50_000_000);
  e.messages.push({id:'big',role:'user',content:[{type:'text',text:huge},
    {type:'tool-result',id:'x',result:{type:'content',value:[{type:'text',text:huge},{type:'text',text:huge}]}},
    {type:'tool-result',id:'y',result:huge}]});
  const t=Date.now();
  assert.doesNotThrow(()=>run(e));
  assert.ok(Date.now()-t<2000);
});

test('empty media arrays do not disable pruning; non-empty media stays protected',()=>{
  for(const field of ['attachments','files']){
    const top=arcs(20,1100,{extra:{[field]:[]}});
    run(top);assert.equal(val(top,0),PRUNED,`${field} top empty`);
    const nested=arcs(20,1100);
    nested.messages[1].content[0].result[field]=[];
    run(nested);assert.equal(val(nested,0),PRUNED,`${field} nested empty`);
    const full=arcs(20,1100,{extra:{[field]:[{url:'f'}]}});
    run(full);assert.notEqual(val(full,0),PRUNED,`${field} non-empty`);
  }
});

test('single-text content array prunes; multi-part, media and trapped shapes are untouched',()=>{
  const first=e=>e.messages[1].content[0].result;
  const one=contentShape(arcs(20,1100));
  run(one);
  assert.deepEqual(first(one),{type:'content',value:[{type:'text',text:PRUNED}]});

  const two=contentShape(arcs(20,1100));
  for(const m of two.messages)if(m.role==='tool')m.content[0].result.value.push({type:'text',text:'[notice] truncated'});
  run(two);
  assert.equal(first(two).value.length,2);
  assert.equal(first(two).value[0].text,'x'.repeat(1100));

  for(const mk of [()=>({type:'image',data:'abc'}),()=>({type:'text',text:'x'.repeat(1100),attachments:[{url:'f'}]})]){
    const media=contentShape(arcs(20,1100));
    for(const m of media.messages)if(m.role==='tool')m.content[0].result.value=[mk()];
    run(media);
    assert.notEqual(first(media).value[0].text,PRUNED);
    assert.ok(first(media).value[0].type==='image'||first(media).value[0].text.length===1100);
  }

  let calls=0;
  const getter=contentShape(arcs(20,1100));
  for(const m of getter.messages)if(m.role==='tool'){
    const item={type:'text'};
    Object.defineProperty(item,'text',{get(){calls++;return 'x'.repeat(1100);},enumerable:true,configurable:true});
    m.content[0].result.value=[item];
  }
  run(getter);
  assert.equal(calls,0);

  const prox=contentShape(arcs(20,1100));
  for(const m of prox.messages)if(m.role==='tool'){
    let traps=0;
    const item=new Proxy({type:'text',text:'x'.repeat(1100)},{get(t,k){traps++;return t[k];},getOwnPropertyDescriptor(t,k){traps++;return Reflect.getOwnPropertyDescriptor(t,k);}});
    m.content[0].result.value=[item];
  }
  assert.doesNotThrow(()=>run(prox));
  assert.equal(first(prox).value[0].text,'x'.repeat(1100));
});

test('content+string result prunes under pressure and preserves type; media, multipart and traps stay untouched',()=>{
  const mk=(extraResult={},extraPart={})=>{
    const e=arcs(20,1100,{extra:extraPart});
    for(const m of e.messages)if(m.role==='tool'){const r=m.content[0].result;r.type='content';Object.assign(r,extraResult);}
    return e;
  };
  const res=e=>e.messages[1].content[0].result;
  const ok=mk();
  assert.ok(run(ok).pruned>0);
  assert.deepEqual(res(ok),{type:'content',value:PRUNED});

  for(const [r,p] of [[{attachments:[{url:'f'}]},{}],[{file:{path:'a'}},{}],[{},{attachments:[{url:'f'}]}],[{},{file:'a'}]]){
    const e=mk(r,p);
    assert.equal(run(e).pruned,0,JSON.stringify([r,p]));
    assert.equal(res(e).value.length,1100+'out 0\n'.length);
  }

  const one=contentShape(arcs(20,1100));
  run(one);
  assert.deepEqual(res(one),{type:'content',value:[{type:'text',text:PRUNED}]});

  const two=contentShape(arcs(20,1100));
  for(const m of two.messages)if(m.role==='tool')m.content[0].result.value.push({type:'text',text:'[notice] truncated'});
  run(two);
  assert.equal(res(two).value.length,2);
  assert.equal(res(two).value[0].text,'x'.repeat(1100));

  let calls=0;
  const getter=mk();
  for(const m of getter.messages)if(m.role==='tool'){
    const r={type:'content'};
    Object.defineProperty(r,'value',{get(){calls++;return 'x'.repeat(1100);},enumerable:true,configurable:true});
    m.content[0].result=r;
  }
  assert.doesNotThrow(()=>run(getter));
  assert.equal(calls,0);

  const prox=mk();
  let traps=0;
  for(const m of prox.messages)if(m.role==='tool'){
    m.content[0].result=new Proxy({type:'content',value:'x'.repeat(1100)},{get(t,k){traps++;return t[k];},getOwnPropertyDescriptor(t,k){traps++;return Reflect.getOwnPropertyDescriptor(t,k);}});
  }
  assert.doesNotThrow(()=>run(prox));
  assert.equal(traps,0);

  const ro=mk();
  for(const m of ro.messages)if(m.role==='tool')Object.defineProperty(m.content[0].result,'value',{writable:false});
  assert.equal(run(ro).pruned,0);
});

// ---- hardening: diagnostics predicates, shell protection, line-shaped diagnostics, keys, own-data, budgets ----
const setVal=(e,i,v)=>{e.messages[i*2+1].content[0].result.value=v;};

test('timeout/killed/interrupted/cancelled/terminated notices protect plain string, result.value and state.output',()=>{
  const notices=['Command timed out after 120000ms','[killed]','interrupted by user','Request cancelled','Process terminated'];
  for(const t of notices){
    const plain=arcs(20);
    plain.messages[1].content[0].result=`out\n${'x'.repeat(1100)}\n${t}`;
    const keep=plain.messages[1].content[0].result;
    run(plain);
    assert.equal(plain.messages[1].content[0].result,keep,`plain ${t}`);
    const v=arcs(20);setVal(v,0,val(v,0)+`\n${t}`);
    run(v);assert.notEqual(val(v,0),PRUNED,`value ${t}`);
    const st=arcs(20);
    const out=`out\n${'x'.repeat(1100)}\n${t}`;
    st.messages[1].content[0]={type:'tool',id:'c-0',tool:'shell',state:{status:'completed',input:{command:'echo hi'},output:out}};
    run(st);assert.equal(st.messages[1].content[0].state.output,out,`state ${t}`);
  }
  const ok=arcs(20);run(ok);assert.equal(val(ok,0),PRUNED);
});

test('shell head/tail/grep/rg of instruction and secret files are never pruned',()=>{
  for(const command of ['head -n 20 AGENTS.md','tail SECURITY.md','grep -n token .env','rg foo plugin.jsonc','head -5 ./config/.env.local']){
    const e=arcs(20,1100,{inputOf:()=>({command})});
    assert.equal(run(e).pruned,0,command);
    assert.notEqual(val(e,0),PRUNED,command);
    assert.equal(protectedShell(command),true,command);
  }
  assert.equal(protectedShell('cat ./AGENTS.md'),true);
  const control=arcs(20,1100,{inputOf:()=>({command:'head -n 20 notes.txt'})});
  assert.ok(run(control).pruned>0);
  assert.equal(protectedShell('head -n 20 notes.txt'),false);
});

const SOURCE=`import fs from 'node:fs';
export class ConfigError extends Error {}
export function load(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (error) {
    // failure: wrap the error and rethrow
    throw new ConfigError('cannot load ' + path, {cause: error});
  }
}
export const options = {
  timeout: 5000,
  retries: 3,
};
`;
test('source read with incidental Error tokens is prunable; real failure/log output is protected',()=>{
  const readArcs=()=>arcs(20,1100,{name:'read',inputOf:i=>({path:`/src/f${i}.js`})});
  const src=readArcs();setVal(src,0,'out 0\n'+SOURCE.repeat(3)+'x'.repeat(900));
  assert.ok(run(src).pruned>0);
  assert.equal(val(src,0),PRUNED);
  const bodies={
    log:'2026-01-01T10:00:00Z ERROR db: connection refused\n'+'x'.repeat(1100),
    stack:'Error: boom\n    at load (/app/src/a.js:10:5)\n'+'x'.repeat(1100),
    ts:'src/a.ts:3:7 - error TS2322: Type mismatch\n'+'x'.repeat(1100),
    npm:'npm ERR! code E404\n'+'x'.repeat(1100),
    tests:'Tests:  2 failed, 5 passed\n'+'x'.repeat(1100),
  };
  for(const [k,body] of Object.entries(bodies)){
    const e=readArcs();setVal(e,0,body);
    run(e);
    assert.equal(val(e,0),body,k);
  }
});

test('supersession keys do not collide on delimiter-shaped scope, options or path',()=>{
  const pairs=[
    ['grep',{pattern:'a',x:'1&y=2'},{pattern:'a',x:'1',y:'2'}],
    ['grep',{pattern:'p',workdir:'a',cwd:'b|c'},{pattern:'p',workdir:'a|b',cwd:'c'}],
    ['grep',{pattern:'a',x:'1'},{pattern:'a',x:1}],
    ['read',{path:'/f',q:'a|b'},{path:'/f|q=a',q:'b'}],
  ];
  for(const [name,a,b] of pairs){
    const e=arcs(20,1100,{name,inputOf:i=>i===0?a:i===1?b:{pattern:`z${i}`,path:`/z${i}`}});
    assert.equal(runSup(e).pruned,0,JSON.stringify([a,b]));
    assert.notEqual(val(e,0),PRUNED);
  }
  const same=arcs(20,1100,{name:'grep',inputOf:i=>i<2?{pattern:'a',x:'1&y=2'}:{pattern:`z${i}`}});
  assert.ok(runSup(same).pruned>=1);assert.equal(val(same,0),PRUNED);
});

test('throwing getters and Proxy traps are never invoked and never break pruning or caching',()=>{
  let calls=0;
  const trap=()=>{calls++;throw new Error('trap');};
  const proxy=()=>new Proxy({},{get:trap,ownKeys:trap,getOwnPropertyDescriptor:trap,has:trap});
  const def=(o,k)=>Object.defineProperty(o,k,{get:trap,enumerable:true,configurable:true});
  const cases={
    partType:e=>def(e.messages[1].content[0],'type'),
    partResult:e=>def(e.messages[1].content[0],'result'),
    resultValue:e=>def(e.messages[1].content[0].result,'value'),
    partId:e=>def(e.messages[1].content[0],'id'),
    msgContent:e=>def(e.messages[1],'content'),
    msgRole:e=>def(e.messages[1],'role'),
    callInput:e=>def(e.messages[0].content[0],'input'),
    stateGetter:e=>{e.messages[1].content[0]={type:'tool',id:'c-0',tool:'shell'};def(e.messages[1].content[0],'state');},
    proxyMessage:e=>{e.messages[1]=proxy();},
    proxyPart:e=>{e.messages[1].content[0]=proxy();},
    proxyInput:e=>{e.messages[0].content[0].input=proxy();},
    proxyResult:e=>{e.messages[1].content[0].result=proxy();},
  };
  for(const [k,mutate] of Object.entries(cases)){
    const e=arcs(20);mutate(e);
    const cache=new ContextCache();
    assert.doesNotThrow(()=>{
      const gate=cache.begin(e,opts,{ratio:undefined});
      const r=pruneContext(e,opts,{pressure:{ratio:undefined},...gate});
      assert.ok(r.pruned>0,`${k}: other results still prune`);
    },k);
    assert.equal(calls,0,`${k}: no accessor or trap invoked`);
  }
});

test('per-message content-part budget fails closed in prune and cache admission',()=>{
  const e=arcs(20);
  for(let i=0;i<MAX_PARTS_PER_MESSAGE+1;i++)e.messages[1].content.push({type:'text',text:'t'});
  const keep=val(e,0);
  assert.ok(run(e).pruned>0);
  assert.equal(val(e,0),keep,'over-budget message is never rewritten');
  assert.equal(val(e,1),PRUNED);
  const cache=new ContextCache();
  cache.begin(arcs(4,1000),opts,{ratio:undefined});
  const big=arcs(20,1100);
  for(let i=0;i<MAX_PARTS_PER_MESSAGE+1;i++)big.messages[1].content.push({type:'text',text:'t'});
  assert.equal(cache.begin(big,opts,{ratio:undefined}).allowNewDrops,false);
  const c2=new ContextCache();c2.begin(arcs(4,1000),opts,{ratio:undefined});
  assert.equal(c2.begin(arcs(20,1100),opts,{ratio:undefined}).allowNewDrops,true);
});

test('read without limit covers the 2000-line default, never Infinity',()=>{
  const mk=(a,b)=>arcs(20,1100,{name:'read',inputOf:i=>i===0?a:i===1?b:{path:`/z${i}`}});
  let e=mk({path:'/f',offset:0,limit:100},{path:'/f'});
  assert.ok(runSup(e).pruned>=1);assert.equal(val(e,0),PRUNED);
  e=mk({path:'/f'},{path:'/f',offset:0,limit:100});
  assert.equal(runSup(e).pruned,0);assert.notEqual(val(e,0),PRUNED);
  e=mk({path:'/f'},{path:'/f',offset:0,limit:5000});
  assert.ok(runSup(e).pruned>=1);assert.equal(val(e,0),PRUNED);
  e=mk({path:'/f',offset:0,limit:5000},{path:'/f'});
  assert.equal(runSup(e).pruned,0);assert.notEqual(val(e,0),PRUNED);
  e=mk({path:'/f',offset:0,limit:0},{path:'/f',offset:0,limit:5000});
  assert.equal(runSup(e).pruned,0);
});

test('git patch-printing commands are protected',()=>{
  for(const c of ['git log -p','git log --patch -n 3','git -C repo log -p','git log -u','git status -v','git status -vv','git stash show -p',
    'git stash show --patch stash@{1}','git request-pull v1 origin main','git diff','git show HEAD','git reflog -p']){
    assert.equal(protectedShell(c),true,c);
  }
  for(const c of ['git log --oneline -n 5','git status -sb','git status','git stash list','git stash show --stat','git branch -a']){
    assert.equal(protectedShell(c),false,c);
  }
  for(const command of ['git log -p -n 3','git status -v']){
    const e=arcs(20,1100,{inputOf:()=>({command})});
    assert.equal(run(e).pruned,0,command);
    assert.notEqual(val(e,0),PRUNED,command);
  }
  const control=arcs(20,1100,{inputOf:()=>({command:'git log --oneline -n 3'})});
  assert.ok(run(control).pruned>0);
});

test('line-shaped diagnostics: bare Error/FATAL, timestamped lowercase level, JSONL level, compiler code lines are protected',()=>{
  const readArcs=()=>arcs(20,1100,{name:'read',inputOf:i=>({path:`/src/f${i}.js`})});
  const pad='\n'+'x'.repeat(1100);
  const bodies={
    bareError:'Error: cannot open config'+pad,
    bareFatal:'FATAL: out of memory'+pad,
    tsLower:'2026-01-01T10:00:00Z error: connection refused'+pad,
    jsonl:'{"ts":1,"level":"error","msg":"db down"}'+pad,
    jsonSeverity:'{"severity":"CRITICAL","msg":"x"}'+pad,
    ruff:'src/a.py:1:8: F401 `os` imported but unused'+pad,
  };
  for(const [k,body] of Object.entries(bodies)){
    const e=readArcs();setVal(e,0,body);run(e);
    assert.equal(val(e,0),body,k);
  }
  const src=readArcs();setVal(src,0,'out 0\n'+'function f(){ throw new Error("x"); }\n'.repeat(5)+'x'.repeat(1100));
  run(src);assert.equal(val(src,0),PRUNED);
  const info=readArcs();setVal(info,0,'{"level":"info","msg":"ok"}'+pad);
  run(info);assert.equal(val(info,0),PRUNED);
});

test('read and shell protection cover .npmrc, .netrc, id_rsa, secrets.json and SKILL.md',()=>{
  const files=['.npmrc','/home/u/.netrc','~/.ssh/id_rsa','config/secrets.json','skills/x/SKILL.md'];
  for(const f of files){
    const r=arcs(20,1100,{name:'read',inputOf:i=>({path:i===0?f:`/src/f${i}.js`})});
    run(r);assert.notEqual(val(r,0),PRUNED,`read ${f}`);
    for(const command of [`head -n 5 ${f}`,`tail ${f}`,`grep -n x ${f}`]){
      assert.equal(protectedShell(command),true,command);
      const e=arcs(20,1100,{inputOf:()=>({command})});
      assert.equal(run(e).pruned,0,command);
    }
  }
});

test('token tail counts state.output of tool parts (mixed text/tool)',()=>{
  const e=arcs(20,1100);
  const big='y'.repeat(15000);
  e.messages[39].content[0]={type:'tool',id:'c-19',tool:'shell',state:{status:'completed',input:{command:'echo hi'},output:big}};
  e.messages[38].content.push({type:'text',text:'note'});
  run(e);
  // Large recent output exhausts the token tail, so older results are no longer over-protected.
  assert.equal(val(e,17),PRUNED);
  assert.equal(e.messages[39].content[0].state.output,big);
});

test('result.content single-text array prunes and counts toward tokenTail',()=>{
  const alt=arcs(20,1100);
  for(const m of alt.messages)if(m.role==='tool')m.content[0].result={type:'content',content:[{type:'text',text:'x'.repeat(1100)}]};
  const gate=new ContextCache().begin(alt,opts,{ratio:undefined});
  const res=pruneContext(alt,opts,{pressure:{ratio:undefined},...gate});
  assert.ok(res.pruned>0);
  assert.deepEqual(alt.messages[1].content[0].result,{type:'content',content:[{type:'text',text:PRUNED}]});
});
