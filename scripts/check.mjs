// Cross-platform syntax check (replaces a Bash-only loop). Exits non-zero on the first failure.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const list = (dir) => readdirSync(join(root, dir)).filter((f) => f.endsWith(".js")).sort().map((f) => join(dir, f));
const files = ["index.js", ...list("src"), ...list(join("src", "families"))];

for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`syntax check failed: ${file}`);
    process.exit(r.status ?? 1);
  }
}
console.log(`syntax ok: ${files.length} files`);
process.exit(0);
