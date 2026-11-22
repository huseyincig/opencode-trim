import { splitLines, isImportant, hasTestSummary } from "./util.ts";
/** cargo/rustc: drop dependency/build progress; keep diagnostics and test results. */
export const id: string = "cargo";
export const priority: number = 90;
const NOISE = [
  /^\s*(?:Compiling|Downloading|Updating|Blocking|Adding|Locking|Fresh|Checking)\b/,
  /^\s*(?:warning: unused manifest key|note: see more `?Cargo\.toml)/,
];
const PASSING = /^\s*test\s+.+\s+\.\.\.\s+ok\s*$/;
export function match(ctx: any): boolean { return ctx.program === "cargo" || ctx.program === "rustc"; }
export function compress(text: string): string {
  const rows = splitLines(text);
  const testSummary = hasTestSummary(text);
  const kept = [];
  let dropped = 0;
  for (const line of rows) {
    if (!isImportant(line) && NOISE.some((re) => re.test(line))) { dropped++; continue; }
    if (testSummary && !isImportant(line) && PASSING.test(line)) { dropped++; continue; }
    kept.push(line);
  }
  if (!dropped) return text;
  return `[${dropped} cargo progress/passing rows omitted]\n${kept.join("\n")}`;
}
