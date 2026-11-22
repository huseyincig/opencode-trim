// Read-only section parsing for archived native-compaction Markdown. Never rewrites stored text.
export const SECTION_NAMES = Object.freeze([
    'objective', 'requirements', 'decisions', 'work_state', 'next_move', 'relevant_files', 'important_context',
]);
const KNOWN = new Set(SECTION_NAMES);
const TOKEN_RE = /[\p{L}\p{N}_]+/gu;
/** Canonical section name for a user spelling (case/space/hyphen/underscore tolerant), else null. */
export function normalizeSection(value) {
    if (typeof value !== 'string')
        return null;
    const key = value.trim().toLowerCase().replace(/[\s_-]+/g, '_');
    return KNOWN.has(key) ? key : null;
}
const HEADING_RE = /^ {0,3}##[ \t]+(?:\d+[.)][ \t]*|\d+[ \t]+)?(.*?)[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
function headingName(line) {
    const m = HEADING_RE.exec(line);
    if (!m)
        return undefined;
    // Strip optional closing hashes and trailing colon: "## Decisions:" / "## Decisions ##".
    const label = m[1].replace(/[ \t]+#+$/, '').replace(/[ \t]*:$/, '').trim();
    return normalizeSection(label) ?? null; // null = unknown `##` heading
}
/**
 * Parse `## Heading` sections. Returns Map<canonicalName, {start, end}> offsets into `text`
 * (body only, heading line excluded). First occurrence of a known section wins; unknown `##`
 * headings end the current section but never discard others. Headings inside fenced code are ignored.
 */
export function parseSections(text) {
    const out = new Map();
    if (typeof text !== 'string' || !text)
        return out;
    let fence = null;
    let current = null;
    let pos = 0;
    const close = (end) => {
        if (current)
            out.set(current.name, { start: current.start, end });
        current = null;
    };
    while (pos <= text.length) {
        let nl = text.indexOf('\n', pos);
        const lineEnd = nl === -1 ? text.length : nl;
        const next = nl === -1 ? text.length + 1 : nl + 1;
        const line = text.slice(pos, lineEnd).replace(/\r$/, '');
        const f = FENCE_RE.exec(line);
        if (fence) {
            if (f && f[1][0] === fence.ch && f[1].length >= fence.len && !line.slice(f[0].length).trim())
                fence = null;
        }
        else if (f) {
            fence = { ch: f[1][0], len: f[1].length };
        }
        else {
            const name = headingName(line);
            if (name !== undefined) {
                close(pos);
                if (name && !out.has(name))
                    current = { name, start: Math.min(next, text.length) };
            }
        }
        pos = next;
    }
    close(text.length);
    return out;
}
/** Text of one section (empty string when absent). */
export function sectionText(text, section) {
    const name = normalizeSection(section);
    const r = name ? parseSections(text).get(name) : undefined;
    return r && typeof text === 'string' ? text.slice(r.start, r.end) : '';
}
/** Bounded snippet from `section`, around the first query token present, else from the section start. */
export function sectionSnippet(text, section, query, maxChars) {
    const max = Math.max(0, Math.trunc(Number(maxChars)) || 0);
    if (!max)
        return '';
    const body = sectionText(text, section).trim();
    if (body.length <= max)
        return body;
    const lower = body.toLowerCase();
    let at = -1;
    for (const w of String(query ?? '').match(TOKEN_RE) ?? []) {
        at = lower.indexOf(w.toLowerCase());
        if (at >= 0)
            break;
    }
    const start = Math.max(0, Math.min(at < 0 ? 0 : at - Math.floor(max / 4), body.length - max));
    return body.slice(start, start + max);
}
