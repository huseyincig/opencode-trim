import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve as resolvePath, isAbsolute } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { openMemoryStore, MAX_TEXT_CHARS } from './memory-store.ts';
import { SECTION_NAMES, normalizeSection } from './memory-sections.ts';
import { estimateRequest } from './pressure.ts';

export const TOOL_NAME = 'trim_history_search';
export const EXPAND_TOOL_NAME = 'trim_expand';
const EVENT_TYPES = Object.freeze(['session.compaction.started', 'session.compaction.ended', 'session.compaction.failed']);
const MAX_PENDING = 64;
const MAX_QUERY = 500;
const FALLBACK_CHARS = 2_000_000;

function obj(v: unknown): v is Record<string, any> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
export function defaultDbPath(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'opencode-trim', 'memory.db');
}
// Event payload location differs between host revisions; accept the common shapes.
function payload(e: any): Record<string, any> { return obj(e?.data) ? e.data : obj(e?.properties) ? e.properties : (obj(e) ? e : {}); }
function validReg(r: any): { dispose: () => any } {
  if (!r || typeof r.dispose !== 'function') throw new Error('opencode-trim memory: host registration is missing dispose()');
  return r;
}
function pick(...vals: any[]): any { return vals.find(v => v !== undefined && v !== null); }
function sessionOf(e: any): string | undefined { const p = payload(e); const s = pick(p.sessionID, e?.sessionID); return typeof s === 'string' && s ? s : undefined; }

/** Estimated model-visible tokens of a session context; never throws. */
async function contextTokens(ctx: any, sessionID: string): Promise<number | undefined> {
  try { return estimateContext(await ctx.session.context({ sessionID })); } catch { return undefined; }
}

const MAX_MESSAGES = 20_000;
const MAX_DEPTH = 6;
const SKIP_KEYS = new Set(['data', 'base64', 'bytes', 'blob', 'image', 'media']);

/** View of messages for estimation only: host `{type,text}` / `{parts}` messages count like `content`. Never mutates. */
function normalizeMessages(list: any[]): any[] {
  const out = [];
  for (const m of list.slice(0, MAX_MESSAGES)) {
    if (!obj(m) || m.content !== undefined && m.content !== null) { out.push(m); continue; }
    if (typeof m.text === 'string') out.push({ ...m, content: m.text });
    else if (Array.isArray(m.parts)) out.push({ ...m, content: m.parts });
    else out.push(m);
  }
  return out;
}

/** Characters of visible text (string values, not keys/punctuation/media payloads); bounded by depth and total. */
function textChars(root: unknown): number {
  const budget = { left: FALLBACK_CHARS, seen: 0 };
  const walk = (v: any, depth: number): void => {
    if (budget.left <= 0 || depth > MAX_DEPTH) return;
    if (typeof v === 'string') { budget.left -= v.length; return; }
    if (v === null || typeof v !== 'object') return;
    if (++budget.seen > 200_000) { budget.left = 0; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    for (const k of Object.keys(v)) if (!SKIP_KEYS.has(k)) walk(v[k], depth + 1);
  };
  walk(root, 0);
  return Math.max(0, FALLBACK_CHARS - Math.max(0, budget.left));
}

function estimateContext(c: any): number | undefined {
  try {
    if (!Array.isArray(c) && !obj(c)) return undefined;
    const req = Array.isArray(c)
      ? { messages: normalizeMessages(c), system: [], tools: {} }
      : { ...c, messages: Array.isArray(c.messages) ? normalizeMessages(c.messages) : c.messages };
    let est = 0;
    try { est = estimateRequest(req, new Map(), { outputReserveTokens: 8192 }).estimatedTokens; } catch {}
    const chars = textChars(c);
    // Sanity floor: an estimate far below the visible text size means the shape was not understood.
    if (chars > 0 && !(est >= chars / 9)) return Math.ceil(chars / 3);
    return est > 0 ? est : undefined;
  } catch { return undefined; }
}

/** Canonical absolute directory, or undefined for anything not an absolute resolvable string. */
function canonDir(v: unknown): string | undefined {
  try {
    if (typeof v !== 'string' || !v || !isAbsolute(v) || v.includes('\0')) return undefined;
    try { return realpathSync(v); } catch { return resolvePath(v); }
  } catch { return undefined; }
}
/**
 * Fail-closed attribution on a multi-location server. Reads every location candidate so no
 * precedence can hide another: 'absent' | 'ambiguous' | 'conflict' | 'local' | 'foreign'.
 */
function locationState(e: any, localDir: string | undefined): 'absent' | 'ambiguous' | 'conflict' | 'local' | 'foreign' {
  try {
    const dirs = new Set();
    for (const holder of [e, e?.data, e?.properties]) {
      const loc = holder?.location;
      if (loc === undefined || loc === null) continue;
      if (!obj(loc)) return 'ambiguous';
      const raw = loc.directory;
      if (raw === undefined || raw === null) continue;
      const dir = canonDir(raw);
      if (dir === undefined) return 'ambiguous';
      dirs.add(dir);
    }
    if (dirs.size === 0) return 'absent';
    if (dirs.size > 1) return 'conflict';
    if (!localDir) return 'ambiguous';
    return dirs.has(localDir) ? 'local' : 'foreign';
  } catch { return 'ambiguous'; }
}

function agentOf(event: any): string | undefined {
  for (const v of [event?.agent, event?.agentID, event?.agentName, event?.context?.agent, event?.session?.agent]) {
    if (typeof v === 'string' && v) return v;
    if (obj(v) && typeof v.name === 'string' && v.name) return v.name;
    if (obj(v) && typeof v.id === 'string' && v.id) return v.id;
  }
  return undefined;
}

/** Optional observer hooks (stats); a hook failure must never affect memory behavior. */
function callHook(fn: any, arg: any): void { if (typeof fn !== 'function') return; try { fn(arg); } catch { /* observer only */ } }
function sessionIdOf(context: any): string | undefined {
  const s = pick(context?.sessionID, context?.sessionId, context?.session?.id);
  return typeof s === 'string' && s ? s : undefined;
}
/** Main DB + active journal/WAL size in bytes; null for :memory: or any stat failure. */
export function memoryDbBytes(dbPath: unknown): number | null {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') return null;
  try {
    let total = statSync(dbPath).size;
    for (const suffix of ['-wal', '-journal']) {
      try { total += statSync(`${dbPath}${suffix}`).size; } catch { /* no sidecar file */ }
    }
    return total;
  } catch { return null; }
}

function sectionLabel(name: string): string { return name.split('_').map((w: string) => w[0].toUpperCase() + w.slice(1)).join(' '); }

function format(rows: any[]): string {
  if (!rows.length) return 'No matching compaction history for this project.';
  return rows.map((r: any) => `[${r.date.slice(0, 10)}] session ${r.session_id ?? '?'}:${r.section ? ` [${sectionLabel(r.section)}]` : ''} ${r.snippet.replace(/\s+/g, ' ').trim()}`).join('\n');
}

/**
 * Compaction-summary memory. Only called when memory.enabled; owns its DB,
 * event subscription, one tool and one hook, and returns an idempotent cleanup.
 */
export async function setupMemory(ctx: any, opts: any, hooks?: any): Promise<() => Promise<void>> {
  const mem = opts?.memory;
  if (!mem?.enabled) return async () => {};
  const rawProject = ctx?.location?.directory;
  const project = canonDir(rawProject);
  if (!project) throw new Error('opencode-trim memory: ctx.location.directory must be an absolute path');
  const localDir = project;
  const allow = new Set(mem.agentAllowlist);
  const deny = new Set(mem.agentDenylist);
  const dbPath = mem.dbPath ?? defaultDbPath();
  const store = openMemoryStore({ dbPath, retentionDays: mem.retentionDays, project });
  const abort = new AbortController();
  const regs: Array<{ dispose: () => any }> = [];
  let disposed = false;
  const cleanup = async () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    const pendingDisposals: Promise<any>[] = [];
    for (const r of regs.reverse()) {
      try { pendingDisposals.push(Promise.resolve(r.dispose())); } catch { /* keep disposing the rest */ }
    }
    await Promise.allSettled(pendingDisposals);
    pending.clear();
    awaitingAfter.clear();
    frozenRecentWork.clear();
    callHook(hooks?.onClose, { project });
    try { store.close(); } catch {}
  };
  const pending = new Map();
  const awaitingAfter = new Map(); // sessionID -> { event_id, sessionID }
  const frozenRecentWork = new Map<string, string | null>(); // sessionID -> frozen <recent_work> block (prompt-cache stable)
  const forgetSession = (sid: unknown): void => {
    if (typeof sid !== 'string' || !sid) return;
    pending.delete(sid);
    awaitingAfter.delete(sid);
    frozenRecentWork.delete(sid);
  };
  try {
    const vault = {
      store(refId: string, entry: any, sessionID?: string): boolean {
        const target = entry?.input?.path ?? entry?.input?.filePath ?? entry?.input?.command ?? entry?.input?.pattern ?? '';
        return store.saveVault({
          project,
          session_id: typeof sessionID === 'string' && sessionID ? sessionID : null,
          ref_id: refId,
          tool: entry?.name ?? 'tool',
          target: typeof target === 'string' ? target : '',
          text: entry?.original ?? '',
          tokens: Math.max(1, Math.ceil((entry?.length ?? 0) / 3)),
        }).saved;
      },
      has(refId: string): boolean {
        return store.hasVault(project, refId);
      },
    };
    callHook(hooks?.onReady, { project, store, dbPath, vault, forgetSession });
    const isAgentAllowed = (holder: any): boolean => {
      const agent = agentOf(holder);
      if (agent && deny.has(agent)) return false;
      if (allow.size && (!agent || !allow.has(agent))) return false;
      return true;
    };
    // Fail-closed gate first so the tools are never exposed without it.
    regs.push(validReg(await ctx.tool.hook('execute.before', (event: any) => {
      if (event?.tool !== TOOL_NAME && event?.tool !== EXPAND_TOOL_NAME) return;
      const ls = locationState(event, localDir);
      if (ls === 'foreign') return;
      if (ls === 'ambiguous' || ls === 'conflict') throw new Error(`${event.tool} is not available for ambiguous location`);
      if (!isAgentAllowed(event)) throw new Error(`${event.tool} is not available to this agent`);
    })));
    regs.push(validReg(await ctx.tool.transform((editor: any) => {
      editor.add({
        name: EXPAND_TOOL_NAME,
        description: 'Recover, slice, or search EPHEMERAL pruned command/web outputs (such as shell, bash, or webfetch logs) cached by opencode-trim in the project vault. NEVER use trim_expand to read or search live source files on disk — always use your live file/code tools for source code, as vault entries are point-in-time historical snapshots that may be stale. Pass `id` (e.g. "trm_...") with optional startLine/endLine/grep to inspect a cached output; omit `id` and pass `grep` to search cached command/web outputs; or omit both to list recent cached refs.',
        input: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 128, description: 'Cached ref ID from a pruning notice (e.g. "trm_..."). Omit `id` to search across the vault (with `grep`) or list recent cached refs.' },
            tool: { type: 'string', maxLength: 64, description: 'Optional discovery/search filter when `id` is omitted: filter cached refs by tool name (e.g. "shell", "webfetch").' },
            target: { type: 'string', maxLength: 256, description: 'Optional discovery/search filter when `id` is omitted: case-insensitive substring match on target path or command.' },
            limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Optional discovery/search limit when `id` is omitted (default 20, max 50).' },
            startLine: { type: 'integer', minimum: 1, description: 'Optional 1-based start line (inclusive).' },
            endLine: { type: 'integer', minimum: 1, description: 'Optional 1-based end line (inclusive).' },
            grep: { type: 'string', maxLength: 200, description: 'Optional substring or regex line filter (within `id`, or across all project vault refs when `id` is omitted).' },
            regex: { type: 'boolean', description: 'Optional: treat `grep` as a regular expression (bounded/ReDoS-checked) instead of a literal substring.' },
            caseSensitive: { type: 'boolean', description: 'Optional: make `grep` matching case-sensitive (default false).' },
            maxChars: { type: 'integer', minimum: 200, maximum: 50000, description: 'Optional maximum characters to return (default 12000).' },
          },
          required: [], additionalProperties: false,
        },
        output: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            id: { type: 'string' },
            mode: { type: 'string' },
            tool: { type: ['string', 'null'] },
            target: { type: ['string', 'null'] },
            totalLines: { type: 'integer' },
            matchedRefs: { type: 'integer' },
            matchedLines: { type: 'integer' },
            truncated: { type: 'boolean' },
            totalVaultRows: { type: 'integer' },
            refs: { type: 'array' },
            matches: { type: 'array' },
            text: { type: 'string' },
          },
          required: ['found', 'id', 'text'],
        },
        options: { codemode: false },
        execute: async (input: any, context: any) => {
          if (context?.signal?.aborted) throw new Error('Cancelled');
          const ls = locationState(context, localDir);
          if (ls === 'ambiguous' || ls === 'conflict' || ls === 'foreign') throw new Error(`${EXPAND_TOOL_NAME} is not available for this location`);
          if (!isAgentAllowed(context)) throw new Error(`${EXPAND_TOOL_NAME} is not available to this agent`);
          const id = input?.id;
          if (id === undefined || id === null) {
            if (input?.tool !== undefined && input?.tool !== null && (typeof input.tool !== 'string' || input.tool.length > 64)) {
              throw new Error('tool must be a string up to 64 chars');
            }
            if (input?.target !== undefined && input?.target !== null && (typeof input.target !== 'string' || input.target.length > 256)) {
              throw new Error('target must be a string up to 256 chars');
            }
            if (input?.limit !== undefined && input?.limit !== null && (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)) {
              throw new Error('limit must be an integer between 1 and 50');
            }
            if (input?.grep !== undefined && input?.grep !== null) {
              if (typeof input.grep !== 'string' || !input.grep.trim() || input.grep.length > 200) {
                throw new Error('grep must be a non-empty string up to 200 chars');
              }
              if (input?.maxChars !== undefined && input?.maxChars !== null && (typeof input.maxChars !== 'number' || !Number.isInteger(input.maxChars) || input.maxChars < 200 || input.maxChars > 50000)) {
                throw new Error('maxChars must be an integer between 200 and 50000');
              }
              const out = store.searchVault({
                project,
                grep: input.grep,
                regex: input?.regex === true,
                caseSensitive: input?.caseSensitive === true,
                tool: input?.tool,
                target: input?.target,
                limit: input?.limit,
                maxChars: input?.maxChars,
              });
              return { content: out.text, output: out };
            }
            const out = store.listVault({
              project,
              tool: input?.tool,
              target: input?.target,
              limit: input?.limit,
            });
            return { content: out.text, output: out };
          }
          if (typeof id !== 'string' || !id.trim() || id.length > 128) throw new Error('id must be a non-empty string');
          if (input?.startLine !== undefined && input?.startLine !== null && (typeof input.startLine !== 'number' || !Number.isInteger(input.startLine) || input.startLine < 1)) {
            throw new Error('startLine must be a positive integer');
          }
          if (input?.endLine !== undefined && input?.endLine !== null && (typeof input.endLine !== 'number' || !Number.isInteger(input.endLine) || input.endLine < 1)) {
            throw new Error('endLine must be a positive integer');
          }
          if (input?.grep !== undefined && input?.grep !== null && (typeof input.grep !== 'string' || input.grep.length > 200)) {
            throw new Error('grep must be a string up to 200 chars');
          }
          if (input?.maxChars !== undefined && input?.maxChars !== null && (typeof input.maxChars !== 'number' || !Number.isInteger(input.maxChars) || input.maxChars < 200 || input.maxChars > 50000)) {
            throw new Error('maxChars must be an integer between 200 and 50000');
          }
          const out = store.getVault({
            project,
            ref_id: id.trim(),
            startLine: input?.startLine,
            endLine: input?.endLine,
            grep: input?.grep,
            regex: input?.regex === true,
            caseSensitive: input?.caseSensitive === true,
            maxChars: input?.maxChars,
          });
          return { content: out.text, output: out };
        },
      });
      editor.add({
        name: TOOL_NAME,
        description: 'Search or list archived compaction summaries of earlier context. Pass `query` for FTS5 search, or `recent: true` to list newest summaries; supports optional `scope` ("project" | "all"), section, sessionID, days, limit, and fullSection filters.',
        input: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1, maxLength: MAX_QUERY, description: 'Search query (required unless `recent: true`).' },
            recent: { type: 'boolean', description: 'Optional: list newest archived summaries chronologically without a search query.' },
            scope: { type: 'string', enum: ['project', 'all'], description: 'Optional: search/list only this project ("project", default) or across all projects in memory.db ("all").' },
            section: { type: 'string', description: `Optional: restrict the match to one section of the archived summary. One of: ${SECTION_NAMES.join(', ')} (case, spaces and hyphens are tolerated, e.g. "Work State", "next-move").` },
            sessionID: { type: 'string', maxLength: 256, description: 'Optional: restrict search to a specific session ID.' },
            days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Optional: restrict search to summaries from the last N days.' },
            limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Optional: maximum number of results to return (default 5, max 20).' },
            fullSection: { type: 'boolean', description: 'Optional: return expanded section/summary excerpts (up to 2400 chars) instead of 400-char snippets.' },
          },
          required: [], additionalProperties: false,
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
        execute: async (input: any, context: any) => {
          if (context?.signal?.aborted) throw new Error('Cancelled');
          const ls = locationState(context, localDir);
          if (ls === 'ambiguous' || ls === 'conflict' || ls === 'foreign') throw new Error(`${TOOL_NAME} is not available for this location`);
          if (!isAgentAllowed(context)) throw new Error(`${TOOL_NAME} is not available to this agent`);
          const recent = input?.recent === true;
          const q = input?.query;
          if (!recent) {
            if (typeof q !== 'string' || !q.trim() || q.length > MAX_QUERY) throw new Error('query must be a non-empty string');
          } else if (q !== undefined && q !== null && (typeof q !== 'string' || q.length > MAX_QUERY)) {
            throw new Error('query must be a string up to 500 chars');
          }
          const scope = input?.scope === undefined || input?.scope === null ? 'project' : input.scope;
          if (scope !== 'project' && scope !== 'all') throw new Error('scope must be "project" or "all"');
          let section;
          if (input.section !== undefined && input.section !== null) {
            section = normalizeSection(input.section);
            if (!section) throw new Error(`section must be one of: ${SECTION_NAMES.join(', ')}`);
          }
          if (input.sessionID !== undefined && input.sessionID !== null && (typeof input.sessionID !== 'string' || !input.sessionID.trim() || input.sessionID.length > 256)) {
            throw new Error('sessionID must be a non-empty string');
          }
          if (input.days !== undefined && input.days !== null && (typeof input.days !== 'number' || !Number.isInteger(input.days) || input.days < 1 || input.days > 3650)) {
            throw new Error('days must be an integer between 1 and 3650');
          }
          if (input.limit !== undefined && input.limit !== null && (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20)) {
            throw new Error('limit must be an integer between 1 and 20');
          }
          const results = store.search({
            project,
            ...(typeof q === 'string' && q.trim() ? { query: q } : {}),
            recent,
            scope,
            ...(section ? { section } : {}),
            ...(input.sessionID ? { sessionID: input.sessionID } : {}),
            ...(input.days ? { days: input.days } : {}),
            ...(input.limit ? { limit: input.limit } : {}),
            ...(input.fullSection === true ? { fullSection: true } : {}),
          });
          callHook(hooks?.onSearch, { sessionID: sessionIdOf(context), results });
          return { content: format(results), output: { results } };
        },
      });
    })));
    // The summary enters context after compaction.ended; the next context hook for that session sees the real size.
    // When memory.recentWork is opted in, also inject a frozen per-session V2 SystemPart ({ type: 'text', text })
    // for top-level sessions only (never subagents, compaction, title, or generate requests).
    regs.push(validReg(await ctx.session.hook('context', async (event: any) => {
      try {
        const sid = event?.sessionID;
        if (typeof sid !== 'string' || !sid) return;
        const ls = locationState(event, localDir);
        if (ls !== 'local' && ls !== 'absent') return;
        if (
          mem.recentWork === true &&
          isAgentAllowed(event) &&
          Array.isArray(event?.system) &&
          event?.kind !== 'compaction' &&
          event?.kind !== 'title' &&
          event?.kind !== 'generate'
        ) {
          let block = frozenRecentWork.get(sid);
          if (block === undefined) {
            let isChild = Boolean(event?.parentID || event?.session?.parentID);
            if (!isChild && typeof ctx?.session?.get === 'function') {
              try {
                const info = await ctx.session.get({ sessionID: sid });
                if (!obj(info) || info.parentID || info.parentId) isChild = true;
              } catch {
                // Fail closed: if parentID status cannot be verified, do not inject <recent_work>.
                isChild = true;
              }
            }
            block = isChild ? null : store.recentWork({ project, limit: 5 });
            if (frozenRecentWork.size >= 128) frozenRecentWork.delete(frozenRecentWork.keys().next().value as string);
            frozenRecentWork.set(sid, block);
          }
          if (block) {
            const already = event.system.some((p: any) => (typeof p === 'string' ? p : obj(p) ? p.text : undefined) === block);
            if (!already) {
              // OpenCode V2 SessionRequest.system is Array<SystemPart> ({ type: 'text', text: string }).
              // Pushing a raw string crashes V2 provider request compilers evaluating b.text.length.
              event.system.push({ type: 'text', text: block });
            }
          }
        }
        const wait = awaitingAfter.get(sid);
        if (!wait) return;
        awaitingAfter.delete(sid);
        const tokens = estimateContext(event);
        if (tokens !== undefined) store.updateContextAfter(project, wait.event_id, tokens);
      } catch { /* never break the host */ }
    })));
    const subscription = await ctx.event.subscribe({ signal: abort.signal, types: [...EVENT_TYPES] });
    const handle = async (e: any) => {
      const type = e?.type;
      if (!EVENT_TYPES.includes(type)) return;
      // Attribution first: nothing below (payload, context, pending, archive) runs for unattributed events.
      const ls = locationState(e, localDir);
      if (type === 'session.compaction.failed' ? (ls !== 'local' && ls !== 'absent') : ls !== 'local') return;
      const sid = sessionOf(e);
      if (!sid) return;
      const p = payload(e);
      if (type === 'session.compaction.started') {
        const before = await contextTokens(ctx, sid);
        pending.delete(sid);
        if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
        pending.set(sid, before);
      } else if (type === 'session.compaction.failed') {
        pending.delete(sid);
        callHook(hooks?.onCompactionFailed, sid);
      } else {
        const before = pending.get(sid);
        pending.delete(sid);
        callHook(hooks?.onCompactionEnded, sid);
        const text = p.text;
        if (typeof text !== 'string' || !text.trim() || p.native || text.length > MAX_TEXT_CHARS) return;
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
          if (awaitingAfter.size >= MAX_PENDING) awaitingAfter.delete(awaitingAfter.keys().next().value);
          awaitingAfter.set(sid, { event_id, sessionID: sid });
        }
        store.prune(project);
      }
    };
    (async () => {
      try {
        for await (const e of subscription) {
          if (abort.signal.aborted) break;
          try { await handle(e); } catch { /* never break the host */ }
        }
      } catch { /* stream ended or aborted */ }
    })();
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
