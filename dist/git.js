/**
 * Dependency-free, quote/escape-aware shell command inspection used to find git
 * invocations and decide whether their output must never be compressed.
 * Pure text analysis; commands are never evaluated.
 *
 * Fail-closed: a command larger than MAX_COMMAND_CHARS, with more than
 * MAX_SEGMENTS shell segments or MAX_WORDS words in one segment, cannot be
 * analysed completely, so any command mentioning git is treated as protected.
 */
export const MAX_COMMAND_CHARS = 8192;
export const MAX_SEGMENTS = 32;
export const MAX_WORDS = 48;
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env", "--attr-source"]);
const PREFIX_VALUE_OPTS = {
    sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t", "--user", "--group", "--host", "--prompt", "--chdir", "--chroot", "--role", "--type"]),
    env: new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]),
    nice: new Set(["-n", "--adjustment"]),
    time: new Set(["-f", "-o", "--format", "--output"]),
    timeout: new Set(["-k", "-s", "--kill-after", "--signal"]),
    exec: new Set(["-a"]),
    command: new Set(), nohup: new Set(),
};
const PREFIX_WORDS = new Set(Object.keys(PREFIX_VALUE_OPTS));
/** Subcommands whose output is (or may be) a patch/blame/history that must stay verbatim. */
export const PROTECTED_GIT = new Set(["diff", "show", "blame", "apply", "patch", "format-patch", "diff-tree", "range-diff", "am", "request-pull", "diff-index", "diff-files", "cherry-pick", "show-branch"]);
/**
 * Returns the index of the first word after leading env assignments and
 * prefix wrappers (sudo/env/nice/time/...), consuming option values such as
 * `sudo -u root` or `time -f x`. `--opt=value` is a single word.
 */
export function skipPrefixWords(words, start = 0) {
    let i = start;
    while (i < words.length) {
        const w = String(words[i]);
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
            i++;
            continue;
        }
        const name = w.toLowerCase();
        if (!PREFIX_WORDS.has(name))
            break;
        i++;
        const valueOpts = PREFIX_VALUE_OPTS[name];
        while (i < words.length && String(words[i]).startsWith("-")) {
            const opt = String(words[i]);
            i++;
            if (opt === "--")
                break;
            if (valueOpts.has(opt))
                i++;
        }
        if (name === "timeout" && i < words.length && /^\d+(?:\.\d+)?[smhd]?$/i.test(String(words[i]))) {
            i++;
        }
    }
    return i;
}
function baseName(word) { return (word.replace(/\\/g, "/").split("/").at(-1) ?? "").replace(/\.(?:exe|cmd)$/i, "").toLowerCase(); }
/**
 * Quote/escape-aware split on unquoted ; | & and newlines (redirections such
 * as 2>&1 and &> are not separators). Quoted or backslash-escaped separators
 * stay inside their segment. An unterminated quote fails closed to the naive
 * split so a real separator cannot hide. Input beyond MAX_COMMAND_CHARS is ignored;
 * use inspect() to learn about truncation.
 */
export function splitSegments(command) {
    if (typeof command !== "string")
        return [];
    const text = command.slice(0, MAX_COMMAND_CHARS);
    const segs = [];
    let cur = "";
    let quote = "";
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            cur += ch;
            if (ch === "\\" && quote === '"' && i + 1 < text.length)
                cur += text[++i];
            else if (ch === quote)
                quote = "";
            continue;
        }
        if (ch === "\\" && i + 1 < text.length) {
            cur += ch + text[++i];
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            cur += ch;
            continue;
        }
        if (ch === "&" && (text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">")) {
            cur += ch;
            continue;
        }
        if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
            segs.push(cur);
            cur = "";
            continue;
        }
        cur += ch;
    }
    segs.push(cur);
    if (quote)
        return text.split(/[;|&\n]+/).filter(function (s) { return s.trim() !== ""; });
    return segs.filter(function (s) { return s.trim() !== ""; });
}
/** Splits one segment into unquoted shell words (quotes removed, backslash escapes resolved). */
export function shellWords(segment) {
    const words = [];
    let cur = "";
    let has = false;
    let quote = "";
    for (let i = 0; i < segment.length; i++) {
        const ch = segment[i];
        if (quote) {
            if (ch === quote)
                quote = "";
            else if (ch === "\\" && quote === '"' && i + 1 < segment.length && /["\\$`]/.test(segment[i + 1]))
                cur += segment[++i];
            else
                cur += ch;
            continue;
        }
        // Only shell-special characters are unescaped, so Windows paths (C:\git\git.exe) survive.
        if (ch === "\\" && i + 1 < segment.length && /[\s;|&"'`$()<>*?!#~{}\[\]\\]/.test(segment[i + 1])) {
            cur += segment[++i];
            has = true;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            has = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (has)
                words.push(cur);
            cur = "";
            has = false;
            continue;
        }
        cur += ch;
        has = true;
    }
    if (has)
        words.push(cur);
    return words;
}
/**
 * Analyses every shell segment. Returns { calls: [{sub, args}], overflow }.
 * `overflow` is true when a limit was exceeded and the analysis is incomplete.
 */
export function inspectGit(command) {
    const result = { calls: [], overflow: false };
    if (typeof command !== "string")
        return result;
    if (command.length > MAX_COMMAND_CHARS)
        result.overflow = true;
    const segments = splitSegments(command);
    if (segments.length > MAX_SEGMENTS)
        result.overflow = true;
    for (const segment of segments.slice(0, MAX_SEGMENTS)) {
        const all = shellWords(segment);
        if (all.length > MAX_WORDS)
            result.overflow = true;
        const words = all.slice(0, MAX_WORDS);
        let i = skipPrefixWords(words);
        if (i >= words.length || baseName(words[i]) !== "git")
            continue;
        i++;
        while (i < words.length && words[i].startsWith("-"))
            i += GIT_VALUE_OPTS.has(words[i]) ? 2 : 1;
        if (i < words.length)
            result.calls.push({ sub: words[i].toLowerCase(), args: words.slice(i + 1) });
    }
    return result;
}
/** Returns the git subcommand of every shell segment that invokes git. */
export function gitSubcommands(command) {
    return inspectGit(command).calls.map(function (c) { return c.sub; });
}
function optionsOf(args) {
    const i = args.indexOf("--");
    return i < 0 ? args : args.slice(0, i);
}
/** Option that makes log/stash print patch-like content (-p/-u/-c/-m/-L/-U, --cc, --full-diff, --unified, --textconv, --ext-diff, word/color-words diffs...). */
function isPatchArg(a) {
    return /^--(?:patch|patch-with-stat|patch-with-raw|cc|remerge-diff|diff-merges|word-diff|color-words|full-diff|unified|textconv|ext-diff)(?:=|$)/.test(a) ||
        /^-[A-Za-z]*[pucm][A-Za-z0-9]*$/.test(a) || /^-(?:[pu]\d*|L|U\d*)$/.test(a);
}
/** True when this single git call prints patch/diff content (or may). */
export function isProtectedGitCall(call) {
    if (PROTECTED_GIT.has(call.sub))
        return true;
    const opts = optionsOf(call.args);
    if (call.sub === "log" || call.sub === "whatchanged" || call.sub === "reflog") {
        return opts.some(isPatchArg);
    }
    if (call.sub === "status") {
        return opts.some(function (a) { return a === "--verbose" || /^-[A-Za-z]*v[A-Za-z]*$/.test(a); });
    }
    if (call.sub === "stash") {
        const first = opts.find(function (a) { return !a.startsWith("-"); });
        if (first !== "show" && first !== "list")
            return false;
        return opts.some(function (a) { return a === "--include-untracked" || isPatchArg(a); });
    }
    return false;
}
/** True when compressing this command's output could damage patch/blame/diff content. Fails closed on overflow. */
export function isProtectedGit(command) {
    if (typeof command !== "string")
        return false;
    const info = inspectGit(command);
    if (info.overflow && /\bgit\b/i.test(command))
        return true;
    return info.calls.some(isProtectedGitCall);
}
/**
 * True when the command has more than one top-level shell segment (pipe,
 * `&&`, `||`, `;`, `&` or newline outside quotes). Fails closed (true) if the
 * command is too large to analyse completely.
 */
export function hasTopLevelChain(command) {
    if (typeof command !== "string")
        return false;
    if (command.length > MAX_COMMAND_CHARS)
        return true;
    return splitSegments(command).length > 1;
}
