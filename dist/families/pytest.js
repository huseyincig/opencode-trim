import { splitLines, isImportant, hasTestSummary } from "./util.js";
/** pytest: fold dot-progress and PASSED rows only when a completed summary exists. */
export const id = "pytest";
export const priority = 100;
const SHAPE = /(?:=+\s*test session starts\s*=+|short test summary info|collected \d+ items?)/i;
const PROGRESS = /^\s*[.sx]+(?:\s*\[\s*\d+%\])?\s*$/;
const PASSED = /^\s*PASSED\s+\S/i;
export function match(ctx) {
    return ctx.program === "pytest" || SHAPE.test(ctx.head);
}
export function compress(text) {
    if (!hasTestSummary(text))
        return text;
    const rows = splitLines(text);
    const kept = [];
    let dropped = 0;
    for (const line of rows) {
        if (!isImportant(line) && (PROGRESS.test(line) || PASSED.test(line))) {
            dropped++;
            continue;
        }
        kept.push(line);
    }
    if (!dropped)
        return text;
    return `[${dropped} passing pytest rows omitted]\n${kept.join("\n")}`;
}
