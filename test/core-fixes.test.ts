import test from "node:test";
import assert from "node:assert/strict";
import { parseOptions } from "../src/config.ts";
import { ContextCache } from "../src/cache.ts";
import { pruneContext, PRUNED } from "../src/prune.ts";
import { processToolEvent } from "../src/plugin.ts";

const opts = parseOptions({ pruneAfterToolChars: 10000, protectRecentMessages: 4, keepRecentToolResults: 1, pruneMinResultChars: 100 });
function arcs(n, size = 1100, name = "shell", input = { command: "npm test" }) {
  const messages = [];
  for (let i = 0; i < n; i++) {
    messages.push({ id: `a-${i}`, role: "assistant", content: [{ type: "tool-call", id: `c-${i}`, name, input }] });
    messages.push({ id: `r-${i}`, role: "tool", content: [{ type: "tool-result", id: `c-${i}`, name, result: { type: "text", value: `result ${i}\n${"x".repeat(size)}` } }] });
  }
  return { sessionID: "s1", model: { providerID: "p", id: "m" }, tools: {}, system: [], messages };
}
const valueOf = (event, i) => event.messages.find((m) => m.id === `r-${i}`).content[0].result.value;

test("committed drops survive a provider-identity change", () => {
  const cache = new ContextCache();
  const event = arcs(1);
  const first = cache.begin(event, opts, { ratio: 0.7 });
  assert.equal(first.allowNewDrops, true);
  first.finish(["committed-key"]);
  const changed = structuredClone(event);
  changed.model.id = "other-model";
  const next = cache.begin(changed, opts, { ratio: 0.7 });
  assert.equal(next.allowNewDrops, true, "identity change is a natural bust");
  assert.equal(next.plannedDrops.has("committed-key"), true, "planned drops must replay");
});

test("planned drops replay after a message is inserted before them", () => {
  const event = arcs(20);
  const gate = { allowNewDrops: true, plannedDrops: new Set() };
  const first = pruneContext(event, opts, gate);
  assert.ok(first.pruned > 0);
  assert.equal(valueOf(event, 0), PRUNED);

  const shifted = structuredClone(arcs(20));
  shifted.messages.unshift({ id: "new-user", role: "user", content: [{ type: "text", text: "new instruction" }] });
  const replay = pruneContext(shifted, opts, { allowNewDrops: false, plannedDrops: new Set(first.plannedIds) });
  assert.ok(replay.pruned > 0, "stable keys must survive index shifts");
  assert.equal(valueOf(shifted, 0), PRUNED);
});

test("a later read supersedes an earlier slice only when it covers the range", () => {
  const event = arcs(3, 5000);
  const set = (i, offset, limit) => {
    event.messages[2 * i].content[0].name = "read";
    event.messages[2 * i].content[0].input = { filePath: "src/x.ts", offset, limit };
    event.messages[2 * i + 1].content[0].name = "read";
  };
  set(0, 0, 50); set(1, 0, 100); set(2, 200, 10);
  const wide = parseOptions({ ...opts, supersessionMinChars: 100, pruneAfterToolChars: 200000, protectRecentMessages: 4, protectRecentTokens: 1024 });
  const result = pruneContext(event, wide);
  assert.equal(valueOf(event, 0), PRUNED, "covered earlier slice is redundant");
  assert.notEqual(valueOf(event, 1), PRUNED, "a wider read is not redundant");
  assert.notEqual(valueOf(event, 2), PRUNED, "an unrelated slice stays");

  const narrow = arcs(2, 5000);
  const setNarrow = (i, offset, limit) => {
    narrow.messages[2 * i].content[0].name = "read";
    narrow.messages[2 * i].content[0].input = { filePath: "src/x.ts", offset, limit };
    narrow.messages[2 * i + 1].content[0].name = "read";
  };
  setNarrow(0, 0, 100); setNarrow(1, 50, 10);
  const none = pruneContext(narrow, wide);
  assert.equal(none.pruned, 0, "a narrower later read must not supersede");
});

test("multi-part shell result compresses output, keeps the exit notice and mirrors structured output", () => {
  const output = ["ERROR: boom", ...Array.from({ length: 200 }, (_, i) => ` ✓ src/t_${i}.test.ts (1 test)`), "Test Files 200 passed (200)"].join("\n");
  const event = {
    tool: "shell", status: "completed", sessionID: "s", agent: "main", id: "c1", input: { command: "vitest run" },
    result: {
      output: { output, exitCode: 1 },
      content: [{ type: "text", text: output }, { type: "text", text: "Exit code: 1" }],
      metadata: { status: "completed", exit: 1 },
    },
  };
  const before = event.result.content[1].text;
  assert.equal(processToolEvent(event, parseOptions()), true);
  assert.ok(event.result.content[0].text.length < output.length);
  assert.equal(event.result.content[1].text, before, "notice must stay byte-identical");
  assert.equal(event.result.output.output, event.result.content[0].text, "structured output must mirror model text");
  assert.equal(event.result.output.exitCode, 1);
  assert.match(event.result.content[0].text, /ERROR: boom/);
});

test("mixed text/media results and non-matching structured output are untouched", () => {
  const media = {
    tool: "shell", status: "completed", input: { command: "npm test" },
    result: { content: [{ type: "text", text: "ok\n".repeat(1000) }, { type: "file", uri: "file://x", mime: "image/png" }] },
  };
  assert.equal(processToolEvent(media, parseOptions()), false);

  const text = "progress\n".repeat(500);
  const mismatched = {
    tool: "shell", status: "completed", input: { command: "git status" },
    result: { output: { output: "different raw structured text" }, content: [{ type: "text", text }] },
  };
  const changed = processToolEvent(mismatched, parseOptions());
  assert.equal(typeof changed, "boolean");
  assert.equal(mismatched.result.output.output, "different raw structured text");
});

test("cache keeps sessions isolated", () => {
  const cache = new ContextCache();
  const a = arcs(1); a.sessionID = "a";
  const b = arcs(1); b.sessionID = "b";
  const gate = cache.begin(a, opts, { ratio: 0.7 }); gate.finish(["only-a"]);
  const other = cache.begin(b, opts, { ratio: 0.7 });
  assert.equal(other.plannedDrops.has("only-a"), false);
});

test("explicit contextWindow is a last-resort pressure fallback", async () => {
  const { resolveModelLimit } = await import("../src/pressure.ts");
  const event = { model: { providerID: "custom", id: "local" } };
  const configured = resolveModelLimit(event, new Map(), { contextWindow: 12000 });
  assert.equal(configured.context, 12000);
  assert.equal(configured.source, "config");
  assert.equal(resolveModelLimit(event, new Map(), { contextWindow: 0 }).context, undefined);
  const catalog = new Map([["custom/local", { context: 32000 }]]);
  assert.equal(resolveModelLimit(event, catalog, { contextWindow: 12000 }).context, 32000);
});
