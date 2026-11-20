import { splitLines, isImportant } from "./util.js";
/** tsc: never drop type errors; remove watch/compiler chatter only. */
export const id = "tsc";
export const priority = 90;
const NOISE = [
  /^\s*Starting compilation in watch mode\s*$/i,
  /^\s*File change detected\.\s+Starting incremental compilation\s*$/i,
  /^\s*\[\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)\]\s*Starting compilation/i,
  /^\s*Project is up to date\s*$/i,
];
export function match(ctx) { return ctx.program === "tsc" || /(?:^|\n)error TS\d{4}:/.test(ctx.head); }
export function compress(text) {
  const rows = splitLines(text);
  const kept = [];
  let dropped = 0;
  for (const line of rows) {
    if (!isImportant(line) && NOISE.some((re) => re.test(line))) { dropped++; continue; }
    kept.push(line);
  }
  if (!dropped) return text;
  return `[${dropped} tsc watch/status lines omitted]\n${kept.join("\n")}`;
}
