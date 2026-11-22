import { splitLines, isImportant } from "./util.ts";
/** bun: drop install/extract progress; keep errors, warnings and summaries. */
export const id: string = "bun";
export const priority: number = 70;
const NOISE = [
  /^\s*Resolved,\s*downloaded and extracted\b/i,
  /^\s*(?:Downloaded|Saved lockfile|Installing|Extracting)\b.*$/i,
  /^\s*\[\d+\/\d+\]\s+installing\b/i,
  /^\s*\[[.oO]{3,}\]/,
];
export function match(ctx: any): boolean { return ctx.program === "bun"; }
export function compress(text: string): string {
  const rows = splitLines(text);
  const kept = [];
  let dropped = 0;
  for (const line of rows) {
    if (!isImportant(line) && NOISE.some((re) => re.test(line))) { dropped++; continue; }
    kept.push(line);
  }
  if (!dropped) return text;
  return `[${dropped} bun install progress lines omitted]\n${kept.join("\n")}`;
}
