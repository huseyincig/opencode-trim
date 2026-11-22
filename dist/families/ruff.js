import { splitLines, isImportant, familyLimits } from "./util.js";
/** ruff: keep all diagnostics and the "Found N errors" summary; drop resolution/download chatter. */
export const id = "ruff";
export const priority = 90;
const SUMMARY_ROW = /\bFound\s+\d+\s+errors?\b|All checks passed!/i;
const NOISE = [/^\s*(?:Resolved|Downloading|Downloaded|Installed|Installing|Prepared|Audited|Uninstalled|Updating|Building|Built)\b/];
export function match(ctx) { return ctx.program === "ruff"; }
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
    return finish(text, kept, dropped, "ruff", ctx);
}
