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
    const th = o(e.thresholds);
    const bd = isObj(c.breakdown)
        ? {
            systemChars: Math.max(0, n(c.breakdown.systemChars) ?? 0),
            chatChars: Math.max(0, n(c.breakdown.chatChars) ?? 0),
            toolChars: Math.max(0, n(c.breakdown.toolChars) ?? 0),
        }
        : null;
    const diag = isObj(c.diagnostics)
        ? {
            toolSchemaChars: Math.max(0, n(c.diagnostics.toolSchemaChars) ?? 0),
            toolCount: Math.max(0, n(c.diagnostics.toolCount) ?? 0),
            topTools: Array.isArray(c.diagnostics.topTools)
                ? c.diagnostics.topTools
                    .slice(0, 3)
                    .filter((t) => isObj(t) && typeof t.name === "string" && (n(t.chars) ?? 0) > 0)
                    .map((t) => ({ name: safeText(t.name, 24) ?? "tool", chars: Math.max(0, n(t.chars) ?? 0) }))
                : [],
        }
        : null;
    return {
        version: n(raw.version),
        now: n(raw.now),
        sessionID: s(raw.sessionID),
        since: n(raw.since),
        revision: n(raw.revision),
        engine: {
            enabled: b(e.enabled), shell: b(e.shell), toolFiltering: b(e.toolFiltering), pruning: b(e.pruning), compactionInputPruning: b(e.compactionInputPruning),
            autoCompact: b(e.autoCompact),
            thresholds: { start: n(th.start), force: n(th.force), critical: n(th.critical) },
        },
        context: { known: b(c.known) === true, estimatedTokens: n(c.estimatedTokens), estimatedChars: n(c.estimatedChars), usableTokens: n(c.usableTokens), limitTokens: n(c.limitTokens), ratio: n(c.ratio), source: safeText(c.source), media: b(c.media), at: n(c.at), breakdown: bd, diagnostics: diag },
        shell: { known: b(sh.known) === true, runs: n(sh.runs), changed: n(sh.changed), savedChars: n(sh.savedChars) },
        filtering: { known: b(f.known) === true, runs: n(f.runs), changed: n(f.changed), savedChars: n(f.savedChars) },
        pruning: { known: b(p.known) === true, calls: n(p.calls), drops: n(p.drops), removedChars: n(p.removedChars), lastReason: safeText(p.lastReason), lastAt: n(p.lastAt), allowNewDrops: b(p.allowNewDrops) },
        cache: { policy: safeText(ca.policy, 12), allowNewDrops: b(ca.allowNewDrops), at: n(ca.at) },
        compaction: {
            known: b(co.known) === true, running: b(co.running), autoEvents: n(co.autoEvents), manualEvents: n(co.manualEvents), failedEvents: n(co.failedEvents),
            lastAt: n(co.lastAt), lastReason: safeText(co.lastReason, 10), beforeTokens: n(co.beforeTokens), afterTokens: n(co.afterTokens), reducedTokens: n(co.reducedTokens),
            beforeChars: n(co.beforeChars), afterChars: n(co.afterChars), reducedChars: n(co.reducedChars), reducedRatio: n(co.reducedRatio),
            afterRatio: n(co.afterRatio), verification: safeText(co.verification, 16),
        },
        memory: {
            enabled: b(m.enabled), active: b(m.active), error: m.error === null || m.error === undefined || m.error === false ? null : safeText(typeof m.error === "string" ? m.error : "error", 20) ?? "error",
            summaries: n(m.summaries), searches: n(m.searches), searchResults: n(m.searchResults), lastSummaryAt: n(m.lastSummaryAt), dbBytes: n(m.dbBytes),
            vaultRefs: n(m.vaultRefs), vaultChars: n(m.vaultChars),
            sessionCompactions: n(m.sessionCompactions), sessionAutoCompactions: n(m.sessionAutoCompactions), sessionManualCompactions: n(m.sessionManualCompactions),
            sessionLastCompactionAt: n(m.sessionLastCompactionAt), sessionLastCompactionReason: m.sessionLastCompactionReason === "auto" || m.sessionLastCompactionReason === "manual" ? m.sessionLastCompactionReason : null,
            sessionFirstAt: n(m.sessionFirstAt), sessionVaultRefs: n(m.sessionVaultRefs), sessionVaultChars: n(m.sessionVaultChars),
        },
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
export const TRIM_VERSION = "0.12.4";
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
// Compact StatRow items for collapsed sidebar view.
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
export function normalizeViewMode(stored) {
    if (isObj(stored)) {
        if (stored.mode === "collapsed" || stored.mode === "default" || stored.mode === "expanded")
            return stored.mode;
        if (stored.expanded === true)
            return "expanded";
        if (stored.expanded === false)
            return "default";
    }
    return "default";
}
export function nextViewMode(mode) {
    if (mode === "default")
        return "expanded";
    if (mode === "expanded")
        return "collapsed";
    return "default";
}
// Host-side fallback breakdown from loaded session messages (after the last completed compaction).
const MEASURE_SKIP_KEYS = new Set([
    "type", "role", "status", "id", "sessionID", "messageID", "callID", "time", "tokens", "signature", "toolCallId", "toolName", "uri", "base64", "blob", "bytes",
]);
const MEASURE_MEDIA_TYPES = new Set(["media", "image", "file"]);
const MEASURE_DATA_URI = /^data:[^;,\s]{1,80};base64,/i;
export function messageBreakdown(messages) {
    if (!Array.isArray(messages) || !messages.length)
        return null;
    let start = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (isObj(m) && m.type === "compaction" && m.status === "completed") {
            start = i + 1;
            break;
        }
    }
    let systemChars = 0;
    let chatChars = 0;
    let toolChars = 0;
    let budget = 4096;
    const seen = new WeakSet();
    const measure = (v, depth = 0) => {
        if (v == null || budget <= 0)
            return 0;
        if (typeof v === "string")
            return MEASURE_DATA_URI.test(v.slice(0, 128)) ? 0 : v.length;
        if (typeof v !== "object" || depth > 4)
            return 0;
        if (seen.has(v))
            return 0;
        seen.add(v);
        budget--;
        let total = 0;
        if (Array.isArray(v)) {
            for (let i = 0; i < v.length && budget > 0; i++) {
                total += measure(v[i], depth + 1);
            }
            return total;
        }
        const rec = v;
        const rt = typeof rec.type === "string" ? rec.type.toLowerCase() : "";
        if (MEASURE_MEDIA_TYPES.has(rt))
            return 0;
        for (const k in rec) {
            if (budget <= 0)
                break;
            if (MEASURE_SKIP_KEYS.has(k) || !Object.prototype.hasOwnProperty.call(rec, k))
                continue;
            if (k === "data" && typeof rec[k] === "string" && rec[k].length >= 256)
                continue;
            total += measure(rec[k], depth + 1);
        }
        return total;
    };
    const isToolPart = (p) => {
        const t = typeof p?.type === "string" ? p.type.toLowerCase() : "";
        return t === "tool" || t === "tool-call" || t === "tool_use" || t === "tool-result" || t === "tool_result" || t === "tool-invocation" || t === "dynamic-tool";
    };
    for (let i = start; i < messages.length && budget > 0; i++) {
        const m = messages[i];
        if (!isObj(m))
            continue;
        const role = String(m.type ?? m.role ?? "").toLowerCase();
        if (role === "system" || role === "skill") {
            systemChars += measure(m.text ?? m.content ?? m.parts);
            continue;
        }
        if (role === "shell" || role === "tool") {
            toolChars += measure(m.text ?? m.content ?? m.output ?? m.parts);
            continue;
        }
        const content = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : null;
        if (content) {
            for (let j = 0; j < content.length && budget > 0; j++) {
                const part = content[j];
                if (!isObj(part))
                    continue;
                const len = measure(part);
                if (isToolPart(part))
                    toolChars += len;
                else
                    chatChars += len;
            }
        }
        else {
            chatChars += measure(m.text ?? m.content);
        }
    }
    if (systemChars + chatChars + toolChars <= 0)
        return null;
    return { systemChars, chatChars, toolChars };
}
// Host-side compaction breakdown including auto/manual counts (keeps compactionHistory shape intact).
export function compactionBreakdown(messages) {
    if (!Array.isArray(messages))
        return null;
    let total = 0, auto = 0, manual = 0, failed = 0;
    let newest = null;
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
        if (m.reason === "auto")
            auto++;
        else if (m.reason === "manual")
            manual++;
        const t = o(m.time);
        const at = n(t.completed) ?? n(t.created);
        if (newest === null || (at !== null && (newest.at === null || at > newest.at))) {
            newest = { at, reason: m.reason === "auto" || m.reason === "manual" ? m.reason : null };
        }
    }
    if (total === 0 && failed === 0)
        return null;
    return { total, auto, manual, failed, lastAt: newest ? newest.at : null, lastReason: newest ? newest.reason : null };
}
// Largest-remainder apportionment so integer buckets always sum strictly to `totalSlots`.
function apportionThree(a, b, c, totalSlots, minNonZero = false) {
    const sum = a + b + c;
    if (sum <= 0 || totalSlots <= 0)
        return [0, 0, 0];
    const raw = [(a / sum) * totalSlots, (b / sum) * totalSlots, (c / sum) * totalSlots];
    const out = [Math.floor(raw[0]), Math.floor(raw[1]), Math.floor(raw[2])];
    if (minNonZero && totalSlots >= 3) {
        if (a > 0 && out[0] === 0)
            out[0] = 1;
        if (b > 0 && out[1] === 0)
            out[1] = 1;
        if (c > 0 && out[2] === 0)
            out[2] = 1;
    }
    let cur = out[0] + out[1] + out[2];
    while (cur > totalSlots) {
        let maxIdx = 0;
        if (out[1] > out[maxIdx])
            maxIdx = 1;
        if (out[2] > out[maxIdx])
            maxIdx = 2;
        out[maxIdx]--;
        cur--;
    }
    const rem = [
        [0, raw[0] - out[0]],
        [1, raw[1] - out[1]],
        [2, raw[2] - out[2]],
    ];
    rem.sort((x, y) => y[1] - x[1]);
    let idx = 0;
    while (cur < totalSlots) {
        out[rem[idx % 3][0]]++;
        cur++;
        idx++;
    }
    return out;
}
// 100%-filled 3-color composition bar (sys / chat / tools). Empty only when breakdown is unavailable.
export function computeBarSegments(breakdown, width = 32) {
    const w = Number.isInteger(width) && width > 0 ? width : 32;
    const sysC = breakdown ? Math.max(0, breakdown.systemChars) : 0;
    const chatC = breakdown ? Math.max(0, breakdown.chatChars) : 0;
    const toolC = breakdown ? Math.max(0, breakdown.toolChars) : 0;
    if (sysC + chatC + toolC <= 0)
        return { sys: 0, chat: 0, tools: 0, empty: w };
    const [sys, chat, tools] = apportionThree(sysC, chatC, toolC, w, true);
    return { sys, chat, tools, empty: 0 };
}
// Estimated composition percentages (sys% + chat% + tools% === 100% when known).
export function computeCompositionShares(breakdown) {
    const sysC = breakdown ? Math.max(0, breakdown.systemChars) : 0;
    const chatC = breakdown ? Math.max(0, breakdown.chatChars) : 0;
    const toolC = breakdown ? Math.max(0, breakdown.toolChars) : 0;
    if (sysC + chatC + toolC <= 0) {
        return { known: false, sysPct: null, chatPct: null, toolsPct: null, sysText: "--", chatText: "--", toolsText: "--" };
    }
    const [sysPct, chatPct, toolsPct] = apportionThree(sysC, chatC, toolC, 100, false);
    return {
        known: true,
        sysPct,
        chatPct,
        toolsPct,
        sysText: `${sysPct}%`,
        chatText: `${chatPct}%`,
        toolsText: `${toolsPct}%`,
    };
}
function formatSessionCompactSummary(info) {
    if (info.running)
        return "compacting...";
    if (info.count <= 0 && info.failed <= 0)
        return "0 compact";
    if (info.auto > 0 && info.manual > 0)
        return `${fmtCount(info.auto)} auto, ${fmtCount(info.manual)} manual`;
    if (info.auto > 0 && info.auto === info.count)
        return `${fmtCount(info.count)} auto compact`;
    if (info.manual > 0 && info.manual === info.count)
        return `${fmtCount(info.count)} manual compact`;
    if (info.source === "history" || info.source === "db")
        return `${fmtCount(info.count)} archived compact`;
    return `${fmtCount(info.count)} compact`;
}
export function buildSidebarModel(raw, now = Date.now(), options = {}) {
    const snap = normalizeSnapshot(raw);
    const native = nativeOf(options);
    const nativeLimit = nativeLimitOf(options);
    const refNow = n(now) ?? snap?.now ?? Date.now();
    const c = snap?.context ?? null;
    const known = !!(c?.known || native !== null);
    const used = native !== null ? native : (c?.estimatedTokens ?? null);
    const modelLimit = native !== null ? (nativeLimit ?? c?.limitTokens ?? null) : (c?.limitTokens ?? null);
    const usable = c?.usableTokens ?? null;
    // Dynamic budget: follow active cap (usableTokens) whenever a cap is smaller than the model window;
    // otherwise use the full model window. Guarantees percent and health state always agree across any user config.
    const isCapped = usable !== null && usable > 0 && modelLimit !== null && modelLimit > 0 && usable < modelLimit;
    const activeLimit = isCapped ? usable : modelLimit;
    const ratio = known && used !== null && activeLimit !== null && activeLimit > 0
        ? Math.max(0, used) / activeLimit
        : (c?.ratio ?? null);
    const percent = ratio !== null ? Math.min(100, Math.round(ratio * 100)) : null;
    const over = known && used !== null && activeLimit !== null && used > activeLimit ? used - activeLimit : 0;
    const startThreshold = snap?.engine?.thresholds?.start ?? 0.65;
    const forceThreshold = snap?.engine?.thresholds?.force ?? 0.85;
    let healthState = "idle";
    let healthTone = "muted";
    if (ratio !== null) {
        if (over > 0 || ratio >= forceThreshold) {
            healthState = "critical";
            healthTone = "error";
        }
        else if (ratio >= startThreshold) {
            healthState = "caution";
            healthTone = "warning";
        }
        else {
            healthState = "healthy";
            healthTone = "success";
        }
    }
    const usedText = native !== null ? fmtCount(native) : (c?.estimatedTokens !== null && c?.estimatedTokens !== undefined ? "~" + fmtCount(c.estimatedTokens) : "--");
    const limitText = activeLimit !== null && activeLimit > 0 ? fmtCount(activeLimit) : "--";
    const pairText = known && usedText !== "--" ? `${usedText}/${limitText}` : "--";
    const percentText = percent !== null ? `${percent}%` : "--";
    const modelLimitText = modelLimit !== null && modelLimit > 0 ? fmtCount(modelLimit) : null;
    const contextParts = known && usedText !== "--"
        ? [`context ${pairText}`, ...(percent !== null ? [percentText] : [])]
        : ["context --"];
    const contextDetailParts = known && usedText !== "--"
        ? [`context ${pairText}`, ...(percent !== null ? [isCapped && modelLimitText ? `${percentText} (${modelLimitText})` : percentText] : [])]
        : ["context --"];
    const rawBreakdown = c?.breakdown ?? (isObj(options?.messageBreakdown)
        ? {
            systemChars: Math.max(0, n(options.messageBreakdown.systemChars) ?? 0),
            chatChars: Math.max(0, n(options.messageBreakdown.chatChars) ?? 0),
            toolChars: Math.max(0, n(options.messageBreakdown.toolChars) ?? 0),
        }
        : null);
    const composition = computeCompositionShares(rawBreakdown);
    // Session age: prefer host SessionInfo.time.created, then DB earliest session timestamp, then live RPC since.
    const createdAt = n(options?.sessionCreatedAt) ?? snap?.memory?.sessionFirstAt ?? snap?.since ?? null;
    const sessionAge = createdAt !== null && createdAt > 0 ? fmtAge(Math.max(0, refNow - createdAt)) : null;
    // Compactions: live RPC > host message compaction history > DB session compactions.
    const k = snap?.compaction;
    const hostHist = isObj(options?.compactionBreakdown) ? options.compactionBreakdown : historyOf(options);
    const mem = snap?.memory;
    let comp = { running: false, count: 0, auto: 0, manual: 0, failed: 0, lastAt: null, lastReason: null, source: "none" };
    if (k && (k.running === true || k.known)) {
        const a = k.autoEvents ?? 0;
        const mCount = k.manualEvents ?? 0;
        comp = {
            running: k.running === true,
            count: a + mCount,
            auto: a,
            manual: mCount,
            failed: k.failedEvents ?? 0,
            lastAt: k.lastAt,
            lastReason: k.lastReason,
            source: "live",
        };
    }
    else if (hostHist && ((n(hostHist.total) ?? 0) > 0 || (n(hostHist.failed) ?? 0) > 0)) {
        comp = {
            running: false,
            count: n(hostHist.total) ?? 0,
            auto: n(hostHist.auto) ?? 0,
            manual: n(hostHist.manual) ?? 0,
            failed: n(hostHist.failed) ?? 0,
            lastAt: n(hostHist.lastAt),
            lastReason: hostHist.lastReason === "auto" || hostHist.lastReason === "manual" ? hostHist.lastReason : null,
            source: "history",
        };
    }
    else if (mem && mem.sessionCompactions !== null && mem.sessionCompactions > 0) {
        comp = {
            running: false,
            count: mem.sessionCompactions,
            auto: mem.sessionAutoCompactions ?? 0,
            manual: mem.sessionManualCompactions ?? 0,
            failed: 0,
            lastAt: mem.sessionLastCompactionAt,
            lastReason: mem.sessionLastCompactionReason,
            source: "db",
        };
    }
    // Session-scoped savings: live session savedChars/drops, or persisted DB session vault chars after restart.
    const liveSaved = snap ? totalSaved(snap) : null;
    const liveDrops = snap?.pruning?.known ? (snap.pruning.drops ?? 0) : 0;
    const dbSessVaultRefs = mem?.sessionVaultRefs ?? 0;
    const dbSessVaultChars = mem?.sessionVaultChars ?? 0;
    let savedText = "saved 0";
    if (liveSaved !== null && liveSaved > 0) {
        savedText = `saved -${fmtChars(liveSaved)} chars`;
    }
    else if (liveDrops > 0) {
        savedText = `saved ${fmtCount(liveDrops)} drops`;
    }
    else if (dbSessVaultChars > 0) {
        savedText = `saved -${fmtChars(dbSessVaultChars)} chars`;
    }
    else if (dbSessVaultRefs > 0) {
        savedText = `saved ${fmtCount(dbSessVaultRefs)} vault`;
    }
    // Normal/default bottom line (below context + health).
    let activityParts = [];
    let activityTone = "muted";
    if (comp.running) {
        activityParts = ["compacting..."];
        activityTone = "warning";
    }
    else if (healthState === "critical") {
        activityParts = ["compact recommended"];
        activityTone = "muted";
    }
    else if (comp.count > 0) {
        activityParts.push(`${fmtCount(comp.count)} compact`);
        if (comp.lastAt !== null)
            activityParts.push(`${fmtAge(Math.max(0, refNow - comp.lastAt))} ago`);
    }
    else if (savedText !== "saved 0") {
        activityParts = [savedText];
    }
    else {
        activityParts = ["idle"];
    }
    // Detail lines for Expanded mode (dynamic per user config).
    const detailLines = [];
    const sessionParts = [];
    if (sessionAge)
        sessionParts.push(`session ${sessionAge}`);
    const compSummary = formatSessionCompactSummary(comp);
    if (sessionParts.length)
        sessionParts.push(compSummary);
    else
        sessionParts.push(`session --`, compSummary);
    if (comp.failed > 0)
        sessionParts.push(`${fmtCount(comp.failed)} failed`);
    detailLines.push({ key: "session", parts: sessionParts, text: sessionParts.join(" | "), tone: comp.running ? "warning" : "muted" });
    // Savings + Cache line (cache only shown when pruning is enabled or a policy is reported).
    const pruningOn = snap?.engine?.pruning !== false;
    const policy = deriveCachePolicy(snap);
    const showCache = pruningOn && (policy !== null || snap?.pruning?.known === true);
    const effectivePolicy = showCache ? (policy ?? "idle") : null;
    const cacheTone = effectivePolicy === "stable" ? "success" : (effectivePolicy === "open" || effectivePolicy === "bust") ? "warning" : "muted";
    const savedLineParts = effectivePolicy ? [savedText, `cache ${effectivePolicy}`] : [savedText];
    detailLines.push({
        key: "saved",
        parts: [savedText],
        text: savedLineParts.join(" | "),
        tone: "muted",
        cachePolicy: effectivePolicy,
        cacheTone,
    });
    // Memory line: dynamic -- shown ONLY when memory.enabled is true or memory reports an error.
    if (mem) {
        if (mem.error) {
            const p = [`memory error ${mem.error}`];
            detailLines.push({ key: "memory", parts: p, text: p[0], tone: "error" });
        }
        else if (mem.enabled === true && mem.active === true) {
            const mParts = [`memory ${fmtCount(mem.summaries ?? 0)} summaries`];
            if (mem.vaultRefs !== null && mem.vaultRefs > 0)
                mParts.push(`${fmtCount(mem.vaultRefs)} vault`);
            else if (mem.dbBytes !== null)
                mParts.push(fmtCount(mem.dbBytes).replace(/k$/, "K"));
            detailLines.push({ key: "memory", parts: mParts, text: mParts.join(" | "), tone: "muted" });
        }
        else if (mem.enabled === true) {
            detailLines.push({ key: "memory", parts: ["memory idle"], text: "memory idle", tone: "muted" });
        }
    }
    // Structured two-column StatRows for clean native sidebar alignment (Normal & Detail views).
    const contextShortParts = known && usedText !== "--"
        ? [pairText, ...(percent !== null ? [percentText] : [])]
        : ["--"];
    const contextFullParts = known && usedText !== "--"
        ? [pairText, ...(percent !== null ? [isCapped && modelLimitText ? `${percentText} (${modelLimitText})` : percentText] : [])]
        : ["--"];
    const normalRows = [
        { key: "context", label: "Context", parts: contextShortParts, value: contextShortParts.join(" | "), tone: known ? "base" : "muted" },
        {
            key: "activity",
            label: comp.running || healthState === "critical" ? "Status" : comp.count > 0 ? "Compactions" : "Activity",
            parts: activityParts,
            value: activityParts.join(" | "),
            tone: healthState === "critical" ? "error" : activityTone,
        },
    ];
    const savedValue = liveSaved !== null && liveSaved > 0
        ? `-${fmtChars(liveSaved)} chars`
        : liveDrops > 0
            ? `${fmtCount(liveDrops)} drops`
            : dbSessVaultChars > 0
                ? `-${fmtChars(dbSessVaultChars)} chars`
                : dbSessVaultRefs > 0
                    ? `${fmtCount(dbSessVaultRefs)} vault`
                    : "0";
    const detailRows = [
        { key: "context", label: "Context", parts: contextFullParts, value: contextFullParts.join(" | "), tone: known ? "base" : "muted" },
        { key: "session", label: "Session", parts: [sessionAge ?? "--"], value: sessionAge ?? "--", tone: sessionAge ? "base" : "muted" },
        {
            key: "compactions",
            label: "Compactions",
            parts: [compSummary, ...(comp.failed > 0 ? [`${fmtCount(comp.failed)} failed`] : [])],
            value: [compSummary, ...(comp.failed > 0 ? [`${fmtCount(comp.failed)} failed`] : [])].join(" | "),
            tone: comp.running ? "warning" : comp.failed > 0 && comp.count === 0 ? "error" : comp.count > 0 ? "base" : "muted",
        },
        { key: "saved", label: "Saved", parts: [savedValue], value: savedValue, tone: savedValue === "0" ? "muted" : "success" },
    ];
    if (effectivePolicy) {
        detailRows.push({ key: "cache", label: "Cache", parts: [effectivePolicy], value: effectivePolicy, tone: cacheTone });
    }
    if (mem) {
        if (mem.error) {
            detailRows.push({ key: "memory", label: "Memory", parts: ["error " + mem.error], value: "error " + mem.error, tone: "error" });
        }
        else if (mem.enabled === true && mem.active === true) {
            const mVals = [`${fmtCount(mem.summaries ?? 0)} sum`];
            if (mem.vaultRefs !== null && mem.vaultRefs > 0)
                mVals.push(`${fmtCount(mem.vaultRefs)} vault`);
            else if (mem.dbBytes !== null)
                mVals.push(fmtCount(mem.dbBytes).replace(/k$/, "K"));
            detailRows.push({ key: "memory", label: "Memory", parts: mVals, value: mVals.join(" | "), tone: "base" });
        }
        else if (mem.enabled === true) {
            detailRows.push({ key: "memory", label: "Memory", parts: ["idle"], value: "idle", tone: "muted" });
        }
    }
    return {
        hasData: snap !== null,
        context: {
            known,
            percent,
            percentText,
            usedText,
            limitText,
            pairText,
            ratio,
            over,
            isCapped,
            modelLimitText,
            parts: contextParts,
            detailParts: contextDetailParts,
        },
        composition,
        health: {
            state: healthState,
            label: healthState,
            tone: healthTone,
        },
        sessionAge,
        activity: {
            parts: activityParts,
            text: activityParts.join(" | "),
            tone: activityTone,
        },
        detailLines,
        normalRows,
        detailRows,
        segments: (width) => computeBarSegments(rawBreakdown, width),
    };
}
// Pure ASCII gain & status report for the /trim TUI slash command.
export function buildGainReport(raw, now = Date.now(), options = {}) {
    const snap = normalizeSnapshot(raw);
    const model = buildSidebarModel(raw, now, options);
    const lines = [`Trim v${TRIM_VERSION} (${model.health.label})`];
    lines.push(`Context: ${model.context.detailParts.join(" | ")}`);
    if (model.composition.known) {
        lines.push(`Composition (est): sys ${model.composition.sysText} | chat ${model.composition.chatText} | tools ${model.composition.toolsText}`);
    }
    if (snap) {
        const diag = snap.context.diagnostics;
        const bd = snap.context.breakdown;
        if (diag && Array.isArray(diag.topTools) && diag.topTools.length > 0) {
            const toolDenom = Math.max(1, bd?.toolChars ?? diag.topTools.reduce((a, t) => a + t.chars, 0));
            const topParts = diag.topTools.map((t) => `${t.name} ${Math.round((t.chars / toolDenom) * 100)}% (${fmtChars(t.chars)})`);
            lines.push(`Top tools: ${topParts.join(" | ")}`);
        }
        const sysChars = bd?.systemChars ?? 0;
        const schemaChars = diag?.toolSchemaChars ?? 0;
        const toolCount = diag?.toolCount ?? 0;
        const sysTok = Math.round(sysChars / 3);
        const schemaTok = Math.round(schemaChars / 3);
        const budgetTok = snap.context.usableTokens ?? snap.context.limitTokens;
        const sysPct = budgetTok && budgetTok > 0 ? Math.round((sysTok / budgetTok) * 100) : null;
        if (sysTok >= 15000 || (sysPct !== null && sysPct >= 20)) {
            const pctStr = sysPct !== null ? `${sysPct}% of budget; ` : "";
            lines.push(`Overhead alert: system+tools ~${fmtCount(sysTok)} tok (${pctStr}${fmtCount(toolCount)} tool schemas ~${fmtCount(schemaTok)} tok)`);
        }
        else if (toolCount > 0 && sysTok > 0) {
            lines.push(`Overhead: system+tools ~${fmtCount(sysTok)} tok (${fmtCount(toolCount)} tool schemas ~${fmtCount(schemaTok)} tok)`);
        }
        const ver = snap.compaction.verification;
        if (ver) {
            const bt = snap.compaction.beforeTokens;
            const at = snap.compaction.afterTokens;
            const pair = bt !== null && at !== null ? `${fmtCount(bt)} -> ${fmtCount(at)}` : "";
            if (ver === "effective") {
                const dropPct = bt && bt > 0 && at !== null ? `-${Math.round(((bt - at) / bt) * 100)}%` : "";
                const detail = [dropPct, pair].filter(Boolean).join(", ");
                lines.push(`Compaction check: effective${detail ? ` (${detail})` : ""}`);
            }
            else if (ver === "under-reduced") {
                const ar = snap.compaction.afterRatio !== null ? `, still ${Math.round(snap.compaction.afterRatio * 100)}%` : "";
                lines.push(`Compaction check: WARNING under-reduced (${pair}${ar})`);
            }
            else if (ver === "grew") {
                lines.push(`Compaction check: WARNING grew (${pair})`);
            }
        }
        const sh = snap.shell.known ? `${fmtCount(snap.shell.runs ?? 0)} runs (-${fmtChars(snap.shell.savedChars ?? 0)} chars)` : "off";
        const fi = snap.filtering.known ? `${fmtCount(snap.filtering.runs ?? 0)} runs (-${fmtChars(snap.filtering.savedChars ?? 0)} chars)` : "off";
        const pr = snap.pruning.known ? `${fmtCount(snap.pruning.drops ?? 0)} drops (-${fmtChars(snap.pruning.removedChars ?? 0)} chars)` : "off";
        const total = totalSaved(snap) ?? 0;
        const estTok = Math.round(total / 3);
        lines.push(`Savings: -${fmtChars(total)} chars (~${fmtCount(estTok)} tokens)`);
        lines.push(`  shell: ${sh}`);
        lines.push(`  filter: ${fi}`);
        lines.push(`  prune: ${pr}`);
    }
    for (const d of model.detailLines) {
        lines.push(`${d.text}`);
    }
    lines.push("Tip: /trim minimal | normal | detail | toggle | flush");
    return lines.join("\n");
}
