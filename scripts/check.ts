// Cross-platform syntax check across TypeScript sources and compiled dist/ modules. Exits non-zero on first failure.
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root: string = join(dirname(fileURLToPath(import.meta.url)), "..");
const list = (dir: string, ext: string): string[] =>
  existsSync(join(root, dir))
    ? readdirSync(join(root, dir))
        .filter((f: string) => f.endsWith(ext))
        .sort()
        .map((f: string) => join(dir, f))
    : [];
const tsFiles: string[] = ["index.ts", ...list("src", ".ts"), ...list(join("src", "families"), ".ts")];
const distFiles: string[] = [...list("dist", ".js"), ...list(join("dist", "families"), ".js")];
const files: string[] = [...tsFiles, ...distFiles];

for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`syntax check failed: ${file}`);
    process.exit(r.status ?? 1);
  }
}
console.log(`syntax ok: ${files.length} files (${tsFiles.length} ts, ${distFiles.length} dist js)`);
process.exit(0);
