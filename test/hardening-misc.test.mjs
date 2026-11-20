import test from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "../src/compress.js";
import { compressPassingTests } from "../src/runners.js";
import { isProtectedCommand } from "../src/filters.js";
import { PROTECTED_GIT } from "../src/git.js";
import { protectedShell, pruneContext, PRUNED } from "../src/prune.js";
import { estimateRequest } from "../src/pressure.js";
import { parseOptions } from "../src/config.js";

test("stripAnsi normalizes CRLF and lone CR", () => {
  assert.equal(stripAnsi("a\r\nb\rc\n"), "a\nb\nc\n");
  assert.equal(stripAnsi("a\r\n\r\nb"), "a\n\nb");
});

test("passing row with file:line is dropped; non-pass anchor, failure and summary kept", () => {
  const text = [
    "✓ src/a.test.js:12 works",
    "✓ plain ok",
    "src/c.js:7 something to look at",
    "✕ src/b.test.js:3 broken",
    "Tests: 2 passed, 1 failed",
  ].join("\n");
  const r = compressPassingTests("npm test", text);
  assert.equal(r.dropped, 2);
  assert.ok(!r.text.includes("src/a.test.js:12"));
  assert.ok(r.text.includes("src/c.js:7 something to look at"));
  assert.ok(r.text.includes("✕ src/b.test.js:3 broken"));
  assert.ok(r.text.includes("Tests: 2 passed"));
});

test("compressPassingTests leaves a non-test command (cat of a file) unchanged", () => {
  const text = "✓ src/a.test.js:12 works\nTests: 1 passed";
  const r = compressPassingTests("cat report.txt", text);
  assert.equal(r.text, text);
  assert.equal(r.dropped, 0);
});

test("modern ssh key names are protected in filters and prune", () => {
  for (const k of ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "id_ed25519_sk"]) {
    assert.ok(isProtectedCommand(`cat ~/.ssh/${k}`), `filters ${k}`);
    assert.ok(protectedShell(`cat ~/.ssh/${k}`), `prune ${k}`);
  }
  assert.ok(!protectedShell("cat ~/.ssh/id_ed25519.pub"), "public key not covered by this rule");
});

test("git show-branch is protected", () => {
  assert.ok(PROTECTED_GIT.has("show-branch"));
});

test("string message content is counted by estimateRequest", () => {
  const opts = { outputReserveTokens: 0 };
  const big = "x".repeat(30000);
  const s = estimateRequest({ messages: [{ content: big }] }, new Map(), opts).estimatedTokens;
  const a = estimateRequest({ messages: [{ content: [{ type: "text", text: big }] }] }, new Map(), opts).estimatedTokens;
  assert.ok(s >= 10000, `string counted: ${s}`);
  assert.ok(a >= 10000);
  assert.doesNotThrow(() => estimateRequest({ messages: [{ content: 5 }, {}] }, new Map(), opts));
});

const popts = parseOptions({ protectRecentMessages: 4, keepRecentToolResults: 1, pruneAfterToolChars: 10000, pruneMinResultChars: 100 });
function ctx(n, size, first) {
  const messages = [];
  for (let i = 0; i < n; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool-call", id: `c${i}`, name: "shell", input: { command: "echo hello" } }] });
    messages.push({ role: "tool", content: [{ type: "tool-result", id: `c${i}`, name: "shell", result: { type: "text", value: i === 0 ? first : `ok ${i}: ` + "x".repeat(size) } }] });
  }
  return { messages };
}
const pad = "\n" + "x".repeat(1200);

test("pruneContext keeps line-start × and ✕ diagnostics, prunes ×10 zoom", () => {
  for (const line of ["× test failed-ish", "✕ test"]) {
    const event = ctx(20, 1100, line + pad);
    pruneContext(event, popts);
    assert.notEqual(event.messages[1].content[0].result.value, PRUNED, line);
  }
  const event = ctx(20, 1100, "×10 zoom" + pad);
  pruneContext(event, popts);
  assert.equal(event.messages[1].content[0].result.value, PRUNED);
});

test("pruneContext counts string content without throwing", () => {
  const event = ctx(20, 1100, "ok" + pad);
  event.messages.push({ role: "user", content: "y".repeat(50000) });
  assert.doesNotThrow(() => pruneContext(event, popts));
});
