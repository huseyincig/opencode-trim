import { splitLines, isImportant } from "./util.js";
/** npm: remove install/registry chatter; never touch lifecycle errors or summaries. */
export const id = "npm";
export const priority = 70;
const NOISE = [
    /^npm (?:notice|sill|verb|http|timing)\b/i,
    /^\s*\[[.oO]{3,}\]/,
    /^\s*(?:⠁|⠂|⠄|⠈|⠐|⠠|⠰|⠸|⠼|⠴|⠦|⠧|⠇|⠏)\s/,
    /^\s*(?:reify|audit)\b.*\b(?:timing|completed)\b/i,
];
export function match(ctx) { return ctx.program === "npm"; }
export function compress(text) {
    const rows = splitLines(text);
    const kept = [];
    let dropped = 0;
    for (const line of rows) {
        if (!isImportant(line) && NOISE.some((re) => re.test(line))) {
            dropped++;
            continue;
        }
        kept.push(line);
    }
    if (!dropped)
        return text;
    // Keep an explicit record so withheld volume is visible.
    return `[${dropped} npm chatter lines omitted]\n${kept.join("\n")}`;
}
