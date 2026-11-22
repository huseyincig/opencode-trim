import test from "node:test";
import assert from "node:assert/strict";
import { parseOptions } from "../src/config.ts";
import { ContextCache } from "../src/cache.ts";
import { resolveModelLimit } from "../src/pressure.ts";
import { clean, familyLimits } from "../src/families/util.ts";
import * as eslint from "../src/families/eslint.ts";
import * as gradle from "../src/families/gradle.ts";

const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const lines = (s) => s.split("\n").length;

test("familyLimits defaults and sanitizes configured caps", () => {
  assert.deepEqual(familyLimits(), { maxLines: 160, maxChars: 16000 });
  assert.deepEqual(familyLimits({ options: { maxOutputLines: 400, maxOutputChars: 50000 } }), { maxLines: 400, maxChars: 50000 });
  assert.deepEqual(familyLimits({ options: { maxOutputLines: -1, maxOutputChars: NaN } }), { maxLines: 160, maxChars: 16000 });
});

test("finish-style family (eslint) honors raised and lowered caps", () => {
  const problems = rows(200, (i) => `src/f${i}.js:1:1  error  bad thing ${i}`);
  const noise = rows(10, (i) => `✓ src/ok${i}.js`);
  const text = [...noise, ...problems, "210 problems (200 errors, 0 warnings)"].join("\n");
  assert.equal(eslint.compress(text), text, "default cap: kept rows exceed 160");
  const raised = eslint.compress(text, { options: { maxOutputLines: 400, maxOutputChars: 50000 } });
  assert.notEqual(raised, text);
  assert.ok(lines(raised) <= 400 && raised.length <= 50000);

  const small = [...noise, ...problems.slice(0, 30), "40 problems (30 errors, 0 warnings)"].join("\n");
  assert.notEqual(eslint.compress(small), small);
  assert.equal(eslint.compress(small, { options: { maxOutputLines: 20, maxOutputChars: 16000 } }), small);
  assert.equal(eslint.compress(small, { options: { maxOutputLines: 400, maxOutputChars: 500 } }), small);
});

test("MAX_*-style family (gradle) honors raised and lowered caps", () => {
  const noise = rows(30, (i) => `> Task :m${i}:compileJava UP-TO-DATE`);
  const keep = rows(180, (i) => `> Task :m${i}:custom ran ${i}`);
  const text = [...noise, ...keep, "BUILD SUCCESSFUL in 2s"].join("\n");
  assert.equal(gradle.compress(text), text);
  const raised = gradle.compress(text, { options: { maxOutputLines: 400, maxOutputChars: 50000 } });
  assert.notEqual(raised, text);
  assert.ok(lines(raised) <= 400);
  const small = [...noise, ...keep.slice(0, 15), "BUILD SUCCESSFUL in 2s"].join("\n");
  assert.notEqual(gradle.compress(small), small);
  assert.equal(gradle.compress(small, { options: { maxOutputLines: 10, maxOutputChars: 16000 } }), small);
});

test("clean normalizes CRLF and lone CR", () => {
  assert.equal(clean("a\r\nb\rc\nd"), "a\nb\nc\nd");
});

const opts = parseOptions({ pruneAfterToolChars: 10000 });
function arcs(n, size = 1100) {
  const messages = [];
  for (let i = 0; i < n; i++) {
    messages.push({ id: `a-${i}`, role: "assistant", content: [{ type: "tool-call", id: `c-${i}`, name: "shell", input: { command: "x" } }] });
    messages.push({ id: `r-${i}`, role: "tool", content: [{ type: "tool-result", id: `c-${i}`, name: "shell", result: { type: "text", value: `r${i}\n${"x".repeat(size)}` } }] });
  }
  return { sessionID: "s-size", model: { providerID: "p", id: "m" }, tools: {}, system: [], messages };
}

test("sizeMark resets after shrink so later growth can re-admit", () => {
  const cache = new ContextCache();
  assert.equal(cache.begin(arcs(20), opts, {}).allowNewDrops, true, "first over-budget admission");
  assert.equal(cache.begin(arcs(12), opts, {}).allowNewDrops, false, "shrunk but still over budget");
  assert.equal(cache.begin(arcs(15), opts, {}).allowNewDrops, true, "quarter-budget growth over lowered baseline");
});

test("model source is config when catalog lacks context/input", () => {
  const event = { model: { providerID: "p", id: "m" } };
  const r = resolveModelLimit(event, new Map([["p/m", { output: 4000 }]]), { contextWindow: 12000 });
  assert.equal(r.context, 12000);
  assert.equal(r.source, "config");
  assert.equal(r.output, 4000);
  const withCtx = resolveModelLimit(event, new Map([["p/m", { context: 32000 }]]), { contextWindow: 12000 });
  assert.equal(withCtx.source, "model-catalog");
  assert.equal(withCtx.context, 32000);
});

test("filterRules program is case-insensitive and lowercased", () => {
  const o = parseOptions({ filterRules: [{ program: "NPM", dropPrefixes: ["x!"] }, { program: "Git" }] });
  assert.deepEqual(o.filterRules.map((r) => r.program), ["npm", "git"]);
  assert.throws(() => parseOptions({ filterRules: [{ program: "bad prog" }] }), TypeError);
});

test("filterRules single-character entries are still rejected", () => {
  assert.throws(() => parseOptions({ filterRules: [{ program: "npm", dropPrefixes: ["x"] }] }), TypeError);
  assert.throws(() => parseOptions({ filterRules: [{ program: "npm", dropExact: ["y"] }] }), TypeError);
});

test("pruneEligibleTools accepts camelCase and normalizes to lowercase", () => {
  const o = parseOptions({ pruneEligibleTools: ["executeCommand", "EXECUTECOMMAND", "Read"] });
  assert.deepEqual([...o.pruneEligibleTools], ["executecommand", "read"]);
  assert.throws(() => parseOptions({ pruneEligibleTools: ["bad name"] }), TypeError);
});

test("npm install with 220 lines and 40 noise rows is compressed", async () => {
  const { compressOutput } = await import("../src/compress.ts");
  const install = rows(220, (i) => `added package-${i}@1.0.${i} node_modules/package-${i}`);
  const noise = rows(40, (i) => `npm http fetch GET 200 https://registry.npmjs.org/pkg-${i} ${i}ms`);
  const text = [...noise.slice(0, 20), ...install, ...noise.slice(20), "added 220 packages in 9s"].join("\n");
  const r = compressOutput({ command: "npm install", text, exitCode: 0, options: parseOptions() });
  console.log(`npm-install changed=${r.changed} reason=${r.reason} in=${text.length} out=${r.text.length}`);
  assert.equal(r.changed, true);
  assert.ok(r.reason && r.reason !== "raw");
  assert.ok(r.text.length < text.length / 2);
});
