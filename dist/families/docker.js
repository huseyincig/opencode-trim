import { splitLines, isImportant, familyLimits } from "./util.js";
/** docker: strip pull/build layer progress; keep errors, failing steps, image ids/digests and final status. */
export const id = "docker";
export const priority = 60;
const SUMMARY_ROW = /Digest:\s*sha256:|^Status:|Successfully (?:built|tagged)|naming to |writing image|exporting to image/im;
const NOISE = [
    /^[0-9a-f]{12}: (?:Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)\b/,
    /^#\d+\s+sha256:[0-9a-f]+\s/,
    /^#\d+\s+(?:transferring|sending)\b/,
    /^#\d+\s+CACHED\s*$/,
    /^\s*--->\s+(?:Running in|Using cache)\b/,
    /^Removing intermediate container\b/,
    /^\s*[\[=>\s.-]{6,}\]?\s+[\d.]+\s*[kMG]?B\/[\d.]+\s*[kMG]?B\s*$/,
];
export function match(ctx) { return ctx.program === "docker" || ctx.program === "docker-compose" || ctx.program === "podman"; }
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
    return finish(text, kept, dropped, "docker", ctx);
}
