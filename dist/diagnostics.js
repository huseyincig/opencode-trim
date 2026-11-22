// Shared, dependency-free diagnostic predicates. All regexes are linear/bounded.
export const MAX_LINE = 2000;
export const FAILURE = /\b(?:error|failed|failure|fatal|panic|exception|assertionerror|traceback|segmentation fault|unhandled rejection|timed out|timeout|interrupted|killed|cancelled|canceled|terminated|permission denied|access denied|security|vulnerab\w{0,12}|critical|CVE-\d{4}-\d{4,7})\b|\berror TS\d{4,5}\b|\bE\d{3,4}\b|\bFAIL\b|(?:^|\s)[✗✘✖✕❌]|^\s*×(?=\s)/i;
export const WARNING = /\b(?:warn(?:ing)?s?|deprecated|deprecation)\b/i;
export const CODE = /\b(?:TS\d{4,5}|[EFW]\d{3,4})\b/;
export const ANCHOR = /[\w.@~-]{1,100}(?:[\\/][\w.@~+-]{1,100}){1,30}:\d{1,7}(?::\d{1,5})?/;
export const STACK = /^\s{0,20}(?:at [^\n]{1,300}:\d{1,7}(?::\d{1,5})?\)?\s*$|File "[^"\n]{1,300}", line \d{1,7}|Caused by:)/;
export const SUMMARY = /^\s{0,20}(?:Tests?:\s{1,12}\d|Test Suites?:\s{1,12}\d|Test Files\s{1,12}\d|Ran \d{1,7} tests?\b|\d{1,7} (?:passing|failing|passed|failed|tests? (?:passed|failed))\b|=+ .{0,200}\b(?:passed|failed|error|errors)\b.{0,200}=+\s*$|test result:|# (?:pass|fail|tests) \d|Found \d{1,7} errors?\b|Build (?:succeeded|failed)\b|added \d{1,7} packages?\b|up to date,? audited|\d{1,7} (?:vulnerabilit(?:y|ies)|packages? (?:are )?looking for funding))/i;
const cut = (s) => (typeof s === 'string' && s.length > MAX_LINE ? s.slice(0, MAX_LINE) : String(s ?? ''));
export function isDiagnosticLine(line) {
    const l = cut(line);
    return FAILURE.test(l) || WARNING.test(l) || STACK.test(l) || ANCHOR.test(l) || CODE.test(l);
}
export function isImportantLine(line) {
    const l = cut(line);
    return isDiagnosticLine(l) || SUMMARY.test(l);
}
function scan(text, re, maxLines = 20000) {
    const s = String(text ?? '');
    let start = 0, n = 0;
    while (start <= s.length && n++ < maxLines) {
        let end = s.indexOf('\n', start);
        if (end < 0)
            end = s.length;
        if (re.test(s.slice(start, Math.min(end, start + MAX_LINE))))
            return true;
        start = end + 1;
    }
    return false;
}
export function hasFailureText(text) {
    return scan(text, FAILURE);
}
export function hasSummaryText(text) {
    return scan(text, SUMMARY);
}
const EXIT = /^\s{0,20}(?:\[?Process exited with code (-?\d{1,5})\]?|exit code:?\s{0,3}(-?\d{1,5})|exited with (?:code|status) (-?\d{1,5}))\b/im;
export function isExitNotice(text) {
    return scan(text, /^\s{0,20}\[?(?:Process exited with code|exit code:?|exited with (?:code|status))\s{0,3}-?\d/i);
}
export function parseExitCode(text) {
    const s = String(text ?? '');
    const tail = s.length > 20000 ? s.slice(-20000) : s;
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = EXIT.exec(cut(lines[i]));
        if (m)
            return Number(m[1] ?? m[2] ?? m[3]);
    }
    return null;
}
