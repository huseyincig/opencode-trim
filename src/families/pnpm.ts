import { splitLines, isImportant } from "./util.ts";
/** pnpm: drop resolution/download progress; keep lifecycle failures and summaries. */
export const id: string = "pnpm";
export const priority: number = 70;
const NOISE = [
  /^\s*Progress:\s+resolved\s+\d+/i,
  /^\s*Packages:\s*[+\-]\d+/i,
  /^\s*(?:Downloading|Resolving|Fetching)\s+\S+/i,
  /^\s*\[[.oO]{3,}\]/,
];
export function match(ctx: any): boolean { return ctx.program === "pnpm"; }
export function compress(text: string): string {
  const rows = splitLines(text);
  const kept = [];
  let dropped = 0;
  for (const line of rows) {
    if (!isImportant(line) && NOISE.some((re) => re.test(line))) { dropped++; continue; }
    kept.push(line);
  }
  if (!dropped) return text;
  return `[${dropped} pnpm progress lines omitted]\n${kept.join("\n")}`;
}
