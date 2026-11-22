// Pure view-model for the optional TUI sidebar. No host, server or I/O imports.
import { fmtAge, fmtChars, fmtCount, fmtPercent } from "./tui-format.js";
export const STORAGE_KEY = "opencode-trim.tui";
export const FRESH_RUNNING_MS = 15_000;
export const FRESH_IDLE_MS = 300_000;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const b = (v) => (typeof v === "boolean" ? v : null);
const s = (v) => (typeof v === "string" ? v : null);
const o = (v) => (isObj(v) ? v : {});
export function safeText(value, max = 16) {
    if (typeof value !== "string")
        return null;
    const t = value.replace(/[^\x20-\x7e]/g, "?").replace(/\s+/g, " ").trim();
    if (!t)
        return null;
    return t.length > max ? t.slice(0, Math.max(1, max - 1)) + "~" : t;
}
export function normalizeEventSessionID(event) {
    if (!isObj(event))
        return null;
    const p = isObj(event.properties) ? event.properties : isObj(event.data) ? event.data : event;
    const id = p.sessionID ?? p.sessionId ?? event.sessionID;
    return typeof id === "string" && id ? id : null;
}
export function normalizeSnapshot(raw) {
    if (!isObj(raw))
        return null;
    const e = o(raw.engine), c = o(raw.context), sh = o(raw.shell), f = o(raw.filtering);
    const p = o(raw.pruning), ca = o(raw.cache), co = o(raw.compaction), m = o(raw.memory);
    return {
        version: n(raw.version),
        now: n(raw.now),
        sessionID: s(raw.sessionID),
        since: n(raw.since),
        revision: n(raw.revision),
        engine: { enabled: b(e.enabled), shell: b(e.shell), toolFiltering: b(e.toolFiltering), pruning: b(e.pruning), compactionInputPruning: b(e.compactionInputPruning) },
        context: { known: b(c.known) === true, estimatedTokens: n(c.estimatedTokens), estimatedChars: n(c.estimatedChars), usableTokens: n(c.usableTokens), limitTokens: n(c.limitTokens), ratio: n(c.ratio), source: safeText(c.source), media: b(c.media), at: n(c.at) },
        shell: { known: b(sh.known) === true, runs: n(sh.runs), changed: n(sh.changed), savedChars: n(sh.savedChars) },
        filtering: { known: b(f.known) === true, runs: n(f.runs), changed: n(f.changed), savedChars: n(f.savedChars) },
        pruning: { known: b(p.known) === true, calls: n(p.calls), drops: n(p.drops), removedChars: n(p.removedChars), lastReason: safeText(p.lastReason), lastAt: n(p.lastAt), allowNewDrops: b(p.allowNewDrops) },
        cache: { policy: safeText(ca.policy, 12), allowNewDrops: b(ca.allowNewDrops), at: n(ca.at) },
        compaction: {
            known: b(co.known) === true, running: b(co.running), autoEvents: n(co.autoEvents), manualEvents: n(co.manualEvents), failedEvents: n(co.failedEvents),
            lastAt: n(co.lastAt), lastReason: safeText(co.lastReason, 10), beforeTokens: n(co.beforeTokens), afterTokens: n(co.afterTokens), reducedTokens: n(co.reducedTokens),
            beforeChars: n(co.beforeChars), afterChars: n(co.afterChars), reducedChars: n(co.reducedChars), reducedRatio: n(co.reducedRatio),
        },
        memory: { enabled: b(m.enabled), active: b(m.active), error: m.error === null || m.error === undefined || m.error === false ? null : safeText(typeof m.error === "string" ? m.error : "error", 20) ?? "error", summaries: n(m.summaries), searches: n(m.searches), searchResults: n(m.searchResults), lastSummaryAt: n(m.lastSummaryAt), dbBytes: n(m.dbBytes) },
    };
}
// Cache policy label: explicit policy wins; else derived from allowNewDrops; else unknown (null).
export function deriveCachePolicy(snapshot) {
    const snap = normalizeSnapshot(snapshot);
    if (!snap)
        return null;
    if (snap.cache.policy)
        return snap.cache.policy;
    const allow = snap.cache.allowNewDrops ?? snap.pruning.allowNewDrops;
    if (allow === true)
        return "open";
    if (allow === false)
        return "stable";
    return null;
}
// Snapshot is stale when missing, or older than the freshness window for the session state.
export function isStale(snapshot, now, running = false) {
    if (!isObj(snapshot))
        return true;
    const at = n(snapshot.now);
    const t = n(now);
    if (at === null || t === null)
        return true;
    return t - at > (running ? FRESH_RUNNING_MS : FRESH_IDLE_MS);
}
// Native OpenCode usage: last assistant message with tokens after the last completed compaction.
export function nativeContextTokens(messages) {
    if (!Array.isArray(messages))
        return null;
    let start = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (isObj(m) && m.type === "compaction" && m.status === "completed") {
            start = i + 1;
            break;
        }
    }
    for (let i = messages.length - 1; i >= start; i--) {
        const m = messages[i];
        if (!isObj(m) || m.type !== "assistant" || !isObj(m.tokens))
            continue;
        const input = n(m.tokens.input);
        if (input === null)
            continue;
        const cache = isObj(m.tokens.cache) ? n(m.tokens.cache.read) : null;
        return Math.max(0, input + (cache ?? 0));
    }
    return null;
}
// Persisted compaction messages in the loaded session list: read-only history for when live stats were reset.
export function compactionHistory(messages) {
    if (!Array.isArray(messages))
        return null;
    let total = 0, failed = 0, newest = null;
    for (const m of messages) {
        if (!isObj(m) || m.type !== "compaction")
            continue;
        if (m.status === "failed") {
            failed++;
            continue;
        }
        if (m.status !== "completed")
            continue;
        total++;
        const t = o(m.time);
        const at = n(t.completed) ?? n(t.created);
        if (newest === null || (at !== null && (newest.at === null || at > newest.at)))
            newest = { at, reason: m.reason === "auto" || m.reason === "manual" ? m.reason : null };
    }
    if (total === 0 && failed === 0)
        return null;
    return { total, failed, lastAt: newest ? newest.at : null, lastReason: newest ? newest.reason : null };
}
function historyOf(options) {
    const h = isObj(options) && isObj(options.compactionHistory) ? options.compactionHistory : null;
    if (!h)
        return null;
    const total = n(h.total) ?? 0, failed = n(h.failed) ?? 0;
    return total > 0 || failed > 0 ? { total, failed, lastAt: n(h.lastAt), lastReason: h.lastReason === "auto" || h.lastReason === "manual" ? h.lastReason : null } : null;
}
function nativeOf(options) {
    return isObj(options) ? n(options.nativeTokens) : null;
}
function nativeLimitOf(options) {
    const v = isObj(options) ? n(options.nativeLimitTokens) : null;
    return v !== null && v > 0 ? v : null;
}
// Single denominator: full model window (limitTokens). Native usage wins over the estimate. Returns null when unknown.
function contextMetrics(snap, native = null, nativeLimit = null) {
    const c = snap.context;
    const used = native !== null ? native : c.estimatedTokens;
    const lim = native !== null ? (nativeLimit ?? c.limitTokens) : c.limitTokens;
    if ((native === null && !c.known) || used === null || lim === null || lim <= 0)
        return null;
    const raw = Math.max(0, used) / lim;
    return { percent: Math.min(100, Math.round(raw * 100)), over: used > lim ? used - lim : 0, limit: lim };
}
function totalSaved(snap) {
    const parts = [[snap.shell.known, snap.shell.savedChars], [snap.filtering.known, snap.filtering.savedChars], [snap.pruning.known, snap.pruning.removedChars]];
    let sum = 0, any = false;
    for (const [k, v] of parts)
        if (k && v !== null) {
            sum += v;
            any = true;
        }
    return any ? sum : null;
}
export const TRIM_VERSION = "0.7.0";
export const SECTION_TITLES = { context: "Context", optimization: "Optimization", compaction: "Compaction", memory: "Memory" };
// Flat row model. Each row: key, section, kind (stat|warn), label, value, tone, line (compat).
export function buildRows(raw, now = Date.now(), options = {}) {
    const native = nativeOf(options);
    const nativeLimit = nativeLimitOf(options);
    const snap = normalizeSnapshot(raw);
    const rows = [];
    const row = (section, key, label, value, tone = "base", extra = {}) => rows.push({ section, key, kind: "stat", label, value, text: value, tone, line: extra.line ?? (label + " " + value).trim() });
    if (!snap) {
        row("context", "ctx", "--", "--", "muted", { line: "-- --" });
        return rows;
    }
    const c = snap.context;
    const cm = contextMetrics(snap, native, nativeLimit);
    // Context section only exists once the context snapshot is known.
    if (c.known || native !== null) {
        const est = native !== null ? fmtCount(native) : c.estimatedTokens !== null ? "~" + fmtCount(c.estimatedTokens) : "--";
        const limV = native !== null ? (nativeLimit ?? c.limitTokens) : c.limitTokens;
        const lim = limV !== null && limV > 0 ? fmtCount(limV) : "--";
        const pct = cm ? cm.percent + "%" : "--";
        // Section header already says Context: label is the percent, value the token pair.
        row("context", "ctx", pct, est === "--" ? "--" : `${est}/${lim}`, !cm ? "muted" : cm.over ? "warning" : "base");
        if (cm && cm.over)
            row("context", "over", "over", (native !== null ? "" : "~") + fmtCount(cm.over), "warning");
    }
    const act = (k, runs, unit, sav) => {
        if (!k || !runs)
            return null;
        return `${fmtCount(runs)} ${unit}` + (sav ? " -" + fmtChars(sav) : "");
    };
    const sh = act(snap.shell.known, snap.shell.runs, "runs", snap.shell.savedChars);
    if (sh)
        row("optimization", "shell", "shell", sh);
    const fi = act(snap.filtering.known, snap.filtering.runs, "runs", snap.filtering.savedChars);
    if (fi)
        row("optimization", "filter", "filter", fi);
    const pr = act(snap.pruning.known, snap.pruning.drops, "drops", snap.pruning.removedChars);
    if (pr)
        row("optimization", "prune", "prune", pr);
    const policy = deriveCachePolicy(snap);
    if (policy)
        row("optimization", "cache", "cache", policy);
    else if (snap.pruning.known && snap.pruning.calls)
        row("optimization", "cache", "cache", "--", "muted");
    const k = snap.compaction;
    const ck = k.known;
    if (k.running === true)
        row("compaction", "running", "compact", "running", "warning");
    else if (ck) {
        const parts = [];
        if (k.autoEvents)
            parts.push(`${fmtCount(k.autoEvents)} auto`);
        if (k.manualEvents)
            parts.push(`${fmtCount(k.manualEvents)} manual`);
        row("compaction", "compact", "compact", parts.length ? parts.join(" / ") : "idle", parts.length ? "base" : "muted");
    }
    if (ck && k.failedEvents)
        row("compaction", "failed", "failed", fmtCount(k.failedEvents), "error");
    if (ck && k.lastAt !== null) {
        const age = snap.now !== null ? fmtAge(snap.now - k.lastAt) : "--";
        row("compaction", "last", "last", `${age} ago${k.lastReason ? " " + k.lastReason : ""}`);
    }
    if (ck && k.beforeChars !== null && k.afterChars !== null) {
        const ratio = k.reducedRatio ?? (k.beforeChars > 0 ? (k.beforeChars - k.afterChars) / k.beforeChars : null);
        row("compaction", "reduced", "reduced", `${fmtPercent(ratio)}* ~${fmtChars(k.beforeChars)} -> ${fmtChars(k.afterChars)}`);
    }
    // Live stats reset with the server; fall back to persisted compaction messages. Read-only: no live or reduction claims.
    const hist = historyOf(options);
    if (!ck && k.running !== true && hist) {
        row("compaction", "compact", "compact", `${fmtCount(hist.total)} archived`, hist.total ? "base" : "muted");
        if (hist.failed)
            row("compaction", "failed", "failed", fmtCount(hist.failed), "error");
        if (hist.lastAt !== null) {
            const ref = snap.now ?? Date.now();
            row("compaction", "last", "last", `${fmtAge(Math.max(0, ref - hist.lastAt))} ago${hist.lastReason ? " " + hist.lastReason : ""}`);
        }
    }
    const m = snap.memory;
    // Active memory sits under a Memory header (no "mem" label); other states are one bare row.
    if (m.error)
        row("memory", "mem", "memory", "error " + m.error, "error");
    else if (m.enabled === false)
        row("memory", "mem", "memory", "off", "muted");
    else if (m.enabled === true && m.active === true) {
        const parts = [];
        if (m.searches !== null)
            parts.push(`${fmtCount(m.searches)} searches`);
        if (m.dbBytes !== null)
            parts.push(fmtCount(m.dbBytes).replace(/k$/, "K"));
        row("memory", "mem", `${fmtCount(m.summaries ?? 0)} summaries`, parts.join(" | "));
    }
    else if (m.enabled === true)
        row("memory", "mem", "memory", "idle", "muted");
    else
        row("memory", "mem", "memory", "--", "muted");
    return rows;
}
// Grouped view for the card: only non-empty sections, in fixed order.
export function buildSections(raw, now = Date.now(), options = {}) {
    const rows = buildRows(raw, now, options);
    const snap = normalizeSnapshot(raw);
    const out = [];
    for (const key of Object.keys(SECTION_TITLES)) {
        const r = rows.filter((x) => x.section === key);
        // Memory only gets a header when active; off/idle/unknown/error is a single bare row.
        const bare = key === "memory" && !(snap && snap.memory.enabled === true && snap.memory.active === true && !snap.memory.error);
        if (r.length)
            out.push({ key, title: bare ? null : SECTION_TITLES[key], rows: r });
    }
    return out;
}
function collapsedMetrics(raw, options = {}) {
    const snap = normalizeSnapshot(raw);
    if (!snap)
        return "--";
    const cm = contextMetrics(snap, nativeOf(options), nativeLimitOf(options));
    const parts = [cm ? cm.percent + "%" : "--"];
    const t = totalSaved(snap);
    if (t)
        parts.push("-" + fmtChars(t));
    if (snap.pruning.known && snap.pruning.drops)
        parts.push(fmtCount(snap.pruning.drops));
    const m = snap.memory;
    if (m.error)
        parts.push("mem err");
    else if (m.enabled === false)
        parts.push("mem off");
    else if (m.enabled === true && m.active === true && m.summaries)
        parts.push("mem " + fmtCount(m.summaries));
    return parts.join(" | ");
}
// Header pieces: left title (toggle glyph + version), right metrics (collapsed only) and marker ("!" stale, "?" no data).
export function buildHeader(raw, { expanded = false, stale = false, nativeTokens = null, nativeLimitTokens = null } = {}) {
    const hasData = normalizeSnapshot(raw) !== null;
    return {
        title: `${expanded ? "-" : "+"} trim v${TRIM_VERSION}`,
        summary: expanded ? "" : collapsedMetrics(raw, { nativeTokens, nativeLimitTokens }),
        marker: !hasData ? "?" : stale ? "!" : "",
    };
}
export function collapsedSummary(raw, { stale = false, nativeTokens = null, nativeLimitTokens = null } = {}) {
    return `+ trim ${collapsedMetrics(raw, { nativeTokens, nativeLimitTokens })}${stale ? "!" : ""}`;
}
// Compact StatRow items for collapsed sidebar view (matches opencode-guardian sidebar quality).
export function buildCollapsedRows(raw, options = {}) {
    const snap = normalizeSnapshot(raw);
    const native = nativeOf(options);
    const nativeLimit = nativeLimitOf(options);
    const rows = [];
    if (!snap) {
        rows.push({ key: "ctx", label: "Context", value: "--", tone: "muted" });
        rows.push({ key: "saved", label: "Savings", value: "Idle", tone: "muted" });
        return rows;
    }
    const c = snap.context;
    const cm = contextMetrics(snap, native, nativeLimit);
    if (c.known || native !== null) {
        const est = native !== null ? fmtCount(native) : c.estimatedTokens !== null ? "~" + fmtCount(c.estimatedTokens) : "--";
        const limV = native !== null ? (nativeLimit ?? c.limitTokens) : c.limitTokens;
        const lim = limV !== null && limV > 0 ? fmtCount(limV) : "--";
        const pct = cm ? cm.percent + "%" : "--";
        const ctxTone = !cm ? "muted" : cm.over ? "warning" : cm.percent >= 85 ? "warning" : "base";
        rows.push({ key: "ctx", label: "Context", value: est === "--" ? pct : `${pct} (${est}/${lim})`, tone: ctxTone });
    }
    else {
        rows.push({ key: "ctx", label: "Context", value: "--", tone: "muted" });
    }
    const saved = totalSaved(snap);
    const drops = snap.pruning.known ? snap.pruning.drops : null;
    if (saved || drops) {
        const parts = [];
        if (saved)
            parts.push("-" + fmtChars(saved));
        if (drops)
            parts.push(`${fmtCount(drops)} drops`);
        rows.push({ key: "saved", label: "Savings", value: parts.join(" | "), tone: "success" });
    }
    else {
        rows.push({ key: "saved", label: "Savings", value: "Idle", tone: "muted" });
    }
    const m = snap.memory;
    if (m.error)
        rows.push({ key: "mem", label: "Memory", value: "error " + m.error, tone: "error" });
    else if (m.enabled === true && m.active === true) {
        rows.push({ key: "mem", label: "Memory", value: `${fmtCount(m.summaries ?? 0)} summaries`, tone: "base" });
    }
    return rows;
}
export function headerText(stale = false) {
    return stale ? "- trim !" : "- trim";
}
