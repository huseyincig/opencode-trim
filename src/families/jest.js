import { splitLines, isImportant, hasTestSummary } from "./util.js";
/** jest: fold PASS/✓ rows and timing noise when a completed run summary is present. */
export const id = "jest";
export const priority = 100;
const SHAPE = /(?:Tests:\s+\d+|Test Suites:\s*\d+|PASS\s+\S+\.(?:test|spec)\.)/;
const PASSING = [
  /^\s*PASS\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?\s*$/,
  /^\s*✓\s+\S/,
  /^\s*✔\s+\S/,
  /^\s*Time:\s+[0-9.]+\s*(?:ms|s)\b/i,
  /^\s*Ran all test suites\b/i,
];
export function match(ctx) {
  return ctx.program === "jest" || (SHAPE.test(ctx.head) && /jest|Tests:\s+\d+/i.test(ctx.head));
}
export function compress(text) {
  if (!hasTestSummary(text)) return text;
  const rows = splitLines(text);
  const kept = [];
  let dropped = 0;
  for (const line of rows) {
    if (!isImportant(line) && PASSING.some((re) => re.test(line))) { dropped++; continue; }
    kept.push(line);
  }
  if (!dropped) return text;
  return `[${dropped} passing jest rows omitted]\n${kept.join("\n")}`;
}
