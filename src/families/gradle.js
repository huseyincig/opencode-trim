import { splitLines, isImportant, familyLimits } from "./util.js";
/** gradle: drop up-to-date/no-source task rows; BUILD result, failing task output and warnings stay. */
export const id = "gradle";
export const priority = 60;
const PROGRAMS = new Set(["gradle", "gradlew"]);
const NOISE = [
  /^> Task \S+ (?:UP-TO-DATE|NO-SOURCE|FROM-CACHE|SKIPPED)\s*$/,
  /^> Configure project\b/,
  /^Starting a Gradle Daemon\b/,
  /^Download(?:ing)?\s+https?:\/\//,
  /^\s*<[-=]+>\s*\d+%/,
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
    const out = `[${dropped} gradle progress rows omitted]\n${kept.join("\n")}`;
    const outRows = out.split("\n");
    if (outRows.length > MAX_LINES || out.length > MAX_CHARS) return text;
    const have = new Set(outRows);
    for (const line of rows) if (isImportant(line) && !have.has(line)) return text;
    return out;
  } catch { return text; }
}
