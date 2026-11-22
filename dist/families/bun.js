import { splitLines, isImportant } from "./util.js";
/** bun: drop install/extract progress; keep errors, warnings and summaries. */
export const id = "bun";
export const priority = 70;
const NOISE = [
    /^\s*Resolved,\s*downloaded and extracted\b/i,
    /^\s*(?:Downloaded|Saved lockfile|Installing|Extracting)\b.*$/i,
    /^\s*\[\d+\/\d+\]\s+installing\b/i,
    /^\s*\[[.oO]{3,}\]/,
];
export function match(ctx) { return ctx.program === "bun"; }
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
    return `[${dropped} bun install progress lines omitted]\n${kept.join("\n")}`;
}
