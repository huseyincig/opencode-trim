import { splitLines, isImportant } from "./util.ts";
import { isProtectedGit } from "../git.ts";
/** git: remove transfer/checkout progress; keep status, refs, diffs and log records. */
export const id: string = "git";
export const priority: number = 80;
const PROGRESS = [
  /^remote:\s*(?:Enumerating|Counting|Compressing|Total|Finding)\b/i,
  /^(?:Receiving|Resolving|Counting|Compressing|Enumerating|Updating files?|Checking out files?|Unpacking objects?)\b/i,
  /^\s*(?:remote:\s*)?\d{1,3}%\s*\(\d+\/\d+\)/,
  /^\s*[|/\\-]\s*$/,
];
export function match(ctx: any): boolean { return ctx.program === "git"; }
export function compress(text: string, ctx?: any): string {
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
