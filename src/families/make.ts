import { splitLines, isImportant, familyLimits } from "./util.ts";
/** make: drop directory-change and nothing-to-do chatter; commands, errors and targets stay. */
export const id: string = "make";
export const priority: number = 60;
const PROGRAMS = new Set(["make", "gmake"]);
const NOISE = [
  /^g?make(?:\[\d+\])?: (?:Entering|Leaving) directory\b/,
  /^g?make(?:\[\d+\])?: Nothing to be done for\b/,
  /^g?make(?:\[\d+\])?: .* is up to date\.\s*$/,
];
export function match(ctx: any): boolean { return PROGRAMS.has(String(ctx?.program ?? "").toLowerCase()); }
export function compress(text: string, ctx?: any): string {
  try {
    const { maxLines: MAX_LINES, maxChars: MAX_CHARS } = familyLimits(ctx);
    if (typeof text !== "string" || !text) return text;
    const rows = splitLines(text);
    let dropped = 0;
    let kept = [];
    for (const line of rows) {
      if (!isImportant(line) && NOISE.some((re) => re.test(line))) { dropped++; continue; }
      kept.push(line);
    }
    if (dropped < 3) return text;
    const out = `[${dropped} make progress rows omitted]\n${kept.join("\n")}`;
    const outRows = out.split("\n");
    if (outRows.length > MAX_LINES || out.length > MAX_CHARS) return text;
    const have = new Set(outRows);
    for (const line of rows) if (isImportant(line) && !have.has(line)) return text;
    return out;
  } catch { return text; }
}
