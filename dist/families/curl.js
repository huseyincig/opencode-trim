import { splitLines, isImportant, familyLimits } from "./util.js";
/** curl: drop progress-meter rows and "[N bytes data]" verbose lines; headers, body and errors stay. */
export const id = "curl";
export const priority = 60;
const PROGRAMS = new Set(["curl"]);
const NOISE = [
    /^\s*%\s+Total\b/,
    /^\s+Dload\s+Upload\b/,
    /^\s*\d{1,6}\s+[\d.]+[kMGTP]?\s+\d{1,6}\s+[\d.]+[kMGTP]?\s+\d/,
    /^\s*[{}<>]?\s*\[\d+ bytes data\]\s*$/,
];
export function match(ctx) { return PROGRAMS.has(String(ctx?.program ?? "").toLowerCase()); }
export function compress(text, ctx) {
    try {
        const { maxLines: MAX_LINES, maxChars: MAX_CHARS } = familyLimits(ctx);
        if (typeof text !== "string" || !text)
            return text;
        const rows = splitLines(text);
        let dropped = 0;
        let kept = [];
        for (const line of rows) {
            if (!isImportant(line) && NOISE.some((re) => re.test(line))) {
                dropped++;
                continue;
            }
            kept.push(line);
        }
        if (dropped < 3)
            return text;
        const out = `[${dropped} curl progress rows omitted]\n${kept.join("\n")}`;
        const outRows = out.split("\n");
        if (outRows.length > MAX_LINES || out.length > MAX_CHARS)
            return text;
        const have = new Set(outRows);
        for (const line of rows)
            if (isImportant(line) && !have.has(line))
                return text;
        return out;
    }
    catch {
        return text;
    }
}
