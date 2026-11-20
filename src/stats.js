import { SNAPSHOT_VERSION } from './stats-rpc.js';

// In-memory, per-session/process counters for the TUI. Nothing is persisted. Snapshots are JSON-safe and carry
// no project path, command, query, text, model name or summary. Unknown values are null; measured zero is 0.
const MAX_SESSION_ID = 512;
const SOURCES = new Set(['event-model', 'model-catalog', 'config', 'unavailable']);
const PRUNE_REASONS = new Set(['pruned', 'cache-deferred', 'below-pressure', 'no-safe-target', 'disabled']);
const COMPACTION_REASONS = new Set(['auto', 'manual']);

const sidOf = (v) => (typeof v === 'string' && v && v.length <= MAX_SESSION_ID ? v : null);
const numOf = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const intOf = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null);
const reasonOf = (v, allowed) => (typeof v === 'string' && allowed.has(v) ? v : null);

function newState(at) {
  return {
    since: at, revision: 0,
    shell: { runs: 0, changed: 0, savedChars: 0 },
    filtering: { runs: 0, changed: 0, savedChars: 0 },
    pruning: { calls: 0, drops: 0, removedChars: 0, lastReason: null, lastAt: null, allowNewDrops: null },
    cache: { allowNewDrops: null, reason: null, at: null },
    context: null,
    compaction: {
      seen: false, running: false, autoEvents: 0, manualEvents: 0, failedEvents: 0, lastAt: null, lastReason: null,
      beforeTokens: null, beforeChars: null, afterTokens: null, afterChars: null, awaitingAfter: false,
    },
    memory: { searches: 0, searchResults: 0 },
  };
}

export function createTrimStats({
  options = {}, now = Date.now, emit, setTimeout: setT = globalThis.setTimeout, clearTimeout: clearT = globalThis.clearTimeout,
  maxSessions = 256, emitIntervalMs = 250,
} = {}) {
  const cap = Number.isSafeInteger(maxSessions) ? Math.min(4096, Math.max(1, maxSessions)) : 256;
  const interval = Number.isFinite(emitIntervalMs) ? Math.max(0, emitIntervalMs) : 250;
  const sessions = new Map(); // LRU: insertion order = recency
  const pending = new Set();
  let timer = null;
  let disposed = false;
  let memoryProvider = null;
  let memoryState = { active: false, error: null };

  const clock = () => { try { const t = now(); return Number.isFinite(t) ? t : Date.now(); } catch { return Date.now(); } };

  function touch(sessionID, create = true) {
    let s = sessions.get(sessionID);
    if (s) { sessions.delete(sessionID); sessions.set(sessionID, s); return s; }
    if (!create) return null;
    s = newState(clock());
    sessions.set(sessionID, s);
    while (sessions.size > cap) {
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
      pending.delete(oldest);
    }
    return s;
  }

  function flush() {
    timer = null;
    if (disposed) { pending.clear(); return; }
    const ids = [...pending];
    pending.clear();
    for (const id of ids) {
      const s = sessions.get(id);
      if (!s) continue;
      try { if (typeof emit === 'function') { const r = emit(id, s.revision); if (r && typeof r.catch === 'function') r.catch(() => {}); } } catch { /* never break the engine */ }
    }
  }

  function changed(sessionID, s) {
    s.revision += 1;
    if (disposed || typeof emit !== 'function') return;
    pending.add(sessionID);
    if (timer !== null) return;
    try {
      timer = setT(flush, interval);
      if (timer && typeof timer.unref === 'function') timer.unref();
      if (timer === null || timer === undefined) timer = 0;
    } catch { timer = null; pending.clear(); }
  }

  /** Run a mutation for a valid session; never throws. */
  function mutate(sessionID, fn) {
    try {
      if (disposed) return false;
      const id = sidOf(sessionID);
      if (!id) return false;
      const s = touch(id);
      fn(s);
      changed(id, s);
      return true;
    } catch { return false; }
  }

  function snapshot(sessionID) {
    const o = options ?? {};
    const id = sidOf(sessionID);
    const s = id ? touch(id, false) : null; // reads never create state or refresh LRU order beyond touch
    const at = clock();
    const feature = (counters, enabled) => (enabled
      ? { known: true, runs: counters.runs, changed: counters.changed, savedChars: counters.savedChars }
      : { known: false, runs: null, changed: null, savedChars: null });
    const c = s?.context ?? null;
    const p = s?.pruning;
    const k = s?.compaction;
    let cachePolicy = null;
    if (o.pruning === false) cachePolicy = 'off';
    else if (s && p.calls > 0) {
      cachePolicy = (s.cache.reason === 'cache-deferred' || s.cache.allowNewDrops === false) ? 'deferred'
        : s.cache.allowNewDrops === true ? 'bust' : 'stable';
    }
    const bothTokens = k && k.beforeTokens !== null && k.afterTokens !== null;
    const bothChars = k && k.beforeChars !== null && k.afterChars !== null;
    let memory = { enabled: !!o.memory?.enabled, active: !!memoryState.active, error: memoryState.error, summaries: null, searches: null, searchResults: null, lastSummaryAt: null, dbBytes: null };
    if (memory.enabled && memory.active) {
      memory.searches = s ? s.memory.searches : 0;
      memory.searchResults = s ? s.memory.searchResults : 0;
      try {
        const m = memoryProvider?.();
        if (m && typeof m === 'object') {
          memory.summaries = intOf(m.summaries);
          memory.lastSummaryAt = numOf(m.lastSummaryAt);
          memory.dbBytes = intOf(m.dbBytes);
        }
      } catch { /* provider failure leaves nulls */ }
    }
    return {
      version: SNAPSHOT_VERSION,
      now: at,
      sessionID: id,
      since: s ? s.since : null,
      revision: s ? s.revision : 0,
      engine: {
        enabled: o.enabled !== false, shell: !!o.shell, toolFiltering: !!o.toolFiltering, pruning: !!o.pruning,
        compactionInputPruning: !!o.compactionInputPruning,
        thresholds: { start: numOf(o.pressureStartRatio), force: numOf(o.pressureForceRatio), critical: numOf(o.pressureCriticalRatio) },
      },
      context: c
        ? { known: true, estimatedTokens: c.estimatedTokens, estimatedChars: c.estimatedChars, usableTokens: c.usableTokens, limitTokens: c.limitTokens, ratio: c.ratio, source: c.source, media: c.media, at: c.at }
        : { known: false, estimatedTokens: null, estimatedChars: null, usableTokens: null, limitTokens: null, ratio: null, source: null, media: null, at: null },
      shell: feature(s?.shell ?? { runs: 0, changed: 0, savedChars: 0 }, !!o.shell),
      filtering: feature(s?.filtering ?? { runs: 0, changed: 0, savedChars: 0 }, !!o.toolFiltering),
      pruning: o.pruning
        ? { known: true, calls: p?.calls ?? 0, drops: p?.drops ?? 0, removedChars: p?.removedChars ?? 0, lastReason: p?.lastReason ?? null, lastAt: p?.lastAt ?? null, allowNewDrops: p?.allowNewDrops ?? null }
        : { known: false, calls: null, drops: null, removedChars: null, lastReason: null, lastAt: null, allowNewDrops: null },
      cache: { policy: cachePolicy, allowNewDrops: s?.cache.allowNewDrops ?? null, at: s?.cache.at ?? null },
      compaction: {
        known: !!k?.seen, running: !!k?.running,
        autoEvents: k?.seen ? k.autoEvents : null, manualEvents: k?.seen ? k.manualEvents : null, failedEvents: k?.seen ? k.failedEvents : null,
        lastAt: k?.lastAt ?? null, lastReason: k?.lastReason ?? null,
        beforeTokens: k?.beforeTokens ?? null, afterTokens: k?.afterTokens ?? null,
        reducedTokens: bothTokens ? k.beforeTokens - k.afterTokens : null, // signed: negative means the summary grew context
        beforeChars: k?.beforeChars ?? null, afterChars: k?.afterChars ?? null,
        reducedChars: bothChars ? k.beforeChars - k.afterChars : null,
        reducedRatio: bothChars && k.beforeChars > 0 ? (k.beforeChars - k.afterChars) / k.beforeChars : null,
      },
      memory,
    };
  }

  // Every public method accepts anything and never throws (null/primitive arguments become `{}`).
  const safe = (fn, fallback = false) => (arg) => {
    try { return fn(arg !== null && typeof arg === 'object' ? arg : {}); } catch { return fallback; }
  };
  const api = {
    /** kind: 'shell' | 'filtering'; one eligible tool run. */
    recordTool({ sessionID, kind, changed: didChange, savedChars } = {}) {
      if (kind !== 'shell' && kind !== 'filtering') return false;
      return mutate(sessionID, (s) => {
        const c = s[kind];
        c.runs += 1;
        if (didChange === true) { c.changed += 1; c.savedChars += intOf(savedChars) ?? 0; }
      });
    },
    recordContext({ sessionID, estimatedTokens, estimatedChars, usableTokens, limitTokens, ratio, source, media } = {}) {
      return mutate(sessionID, (s) => {
        const at = clock();
        s.context = {
          estimatedTokens: intOf(estimatedTokens), estimatedChars: intOf(estimatedChars), usableTokens: intOf(usableTokens),
          limitTokens: intOf(limitTokens), ratio: numOf(ratio), source: SOURCES.has(source) ? source : null,
          media: typeof media === 'boolean' ? media : null, at,
        };
        const k = s.compaction;
        if (k.awaitingAfter) {
          k.awaitingAfter = false;
          k.afterTokens = s.context.estimatedTokens;
          k.afterChars = s.context.estimatedChars;
        }
      });
    },
    recordPrune({ sessionID, pruned, removedChars, reason, allowNewDrops } = {}) {
      return mutate(sessionID, (s) => {
        const at = clock();
        const p = s.pruning;
        p.calls += 1;
        p.drops += intOf(pruned) ?? 0;
        p.removedChars += intOf(removedChars) ?? 0;
        p.lastReason = reasonOf(reason, PRUNE_REASONS);
        p.lastAt = at;
        p.allowNewDrops = typeof allowNewDrops === 'boolean' ? allowNewDrops : null;
        s.cache = { allowNewDrops: p.allowNewDrops, reason: p.lastReason, at };
      });
    },
    /** type: 'started' | 'ended' | 'failed'; reason 'auto' | 'manual' (others counted nowhere but still mark lastAt). */
    recordCompactionEvent({ sessionID, type, reason } = {}) {
      if (type !== 'started' && type !== 'ended' && type !== 'failed') return false;
      return mutate(sessionID, (s) => {
        const k = s.compaction;
        const at = clock();
        k.seen = true;
        if (type === 'started') {
          k.running = true;
          k.awaitingAfter = false;
          k.beforeTokens = s.context?.estimatedTokens ?? null;
          k.beforeChars = s.context?.estimatedChars ?? null;
          k.afterTokens = null;
          k.afterChars = null;
          return;
        }
        k.running = false;
        k.lastAt = at;
        if (type === 'failed') { k.failedEvents += 1; k.awaitingAfter = false; return; }
        const r = reasonOf(reason, COMPACTION_REASONS);
        if (r === 'auto') k.autoEvents += 1;
        else if (r === 'manual') k.manualEvents += 1;
        k.lastReason = r;
        k.awaitingAfter = true;
      });
    },
    recordMemorySearch({ sessionID, results } = {}) {
      return mutate(sessionID, (s) => {
        s.memory.searches += 1;
        s.memory.searchResults += intOf(results) ?? 0;
      });
    },
    setMemoryProvider(fn) { memoryProvider = typeof fn === 'function' ? fn : null; },
    setMemoryState({ active, error } = {}) {
      memoryState = { active: active === true, error: typeof error === 'string' && error ? error.slice(0, 64) : null };
      if (disposed || typeof emit !== 'function') return;
      for (const [id, s] of sessions) changed(id, s);
    },
    snapshot,
    dispose() {
      disposed = true;
      pending.clear();
      if (timer !== null) { try { clearT(timer); } catch { /* ignore */ } timer = null; }
    },
  };
  for (const name of ['recordTool', 'recordContext', 'recordPrune', 'recordCompactionEvent', 'recordMemorySearch', 'setMemoryState']) {
    api[name] = safe(api[name]);
  }
  const rawSnapshot = api.snapshot;
  api.snapshot = (sessionID) => {
    try { return rawSnapshot(sessionID); } catch { return rawSnapshot(undefined); }
  };
  const rawProvider = api.setMemoryProvider;
  api.setMemoryProvider = (fn) => { try { rawProvider(fn); } catch { /* ignore */ } };
  return api;
}
