/** Pure, deliberately conservative estimates; no claim of exact provider token accounting. */
function obj(x) { return x !== null && typeof x === 'object'; }
const PRUNED_MSG_CHARS = new WeakMap();
export function recordPrunedMsgChars(msg, deltaChars) {
    if (!obj(msg) || typeof deltaChars !== 'number' || !Number.isFinite(deltaChars) || deltaChars === 0)
        return;
    const next = (PRUNED_MSG_CHARS.get(msg) ?? 0) + deltaChars;
    if (next > 0)
        PRUNED_MSG_CHARS.set(msg, next);
    else
        PRUNED_MSG_CHARS.delete(msg);
}
export function getPrunedMsgChars(msg) {
    return obj(msg) ? (PRUNED_MSG_CHARS.get(msg) ?? 0) : 0;
}
function asPositiveInt(n) { return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 10_000_000 ? n : undefined; }
export function resolveModelLimit(event, modelLimits = new Map(), options = {}) {
    const direct = event?.model?.limit;
    const directContext = asPositiveInt(direct?.context);
    const input = asPositiveInt(direct?.input);
    const id = event?.model?.id, provider = event?.model?.providerID;
    const fromCatalog = typeof id === 'string' && typeof provider === 'string' ? modelLimits.get(`${provider}/${id}`) : undefined;
    const configured = asPositiveInt(options?.contextWindow);
    const cap = asPositiveInt(options?.contextWindowCap);
    const ratioCap = typeof options?.contextWindowRatioCap === 'number' && options.contextWindowRatioCap >= 0.05 && options.contextWindowRatioCap <= 1 ? options.contextWindowRatioCap : undefined;
    const rawContext = input ?? directContext ?? asPositiveInt(fromCatalog?.input) ?? asPositiveInt(fromCatalog?.context) ?? configured;
    const catalogContext = asPositiveInt(fromCatalog?.input) ?? asPositiveInt(fromCatalog?.context);
    let context = rawContext;
    let capped = false;
    if (ratioCap !== undefined && rawContext !== undefined) {
        const byRatio = Math.max(1024, Math.floor(rawContext * ratioCap));
        if (context === undefined || byRatio < context) {
            context = byRatio;
            capped = true;
        }
    }
    else if (cap !== undefined) {
        if (rawContext !== undefined && cap < rawContext) {
            context = cap;
            capped = true;
        }
    }
    const source = input || directContext ? 'event-model' : catalogContext ? 'model-catalog' : configured ? 'config' : 'unavailable';
    const out = { context,
        output: asPositiveInt(direct?.output) ?? asPositiveInt(fromCatalog?.output),
        source };
    if (cap !== undefined || ratioCap !== undefined) {
        out.capped = capped;
        if (capped)
            out.uncappedContext = rawContext;
    }
    return out;
}
/** Bytes are treated conservatively for mostly UTF-8 text, without expensive tokenizer dependencies. */
export function estimateTokens(text) {
    if (typeof text !== 'string')
        return 0;
    const bytes = Buffer.byteLength(text, 'utf8');
    return Math.ceil(bytes / 3) + 4;
}
function limitedStringify(value, maxLength = 600_000) {
    if (value === undefined || value === null)
        return '';
    if (typeof value === 'string')
        return value.slice(0, maxLength);
    try {
        const encoded = JSON.stringify(value);
        return typeof encoded === 'string' ? encoded.slice(0, maxLength) : '';
    }
    catch {
        return '';
    }
}
function parseTokenBag(t) {
    if (!obj(t))
        return undefined;
    const inp = asPositiveInt(t.input) ?? asPositiveInt(t.prompt) ?? asPositiveInt(t.inputTokens) ?? 0;
    const out = asPositiveInt(t.output) ?? asPositiveInt(t.completion) ?? asPositiveInt(t.outputTokens) ?? 0;
    const reasoning = asPositiveInt(t.reasoning) ?? asPositiveInt(t.reasoningTokens) ?? 0;
    const cacheRead = obj(t.cache) ? (asPositiveInt(t.cache.read) ?? 0) : (asPositiveInt(t.cacheRead) ?? 0);
    const cacheWrite = obj(t.cache) ? (asPositiveInt(t.cache.write) ?? 0) : (asPositiveInt(t.cacheWrite) ?? 0);
    const sum = inp + out + reasoning + cacheRead + cacheWrite;
    if (sum > 0)
        return sum;
    return asPositiveInt(t.total) ?? asPositiveInt(t.totalTokens);
}
function extractMsgReportedTokens(msg) {
    if (!obj(msg))
        return undefined;
    const role = msg.role ?? msg.type ?? msg.info?.role;
    if (role !== 'assistant')
        return undefined;
    const direct = obj(msg.tokens) ? msg.tokens : obj(msg.usage) ? msg.usage : obj(msg.info?.tokens) ? msg.info.tokens : obj(msg.info?.usage) ? msg.info.usage : undefined;
    if (direct) {
        const parsed = parseTokenBag(direct);
        if (parsed !== undefined)
            return parsed;
    }
    const numDirect = asPositiveInt(msg.tokens) ?? asPositiveInt(msg.info?.tokens);
    if (numDirect !== undefined)
        return numDirect;
    const parts = Array.isArray(msg.content) ? msg.content : Array.isArray(msg.parts) ? msg.parts : undefined;
    if (parts) {
        let lastPartTokens;
        for (const part of parts) {
            if (!obj(part))
                continue;
            const bag = obj(part.tokens) ? part.tokens : obj(part.usage) ? part.usage : undefined;
            const p = bag ? parseTokenBag(bag) : undefined;
            if (p !== undefined)
                lastPartTokens = p;
        }
        if (lastPartTokens !== undefined)
            return lastPartTokens;
    }
    return undefined;
}
export function sumPrunedMsgChars(messages) {
    if (!Array.isArray(messages))
        return 0;
    let total = 0;
    for (const m of messages)
        total += getPrunedMsgChars(m);
    return total;
}
export function estimateRequest(event, modelLimits, options, native) {
    const model = resolveModelLimit(event, modelLimits, options);
    let estimatedTokens = 0;
    let estimatedChars = 0; // visible text chars counted by the same walk as estimatedTokens
    let systemChars = 0;
    let chatChars = 0;
    let toolChars = 0;
    let mediaPresent = false;
    let lastReportedBase;
    let lastFromNative = false;
    let trailingAfterReported = 0;
    let prunedCharsSoFar = 0;
    const isToolPart = (p) => {
        const t = typeof p?.type === 'string' ? p.type.toLowerCase() : '';
        return t === 'tool' || t === 'tool-call' || t === 'tool_use' || t === 'tool-result' || t === 'tool_result' || t === 'tool-invocation' || t === 'dynamic-tool';
    };
    for (const part of event?.system ?? []) {
        const text = limitedStringify(part);
        estimatedChars += text.length;
        systemChars += text.length;
        estimatedTokens += estimateTokens(text);
    }
    for (const msg of event?.messages ?? []) {
        prunedCharsSoFar += getPrunedMsgChars(msg);
        let msgTokens = 12;
        const role = String(msg?.role ?? msg?.type ?? '').toLowerCase();
        const isToolMsg = role === 'tool' || role === 'shell';
        const isSysMsg = role === 'system' || role === 'skill';
        if (typeof msg?.reasoning_content === 'string') {
            const rtext = msg.reasoning_content.slice(0, 600_000);
            estimatedChars += rtext.length;
            chatChars += rtext.length;
            msgTokens += estimateTokens(rtext);
        }
        const content = msg?.content;
        if (typeof content === 'string') {
            const text = content.slice(0, 600_000);
            estimatedChars += text.length;
            if (isToolMsg)
                toolChars += text.length;
            else if (isSysMsg)
                systemChars += text.length;
            else
                chatChars += text.length;
            msgTokens += estimateTokens(text);
        }
        else if (Array.isArray(content)) {
            for (const part of content) {
                if (!obj(part))
                    continue;
                if (part.type === 'media' || part.type === 'image' || part.type === 'file')
                    mediaPresent = true;
                const text = limitedStringify(part);
                estimatedChars += text.length;
                if (isToolMsg || isToolPart(part))
                    toolChars += text.length;
                else if (isSysMsg)
                    systemChars += text.length;
                else
                    chatChars += text.length;
                msgTokens += estimateTokens(text);
            }
        }
        estimatedTokens += msgTokens;
        let reported = extractMsgReportedTokens(msg);
        let fromNative = false;
        if (reported === undefined && native && typeof msg?.id === 'string') {
            const v = native.tokens.get(msg.id);
            if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
                reported = v;
                fromNative = true;
            }
        }
        if (reported !== undefined) {
            // Real counts already include drops applied in the request they measured; only newer drops are subtracted.
            const newlyPruned = fromNative ? Math.max(0, prunedCharsSoFar - (native?.baselineChars ?? 0)) : prunedCharsSoFar;
            const reclaimedTokens = Math.floor(newlyPruned / 3);
            lastReportedBase = Math.max(0, reported - reclaimedTokens);
            lastFromNative = fromNative;
            trailingAfterReported = 0;
        }
        else if (lastReportedBase !== undefined) {
            trailingAfterReported += msgTokens;
        }
    }
    for (const [name, tool] of Object.entries(event?.tools ?? {})) {
        const text = limitedStringify(tool);
        estimatedChars += name.length + text.length;
        systemChars += name.length + text.length;
        estimatedTokens += estimateTokens(name) + estimateTokens(text);
    }
    const reportedTokens = lastReportedBase !== undefined ? lastReportedBase + trailingAfterReported : undefined;
    // Real counts for the latest assistant step are authoritative (they match the OpenCode screen); the byte estimate
    // is only a floor for provider counts embedded in messages and the fallback when no real count exists.
    const effectiveTokens = reportedTokens !== undefined ? (lastFromNative ? reportedTokens : Math.max(estimatedTokens, reportedTokens)) : estimatedTokens;
    const context = model.context;
    const cappedModelOutput = context && model.output ? Math.min(model.output, Math.floor(context * 0.25)) : (model.output ?? 0);
    const rawReserve = Math.max(options.outputReserveTokens, cappedModelOutput);
    const uncappedHeadroom = model.capped && context && model.uncappedContext && model.uncappedContext > context ? model.uncappedContext - context : 0;
    const reserve = Math.max(0, rawReserve - uncappedHeadroom);
    const usable = context && context > reserve ? context - reserve : undefined;
    const ratio = usable ? effectiveTokens / usable : undefined;
    const out = { estimatedTokens, estimatedChars, modelContext: context, modelSource: model.source, usableTokens: usable,
        ratio, estimated: true, mediaPresent, effectiveTokens, breakdown: { systemChars, chatChars, toolChars } };
    if (reportedTokens !== undefined)
        out.reportedTokens = reportedTokens;
    return out;
}
/** Prewarm host-provided limits once. Not a provider generation request. */
export async function discoverModelLimits(ctx) {
    const result = new Map();
    if (typeof ctx?.model?.list !== 'function')
        return result;
    try {
        const response = await ctx.model.list();
        const items = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : [];
        for (const model of items.slice(0, 2000)) {
            if (typeof model?.providerID === 'string' && typeof model.id === 'string' && model.limit) {
                result.set(`${model.providerID}/${model.id}`, model.limit);
            }
        }
    }
    catch { /* No model list: do not fabricate a context window. */ }
    return result;
}
/**
 * Refresh the catalog once for a model that was selected after setup (fallback,
 * provider switch, reloaded config). Missing limits stay missing; no default
 * context window is invented.
 */
const MODEL_LOOKUP_ATTEMPTS = new WeakMap();
const MAX_MODEL_LOOKUP_RETRIES = 3;
export async function ensureModelLimit(ctx, modelLimits, model, attempted) {
    if (!(modelLimits instanceof Map) || !(attempted instanceof Set))
        return;
    if (typeof model?.providerID !== 'string' || typeof model.id !== 'string')
        return;
    const key = `${model.providerID}/${model.id}`;
    if (modelLimits.has(key) || attempted.has(key))
        return;
    let counts = MODEL_LOOKUP_ATTEMPTS.get(attempted);
    if (!counts) {
        counts = new Map();
        MODEL_LOOKUP_ATTEMPTS.set(attempted, counts);
    }
    const prev = counts.get(key) ?? 0;
    if (prev >= MAX_MODEL_LOOKUP_RETRIES) {
        attempted.add(key);
        return;
    }
    try {
        const fresh = await discoverModelLimits(ctx);
        for (const [k, v] of fresh)
            if (!modelLimits.has(k))
                modelLimits.set(k, v);
        if (modelLimits.has(key)) {
            counts.delete(key);
            return;
        }
        // On OpenCode v2.4.0 non-blocking startup, ctx.model.list() can return empty before providers finish loading;
        // do not burn lookup retries on an empty catalog.
        if (fresh.size > 0) {
            const next = prev + 1;
            counts.set(key, next);
            if (next >= MAX_MODEL_LOOKUP_RETRIES)
                attempted.add(key);
        }
    }
    catch { /* Best effort only. */ }
}
