import { splitLines, isImportant, familyLimits } from "./util.js";
/** terraform: drop refresh/read/plugin chatter; plan diff, Plan:, Apply complete, errors and outputs stay. */
export const id = "terraform";
export const priority = 60;
const PROGRAMS = new Set(["terraform", "tofu", "terragrunt"]);
const NOISE = [
    /:\s*Refreshing state\.\.\./,
    /:\s*Reading\.\.\./,
    /:\s*Read complete after\b/,
    /:\s*Still (?:creating|modifying|destroying|reading)\.\.\./,
    /:\s*(?:Creating|Modifying|Destroying)\.\.\.\s*$/,
    /^\s*[-•]\s*(?:Finding|Installing|Installed|Reusing|Using|Downloading)\b/,
    /^\s*Initializing (?:the backend|provider plugins|modules)\.\.\./,
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
        const out = `[${dropped} terraform progress rows omitted]\n${kept.join("\n")}`;
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
