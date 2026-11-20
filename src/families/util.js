/**
 * Shared, dependency-free helpers for command-family compressors.
 * Families only remove low-value rows; compress.js independently verifies
 * that every diagnostic, stack frame and summary line survived.
 */
import { hasSummaryText, isImportantLine } from "../diagnostics.js";
const TEST_SUMMARY_LINE = /^\s{0,20}(?:Test Files\s+\d+|Test Suites:\s*\d+|Tests:\s*\d+|={2,}\s*\d+\s+(?:passed|failed)|\d+\s+passed\b|Ran\s+\d+\s+tests?|BUILD (?:SUCCESSFUL|FAILED))/i;
// Shell/git command inspection lives in ../git.js; re-exported for compatibility.
export { skipPrefixWords, splitSegments, shellWords, gitSubcommands } from "../git.js";

export const FAILURE = /(?:\b(?:error|failed|failure|fatal|panic|exception|assertionerror|traceback|segmentation fault|unhandled rejection)\b|\berror\s+TS\d+\b|\bE\d{3,}\b|\bFAIL\b|✗|❌)/i;
export const WARNING = /\b(?:warning|warn|deprecated)\b/i;
export const SUMMARY = /(?:^\s*(?:Test Files|Test Suites:|Tests|Ran|BUILD\s+(?:SUCCESSFUL|FAILED)|Found\s+\d+\s+errors?|Checked\s+\d+\s+files?|Code style|Successfully installed|Installed\s+\d+\s+packages?|=+\s*\d+\s+(?:passed|failed)|exit\s*(?:code|status)|finished|completed|success|done)\b|\b\d+\s+(?:passed|failed|skipped|errors?|warnings?)\b)/im;
// Quantifiers are bounded so adversarial single-line inputs stay linear.
export const STACK = /(?:\bat\s+\S[^\n]{0,300}?:\d+(?::\d+)?\b|(?:^|\s)(?:File\s+"[^"\n]{1,300}", line \d+|Caused by:))/i;
export const ANCHOR = /\b[\w.-]{1,120}(?:[/\\][\w.-]{1,120}){1,16}:\d+(?::\d+)?/;

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])/g;

export function clean(text) {
  return typeof text === "string" ? text.replace(ANSI, "").replace(/\r\n?/g, "\n") : "";
}
/** Configured output caps (conservative defaults for direct calls without ctx). */
export function familyLimits(ctx) {
  const pos = (n, d) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : d);
  return {
    maxLines: pos(ctx?.options?.maxOutputLines, 160),
    maxChars: pos(ctx?.options?.maxOutputChars, 16000),
  };
}
export function splitLines(text) { return clean(text).split("\n"); }
export function render(rows) { return rows.join("\n"); }
export function isImportant(line) {
  return FAILURE.test(line) || WARNING.test(line) || SUMMARY.test(line) || STACK.test(line) || ANCHOR.test(line) || isImportantLine(line);
}
export function isFailure(line) { return FAILURE.test(line); }
export function isNoiseMeter(line) {
  return /^\s*(?:\d{1,3}%\s*(?:\[[^\]]*\])?|\[[#=>.\s-]{6,}\]\s*\d{1,3}%|[-\\|/]\s*$)/.test(line);
}
export function dropMatching(rows, predicate) {
  const kept = []; let dropped = 0;
  for (const line of rows) {
    if (!isImportant(line) && predicate(line)) { dropped++; continue; }
    kept.push(line);
  }
  return { rows: kept, dropped };
}
export function foldMatching(rows, predicate, label) {
  const { rows: kept, dropped } = dropMatching(rows, predicate);
  if (!dropped) return { text: render(rows), dropped: 0 };
  return { text: `[${dropped} ${label}] ${render(kept)}`.replace("] ", "]\n"), dropped };
}
export function headTail(rows, max, label) {
  if (rows.length <= max) return render(rows);
  const head = Math.max(1, Math.ceil(max * 0.6));
  const tail = Math.max(1, max - head);
  const omitted = rows.length - head - tail;
  return [...rows.slice(0, head), `[${omitted} ${label}]`, ...rows.slice(-tail)].join("\n");
}
export function unique(rows) {
  const seen = new Set(); const out = [];
  for (const row of rows) {
    const key = row.trim();
    if (seen.has(key)) continue;
    seen.add(key); out.push(row);
  }
  return out;
}
export function collapseBlank(rows, max = 1) {
  const out = []; let blanks = 0;
  for (const row of rows) {
    if (row.trim() === "") { blanks++; if (blanks > max) continue; }
    else blanks = 0;
    out.push(row);
  }
  return out;
}
export function compactRows(rows, max) {
  return headTail(collapseBlank(rows), max, "lines omitted");
}
export function summarizeCounts(text) {
  const s = text.match(/(\d+)\s+(passed|failed|skipped|errors?|warnings?)/gi) ?? [];
  return s.slice(0, 8).join(", ");
}
export function hasTestSummary(text) {
  // Line-anchored: a passing-test row such as "✓ keeps 3 passed rows" is not a summary.
  if (typeof text !== "string") return false;
  return hasSummaryText(text) || text.split("\n").some((line) => TEST_SUMMARY_LINE.test(line.slice(0, 2000)));
}
export function truncateLine(line, max = 400) {
  return line.length <= max ? line : `${line.slice(0, max - 20)}… [line truncated]`;
}
