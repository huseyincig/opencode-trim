import { splitLines, isImportant } from "./util.ts";
/** npm: remove install/registry chatter; never touch lifecycle errors or summaries. */
export const id: string = "npm";
export const priority: number = 70;
const NOISE = [
  /^npm (?:notice|sill|verb|http|timing)\b/i,
  /^\s*\[[.oO]{3,}\]/,
  /^\s*(?:⠁|⠂|⠄|⠈|⠐|⠠|⠰|⠸|⠼|⠴|⠦|⠧|⠇|⠏)\s/,
  /^\s*(?:reify|audit)\b.*\b(?:timing|completed)\b/i,
];
export function match(ctx: any): boolean { return ctx.program === "npm"; }
export function compress(text: string): string {
  const rows = splitLines(text);
  const kept = [];
  let dropped = 0;
  for (const line of rows) {
    if (!isImportant(line) && NOISE.some((re) => re.test(line))) { dropped++; continue; }
    kept.push(line);
  }
  if (!dropped) return text;
  // Keep an explicit record so withheld volume is visible.
  return `[${dropped} npm chatter lines omitted]\n${kept.join("\n")}`;
}
