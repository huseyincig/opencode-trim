import { splitLines, isImportant, familyLimits } from "./util.js";
/** wget: drop progress bars and connect chatter; HTTP errors, redirects and the saved-file line stay. */
export const id = "wget";
export const priority = 60;
const PROGRAMS = new Set(["wget"]);
const NOISE = [
  /^\s*\d{1,6}[KMG]\s[ .,]*\d{1,6}%/,
  /^\S.*\d{1,6}%\s*\[[=>\s.]*\]/,
  /^\s*\d{1,6}%\s*\[[=>\s.]*\]/,
  /^Connecting to\b/,
  /^Resolving\b/,
  /^Length:\s/,
  /^Reusing existing connection\b/,
  /^HTTP request sent, awaiting response\.\.\. 200\b/,
];
const SAVING = /^Saving to:/;
const SAVED = /\bsaved\s*\[/i;
export function match(ctx) { return PROGRAMS.has(String(ctx?.program ?? "").toLowerCase()); }
export function compress(text, ctx) {
  try {
    const { maxLines: MAX_LINES, maxChars: MAX_CHARS } = familyLimits(ctx);
    if (typeof text !== "string" || !text) return text;
    const rows = splitLines(text);
    // "Saving to" is redundant only when the final saved line confirms the file.
    const redundantSaving = rows.some((l) => SAVED.test(l));
    let dropped = 0;
    let kept = [];
    for (const line of rows) {
      if (!isImportant(line) && (NOISE.some((re) => re.test(line)) || (redundantSaving && SAVING.test(line)))) { dropped++; continue; }
      kept.push(line);
    }
    if (dropped < 3) return text;
    const out = `[${dropped} wget progress rows omitted]\n${kept.join("\n")}`;
    const outRows = out.split("\n");
    if (outRows.length > MAX_LINES || out.length > MAX_CHARS) return text;
    const have = new Set(outRows);
    for (const line of rows) if (isImportant(line) && !have.has(line)) return text;
    return out;
  } catch { return text; }
}
