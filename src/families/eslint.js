import { splitLines, isImportant, familyLimits } from "./util.js";
/** eslint: drop clean-file/progress rows once a problems summary exists; keep every problem. */
export const id = "eslint";
export const priority = 90;
const SUMMARY_ROW = /\b\d+\s+problems?\b|\b\d+\s+errors?\b.*\b\d+\s+warnings?\b/i;
const NOISE = [/^\s*(?:✓|✔)\s+\S/, /^\s*(?:Linting|Checking|Running)\b.*(?:\.\.\.|files?)\s*$/i, /^\S.*\s\d+ms\s*$/, /^\s*(?:OK|PASS)\s+\S+\s*$/];
export function match(ctx) { return ctx.program === "eslint" || ctx.program === "eslint_d"; }
function finish(text, kept, dropped, tool, ctx) {
  const { maxLines, maxChars } = familyLimits(ctx);
  if (dropped < 2) return text;
  if (kept.length > maxLines - 2) return text;
  const out = `[${dropped} ${tool} progress rows omitted]\n${kept.join("\n")}`;
  return out.length > maxChars || out.split("\n").length > maxLines ? text : out;
}
export function compress(text, ctx) {
  if (typeof text !== "string" || !SUMMARY_ROW.test(text)) return text;
  const kept = []; let dropped = 0;
  for (const line of splitLines(text)) {
    if (!isImportant(line) && NOISE.some((re) => re.test(line))) { dropped++; continue; }
    kept.push(line);
  }
  return finish(text, kept, dropped, "eslint", ctx);
}
