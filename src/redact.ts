/**
 * Pure, dependency-free secret redaction shared by memory/vault storage and
 * pruning preview notices (keeps `./prune` free of `node:sqlite`).
 */
const MAX_SCAN_CHARS = 200_000;
const MAX_SCAN_DEPTH = 32;
const MAX_KEY_MATCHES = 10_000;

export const REDACTED = '[REDACTED]';

// Order matters: block/structured forms first, generic assignments last.
const SECRET_PATTERNS: Array<[RegExp | null, string | null]> = [
  [/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE|PGP [A-Z ]*BLOCK)-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\b(?:Basic)\s+[A-Za-z0-9+/=]{12,}/g, `Basic ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, `$1:${REDACTED}@`],
  // Bounded structured scanner for secret-keyed values (nested objects/arrays, escaped quotes).
  [null, null],
  // KEY=value / KEY: value / "key": "value" for secret-looking names
  [
    /(["']?\b[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|pwd|credential|private[_-]?key|auth|access[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=：]\s*)(?!\[REDACTED\])(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi,
    `$1${REDACTED}`,
  ],
  // PIN assignments and multilingual password/secret labels (CJK, Romance, Germanic)
  [
    /(\bPIN\b\s*[:=：]\s*)(?!\[REDACTED\])['"`]?\d{4,16}['"`]?/gi,
    `$1${REDACTED}`,
  ],
  [
    /((?:密碼|密码|パスワード|비밀번호|contraseña|mot\s+de\s+passe|passwort)\s*[:=：]\s*)(?!\[REDACTED\])(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi,
    `$1${REDACTED}`,
  ],
  // Generic exported env assignment of uppercase names with long values
  [/\b(export\s+[A-Z][A-Z0-9_]{2,}=)(?:"[^"\n]*"|'[^'\n]*'|\S+)/g, `$1${REDACTED}`],
];

/**
 * Value starting at i: `end` is exclusive; `end === i` means no value. `closed:false` means the value
 * could not be delimited safely (unclosed, mismatched, too deep, or beyond the scan window): callers
 * must fail closed and redact through the end of the text. Never throws.
 */
function valueEnd(s: string, i: number): { end: number; closed: boolean } {
  const limit = Math.min(s.length, i + MAX_SCAN_CHARS);
  const c = s[i];
  if (c === undefined) return { end: i, closed: true };
  if (c === '{' || c === '[') {
    const stack: string[] = [];
    let quote = '';
    for (let j = i; j < limit; j++) {
      const ch = s[j];
      if (quote) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{' || ch === '[') {
        if (stack.length >= MAX_SCAN_DEPTH) return { end: s.length, closed: false };
        stack.push(ch === '{' ? '}' : ']');
      } else if (ch === '}' || ch === ']') {
        if (stack.pop() !== ch) return { end: s.length, closed: false };
        if (!stack.length) return { end: j + 1, closed: true };
      }
    }
    return { end: s.length, closed: false };
  }
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < limit; j++) {
      if (s[j] === '\\') j++;
      else if (s[j] === c) return { end: j + 1, closed: true };
      else if (s[j] === '\n') break;
    }
    return { end: s.length, closed: false };
  }
  let j = i;
  while (j < limit && !/[\s,;&}\])]/.test(s[j])) j++;
  if (j >= limit && limit < s.length) return { end: s.length, closed: false };
  return { end: j, closed: true };
}

function redactStructured(text: string): string {
  try {
    const re = /(["']?)\b[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|pwd|credential|private[_-]?key|auth|access[_-]?key)[A-Za-z0-9_.-]*\1\s*[:=：]\s*/gi;
    let out = '';
    let last = 0;
    let n = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (++n > MAX_KEY_MATCHES) {
        // Too many keys to process safely: redact from this key to the end.
        return out + text.slice(last, m.index) + REDACTED;
      }
      const start = m.index + m[0].length;
      if (text.startsWith(REDACTED, start)) {
        // An existing marker is a complete value only when properly delimited; otherwise fail closed.
        const next = text[start + REDACTED.length];
        if (next === undefined || /[\s,;&}\])]/.test(next)) continue;
        return out + text.slice(last, start) + REDACTED;
      }
      const { end, closed } = valueEnd(text, start);
      if (!closed) return out + text.slice(last, start) + REDACTED;
      if (end <= start) { if (m[0].length === 0) re.lastIndex++; continue; }
      out += text.slice(last, start) + REDACTED;
      last = end;
      re.lastIndex = end;
    }
    return out + text.slice(last);
  } catch {
    // Fail closed: never return text the scanner could not process.
    return REDACTED;
  }
}

/** Linear-time removal of `key: [REDACTED]` (key looked up backwards, bounded) for the emptiness check. */
export function stripRedactedAssignments(text: string): string {
  const re = /["']?\s*[:=]\s*\[REDACTED\]/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    let k = m.index;
    const floor = Math.max(last, k - 256);
    while (k > floor && /[\w.-]/.test(text[k - 1])) k--;
    out += text.slice(last, k);
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

export function redactSecrets(text: unknown): string {
  let out = String(text ?? '');
  for (const [re, rep] of SECRET_PATTERNS) out = re === null ? redactStructured(out) : out.replace(re, rep as string);
  return out;
}
