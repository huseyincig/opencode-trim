import { splitLines, isImportant, familyLimits } from "./util.js";
/** pip: drop collect/download/build progress; errors, "Successfully installed" and a few "already satisfied" rows stay. */
export const id = "pip";
export const priority = 60;
const PROGRAMS = new Set(["pip", "pip3"]);
const NOISE = [
  /^\s*(?:Collecting|Downloading|Using cached|Installing collected packages|Obtaining|Preparing metadata|Getting requirements|Building wheel|Created wheel|Stored in directory|Installing build dependencies|Running setup\.py|Attempting uninstall|Found existing installation|Uninstalling)\b/,
  /^\s*[━─█#=]{4,}.*\b(?:[kMG]?B|eta)\b/,
];
const SATISFIED = /^\s*Requirement already satisfied:/;
const KEEP_SATISFIED = 3;
export function match(ctx) { return PROGRAMS.has(String(ctx?.program ?? "").toLowerCase()); }
export function compress(text, ctx) {
  try {
    const { maxLines: MAX_LINES, maxChars: MAX_CHARS } = familyLimits(ctx);
    if (typeof text !== "string" || !text) return text;
    const rows = splitLines(text);
    let dropped = 0;
    let satisfied = 0;
    let kept = [];
    for (const line of rows) {
      if (!isImportant(line)) {
        if (SATISFIED.test(line) && ++satisfied > KEEP_SATISFIED) { dropped++; continue; }
        if (NOISE.some((re) => re.test(line))) { dropped++; continue; }
      }
      kept.push(line);
    }
    if (dropped < 3) return text;
    const out = `[${dropped} pip progress rows omitted]\n${kept.join("\n")}`;
    const outRows = out.split("\n");
    if (outRows.length > MAX_LINES || out.length > MAX_CHARS) return text;
    const have = new Set(outRows);
    for (const line of rows) if (isImportant(line) && !have.has(line)) return text;
    return out;
  } catch { return text; }
}
