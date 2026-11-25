
export interface ModelLimitEntry {
  context?: number;
  input?: number;
  output?: number;
}
export interface ResolvedModelLimit {
  context: number | undefined;
  output: number | undefined;
  source: 'event-model' | 'model-catalog' | 'config' | 'unavailable';
  capped?: boolean;
  uncappedContext?: number;
}
export interface ContextBreakdown {
  systemChars: number;
  chatChars: number;
  toolChars: number;
}
export interface ToolBloatEntry {
  name: string;
  chars: number;
}
export interface ContextDiagnostics {
  toolSchemaChars: number;
  toolCount: number;
  topTools: ToolBloatEntry[];
}
export interface PressureEstimate {
  estimatedTokens: number;
  estimatedChars: number;
  modelContext: number | undefined;
  modelSource: ResolvedModelLimit['source'];
  usableTokens: number | undefined;
  ratio: number | undefined;
  estimated: boolean;
  mediaPresent: boolean;
  reportedTokens?: number;
  /** Token count the ratio is based on: real provider tokens when available, else the byte estimate. */
  effectiveTokens: number;
  overheadTokens?: number;
  breakdown?: ContextBreakdown;
  diagnostics?: ContextDiagnostics;
}

/** Pure, deliberately conservative estimates; no claim of exact provider token accounting. */
function obj(x: unknown): x is Record<string, any> { return x !== null && typeof x==='object'; }
const PRUNED_MSG_CHARS = new WeakMap<object, number>();
export function recordPrunedMsgChars(msg: unknown, deltaChars: number): void {
  if (!obj(msg) || typeof deltaChars !== 'number' || !Number.isFinite(deltaChars) || deltaChars === 0) return;
  const next = (PRUNED_MSG_CHARS.get(msg) ?? 0) + deltaChars;
  if (next > 0) PRUNED_MSG_CHARS.set(msg, next);
  else PRUNED_MSG_CHARS.delete(msg);
}
export function getPrunedMsgChars(msg: unknown): number {
  return obj(msg) ? (PRUNED_MSG_CHARS.get(msg) ?? 0) : 0;
}
function asPositiveInt(n: unknown): number | undefined { return typeof n === 'number' && Number.isSafeInteger(n)&&n>0&&n<=10_000_000 ? n:undefined; }
export function resolveModelLimit(event: any, modelLimits: Map<string, ModelLimitEntry> = new Map(), options: any = {}): ResolvedModelLimit {
  const direct = event?.model?.limit;
  const directContext=asPositiveInt(direct?.context);
  const input=asPositiveInt(direct?.input);
  const id=event?.model?.id, provider=event?.model?.providerID;
  const fromCatalog=typeof id==='string'&&typeof provider==='string' ? modelLimits.get(`${provider}/${id}`) : undefined;
  const configured=asPositiveInt(options?.contextWindow);
  const cap=asPositiveInt(options?.contextWindowCap);
  const ratioCap=typeof options?.contextWindowRatioCap==='number'&&options.contextWindowRatioCap>=0.05&&options.contextWindowRatioCap<=1 ? options.contextWindowRatioCap : undefined;
  const rawContext=input ?? directContext ?? asPositiveInt(fromCatalog?.input) ?? asPositiveInt(fromCatalog?.context) ?? configured;
  const catalogContext=asPositiveInt(fromCatalog?.input) ?? asPositiveInt(fromCatalog?.context);
  let context=rawContext;
  let capped=false;
  if(ratioCap!==undefined&&rawContext!==undefined){
    const byRatio=Math.max(1024,Math.floor(rawContext*ratioCap));
    if(context===undefined||byRatio<context){context=byRatio;capped=true;}
  }else if(cap!==undefined){
    if(rawContext!==undefined&&cap<rawContext){context=cap;capped=true;}
  }
  const source: ResolvedModelLimit['source'] = input||directContext?'event-model':catalogContext?'model-catalog':configured?'config':'unavailable';
  const out: ResolvedModelLimit = { context,
    output:asPositiveInt(direct?.output) ?? asPositiveInt(fromCatalog?.output),
    source };
  if(cap!==undefined||ratioCap!==undefined){
    out.capped=capped;
    if(capped)out.uncappedContext=rawContext;
  }
  return out;
}
/** Bytes are treated conservatively for mostly UTF-8 text, without expensive tokenizer dependencies. */
export function estimateTokens(text: unknown): number {
  if(typeof text!=='string') return 0;
  const bytes=Buffer.byteLength(text,'utf8');
  return Math.ceil(bytes/3)+4;
}
function limitedStringify(value: unknown, maxLength: number = 600_000): string {
  if(value === undefined || value === null) return '';
  if(typeof value === 'string') return value.slice(0,maxLength);
  try { const encoded=JSON.stringify(value); return typeof encoded==='string' ? encoded.slice(0,maxLength) : ''; }
  catch { return ''; }
}
const MEDIA_PART_TYPES = new Set(['media', 'image', 'file']);
const MEDIA_BINARY_KEYS = new Set(['data', 'base64', 'bytes', 'blob']);
const DATA_URI_BASE64 = /^data:[^;,\s]{1,80};base64,/i;
const MEDIA_ITEM_TOKENS = 1200;

/**
 * Bounded, media-aware measurement of a single message content part.
 * Never JSON.stringify-s base64 data URIs or binary file/image attachments into
 * estimatedChars, toolChars, or bytes/3 token counts; instead marks mediaPresent
 * and charges a realistic bounded flat token estimate per media attachment.
 */
function measurePart(root: unknown, maxChars: number = 600_000): { chars: number; tokens: number; media: boolean } {
  let chars = 0;
  let tokens = 0;
  let media = false;
  let nodes = 0;
  let mediaCount = 0;
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): void => {
    if (v === null || v === undefined || depth > 8 || ++nodes > 4096) return;
    if (typeof v === 'string') {
      if (DATA_URI_BASE64.test(v.slice(0, 128))) {
        media = true;
        if (++mediaCount <= 32) tokens += MEDIA_ITEM_TOKENS;
        return;
      }
      if (chars >= maxChars) return;
      const slice = v.length > maxChars - chars ? v.slice(0, maxChars - chars) : v;
      chars += slice.length;
      tokens += estimateTokens(slice);
      return;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      if (chars < maxChars) chars += 4;
      tokens += 1;
      return;
    }
    if (typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      const lim = Math.min(v.length, 256);
      for (let i = 0; i < lim && nodes <= 4096; i++) walk(v[i], depth + 1);
      return;
    }
    const rec = v as Record<string, unknown>;
    const t = typeof rec.type === 'string' ? rec.type.toLowerCase() : '';
    if (MEDIA_PART_TYPES.has(t)) {
      media = true;
      if (++mediaCount <= 32) tokens += MEDIA_ITEM_TOKENS;
      return;
    }
    let keyCount = 0;
    for (const k of Object.keys(rec)) {
      if (++keyCount > 128 || nodes > 4096) break;
      const val = rec[k];
      if (MEDIA_BINARY_KEYS.has(k) && typeof val === 'string' && val.length >= 256) {
        media = true;
        if (++mediaCount <= 32) tokens += MEDIA_ITEM_TOKENS;
        continue;
      }
      walk(val, depth + 1);
    }
  };
  walk(root, 0);
  return { chars, tokens, media };
}
function parseTokenBag(t: any): number | undefined {
  if(!obj(t)) return undefined;
  const inp=asPositiveInt(t.input)??asPositiveInt(t.prompt)??asPositiveInt(t.inputTokens)??0;
  const out=asPositiveInt(t.output)??asPositiveInt(t.completion)??asPositiveInt(t.outputTokens)??0;
  const reasoning=asPositiveInt(t.reasoning)??asPositiveInt(t.reasoningTokens)??0;
  const cacheRead=obj(t.cache)?(asPositiveInt(t.cache.read)??0):(asPositiveInt(t.cacheRead)??0);
  const cacheWrite=obj(t.cache)?(asPositiveInt(t.cache.write)??0):(asPositiveInt(t.cacheWrite)??0);
  const sum=inp+out+reasoning+cacheRead+cacheWrite;
  if(sum>0) return sum;
  return asPositiveInt(t.total)??asPositiveInt(t.totalTokens);
}
function extractMsgReportedTokens(msg: any): number | undefined {
  if(!obj(msg)) return undefined;
  const role=msg.role??msg.type??msg.info?.role;
  if(role!=='assistant') return undefined;
  const direct=obj(msg.tokens)?msg.tokens:obj(msg.usage)?msg.usage:obj(msg.info?.tokens)?msg.info.tokens:obj(msg.info?.usage)?msg.info.usage:undefined;
  if(direct) {
    const parsed=parseTokenBag(direct);
    if(parsed!==undefined) return parsed;
  }
  const numDirect=asPositiveInt(msg.tokens)??asPositiveInt(msg.info?.tokens);
  if(numDirect!==undefined) return numDirect;
  const parts=Array.isArray(msg.content)?msg.content:Array.isArray(msg.parts)?msg.parts:undefined;
  if(parts) {
    let lastPartTokens: number | undefined;
    for(const part of parts) {
      if(!obj(part)) continue;
      const bag=obj(part.tokens)?part.tokens:obj(part.usage)?part.usage:undefined;
      const p=bag?parseTokenBag(bag):undefined;
      if(p!==undefined) lastPartTokens=p;
    }
    if(lastPartTokens!==undefined) return lastPartTokens;
  }
  return undefined;
}
/** Only estimates model-visible text; media tokens are not predictable from these hooks. */
/** Real provider token counts keyed by assistant message id (e.g. from session.step.ended), plus drops and overhead baseline already reflected in them. */
export interface NativeTokenInfo { tokens: Map<string, number>; baselineChars?: number; baselineOverheadTokens?: number }
export function sumPrunedMsgChars(messages: unknown): number {
  if(!Array.isArray(messages)) return 0;
  let total=0;
  for(const m of messages) total+=getPrunedMsgChars(m);
  return total;
}
export function estimateRequest(event: any, modelLimits: Map<string, ModelLimitEntry>, options: any, native?: NativeTokenInfo): PressureEstimate {
  const model=resolveModelLimit(event,modelLimits,options);
  let estimatedTokens=0;
  let estimatedChars=0; // visible text chars counted by the same walk as estimatedTokens
  let overheadTokens=0;
  let systemChars=0;
  let chatChars=0;
  let toolChars=0;
  let mediaPresent=false;
  let lastReportedBase;
  let lastFromNative=false;
  let trailingAfterReported=0;
  let prunedCharsSoFar=0;
  const isToolPart=(p: any): boolean => {
    const t=typeof p?.type==='string'?p.type.toLowerCase():'';
    return t==='tool'||t==='tool-call'||t==='tool_use'||t==='tool-result'||t==='tool_result'||t==='tool-invocation'||t==='dynamic-tool';
  };
  for(const part of event?.system??[]) {
    const text=limitedStringify(part);
    estimatedChars+=text.length;
    systemChars+=text.length;
    const tok=estimateTokens(text);
    estimatedTokens+=tok;
    overheadTokens+=tok;
  }
  const toolCharsByName=new Map<string, number>();
  const SAFE_TOOL_NAME=/^[a-z0-9_.:-]{1,32}$/i;
  const addToolChars=(rawName: unknown, chars: number): void => {
    if(chars<=0)return;
    const raw=typeof rawName==='string'?rawName.trim().toLowerCase():'';
    const key=raw&&SAFE_TOOL_NAME.test(raw)?raw:'tool';
    toolCharsByName.set(key,(toolCharsByName.get(key)??0)+chars);
  };
  for(const msg of event?.messages??[]) {
    prunedCharsSoFar+=getPrunedMsgChars(msg);
    let msgTokens=12;
    const role=String(msg?.role??msg?.type??'').toLowerCase();
    const isToolMsg=role==='tool'||role==='shell';
    const isSysMsg=role==='system'||role==='skill';
    if(typeof msg?.reasoning_content==='string') {
      const rtext=msg.reasoning_content.slice(0,600_000);
      estimatedChars+=rtext.length;
      chatChars+=rtext.length;
      msgTokens+=estimateTokens(rtext);
    }
    const content=msg?.content;
    if(typeof content==='string') {
      const text=content.slice(0,600_000);
      estimatedChars+=text.length;
      if(isToolMsg){ toolChars+=text.length; addToolChars(msg?.tool??msg?.name??role,text.length); }
      else if(isSysMsg) systemChars+=text.length;
      else chatChars+=text.length;
      msgTokens+=estimateTokens(text);
    } else if(Array.isArray(content)) {
      for(const part of content) {
        if(!obj(part)) continue;
        const measured=measurePart(part);
        if(measured.media) mediaPresent=true;
        estimatedChars+=measured.chars;
        if(isToolMsg||isToolPart(part)){ toolChars+=measured.chars; addToolChars(part.toolName??part.name??part.tool??msg?.toolName??msg?.tool??role,measured.chars); }
        else if(isSysMsg) systemChars+=measured.chars;
        else chatChars+=measured.chars;
        msgTokens+=measured.tokens;
      }
    }
    estimatedTokens+=msgTokens;
    let reported=extractMsgReportedTokens(msg);
    let fromNative=false;
    if(reported===undefined&&native&&typeof msg?.id==='string'){
      const v=native.tokens.get(msg.id);
      if(typeof v==='number'&&Number.isFinite(v)&&v>0){reported=v;fromNative=true;}
    }
    if(reported!==undefined){
      // Real counts already include drops applied in the request they measured; only newer drops are subtracted.
      const newlyPruned=fromNative?Math.max(0,prunedCharsSoFar-(native?.baselineChars??0)):prunedCharsSoFar;
      const reclaimedTokens=Math.floor(newlyPruned/3);
      lastReportedBase=Math.max(0,reported-reclaimedTokens);
      lastFromNative=fromNative;
      trailingAfterReported=0;
    }else if(lastReportedBase!==undefined){
      trailingAfterReported+=msgTokens;
    }
  }
  let toolSchemaChars=0;
  let toolCount=0;
  for(const [name,tool] of Object.entries(event?.tools??{})) {
    toolCount++;
    const text=limitedStringify(tool);
    const len=name.length+text.length;
    toolSchemaChars+=len;
    estimatedChars+=len;
    systemChars+=len;
    const tok=estimateTokens(name)+estimateTokens(text);
    estimatedTokens+=tok;
    overheadTokens+=tok;
  }
  const topTools: ToolBloatEntry[]=[...toolCharsByName.entries()]
    .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
    .slice(0,3)
    .map(([name,chars])=>({name,chars}));
  const overheadDelta=lastFromNative && typeof native?.baselineOverheadTokens==='number' && Number.isFinite(native.baselineOverheadTokens)
    ? Math.max(0,overheadTokens-native.baselineOverheadTokens) : 0;
  const reportedTokens=lastReportedBase!==undefined ? lastReportedBase+trailingAfterReported+overheadDelta : undefined;
  // Real counts for the latest assistant step are authoritative (they match the OpenCode screen); the byte estimate
  // is only a floor for provider counts embedded in messages and the fallback when no real count exists.
  const effectiveTokens=reportedTokens!==undefined ? (lastFromNative ? reportedTokens : Math.max(estimatedTokens,reportedTokens)) : estimatedTokens;
  const context=model.context;
  const cappedModelOutput=context&&model.output ? Math.min(model.output,Math.floor(context*0.25)) : (model.output??0);
  const rawReserve=Math.max(options.outputReserveTokens,cappedModelOutput);
  const uncappedHeadroom=model.capped&&context&&model.uncappedContext&&model.uncappedContext>context ? model.uncappedContext-context : 0;
  const reserve=Math.max(0,rawReserve-uncappedHeadroom);
  const usable=context && context>reserve ? context-reserve:undefined;
  const ratio=usable ? effectiveTokens/usable:undefined;
  const out: PressureEstimate = {estimatedTokens,estimatedChars,modelContext:context,modelSource:model.source,usableTokens:usable,
    ratio,estimated:true,mediaPresent,effectiveTokens,overheadTokens,breakdown:{systemChars,chatChars,toolChars},
    diagnostics:{toolSchemaChars,toolCount,topTools}};
  if(reportedTokens!==undefined) out.reportedTokens=reportedTokens;
  return out;
}
/** Prewarm host-provided limits once. Not a provider generation request. */
export async function discoverModelLimits(ctx: any): Promise<Map<string, ModelLimitEntry>> {
  const result=new Map();
  if(typeof ctx?.model?.list!=='function') return result;
  try {
    const response=await ctx.model.list();
    const items=Array.isArray(response)?response:Array.isArray(response?.data)?response.data:[];
    for(const model of items.slice(0,2000)) {
      if(typeof model?.providerID==='string'&&typeof model.id==='string'&&model.limit) {
        result.set(`${model.providerID}/${model.id}`,model.limit);
      }
    }
  } catch { /* No model list: do not fabricate a context window. */ }
  return result;
}
/**
 * Refresh the catalog once for a model that was selected after setup (fallback,
 * provider switch, reloaded config). Missing limits stay missing; no default
 * context window is invented.
 */
const MODEL_LOOKUP_ATTEMPTS = new WeakMap<Set<string>, Map<string, number>>();
const MAX_MODEL_LOOKUP_RETRIES = 3;
export function resetModelLookupAttempts(attempted: Set<string>): void {
  if (!(attempted instanceof Set)) return;
  attempted.clear();
  MODEL_LOOKUP_ATTEMPTS.delete(attempted);
}
export async function ensureModelLimit(ctx: any, modelLimits: Map<string, ModelLimitEntry>, model: any, attempted: Set<string>): Promise<void> {
  if(!(modelLimits instanceof Map)||!(attempted instanceof Set)) return;
  if(typeof model?.providerID!=='string'||typeof model.id!=='string') return;
  const key=`${model.providerID}/${model.id}`;
  if(modelLimits.has(key)||attempted.has(key)) return;
  let counts=MODEL_LOOKUP_ATTEMPTS.get(attempted);
  if(!counts){ counts=new Map(); MODEL_LOOKUP_ATTEMPTS.set(attempted,counts); }
  const prev=counts.get(key)??0;
  if(prev>=MAX_MODEL_LOOKUP_RETRIES){ attempted.add(key); return; }
  try {
    const fresh=await discoverModelLimits(ctx);
    for(const [k,v] of fresh) if(!modelLimits.has(k)) modelLimits.set(k,v);
    if(modelLimits.has(key)){ counts.delete(key); return; }
    // On OpenCode v2.4.0 non-blocking startup, ctx.model.list() can return empty before providers finish loading;
    // do not burn lookup retries on an empty catalog.
    if(fresh.size>0){
      const next=prev+1;
      counts.set(key,next);
      if(next>=MAX_MODEL_LOOKUP_RETRIES) attempted.add(key);
    }
  } catch { /* Best effort only. */ }
}

