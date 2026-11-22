import { splitLines, isImportant, hasTestSummary } from "./util.ts";
/** vitest: fold ✓ rows and timing noise when a completed run summary is present. */
export const id: string = "vitest";
export const priority: number = 100;
const SHAPE = /(?:Test Files\s+\d+|Tests\s+\d+|✓|×|RUN\s+v?\d)/;
const PASSING = [
  /^\s*✓\s+\S/,
  /^\s*✔\s+\S/,
  /^\s*Duration\s+[0-9.]+\s*(?:ms|s)\b/i,
  /^\s*Start at\s+\d{1,2}:\d{2}:\d{2}/i,
];
export function match(ctx: any): boolean {
  return ctx.program === "vitest" || (SHAPE.test(ctx.head) && /vitest|Test Files\s+\d+|Tests\s+\d+/i.test(ctx.head));
}
export function compress(text: string): string {
  if (!hasTestSummary(text)) return text;
  const rows = splitLines(text);
  const kept = [];
  let dropped = 0;
  for (const line of rows) {
    if (!isImportant(line) && PASSING.some((re) => re.test(line))) { dropped++; continue; }
    kept.push(line);
  }
  if (!dropped) return text;
  return `[${dropped} passing test progress lines omitted]\n${kept.join("\n")}`;
}
