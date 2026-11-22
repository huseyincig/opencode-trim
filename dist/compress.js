import { applyCustomRules, applyLineFilters, isProtectedCommand, programOf } from "./filters.js";
import { compressPassingTests } from "./runners.js";
import { FAMILIES } from "./families/index.js";
import { gitSubcommands, hasTopLevelChain, shellWords, skipPrefixWords, splitSegments } from "./git.js";
import { SUMMARY as D_SUMMARY, FAILURE as D_FAILURE, WARNING as D_WARNING, STACK as D_STACK, CODE as D_CODE, hasFailureText, isDiagnosticLine, isExitNotice, isImportantLine } from "./diagnostics.js";
/**
 * Deterministic, bounded best-effort output compression.
 * A conservative postcondition rejects a compacted output that loses an
 * important diagnostic indicator or exit failure status.
 */
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])/g;
const FAILURE = /(?:\b(?:error|failed|failure|fatal|panic|exception|assertionerror|traceback|segmentation fault|unhandled rejection)\b|\berror\s+TS\d+\b|\bTS\d{4,5}\b|\b[EFW]\d{3,4}\b|\bE\d{3,}\b|\bFAIL\b|(?:^|\s)[✗✘✖✕❌]|^\s*×(?=\s))/i;
const WARN = /\b(?:warning|warn|deprecated)\b/i;
const SUMMARY = /(?:^\s*(?:Test Files|Test Suites:|Tests|Ran|BUILD\s+(?:SUCCESSFUL|FAILED)|Found\s+\d+\s+errors?|Checked\s+\d+\s+files?|Code style|Successfully installed|Installed\s+\d+\s+packages?|=+\s*\d+\s+(?:passed|failed)|exit\s*(?:code|status)|finished|completed|success|done)\b|\b\d+\s+(?:passed|failed|skipped|errors?|warnings?)\b)/im;
const STACK = /(?:\bat\s+\S[^\n]{0,300}?:\d+(?::\d+)?\b|(?:^|\s)(?:File\s+"[^"\n]{1,300}", line \d+|Caused by:))/i;
/** Central rule: failure/warning/summary/stack/anchor/code lines (local patterns plus src/diagnostics.js). */
// Known success rows (✓/✔/√/ok/PASS) are not important merely because they carry a file:line anchor;
// failure/warning/stack/code/summary content in such a row is still protected.
const SUCCESS_ROW = /^\s{0,20}(?:[✓✔√]|ok\b|PASS\b)/;
const important = (line) => {
    if (FAILURE.test(line) || WARN.test(line) || SUMMARY.test(line) || STACK.test(line) || D_SUMMARY.test(line))
        return true;
    if (SUCCESS_ROW.test(line))
        return D_FAILURE.test(line) || D_WARNING.test(line) || D_STACK.test(line) || D_CODE.test(line);
    return isImportantLine(line);
};
// A failed run is only evidenced by preserved failure, warning, or exit/timeout text.
// A bare passing summary (e.g. "Test Files 200 passed") is NOT failure evidence.
const hasSignal = (text) => FAILURE.test(text) || WARN.test(text) || /exit\s*(?:code|status)|\btim(?:ed\s+out|eout)\b/i.test(text) || isExitNotice(text);
export function stripAnsi(input) { return input.replace(ANSI, "").replace(/\r\n?/g, "\n"); }
export function tokenizeCommand(command) {
    if (typeof command !== "string")
        return [];
    const raw = command.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g) ?? [];
    const out = [];
    for (const piece of raw.slice(0, 64)) {
        const word = piece.replace(/^["']|["']$/g, "");
        if (!word)
            continue;
        // Normalize Windows executable paths only; leave other backslashes (escapes in args) intact.
        const winPath = /^(?:[A-Za-z]:\\|\\\\)/.test(word) || /\\[^\\/]*\.(?:exe|cmd|bat)$/i.test(word);
        out.push(((winPath ? word.replace(/\\/g, "/") : word).split("/").at(-1) ?? "").replace(/\.(?:exe|cmd)$/i, ""));
    }
    return out;
}
// Package managers whose own subcommands are terminal: the manager itself is the program.
const PM_TERMINAL = new Set(["install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "upgrade", "test", "t", "build", "start", "run", "run-script", "sync", "init", "publish", "audit", "outdated", "ls", "list", "link", "prune", "dedupe", "cache", "config", "info", "view", "pack", "version", "why", "create", "lock", "venv", "tree", "pip", "tool", "self", "python", "export", "fund", "rebuild", "store"]);
const PM_RUNNERS = new Set(["exec", "dlx", "x"]);
const LAUNCHER_VALUE_OPTS = {
    npx: new Set(["--package", "-p", "--call", "-c", "--node-options", "--shell", "--prefix", "--userconfig", "--cache", "--registry"]),
    pnpx: new Set(["--package", "-p", "--call", "-c"]),
    bunx: new Set(["--package", "-p"]),
    uvx: new Set(["--from", "--with", "--with-editable", "--with-requirements", "--python", "-p", "-w", "--index", "--index-url", "--default-index", "--extra-index-url", "--constraints", "--overrides", "--env-file", "--directory", "--project", "--config-file"]),
    pipx: new Set(["--spec", "--python", "--pip-args", "--index-url", "--verbosity"]),
};
const UV_RUN_VALUE_OPTS = new Set(["--with", "--with-editable", "--with-requirements", "-p", "--python", "--index", "--index-url", "--default-index", "--extra-index-url", "--constraints", "--overrides", "--env-file", "--directory", "--project", "--config-file", "--from"]);
const PM_RUNNER_VALUE_OPTS = new Set(["--package", "-p", "--call", "-c", "--workspace", "-w", "--prefix", "--registry", "--cache", "--userconfig", "--node-options", "--shell", "--filter", "--dir", "-C"]);
const POETRY_RUN_VALUE_OPTS = new Set(["--directory", "-C", "--project", "-P"]);
/** Returns the index of the last consumed option token (a `--` terminator is consumed and stops the scan). */
function skipOptions(tokens, i, valueOpts) {
    while (i + 1 < tokens.length && String(tokens[i + 1]).startsWith("-")) {
        if (tokens[i + 1] === "--")
            return i + 1;
        i += valueOpts.has(tokens[i + 1]) ? 2 : 1;
    }
    return i;
}
/** Finds the first real program token, skipping launchers; package-manager subcommands resolve to the manager. */
export function resolveProgram(tokens) {
    for (let i = 0; i < tokens.length; i++) {
        const skipped = skipPrefixWords(tokens, i);
        if (skipped !== i) {
            i = skipped - 1;
            continue;
        }
        const word = String(tokens[i]).toLowerCase();
        if (word === "python" || word === "python3" || word === "py") {
            if (tokens[i + 1] === "-m" && tokens[i + 2])
                return tokens[i + 2].toLowerCase();
            continue;
        }
        if (word === "go" && tokens[i + 1] === "test")
            return "go";
        if (LAUNCHER_VALUE_OPTS[word]) {
            const valueOpts = LAUNCHER_VALUE_OPTS[word];
            i = skipOptions(tokens, i, valueOpts);
            if (word === "pipx" && String(tokens[i + 1]).toLowerCase() === "run") {
                i++;
                i = skipOptions(tokens, i, valueOpts);
            }
            continue;
        }
        if (word === "npm" || word === "pnpm" || word === "yarn" || word === "bun") {
            const next = tokens[i + 1]?.toLowerCase();
            if (next && PM_RUNNERS.has(next)) {
                i = skipOptions(tokens, i + 1, PM_RUNNER_VALUE_OPTS);
                continue;
            }
            if (word === "npm" || !next || PM_TERMINAL.has(next) || next.startsWith("-"))
                return word;
            continue;
        }
        if (word === "uv" || word === "poetry") {
            const next = tokens[i + 1]?.toLowerCase();
            if (word === "uv" && (next === "run" || (next === "tool" && tokens[i + 2]?.toLowerCase() === "run"))) {
                i += next === "run" ? 1 : 2;
                i = skipOptions(tokens, i, UV_RUN_VALUE_OPTS);
                continue;
            }
            if (word === "poetry" && next === "run") {
                i = skipOptions(tokens, i + 1, POETRY_RUN_VALUE_OPTS);
                continue;
            }
            if (next === "run") {
                i++;
                continue;
            }
            return word;
        }
        return word;
    }
    return "";
}
export function deduplicateConsecutive(input) {
    const lines = input.split("\n");
    const result = [];
    let i = 0;
    while (i < lines.length) {
        let j = i + 1;
        while (j < lines.length && lines[j] === lines[i])
            j++;
        const count = j - i;
        result.push(lines[i]);
        if (count >= 4 && lines[i].trim())
            result.push(`[${count - 1} identical lines omitted]`);
        else
            for (let k = 1; k < count; k++)
                result.push(lines[i]);
        i = j;
    }
    return result.join("\n");
}
const BASE64_MIN = 500;
const HEX_MIN = 800;
const DATA_URI_RE = /data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/=]{500,})/gi;
const B64_BLOB_RE = /[A-Za-z0-9+/]{500,}={0,2}/g;
const HEX_BLOB_RE = /[0-9a-fA-F]{800,}/g;
/** Elide inline base64 data URIs and long raw base64/hex dumps in tool outputs without touching diagnostics. */
export function scrubBlobs(text) {
    if (typeof text !== "string" || text.length < BASE64_MIN)
        return text;
    let out = text.replace(DATA_URI_RE, (match, mime, payload) => payload.length >= BASE64_MIN ? `[data:${mime} base64 payload of ${payload.length} chars elided]` : match);
    out = out.replace(B64_BLOB_RE, (run) => run.length >= BASE64_MIN && /[+/=]/.test(run) ? `[base64 blob of ${run.length} chars elided]` : run);
    out = out.replace(HEX_BLOB_RE, (run) => run.length >= HEX_MIN && /[a-fA-F]/.test(run) ? `[hex blob of ${run.length} chars elided]` : run);
    return out;
}
const DEBUG_LOG_RE = /^\s*(?:(?:\[[^\]]{1,60}\]|(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s*){0,3}(?:\[\s*(?:trace|debug|verbose)\s*\]|(?:trace|debug|verbose)\s*[:\-]\s|(?:TRACE|DEBUG|VERBOSE)(?::|\s|-))/i;
const DEBUG_JSON_RE = /^\s*\{[^\n]{0,400}?"level"\s*:\s*"(?:trace|debug|verbose)"/i;
/** Collapse consecutive debug/trace/verbose log lines while keeping info/warn/error and diagnostics untouched. */
export function filterDebugLogs(text) {
    if (typeof text !== "string" || !text.includes("\n"))
        return text;
    const lines = text.split("\n");
    const out = [];
    let dropped = 0;
    let changed = false;
    const flush = () => {
        if (dropped > 0) {
            out.push(`[${dropped} debug/trace log lines omitted]`);
            dropped = 0;
        }
    };
    for (const line of lines) {
        if ((DEBUG_LOG_RE.test(line) || DEBUG_JSON_RE.test(line)) && !important(line)) {
            dropped++;
            changed = true;
            continue;
        }
        flush();
        out.push(line);
    }
    flush();
    return changed ? out.join("\n") : text;
}
const STACK_FRAME_LINE = /^\s+(?:at\s+\S[^\n]{0,300}|File\s+"[^"\n]{1,300}",\s+line\s+\d+[^\n]{0,200})$/;
/** Collapse runs of >= 3 byte-identical recursive stack frames to 1 frame plus a count marker. */
export function collapseStackTraces(text) {
    if (typeof text !== "string" || !text.includes("\n"))
        return text;
    const lines = text.split("\n");
    const out = [];
    let changed = false;
    for (let i = 0; i < lines.length;) {
        const line = lines[i];
        if (STACK_FRAME_LINE.test(line)) {
            let j = i + 1;
            while (j < lines.length && lines[j] === line)
                j++;
            if (j - i >= 3) {
                out.push(line, `[${j - i - 1} identical stack frames omitted]`);
                changed = true;
                i = j;
                continue;
            }
        }
        out.push(line);
        i++;
    }
    return changed ? out.join("\n") : text;
}
/** Lossless markdown table cell padding removal outside fenced code blocks. */
export function collapseTablePadding(text) {
    if (typeof text !== "string" || !text.includes("|"))
        return text;
    const lines = text.split("\n");
    let fence = false;
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
            fence = !fence;
            continue;
        }
        if (fence || !trimmed.startsWith("|") || !trimmed.endsWith("|") || line.includes("\\|"))
            continue;
        if (important(line))
            continue;
        const lead = line.slice(0, line.length - line.trimStart().length);
        const cells = trimmed.slice(1, -1).split("|");
        if (cells.length < 2 || !cells.some((c) => c.trim() !== ""))
            continue;
        const next = `${lead}| ${cells.map((c) => c.trim()).join(" | ")} |`;
        if (next.length < line.length) {
            lines[i] = next;
            changed = true;
        }
    }
    return changed ? lines.join("\n") : text;
}
const RUNAWAY_CHAR_RE = /([^\s\-=*_#~.|])\1{199,}/g;
/** Collapse runaway single-character repetition loops and consecutive multi-line block loops. */
export function collapseRepetitionLoops(text) {
    if (typeof text !== "string" || text.length < 120)
        return text;
    let out = text.replace(RUNAWAY_CHAR_RE, (run, ch) => `${ch.repeat(16)} [repeated '${ch}' x${run.length} collapsed]`);
    if (!out.includes("\n"))
        return out;
    const lines = out.split("\n");
    if (lines.length < 12)
        return out;
    let changed = false;
    const result = [];
    let i = 0;
    while (i < lines.length) {
        let matchedSpan = 0;
        let repeatCount = 1;
        for (const span of [2, 3]) {
            if (i + span * 6 > lines.length)
                continue;
            let valid = true;
            for (let s = 0; s < span; s++) {
                const l = lines[i + s];
                if (!l || l.trim().length < 6 || important(l)) {
                    valid = false;
                    break;
                }
            }
            if (!valid)
                continue;
            let count = 1;
            while (i + (count + 1) * span <= lines.length) {
                let same = true;
                for (let s = 0; s < span; s++) {
                    if (lines[i + count * span + s] !== lines[i + s]) {
                        same = false;
                        break;
                    }
                }
                if (!same)
                    break;
                count++;
            }
            if (count >= 6) {
                matchedSpan = span;
                repeatCount = count;
                break;
            }
        }
        if (matchedSpan > 0) {
            for (let s = 0; s < matchedSpan; s++)
                result.push(lines[i + s]);
            result.push(`[${repeatCount - 1} repeated ${matchedSpan}-line blocks omitted]`);
            i += repeatCount * matchedSpan;
            changed = true;
        }
        else {
            result.push(lines[i]);
            i++;
        }
    }
    return changed ? result.join("\n") : out;
}
function applyStructuralCleaners(text) {
    let out = scrubBlobs(text);
    out = filterDebugLogs(out);
    out = collapseStackTraces(out);
    out = collapseTablePadding(out);
    out = collapseRepetitionLoops(out);
    return out;
}
const MAX_LRU_ENTRIES = 128;
const MAX_LRU_CHARS = 512_000;
const MAX_CACHEABLE_INPUT = 200_000;
const compressionLru = new Map();
let lruChars = 0;
let lruHits = 0;
let lruMisses = 0;
export function clearCompressionCache() {
    compressionLru.clear();
    lruChars = 0;
    lruHits = 0;
    lruMisses = 0;
}
export function compressionCacheStats() {
    return { hits: lruHits, misses: lruMisses, entries: compressionLru.size, chars: lruChars };
}
function lruKey(command, exitCode, externalFailureNotice, options, text) {
    if (!options || text.length > MAX_CACHEABLE_INPUT || options.filterRules?.length)
        return null;
    return `${command}\u001f${exitCode ?? ""}\u001f${externalFailureNotice ? 1 : 0}\u001f${options.minOutputChars}:${options.maxOutputLines}:${options.maxOutputChars}:${options.minSavingsRatio}\u001f${text}`;
}
export function looksStructured(text) {
    const s = text.trimStart();
    // Preserve machine-readable output: never convert json/xml/pem into prose.
    // Even malformed/incomplete JSON may be a machine-readable tool stream.
    // Do not destroy it just because JSON.parse fails.
    // Any leading object, or any array whose first element/closing could be JSON
    // (strings, numbers, literals, nested values, empty or still-incomplete).
    // Log prefixes such as "[INFO]" or "[12:00:01]" remain ordinary text.
    if (s.startsWith("{"))
        return true;
    if (/^\[\s*(?:$|["{\[\]]|-(?:\d|$)|\d[\d.eE+-]*\s*(?:[,\]]|$)|(?:true|false|null)\b)/.test(s.slice(0, 256)))
        return true;
    // Incomplete primitive literal at the end of a truncated stream: [tru, [fals, [nul.
    // Also protect when more lines follow (prefix must end its line).
    if (/^\[\s{0,200}(?:t|tr|tru|f|fa|fal|fals|n|nu|nul)[ \t]*(?:\r?\n|$)/.test(s))
        return true;
    if (/^((?:-----BEGIN |<\?xml|<!doctype|<html|<svg)[\s\S]*)/i.test(s))
        return true;
    return looksJsonc(s) || looksConfigOrTable(s);
}
/** JSON with leading // or block comments (JSONC/JSON5-style) before the first value. */
function looksJsonc(s) {
    let rest = s.slice(0, 8192);
    let comments = 0;
    for (let n = 0; n < 64; n++) {
        rest = rest.trimStart();
        if (rest.startsWith("//")) {
            const nl = rest.indexOf("\n");
            if (nl < 0)
                return false;
            rest = rest.slice(nl + 1);
            comments++;
            continue;
        }
        if (rest.startsWith("/*")) {
            const end = rest.indexOf("*/");
            if (end < 0)
                return false;
            rest = rest.slice(end + 2);
            comments++;
            continue;
        }
        break;
    }
    return comments > 0 && /^[{[]/.test(rest);
}
const YAML_LINE = /^\s*(?:#.*|-(?:\s.*)?|[A-Za-z_][\w.-]{0,63}:(?:\s.*)?|(?:"[^"\n]{1,64}"|'[^'\n]{1,64}'):(?:\s.*)?)$/;
const YAML_KEY = /^\s*([A-Za-z_][\w.-]{0,63}):(?:\s|$)/;
const NOT_CONFIG = /^\s*(?:error|warning|warn|fatal|note|hint|help|fail\w*|info|debug)\b/i;
const TOML_HEADER = /^\s*\[\[?[A-Za-z0-9_.\-"' ]{1,80}\]\]?\s*(?:#.*)?$/;
const KEY_VALUE = /^\s*[A-Za-z_][\w.-]{0,63}\s*=\s*\S/;
const CSV_FIELD = /^"?[A-Za-z_][\w."\- ]{0,38}"?$/;
/** Conservative detection of CSV/TSV, YAML, TOML and INI payloads. A false positive only disables compression. */
function looksConfigOrTable(s) {
    const rows = [];
    for (const raw of s.slice(0, 4096).split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (line.trim())
            rows.push(line);
        if (rows.length >= 8)
            break;
    }
    if (rows.length < 2)
        return false;
    // YAML document start or directive.
    if (/^(?:---(?:\s.*)?|%YAML\b.*)$/.test(rows[0]))
        return true;
    // TOML / INI: a lone [section] header followed by key = value, or 3+ leading key = value rows.
    const first = rows.findIndex(r => !/^\s*[#;]/.test(r));
    if (first >= 0 && TOML_HEADER.test(rows[first]) && rows.slice(first + 1, first + 4).some(r => KEY_VALUE.test(r) || /^\s*[#;]/.test(r)))
        return true;
    if (rows.slice(0, 3).length === 3 && rows.slice(0, 3).every(r => KEY_VALUE.test(r) && !NOT_CONFIG.test(r)))
        return true;
    // YAML mapping/list: every inspected row is YAML-shaped with >= 3 distinct, non-diagnostic keys.
    if (rows.length >= 3 && rows.every(r => YAML_LINE.test(r) && !NOT_CONFIG.test(r))) {
        const keys = new Set(rows.map(r => YAML_KEY.exec(r)?.[1]).filter(Boolean));
        if (keys.size >= 3 || (keys.size >= 1 && rows.some(r => /^\s*-(?:\s|$)/.test(r)) && rows.length >= 4))
            return true;
    }
    // CSV / TSV: 3+ rows with the same delimiter count (>= 2) and a header of plain field names.
    if (rows.length >= 3) {
        for (const delim of [",", "\t"]) {
            const counts = rows.slice(0, 5).map(r => r.split(delim).length - 1);
            if (counts[0] >= 2 && counts.slice(0, 3).every(c => c === counts[0]) && rows[0].split(delim).every((f) => CSV_FIELD.test(f.trim())))
                return true;
        }
    }
    return false;
}
const GIT_KIND = new Set(["status", "diff", "log", "show", "fetch", "pull", "push", "branch"]);
function kind(command, output) {
    const cmd0 = String(command ?? "").toLowerCase();
    const gitSubs = gitSubcommands(cmd0);
    if (gitSubs.some(function (sub) { return GIT_KIND.has(sub); }))
        return "git";
    // Other git subcommands (remote, grep, ls-files, tag, stash, reflog...) are listings:
    // ignore git segments so they are not treated as build output or line-selected.
    const cmd = gitSubs.length
        ? splitSegments(cmd0).filter(function (seg) { return !gitSubcommands(seg).length; }).join(";")
        : cmd0;
    // Classify by the real program of each top-level segment (plus its first words), never by
    // arbitrary argument tokens: `grep npm build.log` / `echo npm install` are not builds.
    const heads = splitSegments(cmd).map(programHead).filter(Boolean);
    const any = (re) => heads.some((h) => re.test(h));
    if (any(/^(?:pytest|python\S*\s+-m\s+pytest)(?:\s|$)/) || /^=+ (?:FAILURES|ERRORS|short test summary info) =+/m.test(output))
        return "pytest";
    if (any(/^(?:vitest|jest|npm\s+test|pnpm\s+test|bun\s+test)(?:\s|$)/) || /^\s*(?:Test Files|Test Suites:|Tests:)\s+\d+/m.test(output))
        return "test";
    if (any(/^(?:cargo|rustc|tsc|eslint|biome|ruff|go|gradle|make|xcodebuild|npm|pnpm|yarn|bun|npx|bunx|git)(?:\s|$)/))
        return "build";
    return "generic";
}
/** First words of a segment starting at its actual program: prefix wrappers and npx/bunx runners skipped. */
function programHead(segment) {
    const words = shellWords(segment).slice(0, 48);
    let i = skipPrefixWords(words);
    const base = (w) => (String(w ?? "").replace(/\\/g, "/").split("/").at(-1) ?? "").replace(/\.(?:exe|cmd)$/i, "").toLowerCase();
    if (i >= words.length)
        return "";
    const first = base(words[i]);
    if ((first === "npx" || first === "bunx") && i + 1 < words.length) {
        const next = words.slice(i + 1).filter(w => !w.startsWith("-"))[0];
        if (next)
            return base(next) + " " + words.slice(i + 2).join(" ").toLowerCase();
    }
    return [first, ...words.slice(i + 1, i + 3).map(w => w.toLowerCase())].join(" ");
}
function withContext(lines, indices, before, after, maxLines) {
    const want = new Set();
    for (const idx of indices) {
        for (let j = Math.max(0, idx - before); j <= Math.min(lines.length - 1, idx + after); j++)
            want.add(j);
    }
    // Take earliest and latest signals when above budget; always disclose omissions.
    const selected = [...want].sort((a, b) => a - b);
    if (selected.length <= maxLines)
        return selected;
    const front = Math.ceil(maxLines * 0.65), back = maxLines - front;
    return [...new Set([...selected.slice(0, front), ...selected.slice(-back)])].sort((a, b) => a - b);
}
function renderSelection(lines, indices) {
    const out = [];
    let previous = -1;
    for (const idx of indices) {
        const omitted = idx - previous - 1;
        if (omitted)
            out.push(`[${omitted} lines omitted]`);
        out.push(lines[idx]);
        previous = idx;
    }
    if (previous < lines.length - 1)
        out.push(`[${lines.length - previous - 1} lines omitted]`);
    return out.join("\n");
}
const meaningful = important;
function diagnosticIndices(lines, cmdKind, failed, maxLines) {
    const signal = [];
    for (let i = 0; i < lines.length; i++) {
        if (meaningful(lines[i]) || (/^\s*(?:={3,}|-{3,}|#{3,})\s*(?:fail|error|summary|warn)/i.test(lines[i])))
            signal.push(i);
    }
    const head = cmdKind === "generic" ? 8 : 5;
    const tail = failed ? 22 : 12;
    for (let i = 0; i < Math.min(head, lines.length); i++)
        signal.push(i);
    for (let i = Math.max(0, lines.length - tail); i < lines.length; i++)
        signal.push(i);
    if (!signal.length)
        return [];
    return withContext(lines, [...new Set(signal)].sort((a, b) => a - b), failed ? 2 : 1, failed ? 4 : 1, maxLines);
}
function cutToChars(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    // Keep both beginning and tail; do not call this on a failure with unsaved diagnostics.
    let head = Math.floor(maxChars * 0.38), tail = Math.floor(maxChars * 0.52);
    // Never split a UTF-16 surrogate pair at either cut point.
    const isHigh = (i) => { const c = text.charCodeAt(i); return c >= 0xd800 && c <= 0xdbff; };
    const isLow = (i) => { const c = text.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff; };
    if (head > 0 && isHigh(head - 1))
        head--;
    if (tail > 0 && isLow(text.length - tail))
        tail--;
    return `${text.slice(0, head)}\n[${text.length - head - tail} characters omitted]\n${tail ? text.slice(text.length - tail) : ""}`;
}
function failedExit(exitCode, output) {
    if (typeof exitCode === "number")
        return exitCode !== 0;
    return /(?:^|\n)(?:Process exited with code [1-9]\d*|exit code: [1-9]\d*|command failed|ELIFECYCLE|npm error)/im.test(output);
}
/** Every failure, warning, stack frame and summary line from the original must survive. */
function preservesImportant(original, candidate, limit = 400, failClosed = false) {
    const checked = [];
    for (const line of stripAnsi(original).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (important(line)) {
            // On a failing command, more important lines than we can verify means unverifiable: keep raw.
            if (checked.length >= limit) {
                if (failClosed)
                    return false;
                break;
            }
            checked.push(trimmed);
        }
    }
    for (const line of checked) {
        if (!candidate.includes(line))
            return false;
    }
    return true;
}
function acceptCandidate(original, candidate, ctx, options, reason) {
    if (typeof candidate !== "string" || !candidate)
        return null;
    if (candidate === original)
        return null;
    if (candidate.length > options.maxOutputChars)
        return null;
    if (candidate.split("\n").length > options.maxOutputLines)
        return null;
    if (!preservesImportant(original, candidate, ctx.failed ? 5000 : 400, ctx.failed))
        return null;
    if (ctx.failed && !ctx.externalFailureNotice && !hasSignal(candidate))
        return null;
    // Failure-preserving guard: a nonzero exit never accepts a family candidate that loses
    // the failure evidence or the exit notice the original carried.
    if (ctx.failed) {
        if (hasFailureText(original) && !hasFailureText(candidate))
            return null;
        if (isExitNotice(original) && !isExitNotice(candidate))
            return null;
    }
    if (candidate.length >= original.length * (1 - options.minSavingsRatio))
        return null;
    return { text: candidate, changed: true, reason };
}
export function compressOutput({ command = "", text, exitCode, options, externalFailureNotice = false }) {
    if (typeof text !== "string")
        return { text, changed: false, reason: "non-text" };
    if (text.length < options.minOutputChars)
        return { text, changed: false, reason: "short" };
    // Avoid pathological CPU/memory use on multi-megabyte stdout floods.
    if (text.length > options.maxInputScanChars)
        return { text, changed: false, reason: "scan-limit" };
    if (isProtectedCommand(command))
        return { text, changed: false, reason: "protected-command" };
    if (looksStructured(text) || text.includes("\u0000") || /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
        return { text, changed: false, reason: "structured" };
    const cacheKey = lruKey(command, exitCode, externalFailureNotice, options, text);
    if (cacheKey !== null) {
        const cached = compressionLru.get(cacheKey);
        if (cached !== undefined) {
            compressionLru.delete(cacheKey);
            compressionLru.set(cacheKey, cached);
            lruHits++;
            return { ...cached };
        }
        lruMisses++;
    }
    const memo = (res) => {
        if (cacheKey !== null && res && typeof res.text === "string") {
            const cost = cacheKey.length + res.text.length;
            if (cost <= MAX_LRU_CHARS) {
                while ((lruChars + cost > MAX_LRU_CHARS || compressionLru.size >= MAX_LRU_ENTRIES) && compressionLru.size > 0) {
                    const oldest = compressionLru.keys().next().value;
                    const oldVal = compressionLru.get(oldest);
                    lruChars -= oldest.length + (oldVal?.text?.length ?? 0);
                    compressionLru.delete(oldest);
                }
                compressionLru.set(cacheKey, { ...res });
                lruChars += cost;
            }
        }
        return res;
    };
    const failed = failedExit(exitCode, text);
    const tokens = tokenizeCommand(command);
    // A top-level pipe/chain/list means the output is not one program's report
    // (e.g. `npm test | tail`, `a && b`): never trust a single family; use generic handling.
    const chained = hasTopLevelChain(command);
    const ctx = Object.freeze({
        command, tokens, program: chained ? "" : resolveProgram(tokens), failed,
        exitCode: typeof exitCode === "number" ? exitCode : undefined,
        externalFailureNotice: externalFailureNotice === true,
        head: text.slice(0, 4096), options,
    });
    // User filterRules apply before family dispatch, so families (and the
    // preservation checks) work on the already-filtered text. Chained commands
    // get their rules in the generic path below.
    let work = text, customDropped = 0;
    if (!chained && options.filterRules?.length) {
        const custom = applyCustomRules([ctx.program, programOf(command)], stripAnsi(text), options);
        if (custom.dropped) {
            work = custom.text;
            customDropped = custom.dropped;
        }
    }
    // Tier 1-3: command-specific and output-shape compressors, highest priority first.
    for (const family of chained ? [] : FAMILIES) {
        let matched = false;
        try {
            matched = family.match(ctx) === true;
        }
        catch {
            matched = false;
        }
        if (!matched)
            continue;
        let candidate;
        try {
            candidate = family.compress(work, ctx);
        }
        catch {
            candidate = null;
        }
        const accepted = acceptCandidate(work, candidate, ctx, options, `family:${family.id}`);
        if (accepted && (!customDropped || accepted.text.length < text.length * (1 - options.minSavingsRatio)))
            return memo(accepted);
    }
    const normalized = deduplicateConsecutive(applyStructuralCleaners(stripAnsi(work)));
    // Filter noise before the expensive signal selection. Never strip error
    // markers, summaries, trace frames or file:line references.
    const filtered = applyLineFilters(command, normalized, options);
    const retained = filtered.text;
    const passes = compressPassingTests(command, retained);
    const compacted = passes.text;
    const lines = compacted.split("\n");
    const cmdKind = kind(command, normalized);
    let candidate = compacted;
    // Generic text, git status and listings may contain unique records that are
    // not identifiable as "noise". Never discard middle lines from them.
    const allowSelection = cmdKind === "test" || cmdKind === "pytest" || cmdKind === "build";
    if (allowSelection && (lines.length > options.maxOutputLines || compacted.length > options.maxOutputChars)) {
        const indices = diagnosticIndices(lines, cmdKind, failed, options.maxOutputLines);
        if (!indices.length)
            return memo({ text, changed: false, reason: "no-signals" });
        candidate = renderSelection(lines, indices);
        if (candidate.length > options.maxOutputChars) {
            // For failure, never discard diagnostics by arbitrary character truncation.
            if (failed || FAILURE.test(normalized))
                return memo({ text, changed: false, reason: "diagnostic-protected" });
            candidate = cutToChars(candidate, options.maxOutputChars);
        }
    }
    // Without line selection nothing may bring the result above the output caps.
    if (!allowSelection && (candidate.split("\n").length > options.maxOutputLines || candidate.length > options.maxOutputChars)) {
        return memo({ text, changed: false, reason: "cap-exceeded" });
    }
    // Every distinct important diagnostic, stack frame and summary must remain,
    // not merely one matching indicator. If capacity is too low, preserve raw.
    const importantLines = lines.filter(important);
    if (importantLines.some((line) => !candidate.includes(line)))
        return memo({ text, changed: false, reason: "diagnostic-protected" });
    // Never compress away the only failure/error indicator or the final summary.
    if (FAILURE.test(normalized) && !FAILURE.test(candidate))
        return memo({ text, changed: false, reason: "failure-protected" });
    if (failed && !externalFailureNotice && !hasSignal(candidate) && !/(?:exit|failed)/i.test(candidate))
        return memo({ text, changed: false, reason: "exit-protected" });
    // If there are too many distinct diagnostic lines to keep, preserve raw
    // rather than showing a deceptively complete-looking error report.
    const allDiagnostics = lines.filter((line) => FAILURE.test(line) || STACK.test(line) || (!SUCCESS_ROW.test(line) && isDiagnosticLine(line)));
    if (allDiagnostics.length > options.maxOutputLines && allDiagnostics.some((line) => !candidate.includes(line))) {
        return memo({ text, changed: false, reason: "diagnostic-overflow" });
    }
    const originalSummary = lines.filter((line) => SUMMARY.test(line));
    if (originalSummary.length && !originalSummary.some((line) => candidate.includes(line)))
        return memo({ text, changed: false, reason: "summary-protected" });
    if (candidate.length >= text.length * (1 - options.minSavingsRatio))
        return memo({ text, changed: false, reason: "insufficient-savings" });
    return memo({ text: candidate, changed: true, reason: filtered.dropped ? `${cmdKind}:filtered` : cmdKind });
}
/** Restrict non-shell tool filtering to lossless duplicate folding; do not
 * truncate distinct code/search results or structured tool payloads. */
export function dedupToolOutput(text, options) {
    if (typeof text !== 'string' || text.length < options.minOutputChars ||
        text.length > options.maxInputScanChars || looksStructured(text) || text.includes('\x00'))
        return { text, changed: false };
    const result = deduplicateConsecutive(stripAnsi(text));
    if (result.length >= text.length * (1 - options.minSavingsRatio))
        return { text, changed: false };
    return { text: result, changed: true };
}
