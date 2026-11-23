
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
}

/** Pure, deliberately conservative estimates; no claim of exact provider token accounting. */
function obj(x: unknown): x is Record<string, any> { return x !== null && typeof x==='object'; }
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
export function estimateRequest(event: any, modelLimits: Map<string, ModelLimitEntry>, options: any): PressureEstimate {
  const model=resolveModelLimit(event,modelLimits,options);
  let estimatedTokens=0;
  let estimatedChars=0; // visible text chars counted by the same walk as estimatedTokens
  let mediaPresent=false;
  let lastReportedBase;
  let trailingAfterReported=0;
  for(const part of event?.system??[]) {
    const text=limitedStringify(part);
    estimatedChars+=text.length;
    estimatedTokens+=estimateTokens(text);
  }
  for(const msg of event?.messages??[]) {
    let msgTokens=12;
    if(typeof msg?.reasoning_content==='string') {
      const rtext=msg.reasoning_content.slice(0,600_000);
      estimatedChars+=rtext.length;
      msgTokens+=estimateTokens(rtext);
    }
    const content=msg?.content;
    if(typeof content==='string') {
      const text=content.slice(0,600_000);
      estimatedChars+=text.length;
      msgTokens+=estimateTokens(text);
    } else if(Array.isArray(content)) {
      for(const part of content) {
        if(!obj(part)) continue;
        if(part.type==='media'||part.type==='image'||part.type==='file') mediaPresent=true;
        const text=limitedStringify(part);
        estimatedChars+=text.length;
        msgTokens+=estimateTokens(text);
      }
    }
    estimatedTokens+=msgTokens;
    const reported=extractMsgReportedTokens(msg);
    if(reported!==undefined){
      lastReportedBase=reported;
      trailingAfterReported=0;
    }else if(lastReportedBase!==undefined){
      trailingAfterReported+=msgTokens;
    }
  }
  for(const [name,tool] of Object.entries(event?.tools??{})) {
    const text=limitedStringify(tool);
    estimatedChars+=name.length+text.length;
    estimatedTokens+=estimateTokens(name)+estimateTokens(text);
  }
  const reportedTokens=lastReportedBase!==undefined ? lastReportedBase+trailingAfterReported : undefined;
  const effectiveTokens=reportedTokens!==undefined ? Math.max(estimatedTokens,reportedTokens) : estimatedTokens;
  const context=model.context;
  const cappedModelOutput=context&&model.output ? Math.min(model.output,Math.floor(context*0.25)) : (model.output??0);
  const rawReserve=Math.max(options.outputReserveTokens,cappedModelOutput);
  const uncappedHeadroom=model.capped&&context&&model.uncappedContext&&model.uncappedContext>context ? model.uncappedContext-context : 0;
  const reserve=Math.max(0,rawReserve-uncappedHeadroom);
  const usable=context && context>reserve ? context-reserve:undefined;
  const ratio=usable ? effectiveTokens/usable:undefined;
  const out: PressureEstimate = {estimatedTokens,estimatedChars,modelContext:context,modelSource:model.source,usableTokens:usable,
    ratio,estimated:true,mediaPresent};
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
export async function ensureModelLimit(ctx: any, modelLimits: Map<string, ModelLimitEntry>, model: any, attempted: Set<string>): Promise<void> {
  if(!(modelLimits instanceof Map)||!(attempted instanceof Set)) return;
  if(typeof model?.providerID!=='string'||typeof model.id!=='string') return;
  const key=`${model.providerID}/${model.id}`;
  if(modelLimits.has(key)||attempted.has(key)) return;
  attempted.add(key);
  try {
    const fresh=await discoverModelLimits(ctx);
    for(const [k,v] of fresh) if(!modelLimits.has(k)) modelLimits.set(k,v);
  } catch { /* Best effort only. */ }
}

