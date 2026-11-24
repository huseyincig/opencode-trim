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
    return {
        version: n(raw.version),
        now: n(raw.now),
        sessionID: s(raw.sessionID),
        since: n(raw.since),
        revision: n(raw.revision),
        engine: {
            enabled: b(e.enabled), shell: b(e.shell), toolFiltering: b(e.toolFiltering), pruning: b(e.pruning), compactionInputPruning: b(e.compactionInputPruning),
            thresholds: { start: n(th.start), force: n(th.force), critical: n(th.critical) },
        },
        context: { known: b(c.known) === true, estimatedTokens: n(c.estimatedTokens), estimatedChars: n(c.estimatedChars), usableTokens: n(c.usableTokens), limitTokens: n(c.limitTokens), ratio: n(c.ratio), source: safeText(c.source), media: b(c.media), at: n(c.at), breakdown: bd },
        shell: { known: b(sh.known) === true, runs: n(sh.runs), changed: n(sh.changed), savedChars: n(sh.savedChars) },
        filtering: { known: b(f.known) === true, runs: n(f.runs), changed: n(f.changed), savedChars: n(f.savedChars) },
        pruning: { known: b(p.known) === true, calls: n(p.calls), drops: n(p.drops), removedChars: n(p.removedChars), lastReason: safeText(p.lastReason), lastAt: n(p.lastAt), allowNewDrops: b(p.allowNewDrops) },
        cache: { policy: safeText(ca.policy, 12), allowNewDrops: b(ca.allowNewDrops), at: n(ca.at) },
        compaction: {
            known: b(co.known) === true, running: b(co.running), autoEvents: n(co.autoEvents), manualEvents: n(co.manualEvents), failedEvents: n(co.failedEvents),
            lastAt: n(co.lastAt), lastReason: safeText(co.lastReason, 10), beforeTokens: n(co.beforeTokens), afterTokens: n(co.afterTokens), reducedTokens: n(co.reducedTokens),
            beforeChars: n(co.beforeChars), afterChars: n(co.afterChars), reducedChars: n(co.reducedChars), reducedRatio: n(co.reducedRatio),
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
export const TRIM_VERSION = "0.9.3";
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
    const measure = (v) => {
        if (typeof v === "string")
            return v.length;
        if (!v || typeof v !== "object")
            return 0;
        try {
            return JSON.stringify(v).length;
        }
        catch {
            return 0;
        }
    };
    const isToolPart = (p) => {
        const t = typeof p?.type === "string" ? p.type.toLowerCase() : "";
        return t === "tool" || t === "tool-call" || t === "tool_use" || t === "tool-result" || t === "tool_result" || t === "tool-invocation" || t === "dynamic-tool";
    };
    for (let i = start; i < messages.length; i++) {
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
            for (const part of content) {
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
export function computeBarSegments(barRatio, breakdown, width = 24, health = "healthy") {
    const w = Number.isInteger(width) && width > 0 ? width : 24;
    if (barRatio === null || !Number.isFinite(barRatio) || barRatio <= 0) {
        return { sys: 0, chat: 0, tools: 0, toolsWarn: 0, empty: w };
    }
    const clamped = Math.min(1, Math.max(0, barRatio));
    const filled = Math.min(w, Math.max(1, Math.round(clamped * w)));
    const empty = w - filled;
    const sysC = breakdown ? Math.max(0, breakdown.systemChars) : 0;
    const chatC = breakdown ? Math.max(0, breakdown.chatChars) : 0;
    const toolC = breakdown ? Math.max(0, breakdown.toolChars) : 0;
    const sum = sysC + chatC + toolC;
    let sys = 0, chat = 0, tools = 0;
    if (sum <= 0) {
        tools = filled;
    }
    else {
        const rawSys = (sysC / sum) * filled;
        const rawChat = (chatC / sum) * filled;
        const rawTools = (toolC / sum) * filled;
        sys = Math.floor(rawSys);
        chat = Math.floor(rawChat);
        tools = Math.floor(rawTools);
        // Guarantee non-trivial categories (>= 3% share) at least 1 cell when space permits.
        if (filled >= 3) {
            if (sysC > 0 && sysC / sum >= 0.03 && sys === 0)
                sys = 1;
            if (chatC > 0 && chatC / sum >= 0.03 && chat === 0)
                chat = 1;
            if (toolC > 0 && toolC / sum >= 0.03 && tools === 0)
                tools = 1;
        }
        let cur = sys + chat + tools;
        // Trim overflow from the largest segment if min-1 guarantees exceeded filled.
        while (cur > filled) {
            if (tools >= chat && tools >= sys && tools > 0)
                tools--;
            else if (chat >= sys && chat > 0)
                chat--;
            else if (sys > 0)
                sys--;
            cur--;
        }
        // Distribute remaining rounding cells by largest fractional remainder.
        const rem = [
            ["sys", rawSys - sys],
            ["chat", rawChat - chat],
            ["tools", rawTools - tools],
        ];
        rem.sort((a, b) => b[1] - a[1]);
        let idx = 0;
        while (cur < filled) {
            const k = rem[idx % 3][0];
            if (k === "sys")
                sys++;
            else if (k === "chat")
                chat++;
            else
                tools++;
            cur++;
            idx++;
        }
    }
    let toolsWarn = 0;
    if (health === "caution" && tools >= 2) {
        const lower = Math.floor(tools / 2);
        toolsWarn = tools - lower;
        tools = lower;
    }
    return { sys, chat, tools, toolsWarn, empty };
}
function formatCompactionDetail(info) {
    if (info.running)
        return { value: "running", tone: "warning" };
    if (info.count <= 0 && info.failed <= 0)
        return { value: "0", tone: "muted" };
    const parts = [];
    if (info.auto > 0 && info.manual > 0)
        parts.push(`${fmtCount(info.auto)} auto, ${fmtCount(info.manual)} manual`);
    else if (info.auto > 0 && info.auto === info.count)
        parts.push("auto");
    else if (info.manual > 0 && info.manual === info.count)
        parts.push("manual");
    else if (info.source === "history" || info.source === "db")
        parts.push("archived");
    if (info.failed > 0)
        parts.push(`${fmtCount(info.failed)} failed`);
    const main = parts.length ? `${fmtCount(info.count)} (${parts.join(", ")})` : fmtCount(info.count);
    return { value: main, tone: info.failed > 0 && info.count === 0 ? "error" : "base" };
}
export function buildSidebarModel(raw, now = Date.now(), options = {}) {
    const snap = normalizeSnapshot(raw);
    const native = nativeOf(options);
    const nativeLimit = nativeLimitOf(options);
    const refNow = n(now) ?? snap?.now ?? Date.now();
    const cm = snap ? contextMetrics(snap, native, nativeLimit) : null;
    const c = snap?.context ?? null;
    const known = !!(c?.known || native !== null);
    const used = native !== null ? native : (c?.estimatedTokens ?? null);
    const limit = native !== null ? (nativeLimit ?? c?.limitTokens ?? null) : (c?.limitTokens ?? null);
    const barRatio = cm && limit ? Math.max(0, (used ?? 0) / limit) : null;
    const startThreshold = snap?.engine?.thresholds?.start ?? 0.65;
    const forceThreshold = snap?.engine?.thresholds?.force ?? 0.85;
    const engineRatio = c?.ratio ?? null;
    const effectiveRatio = barRatio !== null
        ? (engineRatio !== null ? Math.max(barRatio, engineRatio) : barRatio)
        : engineRatio;
    let healthState = "idle";
    let healthTone = "muted";
    if (effectiveRatio !== null) {
        if (cm?.over || effectiveRatio >= forceThreshold) {
            healthState = "critical";
            healthTone = "error";
        }
        else if (effectiveRatio >= startThreshold) {
            healthState = "caution";
            healthTone = "warning";
        }
        else {
            healthState = "healthy";
            healthTone = "success";
        }
    }
    const usedText = native !== null ? fmtCount(native) : (c?.estimatedTokens !== null && c?.estimatedTokens !== undefined ? "~" + fmtCount(c.estimatedTokens) : "--");
    const limitText = limit !== null && limit > 0 ? fmtCount(limit) : "--";
    const pairText = known && usedText !== "--" ? `${usedText}/${limitText}` : "--";
    const percent = cm ? cm.percent : null;
    const percentText = percent !== null ? `${percent}%` : "--";
    const usable = c?.usableTokens ?? null;
    const hasCap = usable !== null && usable > 0 && limit !== null && limit > 0 && usable < limit;
    const capPct = hasCap && used !== null ? Math.min(100, Math.round((Math.max(0, used) / usable) * 100)) : null;
    const capText = hasCap ? `${fmtCount(usable)}${capPct !== null ? ` (${capPct}%)` : ""}` : null;
    const rawBreakdown = c?.breakdown ?? (isObj(options?.messageBreakdown)
        ? {
            systemChars: Math.max(0, n(options.messageBreakdown.systemChars) ?? 0),
            chatChars: Math.max(0, n(options.messageBreakdown.chatChars) ?? 0),
            toolChars: Math.max(0, n(options.messageBreakdown.toolChars) ?? 0),
        }
        : null);
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
    // Session-scoped savings: live session drops/savedChars, or persisted DB session vault refs after restart.
    const liveSaved = snap ? totalSaved(snap) : null;
    const liveDrops = snap?.pruning?.known ? (snap.pruning.drops ?? 0) : 0;
    const dbSessVaultRefs = mem?.sessionVaultRefs ?? 0;
    const dbSessVaultChars = mem?.sessionVaultChars ?? 0;
    let savedParts = [];
    let savedTone = "muted";
    if (liveDrops > 0 || (liveSaved !== null && liveSaved > 0)) {
        if (liveDrops > 0)
            savedParts.push(`${fmtCount(liveDrops)} drops`);
        if (liveSaved !== null && liveSaved > 0)
            savedParts.push(`-${fmtChars(liveSaved)}`);
        savedTone = "base";
    }
    else if (dbSessVaultRefs > 0 || dbSessVaultChars > 0) {
        if (dbSessVaultRefs > 0)
            savedParts.push(`${fmtCount(dbSessVaultRefs)} vault`);
        if (dbSessVaultChars > 0)
            savedParts.push(`-${fmtChars(dbSessVaultChars)}`);
        savedTone = "base";
    }
    // Bottom-right status summary for Open/Default mode.
    let statusRightParts = [];
    let statusRightTone = "muted";
    if (comp.running) {
        statusRightParts = ["compacting..."];
        statusRightTone = "warning";
    }
    else if (healthState === "critical") {
        statusRightParts = ["compact recommended"];
        statusRightTone = "muted";
    }
    else if (comp.count > 0) {
        statusRightParts.push(`${fmtCount(comp.count)} compact`);
        if (comp.lastAt !== null)
            statusRightParts.push(`${fmtAge(Math.max(0, refNow - comp.lastAt))} ago`);
    }
    else if (savedParts.length) {
        statusRightParts = savedParts;
    }
    else {
        statusRightParts = ["idle"];
    }
    // Detail rows for Expanded mode.
    const details = [];
    const pushDetail = (key, label, parts, tone = "base") => {
        details.push({ key, label, parts, value: parts.join(" | "), tone });
    };
    if (sessionAge)
        pushDetail("session", "session", [sessionAge], "base");
    if (capText)
        pushDetail("cap", "cap", [capText], capPct !== null && capPct >= 85 ? "warning" : "base");
    const compDetail = formatCompactionDetail(comp);
    pushDetail("compactions", "compactions", [compDetail.value], compDetail.tone);
    pushDetail("saved", "saved", savedParts.length ? savedParts : ["idle"], savedTone);
    const policy = deriveCachePolicy(snap);
    if (policy) {
        const pTone = policy === "stable" ? "success" : (policy === "open" || policy === "bust") ? "warning" : "muted";
        pushDetail("cache", "cache", [policy], pTone);
    }
    else if (snap?.pruning?.known) {
        pushDetail("cache", "cache", ["idle"], "muted");
    }
    if (mem) {
        if (mem.error) {
            pushDetail("memory", "memory", ["error " + mem.error], "error");
        }
        else if (mem.enabled === true && mem.active === true) {
            const mParts = [`${fmtCount(mem.summaries ?? 0)} sum`];
            if (mem.vaultRefs !== null && mem.vaultRefs > 0)
                mParts.push(`${fmtCount(mem.vaultRefs)} vault`);
            else if (mem.dbBytes !== null)
                mParts.push(fmtCount(mem.dbBytes).replace(/k$/, "K"));
            pushDetail("memory", "memory", mParts, "base");
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
            barRatio,
            effectiveRatio,
            over: cm?.over ?? 0,
            overText: cm && cm.over ? (native !== null ? "" : "~") + fmtCount(cm.over) : null,
            capTokens: hasCap ? usable : null,
            capRatio: capPct !== null ? capPct / 100 : null,
            capText,
        },
        health: {
            state: healthState,
            label: healthState,
            tone: healthTone,
        },
        sessionAge,
        statusRight: {
            parts: statusRightParts,
            text: statusRightParts.join(" | "),
            tone: statusRightTone,
        },
        details,
        segments: (width) => computeBarSegments(barRatio, rawBreakdown, width, healthState),
    };
}
