import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve as resolvePath, isAbsolute } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { openMemoryStore, MAX_TEXT_CHARS } from "./memory-store.js";
import { SECTION_NAMES, normalizeSection } from "./memory-sections.js";
import { estimateRequest } from "./pressure.js";
export const TOOL_NAME = 'trim_history_search';
export const EXPAND_TOOL_NAME = 'trim_expand';
const EVENT_TYPES = Object.freeze(['session.compaction.started', 'session.compaction.ended', 'session.compaction.failed']);
const MAX_PENDING = 64;
const MAX_QUERY = 500;
const FALLBACK_CHARS = 2_000_000;
function obj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
export function defaultDbPath() {
    const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    return join(base, 'opencode-trim', 'memory.db');
}
// Event payload location differs between host revisions; accept the common shapes.
function payload(e) { return obj(e?.data) ? e.data : obj(e?.properties) ? e.properties : (obj(e) ? e : {}); }
function validReg(r) {
    if (!r || typeof r.dispose !== 'function')
        throw new Error('opencode-trim memory: host registration is missing dispose()');
    return r;
}
function pick(...vals) { return vals.find(v => v !== undefined && v !== null); }
function sessionOf(e) { const p = payload(e); const s = pick(p.sessionID, e?.sessionID); return typeof s === 'string' && s ? s : undefined; }
/** Estimated model-visible tokens of a session context; never throws. */
async function contextTokens(ctx, sessionID) {
    try {
        return estimateContext(await ctx.session.context({ sessionID }));
    }
    catch {
        return undefined;
    }
}
const MAX_MESSAGES = 20_000;
const MAX_DEPTH = 6;
const SKIP_KEYS = new Set(['data', 'base64', 'bytes', 'blob', 'image', 'media']);
/** View of messages for estimation only: host `{type,text}` / `{parts}` messages count like `content`. Never mutates. */
function normalizeMessages(list) {
    const out = [];
    for (const m of list.slice(0, MAX_MESSAGES)) {
        if (!obj(m) || m.content !== undefined && m.content !== null) {
            out.push(m);
            continue;
        }
        if (typeof m.text === 'string')
            out.push({ ...m, content: m.text });
        else if (Array.isArray(m.parts))
            out.push({ ...m, content: m.parts });
        else
            out.push(m);
    }
    return out;
}
/** Characters of visible text (string values, not keys/punctuation/media payloads); bounded by depth and total. */
function textChars(root) {
    const budget = { left: FALLBACK_CHARS, seen: 0 };
    const walk = (v, depth) => {
        if (budget.left <= 0 || depth > MAX_DEPTH)
            return;
        if (typeof v === 'string') {
            budget.left -= v.length;
            return;
        }
        if (v === null || typeof v !== 'object')
            return;
        if (++budget.seen > 200_000) {
            budget.left = 0;
            return;
        }
        if (Array.isArray(v)) {
            for (const x of v)
                walk(x, depth + 1);
            return;
        }
        for (const k of Object.keys(v))
            if (!SKIP_KEYS.has(k))
                walk(v[k], depth + 1);
    };
    walk(root, 0);
    return Math.max(0, FALLBACK_CHARS - Math.max(0, budget.left));
}
function estimateContext(c) {
    try {
        if (!Array.isArray(c) && !obj(c))
            return undefined;
        const req = Array.isArray(c)
            ? { messages: normalizeMessages(c), system: [], tools: {} }
            : { ...c, messages: Array.isArray(c.messages) ? normalizeMessages(c.messages) : c.messages };
        let est = 0;
        try {
            est = estimateRequest(req, new Map(), { outputReserveTokens: 8192 }).estimatedTokens;
        }
        catch { }
        const chars = textChars(c);
        // Sanity floor: an estimate far below the visible text size means the shape was not understood.
        if (chars > 0 && !(est >= chars / 9))
            return Math.ceil(chars / 3);
        return est > 0 ? est : undefined;
    }
    catch {
        return undefined;
    }
}
/** Canonical absolute directory, or undefined for anything not an absolute resolvable string. */
function canonDir(v) {
    try {
        if (typeof v !== 'string' || !v || !isAbsolute(v) || v.includes('\0'))
            return undefined;
        try {
            return realpathSync(v);
        }
        catch {
            return resolvePath(v);
        }
    }
    catch {
        return undefined;
    }
}
/**
 * Fail-closed attribution on a multi-location server. Reads every location candidate so no
 * precedence can hide another: 'absent' | 'ambiguous' | 'conflict' | 'local' | 'foreign'.
 */
function locationState(e, localDir) {
    try {
        const dirs = new Set();
        for (const holder of [e, e?.data, e?.properties]) {
            const loc = holder?.location;
            if (loc === undefined || loc === null)
                continue;
            if (!obj(loc))
                return 'ambiguous';
            const raw = loc.directory;
            if (raw === undefined || raw === null)
                continue;
            const dir = canonDir(raw);
            if (dir === undefined)
                return 'ambiguous';
            dirs.add(dir);
        }
        if (dirs.size === 0)
            return 'absent';
        if (dirs.size > 1)
            return 'conflict';
        if (!localDir)
            return 'ambiguous';
        return dirs.has(localDir) ? 'local' : 'foreign';
    }
    catch {
        return 'ambiguous';
    }
}
function agentOf(event) {
    for (const v of [event?.agent, event?.agentID, event?.agentName, event?.context?.agent, event?.session?.agent]) {
        if (typeof v === 'string' && v)
            return v;
        if (obj(v) && typeof v.name === 'string' && v.name)
            return v.name;
        if (obj(v) && typeof v.id === 'string' && v.id)
            return v.id;
    }
    return undefined;
}
/** Optional observer hooks (stats); a hook failure must never affect memory behavior. */
function callHook(fn, arg) { if (typeof fn !== 'function')
    return; try {
    fn(arg);
}
catch { /* observer only */ } }
function sessionIdOf(context) {
    const s = pick(context?.sessionID, context?.sessionId, context?.session?.id);
    return typeof s === 'string' && s ? s : undefined;
}
/** Main DB + active journal/WAL size in bytes; null for :memory: or any stat failure. */
export function memoryDbBytes(dbPath) {
    if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:')
        return null;
    try {
        let total = statSync(dbPath).size;
        for (const suffix of ['-wal', '-journal']) {
            try {
                total += statSync(`${dbPath}${suffix}`).size;
            }
            catch { /* no sidecar file */ }
        }
        return total;
    }
    catch {
        return null;
    }
}
function sectionLabel(name) { return name.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '); }
function format(rows) {
    if (!rows.length)
        return 'No matching compaction history for this project.';
    return rows.map((r) => `[${r.date.slice(0, 10)}] session ${r.session_id ?? '?'}:${r.section ? ` [${sectionLabel(r.section)}]` : ''} ${r.snippet.replace(/\s+/g, ' ').trim()}`).join('\n');
}
/**
 * Compaction-summary memory. Only called when memory.enabled; owns its DB,
 * event subscription, one tool and one hook, and returns an idempotent cleanup.
 */
export async function setupMemory(ctx, opts, hooks) {
    const mem = opts?.memory;
    if (!mem?.enabled)
        return async () => { };
    const rawProject = ctx?.location?.directory;
    const project = canonDir(rawProject);
    if (!project)
        throw new Error('opencode-trim memory: ctx.location.directory must be an absolute path');
    const localDir = project;
    const allow = new Set(mem.agentAllowlist);
    const deny = new Set(mem.agentDenylist);
    const dbPath = mem.dbPath ?? defaultDbPath();
    const store = openMemoryStore({ dbPath, retentionDays: mem.retentionDays, project });
    const abort = new AbortController();
    const regs = [];
    let disposed = false;
    const cleanup = async () => {
        if (disposed)
            return;
        disposed = true;
        abort.abort();
        const pendingDisposals = [];
        for (const r of regs.reverse()) {
            try {
                pendingDisposals.push(Promise.resolve(r.dispose()));
            }
            catch { /* keep disposing the rest */ }
        }
        await Promise.allSettled(pendingDisposals);
        callHook(hooks?.onClose, { project });
        try {
            store.close();
        }
        catch { }
    };
    try {
        const vault = {
            store(refId, entry) {
                const target = entry?.input?.path ?? entry?.input?.filePath ?? entry?.input?.command ?? entry?.input?.pattern ?? '';
                return store.saveVault({
                    project,
                    ref_id: refId,
                    tool: entry?.name ?? 'tool',
                    target: typeof target === 'string' ? target : '',
                    text: entry?.original ?? '',
                    tokens: Math.max(1, Math.ceil((entry?.length ?? 0) / 3)),
                }).saved;
            },
            has(refId) {
                return store.hasVault(project, refId);
            },
        };
        callHook(hooks?.onReady, { project, store, dbPath, vault });
        // Fail-closed gate first so the tools are never exposed without it.
        regs.push(validReg(await ctx.tool.hook('execute.before', (event) => {
            if (event?.tool !== TOOL_NAME && event?.tool !== EXPAND_TOOL_NAME)
                return;
            const agent = agentOf(event);
            // Empty allowlist = no plugin-level restriction (host permissions decide).
            if ((agent && deny.has(agent)) || (allow.size && (!agent || !allow.has(agent))))
                throw new Error(`${event.tool} is not available to this agent`);
        })));
        regs.push(validReg(await ctx.tool.transform((editor) => {
            editor.add({
                name: EXPAND_TOOL_NAME,
                description: 'Restore or inspect a pruned tool output cached by opencode-trim under a ref ID (e.g. "trm_..."). Supports optional line range (startLine, endLine) and case-insensitive grep filtering.',
                input: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', minLength: 1, maxLength: 128, description: 'The cached ref ID from a pruning notice (e.g. "trm_...").' },
                        startLine: { type: 'integer', minimum: 1, description: 'Optional 1-based start line (inclusive).' },
                        endLine: { type: 'integer', minimum: 1, description: 'Optional 1-based end line (inclusive).' },
                        grep: { type: 'string', maxLength: 200, description: 'Optional case-insensitive substring filter.' },
                    },
                    required: ['id'], additionalProperties: false,
                },
                output: {
                    type: 'object',
                    properties: {
                        found: { type: 'boolean' },
                        id: { type: 'string' },
                        tool: { type: ['string', 'null'] },
                        target: { type: ['string', 'null'] },
                        totalLines: { type: 'integer' },
                        matchedLines: { type: 'integer' },
                        truncated: { type: 'boolean' },
                        text: { type: 'string' },
                    },
                    required: ['found', 'id', 'text'],
                },
                options: { codemode: false },
                execute: async (input, context) => {
                    if (context?.signal?.aborted)
                        throw new Error('Cancelled');
                    const id = input?.id;
                    if (typeof id !== 'string' || !id.trim() || id.length > 128)
                        throw new Error('id must be a non-empty string');
                    const out = store.getVault({
                        project,
                        ref_id: id.trim(),
                        startLine: input?.startLine,
                        endLine: input?.endLine,
                        grep: input?.grep,
                    });
                    return { content: out.text, output: out };
                },
            });
            editor.add({
                name: TOOL_NAME,
                description: 'Search archived compaction summaries of earlier context for this project. Returns short snippets; use only when past decisions are needed.',
                input: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', minLength: 1, maxLength: MAX_QUERY },
                        section: { type: 'string', description: `Optional: restrict the match to one section of the archived summary. One of: ${SECTION_NAMES.join(', ')} (case, spaces and hyphens are tolerated, e.g. "Work State", "next-move").` },
                    },
                    required: ['query'], additionalProperties: false,
                },
                output: {
                    type: 'object',
                    properties: {
                        results: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    event_id: { type: 'string' },
                                    project: { type: 'string' },
                                    session_id: { type: ['string', 'null'] },
                                    model: { type: ['string', 'null'] },
                                    reason: { type: ['string', 'null'] },
                                    created_at: { type: 'integer' },
                                    date: { type: 'string' },
                                    rank: { type: 'number' },
                                    snippet: { type: 'string' },
                                    section: { type: ['string', 'null'] },
                                },
                            },
                        },
                    },
                    required: ['results'],
                },
                options: { codemode: false },
                execute: async (input, context) => {
                    if (context?.signal?.aborted)
                        throw new Error('Cancelled');
                    const q = input?.query;
                    if (typeof q !== 'string' || !q.trim() || q.length > MAX_QUERY)
                        throw new Error('query must be a non-empty string');
                    let section;
                    if (input.section !== undefined && input.section !== null) {
                        section = normalizeSection(input.section);
                        if (!section)
                            throw new Error(`section must be one of: ${SECTION_NAMES.join(', ')}`);
                    }
                    const results = store.search(section ? { project, query: q, section } : { project, query: q });
                    callHook(hooks?.onSearch, { sessionID: sessionIdOf(context), results });
                    return { content: format(results), output: { results } };
                },
            });
        })));
        const pending = new Map();
        const awaitingAfter = new Map(); // sessionID -> { event_id, sessionID }
        // The summary enters context after compaction.ended; the next context hook for that session sees the real size.
        regs.push(validReg(await ctx.session.hook('context', (event) => {
            try {
                const sid = event?.sessionID;
                if (typeof sid !== 'string' || !sid)
                    return;
                const ls = locationState(event, localDir);
                if (ls !== 'local' && ls !== 'absent')
                    return;
                const wait = awaitingAfter.get(sid);
                if (!wait)
                    return;
                awaitingAfter.delete(sid);
                const tokens = estimateContext(event);
                if (tokens !== undefined)
                    store.updateContextAfter(project, wait.event_id, tokens);
            }
            catch { /* never break the host */ }
        })));
        const subscription = await ctx.event.subscribe({ signal: abort.signal, types: [...EVENT_TYPES] });
        const handle = async (e) => {
            const type = e?.type;
            if (!EVENT_TYPES.includes(type))
                return;
            // Attribution first: nothing below (payload, context, pending, archive) runs for unattributed events.
            const ls = locationState(e, localDir);
            if (type === 'session.compaction.failed' ? (ls !== 'local' && ls !== 'absent') : ls !== 'local')
                return;
            const sid = sessionOf(e);
            if (!sid)
                return;
            const p = payload(e);
            if (type === 'session.compaction.started') {
                const before = await contextTokens(ctx, sid);
                pending.delete(sid);
                if (pending.size >= MAX_PENDING)
                    pending.delete(pending.keys().next().value);
                pending.set(sid, before);
            }
            else if (type === 'session.compaction.failed') {
                pending.delete(sid);
            }
            else {
                const before = pending.get(sid);
                pending.delete(sid);
                callHook(hooks?.onCompactionEnded, sid);
                const text = p.text;
                if (typeof text !== 'string' || !text.trim() || p.native || text.length > MAX_TEXT_CHARS)
                    return;
                const id = pick(p.eventID, p.id, e.id);
                const event_id = typeof id === 'string' && id ? id
                    : `${sid}:${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
                const model = obj(p.model) ? pick(p.model.id, p.model.modelID) : p.model;
                const { inserted } = store.archive({
                    event_id, project, session_id: sid, model, reason: p.reason,
                    created_at: Date.now(), text, tokens: { tokens: p.tokens, cost: p.cost },
                    context_before_tokens: before, context_after_tokens: null,
                });
                // The summary is inserted into context after this event; fill the size in on the next session.context.
                if (inserted) {
                    awaitingAfter.delete(sid);
                    if (awaitingAfter.size >= MAX_PENDING)
                        awaitingAfter.delete(awaitingAfter.keys().next().value);
                    awaitingAfter.set(sid, { event_id, sessionID: sid });
                }
                store.prune(project);
            }
        };
        (async () => {
            try {
                for await (const e of subscription) {
                    if (abort.signal.aborted)
                        break;
                    try {
                        await handle(e);
                    }
                    catch { /* never break the host */ }
                }
            }
            catch { /* stream ended or aborted */ }
        })();
        return cleanup;
    }
    catch (error) {
        await cleanup();
        throw error;
    }
}
