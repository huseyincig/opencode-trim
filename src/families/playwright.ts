import { splitLines, isImportant, FAILURE, WARNING, SUMMARY, STACK, familyLimits } from "./util.ts";
/** playwright: fold passing rows and HTML-report hints once a run summary exists; keep failures, retries, stacks, attachments. */
export const id: string = "playwright";
export const priority: number = 90;
const SUMMARY_ROW = /^\s*\d+\s+(?:passed|failed|flaky|skipped|did not run)\b/im;
// A passing row carries a spec path anchor but no diagnostic, so it is droppable
// unless it is a failure/warning/summary/stack/retry row.
const PASSING = /^\s*(?:✓|✔|ok)\s+\d+\s+.*\(\d+(?:\.\d+)?m?s\)\s*$/;
const REPORT = [/^\s*To open last HTML report run:\s*$/i, /^\s*npx playwright show-report\b/, /^\s*Serving HTML report at\b/i, /^\s*Press Ctrl\+C to quit\.?\s*$/i];
const RETRY = /\bretry\b|\battachment/i;
export function match(ctx: any): boolean { return ctx.program === "playwright"; }
function finish(text: string, kept: string[], dropped: number, tool: string, ctx: any): string {
  const { maxLines, maxChars } = familyLimits(ctx);
  if (dropped < 2) return text;
  if (kept.length > maxLines - 2) return text;
  const out = `[${dropped} ${tool} progress rows omitted]\n${kept.join("\n")}`;
  return out.length > maxChars || out.split("\n").length > maxLines ? text : out;
}
export function compress(text: string, ctx?: any): string {
  if (typeof text !== "string" || !SUMMARY_ROW.test(text)) return text;
  const kept = []; let dropped = 0;
  for (const line of splitLines(text)) {
    const diag = FAILURE.test(line) || WARNING.test(line) || STACK.test(line) || RETRY.test(line);
    if (!diag && (PASSING.test(line) || (!isImportant(line) && REPORT.some((re) => re.test(line))))) { dropped++; continue; }
    kept.push(line);
  }
  return finish(text, kept, dropped, "playwright", ctx);
}
