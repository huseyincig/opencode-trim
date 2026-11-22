import { splitLines, isImportant, familyLimits } from "./util.js";
/** prettier: keep "Code style issues found" and unformatted file list; drop checking/unchanged chatter. */
export const id = "prettier";
export const priority = 90;
const SUMMARY_ROW = /Code style issues found|All matched files use Prettier code style/i;
const NOISE = [/^\s*Checking formatting\.\.\.\s*$/i, /\s\d+ms\s+\((?:unchanged|cached)\)\s*$/, /^\s*(?:Unchanged|Skipping)\b/i];
export function match(ctx) { return ctx.program === "prettier"; }
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
    return finish(text, kept, dropped, "prettier", ctx);
}
