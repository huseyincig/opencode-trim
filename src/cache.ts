/** Prompt-cache-aware owner: keep a stable drop set until a natural bust or force band. */
import {ownData,isPlainArray,isTrimMeshProtected,MAX_PARTS_PER_MESSAGE,MAX_PARTS_TOTAL} from './prune.ts';

export interface CacheGate {
  allowNewDrops: boolean;
  plannedDrops: Set<string>;
  finish: (ids: Iterable<string>) => void;
}
export interface CacheSessionEntry {
  identity: string;
  plannedDrops: Set<string>;
  sizeMark?: number;
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
        const out=ownData(ownData(part,'state'),'output');
        if(typeof out==='string')total+=out.length;
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
export const MAX_PLANNED: number = 4000;
export class ContextCache {
  sessions: Map<string, CacheSessionEntry>;
  constructor(){this.sessions=new Map();}
  begin(event: any, opts: any, pressure: any, kind: string = 'context'): CacheGate {
    const sid=event?.sessionID;
    if(typeof sid!=='string'||!sid)return {allowNewDrops:true,plannedDrops:new Set(),finish:()=>{}};
    const key=`${kind}:${sid}`;
    const identity=requestIdentity(event);
    let entry=this.sessions.get(key);
    const changed=!entry||entry.identity!==identity;
    if(!entry){
      entry={identity,plannedDrops:new Set()};
    }else if(changed){
      // A model/tool/system change is a natural provider-cache rebuild: it may
      // admit new decisions, but previously committed drops must keep replaying.
      // Dropping the set here would resurrect old results and cause a second
      // prefix rewrite on every following request.
      entry.identity=identity;
      entry.sizeMark=undefined;
    }
    this.sessions.delete(key);this.sessions.set(key,entry);
    while(this.sessions.size>128)this.sessions.delete(this.sessions.keys().next().value as string);
    // Compaction is already a natural model request, whose history is about
    // to be checkpointed. Force pressure is a deliberate bounded cache bust.
    let allowNewDrops=kind==='compaction'||changed||
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
    return {allowNewDrops,plannedDrops:entry.plannedDrops,
      finish(ids){for(const id of ids)entry.plannedDrops.add(id);
        // In-place eviction keeps the Set handed out by begin() valid.
        while(entry.plannedDrops.size>MAX_PLANNED)
          entry.plannedDrops.delete(entry.plannedDrops.values().next().value as string);
      }};
  }
  resetSession(sessionID: unknown): void {
    if(typeof sessionID!=='string'||!sessionID)return;
    this.sessions.delete(`context:${sessionID}`);
    this.sessions.delete(`compaction:${sessionID}`);
  }
  clear(): void {this.sessions.clear();}
}
