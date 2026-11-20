import { splitLines, isImportant, familyLimits } from "./util.js";
/** uv: drop resolve/prepare/audit progress; errors, the "Installed N packages" summary and +/- rows stay. */
export const id = "uv";
export const priority = 60;
const PROGRAMS = new Set(["uv", "uvx"]);
const NOISE = [
  /^\s*(?:Resolved|Prepared|Audited|Downloading|Downloaded|Building|Built|Using Python|Creating virtual|Uninstalled)\b/,
  /^\s*[━─█#=]{4,}.*\b(?:[kMG]?i?B|eta)\b/,
];
export function match(ctx) { return PROGRAMS.has(String(ctx?.program ?? "").toLowerCase()); }
export function compress(text, ctx) {
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
    const out = `[${dropped} uv progress rows omitted]\n${kept.join("\n")}`;
    const outRows = out.split("\n");
    if (outRows.length > MAX_LINES || out.length > MAX_CHARS) return text;
    const have = new Set(outRows);
    for (const line of rows) if (isImportant(line) && !have.has(line)) return text;
    return out;
  } catch { return text; }
}
