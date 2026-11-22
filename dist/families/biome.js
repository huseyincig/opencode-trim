import { splitLines, isImportant, familyLimits } from "./util.js";
/** biome: drop formatter/checker chatter; keep diagnostics and the "Checked N files" summary. */
export const id = "biome";
export const priority = 90;
const SUMMARY_ROW = /\bChecked\s+\d+\s+files?\b|\bFormatted\s+\d+\s+files?\b|\bFixed\s+\d+\s+files?\b/i;
const NOISE = [/^\s*(?:Checking|Formatting|Linting|Running|Resolving|Analyzing|Scanning)\b/i, /^\s*(?:✔|✓)\s/, /^\s*(?:ℹ|i)\s+(?:Some|Skipped|Use|Run)\b/, /^\s*Skipped\s+\d+\s+suggested fixes?\b/i];
export function match(ctx) { return ctx.program === "biome"; }
function finish(text, kept, dropped, tool, ctx) {
    const { maxLines, maxChars } = familyLimits(ctx);
    if (dropped < 2)
        return text;
    if (kept.length > maxLines - 2)
        return text;
    const out = `[${dropped} ${tool} progress rows omitted]\n${kept.join("\n")}`;
    return out.length > maxChars || out.split("\n").length > maxLines ? text : out;
}
export function compress(text, ctx) {
    if (typeof text !== "string" || !SUMMARY_ROW.test(text))
        return text;
    const kept = [];
    let dropped = 0;
    for (const line of splitLines(text)) {
        if (!isImportant(line) && NOISE.some((re) => re.test(line))) {
            dropped++;
            continue;
        }
        kept.push(line);
    }
    return finish(text, kept, dropped, "biome", ctx);
}
