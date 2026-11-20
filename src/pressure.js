/** Pure, deliberately conservative estimates; no claim of exact provider token accounting. */
function obj(x) { return x !== null && typeof x==='object'; }
function asPositiveInt(n) { return Number.isSafeInteger(n)&&n>0&&n<=10_000_000 ? n:undefined; }
export function resolveModelLimit(event, modelLimits = new Map(), options = {}) {
  const direct = event?.model?.limit;
  const directContext=asPositiveInt(direct?.context);
  const input=asPositiveInt(direct?.input);
  const id=event?.model?.id, provider=event?.model?.providerID;
  const fromCatalog=typeof id==='string'&&typeof provider==='string' ? modelLimits.get(`${provider}/${id}`) : undefined;
  const configured=asPositiveInt(options?.contextWindow);
  const context=input ?? directContext ?? asPositiveInt(fromCatalog?.input) ?? asPositiveInt(fromCatalog?.context) ?? configured;
  const catalogContext=asPositiveInt(fromCatalog?.input) ?? asPositiveInt(fromCatalog?.context);
  const source=input||directContext?'event-model':catalogContext?'model-catalog':configured?'config':'unavailable';
  return { context,
    output:asPositiveInt(direct?.output) ?? asPositiveInt(fromCatalog?.output),
    source };
}
/** Bytes are treated conservatively for mostly UTF-8 text, without expensive tokenizer dependencies. */
export function estimateTokens(text) {
  if(typeof text!=='string') return 0;
  const bytes=Buffer.byteLength(text,'utf8');
  return Math.ceil(bytes/3)+4;
}
function limitedStringify(value, maxLength=600_000) {
  if(value === undefined || value === null) return '';
  if(typeof value === 'string') return value.slice(0,maxLength);
  try { const encoded=JSON.stringify(value); return typeof encoded==='string' ? encoded.slice(0,maxLength) : ''; }
  catch { return ''; }
}
/** Only estimates model-visible text; media tokens are not predictable from these hooks. */
export function estimateRequest(event, modelLimits, options) {
  const model=resolveModelLimit(event,modelLimits,options);
  let estimatedTokens=0;
  let estimatedChars=0; // visible text chars counted by the same walk as estimatedTokens
  let mediaPresent=false;
  for(const part of event?.system??[]) {
    const text=limitedStringify(part);
    estimatedChars+=text.length;
    estimatedTokens+=estimateTokens(text);
  }
  for(const msg of event?.messages??[]) {
    estimatedTokens+=12;
    const content=msg?.content;
    if(typeof content==='string') {
      const text=content.slice(0,600_000);
      estimatedChars+=text.length;
      estimatedTokens+=estimateTokens(text);
      continue;
    }
    if(!Array.isArray(content)) continue;
    for(const part of content) {
      if(!obj(part)) continue;
      if(part.type==='media'||part.type==='image'||part.type==='file') mediaPresent=true;
      const text=limitedStringify(part);
      estimatedChars+=text.length;
      estimatedTokens+=estimateTokens(text);
    }
  }
  for(const [name,tool] of Object.entries(event?.tools??{})) {
    const text=limitedStringify(tool);
    estimatedChars+=name.length+text.length;
    estimatedTokens+=estimateTokens(name)+estimateTokens(text);
  }
  const reserve=Math.max(options.outputReserveTokens,model.output??0);
  const context=model.context;
  const usable=context && context>reserve ? context-reserve:undefined;
  const ratio=usable ? estimatedTokens/usable:undefined;
  return {estimatedTokens,estimatedChars,modelContext:context,modelSource:model.source,usableTokens:usable,
    ratio,estimated:true,mediaPresent};
}
/** Prewarm host-provided limits once. Not a provider generation request. */
export async function discoverModelLimits(ctx) {
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
export async function ensureModelLimit(ctx, modelLimits, model, attempted) {
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

