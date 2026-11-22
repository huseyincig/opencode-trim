import test from "node:test";
import assert from "node:assert/strict";
import * as eslint from "../src/families/eslint.ts";
import * as biome from "../src/families/biome.ts";
import * as go from "../src/families/go.ts";
import * as ruff from "../src/families/ruff.ts";
import * as prettier from "../src/families/prettier.ts";
import * as playwright from "../src/families/playwright.ts";
import * as docker from "../src/families/docker.ts";

const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join("\n");
const ctx = (program) => ({ command: program, tokens: [program], program, failed: true, exitCode: 1, head: "", options: {} });

const cases = [
  {
    mod: eslint, program: "eslint",
    noisy: [rep(40, (i) => `✔ src/clean${i}.js 3ms`), "/repo/src/a.js", "  12:5  error  'x' is defined but never used  no-unused-vars", "  14:1  warning  Unexpected console statement  no-console", "", "✖ 2 problems (1 error, 1 warning)"].join("\n"),
    keep: ["  12:5  error  'x' is defined but never used  no-unused-vars", "  14:1  warning  Unexpected console statement  no-console", "✖ 2 problems (1 error, 1 warning)"],
    nosummary: rep(30, (i) => `✔ src/clean${i}.js 3ms`),
  },
  {
    mod: biome, program: "biome",
    noisy: [rep(40, (i) => `Checking file ${i}`), "src/a.ts:3:5 lint/style/useConst ━━━━", "  ✖ This let is never reassigned.", "Checked 41 files in 12ms. No fixes applied.", "Found 1 error."].join("\n"),
    keep: ["src/a.ts:3:5 lint/style/useConst ━━━━", "  ✖ This let is never reassigned.", "Checked 41 files in 12ms. No fixes applied.", "Found 1 error."],
    nosummary: rep(30, (i) => `Checking file ${i}`),
  },
  {
    mod: go, program: "go",
    noisy: [rep(20, (i) => `go: downloading acme.org/m${i} v1.0.${i}`), rep(20, (i) => `ok  \tacme.org/p${i}\t0.0${i % 9}s`), "--- FAIL: TestX (0.00s)", "    x_test.go:12: expected 1 got 2", "coverage: 80.0% of statements", "FAIL\tacme.org/bad\t0.01s", "FAIL"].join("\n"),
    keep: ["--- FAIL: TestX (0.00s)", "    x_test.go:12: expected 1 got 2", "coverage: 80.0% of statements", "FAIL\tacme.org/bad\t0.01s"],
    nosummary: rep(30, (i) => `go: downloading acme.org/m${i} v1.0.${i}`),
  },
  {
    mod: ruff, program: "ruff",
    noisy: [rep(30, (i) => `Downloaded package-${i}`), "src/a.py:1:8: F401 `os` imported but unused", "src/b.py:9:1: E501 Line too long", "Found 2 errors."].join("\n"),
    keep: ["src/a.py:1:8: F401 `os` imported but unused", "src/b.py:9:1: E501 Line too long", "Found 2 errors."],
    nosummary: rep(30, (i) => `Downloaded package-${i}`),
  },
  {
    mod: prettier, program: "prettier",
    noisy: ["Checking formatting...", rep(40, (i) => `src/ok${i}.js 4ms (unchanged)`), "[warn] src/bad.js", "[warn] Code style issues found in the above file. Run Prettier with --write to fix."].join("\n"),
    keep: ["[warn] src/bad.js", "[warn] Code style issues found in the above file. Run Prettier with --write to fix."],
    nosummary: ["Checking formatting...", rep(30, (i) => `src/ok${i}.js 4ms (unchanged)`)].join("\n"),
  },
  {
    mod: playwright, program: "playwright",
    noisy: [rep(40, (i) => `  ✓  ${i + 1} [chromium] › tests/a.spec.ts:${i + 3}:1 › works ${i} (${i + 10}ms)`), "  ✘  41 [chromium] › tests/b.spec.ts:9:1 › breaks (1.2s)", "  Retry #1", "    Error: expect(received).toBe(expected)", "      at tests/b.spec.ts:12:5", "  attachment #1: screenshot (image/png)", "  1 failed", "  40 passed (5s)", "To open last HTML report run:", "npx playwright show-report"].join("\n"),
    keep: ["  ✘  41 [chromium] › tests/b.spec.ts:9:1 › breaks (1.2s)", "  Retry #1", "    Error: expect(received).toBe(expected)", "      at tests/b.spec.ts:12:5", "  attachment #1: screenshot (image/png)", "  1 failed", "  40 passed (5s)"],
    nosummary: rep(30, (i) => `  ✓  ${i + 1} [chromium] › tests/a.spec.ts:${i + 3}:1 › works ${i} (${i + 10}ms)`),
  },
  {
    mod: docker, program: "docker",
    noisy: [rep(15, (i) => `a1b2c3d4e5${String(i).padStart(2, "0")}: Downloading  12MB/30MB`), rep(15, (i) => `a1b2c3d4e5${String(i).padStart(2, "0")}: Pull complete`), "#7 [4/6] RUN npm ci", "error: failed to solve: process \"npm ci\" did not complete successfully: exit code: 1", "Digest: sha256:abc123", "Status: Downloaded newer image for node:20"].join("\n"),
    keep: ["#7 [4/6] RUN npm ci", "error: failed to solve: process \"npm ci\" did not complete successfully: exit code: 1", "Digest: sha256:abc123", "Status: Downloaded newer image for node:20"],
    nosummary: rep(30, (i) => `a1b2c3d4e5${String(i).padStart(2, "0")}: Pull complete`),
  },
];

for (const c of cases) {
  const { mod } = c;
  test(`${mod.id}: exports and match`, () => {
    assert.equal(typeof mod.id, "string");
    assert.equal(mod.priority, mod.id === "docker" ? 60 : 90);
    assert.equal(mod.match(ctx(c.program)), true);
    assert.equal(mod.match(ctx("unrelated")), false);
  });
  test(`${mod.id}: compresses noisy fixture and keeps diagnostics`, () => {
    const out = mod.compress(c.noisy, ctx(c.program));
    assert.ok(out.length < c.noisy.length * 0.85, `expected >15% saving, got ${out.length}/${c.noisy.length}`);
    assert.match(out, new RegExp(`\\[\\d+ ${mod.id} progress rows omitted\\]`));
    for (const line of c.keep) assert.ok(out.includes(line), `missing: ${line}`);
    assert.ok(out.split("\n").length <= 160 && out.length <= 16000);
  });
  test(`${mod.id}: no summary leaves text untouched`, () => {
    assert.equal(mod.compress(c.nosummary, ctx(c.program)), c.nosummary);
  });
  test(`${mod.id}: garbage and empty input do not throw`, () => {
    for (const input of ["", "\n\n", "\u0000\u0001 ✔ ??? #### ", "x".repeat(5000), undefined, null, 42]) {
      assert.doesNotThrow(() => mod.compress(input, ctx(c.program)));
    }
    assert.equal(mod.compress("", ctx(c.program)), "");
  });
  test(`${mod.id}: deterministic`, () => {
    assert.equal(mod.compress(c.noisy, ctx(c.program)), mod.compress(c.noisy, ctx(c.program)));
  });
}

test("go: all-passing run keeps ok package rows", () => {
  const text = rep(10, (i) => `ok  \tacme.org/p${i}\t0.01s`);
  assert.equal(go.compress(text, ctx("go")), text);
});

test("go: build errors without test summary are untouched", () => {
  const text = `${rep(10, (i) => `go: downloading m${i} v1.0.0`)}\n./main.go:5:2: undefined: foo`;
  assert.equal(go.compress(text, ctx("go")), text);
});

test("oversized output is bounded", () => {
  const text = `${rep(400, (i) => `  ${i}:1  error  problem number ${i}  no-undef`)}\n${rep(30, (i) => `✔ clean${i}.js 1ms`)}\n✖ 400 problems (400 errors, 0 warnings)`;
  const out = eslint.compress(text, ctx("eslint"));
  assert.equal(out, text);
});

const sentinel = (tag, i) => `sentinel-${tag}-${String(i).padStart(4, "0")} unique payload row`;
for (const c of cases) {
  test(`${c.mod.id}: ~1000 unique rows are preserved or output is raw`, () => {
    const rows = c.noisy.split("\n");
    const text = [rows[0], rep(1000, (i) => sentinel(c.mod.id, i)), ...rows.slice(1)].join("\n");
    const out = c.mod.compress(text, ctx(c.program));
    if (out === text) return;
    for (let i = 0; i < 1000; i++) assert.ok(out.includes(sentinel(c.mod.id, i)), `lost: ${sentinel(c.mod.id, i)}`);
  });
}
