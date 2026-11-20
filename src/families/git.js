import { splitLines, isImportant } from "./util.js";
import { isProtectedGit } from "../git.js";
/** git: remove transfer/checkout progress; keep status, refs, diffs and log records. */
export const id = "git";
export const priority = 80;
const PROGRESS = [
  /^remote:\s*(?:Enumerating|Counting|Compressing|Total|Finding)\b/i,
  /^(?:Receiving|Resolving|Counting|Compressing|Enumerating|Updating files?|Checking out files?|Unpacking objects?)\b/i,
  /^\s*(?:remote:\s*)?\d{1,3}%\s*\(\d+\/\d+\)/,
  /^\s*[|/\\-]\s*$/,
];
export function match(ctx) { return ctx.program === "git"; }
export function compress(text, ctx) {
  // Patch/diff/blame/verbose-status output is protected; never rewrite it.
  // Overlong or over-segmented commands fail closed inside isProtectedGit.
  if (isProtectedGit(ctx.command)) return text;
  const rows = splitLines(text);
  const kept = [];
  let dropped = 0;
  for (const line of rows) {
    if (!isImportant(line) && PROGRESS.some((re) => re.test(line))) { dropped++; continue; }
    kept.push(line);
  }
  if (!dropped) return text;
  return `[${dropped} git progress lines omitted]\n${kept.join("\n")}`;
}
