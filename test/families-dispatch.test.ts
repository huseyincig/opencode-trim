import test from "node:test";
import assert from "node:assert/strict";
import { compressOutput } from "../src/compress.ts";
import { parseOptions } from "../src/config.ts";

const options = parseOptions({ minOutputChars: 200, maxOutputLines: 160, maxOutputChars: 16000, minSavingsRatio: 0.15 });
const repeat = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const SENTINEL = "ERROR: sentinel-diagnostic-must-survive";

const cases = [
  { name: "git", command: "git clone https://example.com/x.git", noise: (i) => `Receiving objects: ${i}% (${i}/200), 1.00 MiB`, tail: "Cloning into 'x'..." },
  { name: "npm", command: "npm install", noise: (i) => `npm notice package-${i} installed`, tail: "added 200 packages in 2s" },
  { name: "pnpm", command: "pnpm install", noise: (i) => `Progress: resolved ${i}, reused 0, downloaded ${i}, added 0`, tail: "Done in 2s" },
  { name: "bun", command: "bun install", noise: (i) => `Resolved, downloaded and extracted [${i}/200]`, tail: "installed 200 packages" },
  { name: "cargo", command: "cargo build", noise: (i) => `   Compiling crate-${i} v0.1.0`, tail: "    Finished dev [unoptimized] target(s)" },
  { name: "pytest", command: "pytest -q", noise: (i) => ".".repeat(60), tail: "= 200 passed in 2.00s =" },
  { name: "vitest", command: "vitest run", noise: (i) => ` ✓ src/test_${i}.test.ts (1 test)`, tail: "Test Files 200 passed (200)" },
  { name: "jest", command: "jest", noise: (i) => `PASS src/test_${i}.test.js`, tail: "Tests: 200 passed, 200 total" },
  { name: "tsc", command: "tsc -w", noise: () => "Starting compilation in watch mode...", tail: "Found 0 errors." },
  { name: "eslint", command: "eslint .", noise: (i) => `✓ src/file_${i}.js`, tail: "200 problems (200 errors, 0 warnings)" },
  { name: "biome", command: "biome check .", noise: (i) => `Checking src/file_${i}.js`, tail: "Checked 200 files in 2s" },
  { name: "go", command: "go test ./...", noise: (i) => `go: downloading example.org/pkg-${i} v1.0.0`, tail: "FAIL example.org/pkg\n--- FAIL: TestX" },
  { name: "ruff", command: "ruff check .", noise: (i) => `Resolved ${i} packages`, tail: "Found 200 errors." },
  { name: "prettier", command: "prettier --check .", noise: () => "Checking formatting...", tail: "Code style issues found in 200 files." },
  { name: "playwright", command: "playwright test", noise: (i) => `  ✓  1 tests/spec_${i}.ts:1:1 › works (10ms)`, tail: "  200 passed (2.0s)" },
  { name: "docker", command: "docker pull example/image", noise: (i) => `a1b2c3d4e5f${(i % 10)}: Pulling fs layer ${i}`, tail: "Digest: sha256:deadbeef" },
  { name: "kubectl", command: "kubectl apply -f x.yaml", noise: (i) => `Waiting for deployment/example-${i} rollout`, tail: "deployment.apps/x created" },
  { name: "terraform", command: "terraform plan", noise: (i) => `example_${i}: Refreshing state...`, tail: "Plan: 1 to add, 0 to change, 0 to destroy." },
  { name: "gradle", command: "gradle build", noise: (i) => `> Task :module-${i}:compileJava UP-TO-DATE`, tail: "BUILD SUCCESSFUL in 2s" },
  { name: "make", command: "make all", noise: (i) => `make[1]: Entering directory '/tmp/mod-${i}'`, tail: "nothing to build" },
  { name: "pip", command: "pip install -r requirements.txt", noise: (i) => `Collecting package-${i}`, tail: "Successfully installed package" },
  { name: "uv", command: "uv sync", noise: (i) => `Resolved ${i} packages`, tail: "Installed 200 packages in 2s" },
  { name: "curl", command: "curl -v https://example.com", noise: (i) => `  ${i}  100    ${i}    0     0   ${i}      0 --:--:-- --:--:-- --:--:-- ${i}`, tail: "HTTP/1.1 200 OK" },
  { name: "wget", command: "wget https://example.com/file", noise: (i) => `${i}K .......... ${i}% 1.00M=0.1s`, tail: "2024-01-01 00:00:00 (1.0 MB/s) - 'file' saved [1234/1234]" },
];

for (const item of cases) {
  test(`${item.name}: end-to-end dispatch compresses noise and keeps the diagnostic`, () => {
    const text = [SENTINEL, ...repeat(200, item.noise), item.tail].join("\n");
    const first = compressOutput({ command: item.command, text, exitCode: 0, options });
    assert.equal(first.changed, true, `${item.name} did not compress: ${first.reason}`);
    assert.ok(first.text.length < text.length);
    assert.ok(first.text.includes(SENTINEL), `${item.name} lost the diagnostic`);
    assert.ok(first.text.includes(item.tail.split("\n")[0]), `${item.name} lost its result line`);
    assert.ok(first.text.split("\n").length <= 160);
    assert.ok(first.text.length <= 16000);
    const second = compressOutput({ command: item.command, text, exitCode: 0, options });
    assert.equal(second.text, first.text, `${item.name} is not deterministic`);
  });
}

test("structured, binary and protected commands bypass every family", () => {
  const json = `{"value":"${"x".repeat(4000)}"}`;
  assert.equal(compressOutput({ command: "git status", text: json, options }).changed, false);
  const binary = "ok\u0000" + "x".repeat(4000);
  assert.equal(compressOutput({ command: "npm install", text: binary, options }).changed, false);
  const diff = "diff --git a/x b/x\n" + "+line\n".repeat(2000);
  assert.equal(compressOutput({ command: "git diff", text: diff, options }).changed, false);
});

test("a family candidate that would drop a warning is rejected", () => {
  const text = [
    ...repeat(1000, (i) => `✔ src/clean_${i}.js 3ms`),
    ...repeat(160, (i) => `row-${i}`),
    "warning: keep-me",
    "✖ 1 problem (0 errors, 1 warning)",
  ].join("\n");
  const result = compressOutput({ command: "eslint .", text, exitCode: 1, options });
  assert.ok(result.text.includes("warning: keep-me"), `warning lost: ${result.reason}`);
  assert.ok(result.text.includes("✖ 1 problem"), "summary lost");
});

test("family output never exceeds the configured caps", () => {
  for (const item of cases) {
    const text = [SENTINEL, ...repeat(2000, item.noise), item.tail].join("\n");
    const result = compressOutput({ command: item.command, text, exitCode: 0, options });
    // Unique rows are never truncated: either the family output fits the caps or the raw text is returned.
    if (result.text === text) continue;
    assert.ok(result.text.length <= 16000, `${item.name} exceeded char cap`);
    assert.ok(result.text.split("\n").length <= 160, `${item.name} exceeded line cap`);
  }
});
