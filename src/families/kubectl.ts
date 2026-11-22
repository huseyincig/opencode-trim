import { splitLines, isImportant, familyLimits } from "./util.ts";
/** kubectl: drop wait/spinner rows only; apply/delete outcomes, events and "No resources found" stay. */
export const id: string = "kubectl";
export const priority: number = 60;
const PROGRAMS = new Set(["kubectl", "oc", "minikube", "k3s"]);
const NOISE = [
  /^\s*Waiting for\b/i,
  /^\s*\.{2,}\s*$/,
  /^\s*[-\\|/]\s*$/,
  /^\s*(?:Still waiting)\b.*\.\.\.\s*$/i,
];
export function match(ctx: any): boolean { return PROGRAMS.has(String(ctx?.program ?? "").toLowerCase()); }
export function compress(text: string, ctx?: any): string {
  try {
    const { maxLines: MAX_LINES, maxChars: MAX_CHARS } = familyLimits(ctx);
    if (typeof text !== "string" || !text) return text;
    const rows = splitLines(text);
    let dropped = 0;
    let kept = [];
    for (const line of rows) {
      if (!isImportant(line) && NOISE.some((re) => re.test(line))) { dropped++; continue; }
      kept.push(line);
    }
    if (dropped < 3) return text;
    const out = `[${dropped} kubectl progress rows omitted]\n${kept.join("\n")}`;
    const outRows = out.split("\n");
    if (outRows.length > MAX_LINES || out.length > MAX_CHARS) return text;
    const have = new Set(outRows);
    for (const line of rows) if (isImportant(line) && !have.has(line)) return text;
    return out;
  } catch { return text; }
}
