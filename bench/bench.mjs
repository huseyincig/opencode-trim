import { compressOutput } from "../src/compress.js";
import { parseOptions } from "../src/config.js";
import { pruneContext, PRUNED } from "../src/prune.js";
import { estimateRequest } from "../src/pressure.js";

const options = parseOptions({ minOutputChars: 200, maxOutputLines: 160, maxOutputChars: 16000 });
const rep = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const cases = [
  ["git", "git clone https://example.com/x.git", (i) => `Receiving objects: ${i}% (${i}/200), 1.00 MiB`, "Cloning into 'x'..."],
  ["npm", "npm install", (i) => `npm notice package-${i} installed`, "added 200 packages in 2s"],
  ["pnpm", "pnpm install", (i) => `Progress: resolved ${i}, reused 0, downloaded ${i}`, "Done in 2s"],
  ["bun", "bun install", (i) => `Resolved, downloaded and extracted [${i}/200]`, "installed 200 packages"],
  ["cargo", "cargo build", (i) => `   Compiling crate-${i} v0.1.0`, "    Finished dev [unoptimized] target(s)"],
  ["pytest", "pytest -q", () => ".".repeat(60), "= 200 passed in 2.00s ="],
  ["vitest", "vitest run", (i) => ` ✓ src/test_${i}.test.ts (1 test)`, "Test Files 200 passed (200)"],
  ["jest", "jest", (i) => `PASS src/test_${i}.test.js`, "Tests: 200 passed, 200 total"],
  ["tsc", "tsc -w", () => "Starting compilation in watch mode...", "Found 0 errors."],
  ["eslint", "eslint .", (i) => `✓ src/file_${i}.js`, "200 problems (200 errors, 0 warnings)"],
  ["biome", "biome check .", (i) => `Checking src/file_${i}.js`, "Checked 200 files in 2s"],
  ["go", "go test ./...", (i) => `go: downloading example.org/pkg-${i} v1.0.0`, "FAIL example.org/pkg\n--- FAIL: TestX"],
  ["ruff", "ruff check .", (i) => `Resolved ${i} packages`, "Found 200 errors."],
  ["prettier", "prettier --check .", () => "Checking formatting...", "Code style issues found in 200 files."],
  ["playwright", "playwright test", (i) => `  ✓  1 tests/spec_${i}.ts:1:1 › works (10ms)`, "  200 passed (2.0s)"],
  ["docker", "docker pull example/image", (i) => `a1b2c3d4e5f${i % 10}: Pulling fs layer ${i}`, "Digest: sha256:deadbeef"],
  ["kubectl", "kubectl apply -f x.yaml", (i) => `Waiting for deployment/example-${i} rollout`, "deployment.apps/x created"],
  ["terraform", "terraform plan", (i) => `example_${i}: Refreshing state...`, "Plan: 1 to add, 0 to change, 0 to destroy."],
  ["gradle", "gradle build", (i) => `> Task :module-${i}:compileJava UP-TO-DATE`, "BUILD SUCCESSFUL in 2s"],
  ["make", "make all", (i) => `make[1]: Entering directory '/tmp/mod-${i}'`, "nothing to build"],
  ["pip", "pip install -r requirements.txt", (i) => `Collecting package-${i}`, "Successfully installed package"],
  ["uv", "uv sync", (i) => `Resolved ${i} packages`, "Installed 200 packages in 2s"],
  ["curl", "curl -v https://example.com", (i) => `  ${i}  100    ${i}    0     0   ${i}      0 --:--:-- --:--:-- --:--:-- ${i}`, "HTTP/1.1 200 OK"],
  ["wget", "wget https://example.com/file", (i) => `${i}K .......... ${i}% 1.00M=0.1s`, "2024-01-01 (1.0 MB/s) - 'file' saved [1234/1234]"],
];
const fixtures = cases.map(([name, command, noise, tail]) => ({
  name, command,
  text: ["ERROR: sentinel-diagnostic-must-survive", ...rep(2000, noise), tail].join("\n"),
}));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function measure(fn, rounds = 15) {
  for (let i = 0; i < 3; i++) fn();
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const start = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { medianMs: median(times), maxMs: Math.max(...times) };
}

const rows = [];
for (const fixture of fixtures) {
  const result = compressOutput({ command: fixture.command, text: fixture.text, exitCode: 0, options });
  const timing = measure(() => compressOutput({ command: fixture.command, text: fixture.text, exitCode: 0, options }));
  rows.push({
    family: fixture.name,
    inputBytes: Buffer.byteLength(fixture.text),
    outputBytes: Buffer.byteLength(result.text),
    ratio: result.text.length / fixture.text.length,
    changed: result.changed,
    medianMs: timing.medianMs,
  });
}

const arcs = 400, size = 2000;
const messages = [];
for (let i = 0; i < arcs; i++) {
  messages.push({ id: `a-${i}`, role: "assistant", content: [{ type: "tool-call", id: `c-${i}`, name: "shell", input: { command: "npm test" } }] });
  messages.push({ id: `r-${i}`, role: "tool", content: [{ type: "tool-result", id: `c-${i}`, name: "shell", result: { type: "text", value: `result ${i}\n${"x".repeat(size)}` } }] });
}
const event = { sessionID: "bench", model: { providerID: "bench", id: "model", limit: { context: 200000, output: 8192 } }, tools: {}, system: [], messages };
const originals = messages.map((m) => (m.role === "tool" ? m.content[0].result.value : null));
const pressure = estimateRequest(event, new Map(), options);
const heapBefore = process.memoryUsage().heapUsed;
const restore = () => {
  for (let i = 0; i < messages.length; i++) {
    if (originals[i] !== null) messages[i].content[0].result.value = originals[i];
  }
};
const pruneTiming = measure(() => {
  restore();
  pruneContext(event, options, { allowNewDrops: true, plannedDrops: new Set() });
}, 10);
restore();
const pruned = pruneContext(event, options, { allowNewDrops: true, plannedDrops: new Set() });
const heapAfter = process.memoryUsage().heapUsed;

const summary = {
  compression: {
    families: rows.length,
    totalInputBytes: rows.reduce((n, r) => n + r.inputBytes, 0),
    totalOutputBytes: rows.reduce((n, r) => n + r.outputBytes, 0),
    allChanged: rows.every((r) => r.changed),
    worstMedianMs: Math.max(...rows.map((r) => r.medianMs)),
  },
  pruning: {
    messages: messages.length,
    estimatedTokens: pressure.estimatedTokens,
    usableTokens: pressure.usableTokens,
    ratio: pressure.ratio,
    prunedResults: pruned.pruned,
    removedChars: pruned.removedChars,
    estimatedRemovedTokens: Math.ceil(pruned.removedChars / 3),
    heapDeltaBytes: heapAfter - heapBefore,
    pruneMedianMs: pruneTiming.medianMs,
  },
  rows,
};
console.log(JSON.stringify(summary, null, 2));
console.log("\n| family | input B | output B | ratio | median ms |");
console.log("| --- | ---: | ---: | ---: | ---: |");
for (const r of rows) console.log(`| ${r.family} | ${r.inputBytes} | ${r.outputBytes} | ${(r.ratio * 100).toFixed(1)}% | ${r.medianMs.toFixed(3)} |`);
