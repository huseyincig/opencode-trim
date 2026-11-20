import { realpathSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { parseOptions } from './config.js';
import { isExitNotice } from './diagnostics.js';
import { compressOutput, dedupToolOutput } from './compress.js';
import { pruneContext } from './prune.js';
import { setupMemory, memoryDbBytes } from './memory.js';
import { createTrimStats } from './stats.js';
import { TRIM_STATS_RPC } from './stats-rpc.js';
import { ContextCache } from './cache.js';
import { discoverModelLimits, ensureModelLimit, estimateRequest } from './pressure.js';
import { registerMeshPeer, wasMeshBounded, forgetMeshSession, MESH_METADATA_KEY } from './bridge.js';
const SHELL_TOOLS=new Set(['shell','bash']);
const LIST_TOOLS=new Set(['grep','glob','ls','list','find']);
const EXIT_NOTICE=/(?:exit\s*code|timed out|interrupted|killed|failed)/i;
const COMPACTION_EVENTS=Object.freeze(['session.compaction.started','session.compaction.ended','session.compaction.failed']);
function obj(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
// Tool hook events are not guaranteed to carry a session id on every host revision; stats skip what they cannot attribute.
function toolSessionOf(event){
  for(const v of [event?.sessionID,event?.sessionId,event?.session?.id,event?.context?.sessionID]) if(typeof v==='string'&&v)return v;
  return undefined;
}
function exitCode(event){
  // V2 shell puts the real code in result.output.exitCode; metadata may carry
  // only tool status. Any nonzero candidate wins; sources are ordered so the
  // structured output beats metadata, independent of object key order.
  let zero;
  for(const v of [event?.result?.output,event?.result,event?.result?.metadata,event?.input]) {
    if(!obj(v))continue;
    for(const key of ['exitCode','exit_code','exit']){
      const n=v[key];
      if(!Number.isSafeInteger(n))continue;
      if(n!==0)return n;
      zero=0;
    }
  }
  return zero;
}
// A string result has no separate notice part, so the compacted text itself
// must still carry any exit/timeout notice the original had.
function keepsNotice(original,next){
  if(isExitNotice(original)&&!isExitNotice(next))return false;
  if(/\btimed out\b/i.test(original)&&!/\btimed out\b/i.test(next))return false;
  return true;
}
function assignResult(event,next){
  try{event.result={...event.result,...next};return true;}catch{return false;}
}
function isEventMeshBounded(event){
  for(const h of [event?.result,event,event?.result?.output]){
    if(wasMeshBounded(h))return true;
    if(obj(h?.metadata)&&wasMeshBounded({metadata:h.metadata}))return true;
  }
  return false;
}
/**
 * Compress every text content part independently. Shell results carry the
 * command output in the first part and an exit/timeout notice in a later one;
 * the notice is left intact. When the structured output mirrors the first
 * part, it is updated too so stored and model-visible text stay consistent.
 */
export function processToolEvent(event,options,sink) {
  if(event?.status!=='completed')return false;
  const shell=SHELL_TOOLS.has(event?.tool);
  if(shell ? !options.shell : !options.toolFiltering || !LIST_TOOLS.has(event?.tool)) return false;
  const result=event.result;
  if(!obj(result))return false;
  // Mixed text/media results are protected as a unit: replacing one text part
  // while a sibling image/file part remains could desynchronize the payload.
  const rawContent=result.content;
  if(Array.isArray(rawContent)&&rawContent.some((part)=>!obj(part)||part.type!=='text'))return false;
  const command=typeof event.input?.command==='string'?event.input.command:'';
  if(shell && !command) return false;
  // Observer only (stats): never alters the result or the return value.
  const report=(didChange,savedChars)=>{
    if(typeof sink!=='function')return;
    try{sink({kind:shell?'shell':'filtering',changed:didChange,savedChars});}catch{/* observer only */}
  };
  if(isEventMeshBounded(event)){report(false,0);return false;}
  const code=exitCode(event);
  const content=result.content;
  let firstOriginal=null,firstNext=null,changed=false,saved=0;
  let nextContent=content;
  if(typeof content==='string'){
    // No separate notice part exists: the failure postconditions must apply.
    const next=(shell ? compressOutput({command,text:content,exitCode:code,options,externalFailureNotice:false}) : dedupToolOutput(content,options));
    if(next.changed&&(!shell||keepsNotice(content,next.text))){firstOriginal=content;firstNext=next.text;nextContent=next.text;changed=true;saved+=Math.max(0,content.length-next.text.length);}
  } else if(Array.isArray(content)){
    nextContent=content.slice();
    let noticePresent=false;
    for(let i=0;i<content.length;i++){
      const part=content[i];
      if(obj(part)&&part.type==='text'&&typeof part.text==='string'&&i>0&&EXIT_NOTICE.test(part.text))noticePresent=true;
    }
    for(let i=0;i<content.length;i++){
      const part=content[i];
      if(!obj(part)||part.type!=='text'||typeof part.text!=='string')continue;
      const next=(shell ? compressOutput({command,text:part.text,exitCode:code,options,externalFailureNotice:noticePresent}) : dedupToolOutput(part.text,options));
      if(!next.changed)continue;
      if(i===0){firstOriginal=part.text;firstNext=next.text;}
      nextContent[i]={...part,text:next.text};
      changed=true;saved+=Math.max(0,part.text.length-next.text.length);
    }
  }
  if(!changed){report(false,0);return false;}
  const output=result.output;
  const baseMeta=obj(result.metadata)?result.metadata:{};
  const existingMesh=obj(baseMeta[MESH_METADATA_KEY])?baseMeta[MESH_METADATA_KEY]:{v:2,owner:'opencode-trim',kind:'tool-output'};
  const patch={
    content:nextContent,
    metadata:{...baseMeta,[MESH_METADATA_KEY]:{...existingMesh,boundedBy:'opencode-trim'}},
  };
  if(firstOriginal!==null&&obj(output)&&typeof output.output==='string'&&output.output===firstOriginal){
    patch.output={...output,output:firstNext};
  }
  const applied=assignResult(event,patch);
  report(applied,applied?saved:0);
  return applied;
}
function valid(reg){if(!reg||typeof reg.dispose!=='function')throw new Error('opencode-trim: V2 registration missing dispose()');return reg;}
/**
 * This plugin never calls a model, writes a database, spawns a process,
 * creates a tool, adds a prompt, or edits the user's OpenCode configuration.
 */
export async function setupTrim(ctx){
  const opts=parseOptions(ctx?.options??{});
  if(!opts.enabled)return async()=>{};
  if(typeof ctx?.session?.hook!=='function'||typeof ctx?.tool?.hook!=='function')
    throw new Error('opencode-trim requires OpenCode V2 session/tool hook APIs');
  // Optional TUI stats: created only when tui.enabled. Everything below that touches `stats` is observer-only.
  let rpcReg=null;
  let stats=null;
  if(opts.tui.enabled){
    try{
      stats=createTrimStats({options:opts,emit:(sessionID,revision)=>rpcReg?.events?.emit?.('changed',{sessionID,revision})});
    }catch{stats=null;}
  }
  const modelLimits=(opts.pruning||stats)?await discoverModelLimits(ctx):new Map();
  const modelLookups=new Set();
  const cache=new ContextCache();
  const registrations=[];
  const sessionOf=(event)=>{const s=event?.sessionID;return typeof s==='string'&&s?s:undefined;};
  const observe=(fn)=>{if(!stats)return;try{fn(stats);}catch{/* never affect the engine */}};
  const contextStats=(event,pressure)=>observe((s)=>s.recordContext({
    sessionID:sessionOf(event),estimatedTokens:pressure.estimatedTokens,estimatedChars:pressure.estimatedChars,
    usableTokens:pressure.usableTokens,limitTokens:pressure.modelContext,ratio:pressure.ratio,
    source:pressure.modelSource,media:pressure.mediaPresent}));
  const runPruning=async(event,kind)=>{
    if(!opts.pruning)return;
    try{
      await ensureModelLimit(ctx,modelLimits,event?.model,modelLookups);
      const pressure=estimateRequest(event,modelLimits,opts);
      const gate=cache.begin(event,opts,pressure,kind);
      const result=pruneContext(event,opts,{pressure,...gate});
      gate.finish(result.plannedIds);
      observe((s)=>{
        if(foreignEvent(event))return;
        // A native compaction request is not the live model context; only its prune counters apply.
        if(kind==='context')contextStats(event,result.pruned>0?estimateRequest(event,modelLimits,opts):pressure);
        s.recordPrune({sessionID:sessionOf(event),pruned:result.pruned,removedChars:result.removedChars,
          reason:result.reason,allowNewDrops:gate.allowNewDrops});
      });
    }catch{/* No optimization is safer than breaking a model request. */}
  };
  const statsOnlyContext=async(event)=>{
    try{
      if(foreignEvent(event))return;
      await ensureModelLimit(ctx,modelLimits,event?.model,modelLookups);
      contextStats(event,estimateRequest(event,modelLimits,opts));
    }catch{/* stats are best effort */}
  };
  const canonDir=(v)=>{
    try{
      if(typeof v!=='string'||!v||!isAbsolute(v)||v.includes('\0'))return undefined;
      try{return realpathSync(v);}catch{return resolvePath(v);}
    }catch{return undefined;}
  };
  const localDir=canonDir(ctx?.location?.directory);
  registrations.push({dispose:registerMeshPeer({id:'opencode-trim',directory:localDir,capabilities:['context.prune']})});
  // Events from another or conflicting location must not touch this location's stats.
  const foreignEvent=(e)=>{
    if(!localDir)return false;
    try{
      for(const holder of [e,e?.data,e?.properties]){
        const loc=holder?.location;
        if(loc===undefined||loc===null)continue;
        if(!obj(loc))return true;
        const raw=loc.directory;
        if(raw===undefined||raw===null)continue;
        const dir=canonDir(raw);
        if(dir===undefined||dir!==localDir)return true;
      }
      return false;
    }catch{return true;}
  };
  let subscriptionAbort=null;
  const dispose=async()=>{
    try{subscriptionAbort?.abort();}catch{/* ignore */}
    try{stats?.dispose();}catch{/* ignore */}
    if(rpcReg){const reg=rpcReg;rpcReg=null;await Promise.resolve().then(()=>reg.dispose()).catch(()=>{});}
  };
  try{
    if(opts.shell||opts.toolFiltering){
      registrations.push(valid(await ctx.tool.hook('execute.after',(event)=>{
        try{
          if(!stats||foreignEvent(event))processToolEvent(event,opts);
          else{
            const sessionID=toolSessionOf(event);
            processToolEvent(event,opts,(info)=>stats.recordTool({sessionID,...info}));
          }
        }catch{/* Preserve host result. */}
      })));
    }
    if(opts.pruning){
      registrations.push(valid(await ctx.session.hook('context',(event)=>runPruning(event,'context'))));
      if(opts.compactionInputPruning){
        // This ONLY prunes a native compaction request's old tool results.
        // It neither asks for a summary nor sets event.result.
        registrations.push(valid(await ctx.session.hook('compaction',(event)=>runPruning(event,'compaction'))));
      }
    }else if(stats){
      registrations.push(valid(await ctx.session.hook('context',statsOnlyContext)));
    }
  }catch(error){
    await Promise.allSettled(registrations.reverse().map(reg=>reg.dispose()));
    await dispose();
    cache.clear();throw error;
  }
  if(stats){
    // No host `compaction.auto` exists: count observed compaction events by their reason instead.
    try{
      if(typeof ctx?.rpc?.register==='function'){
        rpcReg=await ctx.rpc.register(TRIM_STATS_RPC,{snapshot:async(input)=>stats.snapshot(input?.sessionID)});
        if(!rpcReg||typeof rpcReg.dispose!=='function')rpcReg=null;
      }
    }catch{rpcReg=null;}
    try{
      if(typeof ctx?.event?.subscribe==='function'){
        subscriptionAbort=new AbortController();
        const signal=subscriptionAbort.signal;
        const subscription=await ctx.event.subscribe({signal,types:[...COMPACTION_EVENTS]});
        (async()=>{
          try{
            for await(const e of subscription){
              if(signal.aborted)break;
              if(foreignEvent(e))continue;
              const p=obj(e?.data)?e.data:obj(e?.properties)?e.properties:(obj(e)?e:{});
              const sid=p.sessionID??p.sessionId??e?.sessionID;
              if(e?.type==='session.deleted'){
                if(typeof sid==='string'&&sid)forgetMeshSession(sid);
                continue;
              }
              observe((s)=>{
                const type=COMPACTION_EVENTS.includes(e?.type)?e.type.slice('session.compaction.'.length):null;
                if(type)s.recordCompactionEvent({sessionID:sid,type,reason:p.reason});
              });
            }
          }catch{/* stream ended or aborted */}
        })();
      }
    }catch{subscriptionAbort=null;}
  }
  let memoryStop=null;
  if(opts.memory.enabled){
    // Memory is optional; a failure must not disable Trim itself.
    try{
      memoryStop=await setupMemory(ctx,opts,stats?{
        onReady:({project,store,dbPath})=>{
          stats.setMemoryProvider(()=>({...store.stats(project),dbBytes:memoryDbBytes(dbPath)}));
          stats.setMemoryState({active:true});
        },
        onSearch:({sessionID,results})=>stats.recordMemorySearch({sessionID,results:Array.isArray(results)?results.length:0}),
        onClose:()=>{stats.setMemoryProvider(null);stats.setMemoryState({active:false});},
      }:undefined);
    }catch{memoryStop=null;observe((s)=>{s.setMemoryProvider(null);s.setMemoryState({active:false,error:'setup-failed'});});}
  }
  let disposed=false;
  return async()=>{
    if(disposed)return;
    disposed=true;cache.clear();
    if(memoryStop)await Promise.resolve().then(memoryStop).catch(()=>{});
    await Promise.allSettled(registrations.reverse().map(reg=>reg.dispose()));
    await dispose();
  };
}
