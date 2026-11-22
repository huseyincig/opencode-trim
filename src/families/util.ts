export interface FamilyContext {
  command?: string;
  tokens?: string[];
  program?: string;
  failed?: boolean;
  exitCode?: number;
  externalFailureNotice?: boolean;
  head?: string;
  options?: { maxOutputLines?: number; maxOutputChars?: number; [key: string]: unknown };
}
export interface FamilyLimits { maxLines: number; maxChars: number; }
/**
 * Shared, dependency-free helpers for command-family compressors.
 * Families only remove low-value rows; compress.js independently verifies
 * that every diagnostic, stack frame and summary line survived.
 */
import { hasSummaryText, isImportantLine } from "../diagnostics.ts";
const TEST_SUMMARY_LINE = /^\s{0,20}(?:Test Files\s+\d+|Test Suites:\s*\d+|Tests:\s*\d+|={2,}\s*\d+\s+(?:passed|failed)|\d+\s+passed\b|Ran\s+\d+\s+tests?|BUILD (?:SUCCESSFUL|FAILED))/i;
// Shell/git command inspection lives in ../git.js; re-exported for compatibility.
export { skipPrefixWords, splitSegments, shellWords, gitSubcommands } from "../git.ts";

export const FAILURE = /(?:\b(?:error|failed|failure|fatal|panic|exception|assertionerror|traceback|segmentation fault|unhandled rejection)\b|\berror\s+TS\d+\b|\bE\d{3,}\b|\bFAIL\b|✗|❌)/i;
export const WARNING = /\b(?:warning|warn|deprecated)\b/i;
export const SUMMARY = /(?:^\s*(?:Test Files|Test Suites:|Tests|Ran|BUILD\s+(?:SUCCESSFUL|FAILED)|Found\s+\d+\s+errors?|Checked\s+\d+\s+files?|Code style|Successfully installed|Installed\s+\d+\s+packages?|=+\s*\d+\s+(?:passed|failed)|exit\s*(?:code|status)|finished|completed|success|done)\b|\b\d+\s+(?:passed|failed|skipped|errors?|warnings?)\b)/im;
// Quantifiers are bounded so adversarial single-line inputs stay linear.
export const STACK = /(?:\bat\s+\S[^\n]{0,300}?:\d+(?::\d+)?\b|(?:^|\s)(?:File\s+"[^"\n]{1,300}", line \d+|Caused by:))/i;
export const ANCHOR = /\b[\w.-]{1,120}(?:[/\\][\w.-]{1,120}){1,16}:\d+(?::\d+)?/;

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])/g;

export function clean(text: unknown): string {
  return typeof text === "string" ? text.replace(ANSI, "").replace(/\r\n?/g, "\n") : "";
}
/** Configured output caps (conservative defaults for direct calls without ctx). */
export function familyLimits(ctx?: FamilyContext): FamilyLimits {
  const pos = (n: unknown, d: number): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : d);
  return {
    maxLines: pos(ctx?.options?.maxOutputLines, 160),
    maxChars: pos(ctx?.options?.maxOutputChars, 16000),
  };
}
export function splitLines(text: unknown): string[] { return clean(text).split("\n"); }
export function render(rows: readonly string[]): string { return rows.join("\n"); }
export function isImportant(line: string): boolean {
  return FAILURE.test(line) || WARNING.test(line) || SUMMARY.test(line) || STACK.test(line) || ANCHOR.test(line) || isImportantLine(line);
}
export function isFailure(line: string): boolean { return FAILURE.test(line); }
export function isNoiseMeter(line: string): boolean {
  return /^\s*(?:\d{1,3}%\s*(?:\[[^\]]*\])?|\[[#=>.\s-]{6,}\]\s*\d{1,3}%|[-\\|/]\s*$)/.test(line);
}
export function dropMatching(rows: readonly string[], predicate: (line: string) => boolean): { rows: string[]; dropped: number } {
  const kept = []; let dropped = 0;
  for (const line of rows) {
    if (!isImportant(line) && predicate(line)) { dropped++; continue; }
    kept.push(line);
  }
  return { rows: kept, dropped };
}
export function foldMatching(rows: readonly string[], predicate: (line: string) => boolean, label: string): { text: string; dropped: number } {
  const { rows: kept, dropped } = dropMatching(rows, predicate);
  if (!dropped) return { text: render(rows), dropped: 0 };
  return { text: `[${dropped} ${label}] ${render(kept)}`.replace("] ", "]\n"), dropped };
}
export function headTail(rows: readonly string[], max: number, label: string): string {
  if (rows.length <= max) return render(rows);
  const head = Math.max(1, Math.ceil(max * 0.6));
  const tail = Math.max(1, max - head);
  const omitted = rows.length - head - tail;
  return [...rows.slice(0, head), `[${omitted} ${label}]`, ...rows.slice(-tail)].join("\n");
}
export function unique(rows: readonly string[]): string[] {
  const seen = new Set(); const out = [];
  for (const row of rows) {
    const key = row.trim();
    if (seen.has(key)) continue;
    seen.add(key); out.push(row);
  }
  return out;
}
export function collapseBlank(rows: readonly string[], max: number = 1): string[] {
  const out = []; let blanks = 0;
  for (const row of rows) {
    if (row.trim() === "") { blanks++; if (blanks > max) continue; }
    else blanks = 0;
    out.push(row);
  }
  return out;
}
export function compactRows(rows: readonly string[], max: number): string {
  return headTail(collapseBlank(rows), max, "lines omitted");
}
export function summarizeCounts(text: string): string {
  const s = text.match(/(\d+)\s+(passed|failed|skipped|errors?|warnings?)/gi) ?? [];
  return s.slice(0, 8).join(", ");
}
export function hasTestSummary(text: unknown): boolean {
  // Line-anchored: a passing-test row such as "✓ keeps 3 passed rows" is not a summary.
  if (typeof text !== "string") return false;
  return hasSummaryText(text) || text.split("\n").some((line) => TEST_SUMMARY_LINE.test(line.slice(0, 2000)));
}
export function truncateLine(line: string, max: number = 400): string {
  return line.length <= max ? line : `${line.slice(0, max - 20)}… [line truncated]`;
}
