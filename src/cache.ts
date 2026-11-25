/** Prompt-cache-aware owner: keep a stable drop set until a natural bust or force band. */
import {ownData,isPlainArray,isTrimMeshProtected,MAX_PARTS_PER_MESSAGE,MAX_PARTS_TOTAL,evaluateCacheBreakEven,type CacheBreakEvenInput} from './prune.ts';
export {evaluateCacheBreakEven,type CacheBreakEvenInput};

export interface CacheGate {
  allowNewDrops: boolean;
  coldCache: boolean;
  warmCache: boolean;
  forceFlush?: boolean;
  adaptiveTier?: 0 | 1 | 2;
  plannedDrops: Set<string>;
  hydratedDrops?: Set<string>;
  finish: (ids: Iterable<string>, opts?: { deferred?: boolean }) => void;
}
export interface CacheSessionEntry {
  identity: string;
  plannedDrops: Set<string>;
  hydratedDrops?: Set<string>;
  sizeMark?: number;
  startBandAdmitted?: boolean;
  adaptiveTier?: 0 | 1 | 2;
  lastRequestAt?: number;
  lastCacheRead?: number;
}

function hash(input: string): string {
  let h=2166136261;
  for(let i=0;i<input.length;i++)h=Math.imul(h^input.charCodeAt(i),16777619);
  return (h>>>0).toString(16);
}
function stable(value: unknown): string {
  try{return JSON.stringify(value)??'';}catch{return '';}
}
export function requestIdentity(event: any): string {
  const model=`${event?.model?.providerID??''}/${event?.model?.id??''}/${event?.model?.variant??''}`;
  const tools=Object.entries(event?.tools??{}).sort(([a],[b])=>a.localeCompare(b))
    .map(([key,val]: [string, any])=>[key,val?.description??'']);
  const system=event?.system??[];
  const msgs=event?.messages;
  const first=Array.isArray(msgs)?[0,1].map(i=>{const x=ownData(msgs,String(i));return ownData(x,'id')??ownData(x,'role')??'';}):[];
  return hash(stable({model,tools,system,first}));
}
/** Text chars of a result: plain string, value string, or text items in value[]/content[] arrays (first 200 items). */
function textChars(r: any): number {
  if(typeof r==='string')return r.length;
  if(r===null||typeof r!=='object')return 0;
  const v=ownData(r,'value');
  let n=typeof v==='string'?v.length:0;
  for(const list of [v,ownData(r,'content')]){
    if(!isPlainArray(list))continue;
    const m=Math.min(list.length,200);
    for(let i=0;i<m;i++){
      const t=ownData(ownData(list,String(i)),'text');
      if(typeof t==='string')n+=t.length;
    }
  }
  return n;
}
/**
 * Bounded count of tool-result text chars (absolute-budget evidence; independent of a model limit).
 * Own-data reads only. Any over-budget structure fails closed: 0 chars means no size admission.
 */
function toolChars(event: any): number {
  const messages=event?.messages;
  if(!Array.isArray(messages)||messages.length>10000)return 0;
  let total=0,parts=0;
  for(let mi=0;mi<messages.length;mi++){
    const msg=ownData(messages,String(mi));
    const content=ownData(msg,'content');
    if(!isPlainArray(content))continue;
    if(content.length>MAX_PARTS_PER_MESSAGE)return 0;
    parts+=content.length;
    if(parts>MAX_PARTS_TOTAL)return 0;
    for(let pi=0;pi<content.length;pi++){
      const part=ownData(content,String(pi));
      if(isTrimMeshProtected(part,msg,event?.sessionID))continue;
      const type=ownData(part,'type');
      if(type==='tool-result'){
        total+=textChars(ownData(part,'result'));
      }else if(type==='tool'){
        const st=ownData(part,'state');
        const out=ownData(st,'output');
        if(typeof out==='string')total+=out.length;
        else total+=textChars(st);
      }
    }
  }
  return total;
}
/**
 * plannedDrops is bounded. Past MAX_PLANNED the OLDEST ids are evicted one at a
 * time (no halving), so only results older than the newest MAX_PLANNED drops can
 * be resurrected. This limitation is deliberate and tested.
 */
export interface CachePersistence {
  load?: (sessionID: string) => Iterable<string>;
  save?: (sessionID: string, ids: Iterable<string>) => void;
  clear?: (sessionID: string) => void;
}
export const MAX_PLANNED: number = 4000;
export class ContextCache {
  sessions: Map<string, CacheSessionEntry>;
  observedCacheReads: Map<string, number>;
  flushRequests: Set<string>;
  #persistence: CachePersistence | null;
  constructor(){
    this.sessions=new Map();
    this.observedCacheReads=new Map();
    this.flushRequests=new Set();
    this.#persistence=null;
  }
  setPersistence(adapter: CachePersistence | null): void {
    this.#persistence=adapter??null;
  }
  requestFlush(sessionID: unknown): boolean {
    if(typeof sessionID!=='string'||!sessionID)return false;
    this.flushRequests.delete(sessionID);
    if(this.flushRequests.size>=128)this.flushRequests.delete(this.flushRequests.values().next().value as string);
    this.flushRequests.add(sessionID);
    return true;
  }
  /** Record latest provider cache.read tokens from session.step.ended for warm/cold detection. */
  observeCacheRead(sessionID: unknown, cacheRead: unknown): void {
    if(typeof sessionID!=='string'||!sessionID)return;
    if(typeof cacheRead!=='number'||!Number.isFinite(cacheRead)||cacheRead<0)return;
    this.observedCacheReads.delete(sessionID);
    if(this.observedCacheReads.size>=128)this.observedCacheReads.delete(this.observedCacheReads.keys().next().value as string);
    this.observedCacheReads.set(sessionID,cacheRead);
  }
  begin(event: any, opts: any, pressure: any, kind: string = 'context', now: number = Date.now()): CacheGate {
    const sid=event?.sessionID;
    if(typeof sid!=='string'||!sid)return {allowNewDrops:true,coldCache:false,warmCache:false,plannedDrops:new Set(),finish:()=>{}};
    const key=`${kind}:${sid}`;
    const identity=requestIdentity(event);
    let entry=this.sessions.get(key);
    const changed=!entry||entry.identity!==identity;
    const inStartBand=typeof pressure?.ratio==='number'&&pressure.ratio>=opts.pressureStartRatio;
    let crossedStartBand=false;
    const prevAt=entry?.lastRequestAt;
    const ttlMs=typeof opts?.cacheTtlMs==='number'&&Number.isFinite(opts.cacheTtlMs)&&opts.cacheTtlMs>0?opts.cacheTtlMs:0;
    const observedRead=kind==='context'?this.observedCacheReads.get(sid):undefined;
    if(kind==='context'&&observedRead!==undefined)this.observedCacheReads.delete(sid);
    const forceFlush=kind==='context'&&this.flushRequests.delete(sid);
    const idleCold=kind==='context'&&ttlMs>0&&prevAt!==undefined&&(now-prevAt)>=ttlMs;
    const missCold=kind==='context'&&observedRead===0&&prevAt!==undefined;
    const coldCache=idleCold||missCold||forceFlush;
    const warmCache=kind==='context'&&!coldCache&&!changed&&observedRead!==undefined&&observedRead>0;
    const prevStartBand=entry?.startBandAdmitted;
    const prevSizeMark=entry?.sizeMark;
    const curTier: 0 | 1 | 2 = kind==='context'&&typeof pressure?.ratio==='number'&&Number.isFinite(pressure.ratio)
      ? (pressure.ratio>=opts.pressureCriticalRatio?2:pressure.ratio>=opts.pressureForceRatio?1:0)
      : 0;
    const prevTier: 0 | 1 | 2 = entry?.adaptiveTier??0;
    const adaptiveTier: 0 | 1 | 2 = curTier>prevTier?curTier:prevTier;
    if(!entry){
      const hydrated=new Set<string>();
      if(kind==='context'&&typeof this.#persistence?.load==='function'){
        try{
          for(const id of this.#persistence.load(sid)){
            if(typeof id==='string'&&id)hydrated.add(id);
            if(hydrated.size>=MAX_PLANNED)break;
          }
        }catch{/* best-effort hydration */}
      }
      entry={identity,plannedDrops:hydrated,hydratedDrops:hydrated.size>0?new Set(hydrated):undefined,startBandAdmitted:inStartBand,adaptiveTier,lastRequestAt:now,lastCacheRead:observedRead};
    }else if(changed){
      // A model/tool/system change is a natural provider-cache rebuild: it may
      // admit new decisions, but previously committed drops must keep replaying.
      // Dropping the set here would resurrect old results and cause a second
      // prefix rewrite on every following request.
      entry.identity=identity;
      entry.sizeMark=undefined;
      entry.startBandAdmitted=inStartBand;
      entry.adaptiveTier=adaptiveTier;
      entry.lastRequestAt=now;
      entry.lastCacheRead=observedRead;
    }else{
      entry.lastRequestAt=now;
      entry.adaptiveTier=adaptiveTier;
      if(observedRead!==undefined)entry.lastCacheRead=observedRead;
      if(!inStartBand){
        entry.startBandAdmitted=false;
      }else if(!entry.startBandAdmitted){
        entry.startBandAdmitted=true;
        crossedStartBand=true;
      }
    }
    this.sessions.delete(key);this.sessions.set(key,entry);
    while(this.sessions.size>128)this.sessions.delete(this.sessions.keys().next().value as string);
    // Compaction is already a natural model request, whose history is about
    // to be checkpointed. Cold cache (idle >= TTL, observed cache miss, or explicit
    // flush) has zero deferral. Force pressure is a deliberate bounded cache bust.
    // Crossing pressureStartRatio (65%) from below also admits once.
    let allowNewDrops=kind==='compaction'||changed||coldCache||crossedStartBand||
      (typeof pressure?.ratio==='number' && pressure.ratio>=opts.pressureForceRatio);
    // Absolute tool-output budget: admissible even when the ratio is unmeasurable.
    // Re-admission needs growth of a quarter budget since the last size admission,
    // so a stable over-budget history does not rewrite the prefix every request.
    const budget=opts.pruneAfterToolChars;
    const chars=toolChars(event);
    // Shrinkage (pruned history, compaction) lowers the baseline so later growth
    // of a quarter budget can re-admit instead of waiting to exceed the old peak.
    if(entry.sizeMark!==undefined&&chars<entry.sizeMark)
      entry.sizeMark=chars>budget*1.25?chars:undefined;
    if(!allowNewDrops&&chars>budget*1.25&&
      (entry.sizeMark===undefined||chars>=entry.sizeMark+budget*0.25))allowNewDrops=true;
    if(allowNewDrops&&chars>budget*1.25)entry.sizeMark=chars;
    const persistence=this.#persistence;
    return {allowNewDrops,coldCache,warmCache,forceFlush,adaptiveTier,plannedDrops:entry.plannedDrops,...(entry.hydratedDrops?{hydratedDrops:entry.hydratedDrops}:{}),
      finish(ids, finishOpts){
        if(finishOpts?.deferred===true){
          if(crossedStartBand)entry.startBandAdmitted=prevStartBand??false;
          entry.sizeMark=prevSizeMark;
        }
        const newlyAdded: string[]=[];
        for(const id of ids){
          if(!entry.plannedDrops.has(id))newlyAdded.push(id);
          entry.plannedDrops.add(id);
        }
        // In-place eviction keeps the Set handed out by begin() valid.
        while(entry.plannedDrops.size>MAX_PLANNED)
          entry.plannedDrops.delete(entry.plannedDrops.values().next().value as string);
        if(kind==='context'&&newlyAdded.length>0&&typeof persistence?.save==='function'){
          try{persistence.save(sid,newlyAdded);}catch{/* best-effort persistence */}
        }
      }};
  }
  resetSession(sessionID: unknown): void {
    if(typeof sessionID!=='string'||!sessionID)return;
    this.sessions.delete(`context:${sessionID}`);
    this.sessions.delete(`compaction:${sessionID}`);
    this.observedCacheReads.delete(sessionID);
    this.flushRequests.delete(sessionID);
    if(typeof this.#persistence?.clear==='function'){
      try{this.#persistence.clear(sessionID);}catch{/* best-effort clear */}
    }
  }
  clear(): void {this.sessions.clear();this.observedCacheReads.clear();this.flushRequests.clear();}
}
