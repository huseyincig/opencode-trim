import { splitLines, isImportant, hasTestSummary, familyLimits } from "./util.js";
/** go: drop download chatter and passing package rows once a test summary exists; keep coverage and build errors. */
export const id = "go";
export const priority = 90;
const SUMMARY_ROW = /^(?:ok|FAIL|PASS)\b|^---\s+FAIL\b/m;
const PASS_ROW = /^\s*--- PASS\b/;
const CHATTER = [PASS_ROW, /^go: (?:downloading|finding|extracting)\b/, /^\s*=== (?:RUN|PAUSE|CONT|NAME)\b/, /^\?\s+\S+\s+\[no test files\]\s*$/];
const PASSING_PKG = /^ok\s+\S+\s+(?:[\d.]+s|\(cached\))(?:\s+\(cached\))?\s*$/;
export function match(ctx) { return ctx.program === "go"; }
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
    if (typeof text !== "string" || (!SUMMARY_ROW.test(text) && !hasTestSummary(text)))
        return text;
    const rows = splitLines(text);
    const hasFail = rows.some((l) => /^(?:FAIL\b|--- FAIL)/.test(l));
    const kept = [];
    let dropped = 0;
    for (const line of rows) {
        if (!isImportant(line) && !/coverage:/.test(line) && (CHATTER.some((re) => re.test(line)) || (hasFail && PASSING_PKG.test(line)))) {
            dropped++;
            continue;
        }
        kept.push(line);
    }
    return finish(text, kept, dropped, "go", ctx);
}
