import test from "node:test"
import assert from "node:assert/strict"
import { buildCollapsedRows, buildHeader, buildRows, buildSections, collapsedSummary, compactionHistory, deriveCachePolicy, headerText, isStale, normalizeEventSessionID, nativeContextTokens, normalizeSnapshot, STORAGE_KEY } from "../src/tui-model.ts"
import { isAscii } from "../src/tui-format.ts"

const NOW = 1_000_000
function snap(over = {}) {
  return {
    version: 1, now: NOW, sessionID: "ses_1", since: 0, revision: 3,
    engine: { enabled: true },
    context: { known: true, estimatedTokens: 87000, usableTokens: 128000, limitTokens: 128000, ratio: 0.68 },
    shell: { known: true, runs: 18, changed: 10, savedChars: 42000 },
    filtering: { known: true, runs: 6, changed: 2, savedChars: 8000 },
    pruning: { known: true, calls: 5, drops: 12, removedChars: 56000, allowNewDrops: false },
    cache: { policy: null, allowNewDrops: false },
    compaction: { known: true, running: false, autoEvents: 2, manualEvents: 1, failedEvents: 0, lastAt: NOW - 120000, lastReason: "auto", beforeChars: 120000, afterChars: 31000, reducedRatio: 0.81 },
    memory: { enabled: false },
    ...over,
  }
}
const line = (rows, key) => rows.find((r) => r.key === key)?.line

test("storage key", () => assert.equal(STORAGE_KEY, "opencode-trim.tui"))

test("normalize invalid input", () => {
  for (const v of [null, undefined, 1, "x", [], true]) assert.equal(normalizeSnapshot(v), null)
  const n = normalizeSnapshot({ context: { known: true, ratio: "x", estimatedTokens: NaN } })
  assert.equal(n.context.ratio, null)
  assert.equal(n.context.estimatedTokens, null)
  assert.equal(n.shell.known, false)
})

test("normalize keeps boolean context.media and nulls other values", () => {
  const m = (media) => normalizeSnapshot({ context: { known: true, media } }).context.media
  assert.equal(m(true), true)
  assert.equal(m(false), false)
  for (const v of [undefined, null, "true", 1, 0]) assert.equal(m(v), null)
})

test("normalize keeps measured zero", () => {
  const n = normalizeSnapshot(snap({ shell: { known: true, runs: 0, savedChars: 0 } }))
  assert.equal(n.shell.runs, 0)
  assert.equal(line(buildRows(n, NOW), "shell"), undefined)
})

test("single denominator: 898k/1M => 90%, bar matches", () => {
  const s = snap({ context: { known: true, estimatedTokens: 898000, usableTokens: 616000, limitTokens: 1000000, ratio: 1.46 } })
  const rows = buildRows(s, NOW)
  assert.equal(line(rows, "ctx"), "90% ~898k/1M")
  assert.equal(line(rows, "over"), undefined)
  assert.equal(line(rows, "room"), undefined)
  assert.equal(collapsedSummary(s), "+ trim 90% | -106k | 12 | mem off")
})

test("over limit shows 100% and over, never negative", () => {
  const s = snap({ context: { known: true, estimatedTokens: 1100000, limitTokens: 1000000, ratio: 1.1 } })
  const rows = buildRows(s, NOW)
  assert.equal(line(rows, "ctx"), "100% ~1.1M/1M")
  assert.equal(line(rows, "over"), "over ~100k")
  assert.equal(rows.find((r) => r.key === "ctx").tone, "warning")
  assert.ok(!collapsedSummary(s).includes("110"))
  assert.ok(!rows.some((r) => /\b1[0-9]{2,}%/.test(r.line) && !r.line.includes("100%")))
})

test("unknown limit => --", () => {
  const rows = buildRows(snap({ context: { known: true, estimatedTokens: 5000, limitTokens: null } }), NOW)
  assert.equal(line(rows, "ctx"), "-- ~5k/--")
  assert.equal(buildRows(snap({ context: { known: true } }), NOW)[0].value, "--")
})

test("zero activity rows hidden, no -0", () => {
  const rows = buildRows(snap({
    shell: { known: true, runs: 0, savedChars: 0 }, filtering: { known: true, runs: 0, savedChars: 0 },
    pruning: { known: true, calls: 0, drops: 0, removedChars: 0 }, cache: {}, compaction: { known: true, autoEvents: 0, manualEvents: 0 },
  }), NOW)
  for (const k of ["shell", "filter", "prune", "cache", "auto", "manual"]) assert.equal(line(rows, k), undefined, k)
  assert.equal(line(rows, "compact"), "compact idle")
  for (const r of rows) assert.ok(!r.line.includes("-0"), r.line)
  assert.equal(line(buildRows(snap({ shell: { known: true, runs: 3, savedChars: 0 } }), NOW), "shell"), "shell 3 runs")
})

test("cache policy matrix", () => {
  assert.equal(deriveCachePolicy(null), null)
  assert.equal(deriveCachePolicy(snap({ cache: { policy: "stable" } })), "stable")
  assert.equal(deriveCachePolicy(snap({ cache: { policy: "cooling", allowNewDrops: true } })), "cooling")
  assert.equal(deriveCachePolicy(snap({ cache: { allowNewDrops: true } })), "open")
  assert.equal(deriveCachePolicy(snap({ cache: { allowNewDrops: false } })), "stable")
  assert.equal(deriveCachePolicy(snap({ cache: {}, pruning: { allowNewDrops: true } })), "open")
  assert.equal(deriveCachePolicy(snap({ cache: {}, pruning: {} })), null)
})

test("reduced only with both before and after", () => {
  const ok = buildRows(snap(), NOW)
  assert.equal(line(ok, "reduced"), "reduced 81%* ~120k -> 31k")
  for (const c of [{ beforeChars: 1000 }, { afterChars: 1000 }, {}]) {
    const rows = buildRows(snap({ compaction: { known: true, ...c } }), NOW)
    assert.equal(line(rows, "reduced"), undefined)
  }
})

test("compaction combined row, failed and running", () => {
  const rows = buildRows(snap({ compaction: { known: true, running: true, autoEvents: 2, manualEvents: 1, failedEvents: 3 } }), NOW)
  assert.equal(line(rows, "failed"), "failed 3")
  assert.equal(line(rows, "running"), "compact running")
  assert.equal(line(buildRows(snap(), NOW), "compact"), "compact 2 auto / 1 manual")
  assert.equal(line(buildRows(snap({ compaction: { known: true, autoEvents: 0, manualEvents: 1 } }), NOW), "compact"), "compact 1 manual")
  const unknown = buildRows(snap({ compaction: { known: false } }), NOW)
  assert.equal(line(unknown, "compact"), undefined)
  assert.equal(line(unknown, "last"), undefined)
  assert.equal(line(buildRows(snap(), NOW), "last"), "last 2m ago auto")
})

test("memory off / active / error / unknown", () => {
  assert.equal(line(buildRows(snap(), NOW), "mem"), "memory off")
  assert.equal(line(buildRows(snap({ memory: { enabled: true, active: true, summaries: 3, searches: 5, dbBytes: 2048 } }), NOW), "mem"), "3 summaries 5 searches | 2K")
  assert.equal(line(buildRows(snap({ memory: { enabled: true, active: true, summaries: 0, searches: 0, dbBytes: 37000 } }), NOW), "mem"), "0 summaries 0 searches | 37K")
  assert.equal(line(buildRows(snap({ memory: { enabled: true, active: true, summaries: 2, searches: null, dbBytes: null } }), NOW), "mem"), "2 summaries")
  assert.equal(line(buildRows(snap({ memory: { enabled: true, active: false } }), NOW), "mem"), "memory idle")
  assert.equal(line(buildRows(snap({ memory: { enabled: true, active: false, error: "disk full" } }), NOW), "mem"), "memory error disk full")
  assert.equal(line(buildRows(snap({ memory: {} }), NOW), "mem"), "memory --")
  const labels = buildRows(snap({ memory: { enabled: true, active: true, summaries: 1 } }), NOW).map((r) => r.label)
  assert.ok(!labels.includes("ctx") && !labels.includes("mem"))
})

test("full rows match design", () => {
  const rows = buildRows(snap(), NOW)
  assert.equal(line(rows, "ctx"), "68% ~87k/128k")
  assert.equal(line(rows, "shell"), "shell 18 runs -42k")
  assert.equal(line(rows, "filter"), "filter 6 runs -8k")
  assert.equal(line(rows, "prune"), "prune 12 drops -56k")
  assert.equal(line(rows, "cache"), "cache stable")
  assert.equal(line(rows, "room"), undefined)
})

test("null snapshot shows -- everywhere", () => {
  const rows = buildRows(null, NOW)
  assert.ok(rows.length > 0)
  for (const r of rows) assert.ok(r.line.includes("--"), r.line)
  assert.equal(collapsedSummary(null, { stale: true }), "+ trim --!")
})

test("stale matrix", () => {
  assert.equal(isStale(null, NOW), true)
  assert.equal(isStale({}, NOW), true)
  assert.equal(isStale(snap(), NaN), true)
  assert.equal(isStale(snap({ now: NOW - 10_000 }), NOW, true), false)
  assert.equal(isStale(snap({ now: NOW - 20_000 }), NOW, true), true)
  assert.equal(isStale(snap({ now: NOW - 20_000 }), NOW, false), false)
  assert.equal(isStale(snap({ now: NOW - 400_000 }), NOW, false), true)
})

test("event session filter", () => {
  assert.equal(normalizeEventSessionID({ sessionID: "a" }), "a")
  assert.equal(normalizeEventSessionID({ properties: { sessionID: "b" } }), "b")
  assert.equal(normalizeEventSessionID({ data: { sessionID: "c" } }), "c")
  assert.equal(normalizeEventSessionID({}), null)
  assert.equal(normalizeEventSessionID(null), null)
  assert.equal(normalizeEventSessionID({ sessionID: 4 }), null)
})

test("collapsed and expanded header ASCII", () => {
  assert.equal(collapsedSummary(snap()), "+ trim 68% | -106k | 12 | mem off")
  assert.equal(collapsedSummary(snap({ shell: {}, filtering: {}, pruning: {} })), "+ trim 68% | mem off")
  assert.equal(headerText(), "- trim")
  assert.equal(headerText(true), "- trim !")
  assert.match(collapsedSummary(snap({ memory: { enabled: true, active: true, summaries: 4 } })), /mem 4$/)
  assert.match(collapsedSummary(snap({ memory: { error: "x" } })), /mem err$/)
})

test("all rows ASCII even with hostile strings, no paths leak", () => {
  const hostile = snap({
    compaction: { known: true, lastAt: NOW, lastReason: "r\u00e9sum\u00e9 \u2192 /home/u/secret/path", beforeChars: 5, afterChars: 1 },
    memory: { enabled: true, error: "\u2603 /home/u/db failed" },
    cache: { policy: "\u2603stable" },
  })
  for (const r of buildRows(hostile, NOW)) assert.ok(isAscii(r.line), r.line)
  for (const s of [collapsedSummary(hostile), collapsedSummary(snap())]) assert.ok(isAscii(s))
  for (const r of buildRows(snap(), NOW)) assert.ok(isAscii(r.line))
})

test("sections: ordered, only non-empty, label/value/tone/bar exposed", () => {
  const s = buildSections(snap({ context: { known: true, estimatedTokens: 898000, limitTokens: 1000000 } }), NOW)
  assert.deepEqual(s.map((x) => x.title), ["Context", "Optimization", "Compaction", null])
  assert.deepEqual(s.map((x) => x.key), ["context", "optimization", "compaction", "memory"])
  const ctx = s[0].rows[0]
  assert.equal(ctx.kind, "stat")
  assert.equal(ctx.label, "90%")
  assert.equal(ctx.value, "~898k/1M")
  assert.ok(!("bar" in ctx) || ctx.bar === null)
  assert.doesNotMatch(ctx.line, /[\[\]#]/)
  const shell = s[1].rows.find((r) => r.key === "shell")
  assert.deepEqual([shell.label, shell.value, shell.kind], ["shell", "18 runs -42k", "stat"])
  const quiet = buildSections(snap({ shell: {}, filtering: {}, pruning: {}, cache: {}, compaction: {}, memory: {} }), NOW)
  assert.deepEqual(quiet.map((x) => x.key), ["context", "memory"])
  assert.equal(buildSections(snap({ context: { known: true, estimatedTokens: 12e5, limitTokens: 1e6 } }), NOW)[0].rows[1].value, "~200k")
})

test("header: title with version, summary only collapsed, marker", () => {
  assert.deepEqual(buildHeader(snap(), { expanded: false }), { title: "+ trim v0.7.2", summary: "68% | -106k | 12 | mem off", marker: "" })
  assert.deepEqual(buildHeader(snap(), { expanded: true, stale: true }), { title: "- trim v0.7.2", summary: "", marker: "!" })
  assert.equal(buildHeader(null).marker, "?")
  for (const h of [buildHeader(snap()), buildHeader(null, { expanded: true })]) assert.ok(isAscii(h.title + h.summary + h.marker))
})

test("compact card: unknown context hidden, memory header only when active", () => {
  const unk = buildSections(snap({ context: { known: false } }), NOW)
  assert.ok(!unk.some((x) => x.key === "context"))
  assert.equal(buildRows(snap({ context: { known: false } }), NOW).some((r) => r.key === "ctx"), false)
  const mem = (m) => buildSections(snap({ memory: m }), NOW).find((x) => x.key === "memory")
  assert.equal(mem({ enabled: false }).title, null)
  assert.equal(mem({ enabled: false }).rows[0].line, "memory off")
  assert.equal(mem({}).title, null)
  assert.equal(mem({}).rows[0].line, "memory --")
  assert.equal(mem({ enabled: true, active: false }).title, null)
  assert.equal(mem({ enabled: true, active: true, summaries: 1 }).title, "Memory")
  assert.equal(buildSections(snap(), NOW).length, 4)
})

const asst = (input, read, extra = {}) => ({ type: "assistant", tokens: { input, output: 5, cache: { read, write: 0 } }, ...extra })

test("native context: 740100/1M => 74%, no estimate shown", () => {
  const s = snap({ context: { known: true, estimatedTokens: 991000, limitTokens: 1000000 } })
  const rows = buildRows(s, NOW, { nativeTokens: 740100 })
  assert.equal(line(rows, "ctx"), "74% 740k/1M")
  assert.ok(!line(rows, "ctx").includes("~") && !line(rows, "ctx").includes("991"))
  assert.equal(collapsedSummary(s, { nativeTokens: 740100 }), "+ trim 74% | -106k | 12 | mem off")
  assert.equal(buildHeader(s, { nativeTokens: 740100 }).summary.startsWith("74%"), true)
  assert.equal(buildSections(s, NOW, { nativeTokens: 740100 })[0].rows[0].value, "740k/1M")
})

test("native context: over limit clamps, null falls back to estimate", () => {
  const s = snap({ context: { known: true, estimatedTokens: 500000, limitTokens: 1000000 } })
  const over = buildRows(s, NOW, { nativeTokens: 1200000 })
  assert.equal(line(over, "ctx"), "100% 1.2M/1M")
  assert.equal(line(over, "over"), "over 200k")
  assert.equal(line(buildRows(s, NOW, { nativeTokens: null }), "ctx"), "50% ~500k/1M")
  assert.equal(line(buildRows(s, NOW), "ctx"), "50% ~500k/1M")
  const nolim = buildRows(snap({ context: { known: true, estimatedTokens: 5, limitTokens: null } }), NOW, { nativeTokens: 740100 })
  assert.equal(nolim[0].value, "740k/--")
  assert.equal(buildRows(snap({ context: { known: false } }), NOW, { nativeTokens: 9 }).some((r) => r.key === "ctx"), true)
})

test("nativeContextTokens: last assistant, compaction boundary, cache read", () => {
  assert.equal(nativeContextTokens(null), null)
  assert.equal(nativeContextTokens([]), null)
  assert.equal(nativeContextTokens([{ type: "user" }, { type: "assistant" }]), null)
  assert.equal(nativeContextTokens([asst(100, 20), asst(700000, 40100)]), 740100)
  assert.equal(nativeContextTokens([asst(900, 0), { type: "compaction", status: "completed" }, { type: "user" }]), null)
  assert.equal(nativeContextTokens([asst(900, 0), { type: "compaction", status: "completed" }, asst(50, 5)]), 55)
  assert.equal(nativeContextTokens([asst(900, 0), { type: "compaction", status: "running" }]), 900)
  assert.equal(nativeContextTokens([{ type: "assistant", tokens: { input: 7, cache: [] } }]), 7)
  assert.equal(nativeContextTokens([{ type: "assistant", tokens: { input: 7 } }]), 7)
})

test("native tokens + native limit work without context snapshot", () => {
  const s = snap({ context: { known: false } })
  const o = { nativeTokens: 740100, nativeLimitTokens: 1000000 }
  assert.equal(line(buildRows(s, NOW, o), "ctx"), "74% 740k/1M")
  assert.equal(buildSections(s, NOW, o)[0].rows[0].value, "740k/1M")
  assert.equal(collapsedSummary(s, o), "+ trim 74% | -106k | 12 | mem off")
  assert.equal(buildHeader(s, o).summary.startsWith("74%"), true)
  const nolim = buildRows(s, NOW, { nativeTokens: 740100 })
  assert.equal(nolim[0].value, "740k/--")
  assert.ok(!nolim[0].value.includes("%"))
  assert.ok(!collapsedSummary(s, { nativeTokens: 740100 }).includes("%"))
  assert.equal(buildRows(s, NOW).some((r) => r.key === "ctx"), false)
  const k = snap({ context: { known: true, estimatedTokens: 991000, limitTokens: 500000 } })
  assert.equal(line(buildRows(k, NOW, o), "ctx"), "74% 740k/1M")
  assert.equal(line(buildRows(k, NOW), "ctx"), "100% ~991k/500k")
})

const comp = (status, time, reason) => ({ type: "compaction", status, time, ...(reason ? { reason } : {}) })

test("compactionHistory: null for empty, non-array and no compaction entries", () => {
  assert.equal(compactionHistory(undefined), null)
  assert.equal(compactionHistory([]), null)
  assert.equal(compactionHistory([{ type: "user" }, null, 5, { type: "assistant" }]), null)
  assert.equal(compactionHistory([comp("running", { created: 1 })]), null)
})

test("compactionHistory: counts completed and failed, newest completed gives last/reason, order independent", () => {
  const list = [
    comp("completed", { created: 10, completed: 20 }, "auto"),
    comp("running", { created: 90 }),
    comp("failed", { created: 50 }),
    comp("completed", { created: 30, completed: 40 }, "manual"),
    comp("completed", { created: 5 }, "weird"),
  ]
  const want = { total: 3, failed: 1, lastAt: 40, lastReason: "manual" }
  assert.deepEqual(compactionHistory(list), want)
  assert.deepEqual(compactionHistory([...list].reverse()), want)
  assert.deepEqual(compactionHistory([comp("completed", { created: 7 }, "auto")]), { total: 1, failed: 0, lastAt: 7, lastReason: "auto" })
  assert.deepEqual(compactionHistory([comp("completed", {})]), { total: 1, failed: 0, lastAt: null, lastReason: null })
  assert.deepEqual(compactionHistory([comp("failed", {})]), { total: 0, failed: 1, lastAt: null, lastReason: null })
})

const UNKNOWN = { compaction: { known: false, running: false } }
const hist = { total: 3, failed: 0, lastAt: NOW - 120000, lastReason: "auto" }

test("history fallback: shows archived count and last, no live or reduction claims", () => {
  const sections = buildSections(snap(UNKNOWN), NOW, { compactionHistory: hist })
  const c = sections.find((x) => x.key === "compaction")
  assert.equal(c.title, "Compaction")
  assert.deepEqual(c.rows.map((r) => r.key), ["compact", "last"])
  assert.equal(c.rows[0].label, "compact")
  assert.equal(c.rows[0].value, "3 archived")
  assert.equal(c.rows[1].value, "2m ago auto")
  assert.equal(buildRows(snap(UNKNOWN), NOW, { compactionHistory: hist }).find((r) => r.key === "reduced"), undefined)
})

test("history fallback: failed-only, failed row, and last without reason", () => {
  const f = buildRows(snap(UNKNOWN), NOW, { compactionHistory: { total: 0, failed: 2, lastAt: null, lastReason: null } })
  assert.equal(line(f, "compact"), "compact 0 archived")
  assert.equal(line(f, "failed"), "failed 2")
  assert.equal(f.find((r) => r.key === "last"), undefined)
  const g = buildRows(snap(UNKNOWN), NOW, { compactionHistory: { total: 1, failed: 1, lastAt: NOW - 120000, lastReason: null } })
  assert.equal(line(g, "last"), "last 2m ago")
  assert.equal(g.find((r) => r.key === "failed").tone, "error")
})

test("history fallback: live-known stats take precedence and no history keeps today's behavior", () => {
  const live = buildRows(snap(), NOW, { compactionHistory: { total: 9, failed: 4, lastAt: 1, lastReason: "manual" } })
  assert.equal(line(live, "compact"), "compact 2 auto / 1 manual")
  assert.ok(live.some((r) => r.key === "reduced"))
  assert.equal(line(live, "last"), "last 2m ago auto")
  const none = (o) => buildRows(snap(UNKNOWN), NOW, o).find((r) => r.section === "compaction")
  assert.equal(none({}), undefined)
  assert.equal(none({ compactionHistory: null }), undefined)
  assert.equal(none({ compactionHistory: { total: 0, failed: 0 } }), undefined)
  assert.equal(none({ compactionHistory: "bad" }), undefined)
})

test('buildCollapsedRows: idle, context, savings and memory states', () => {
  const empty = buildCollapsedRows(null)
  assert.equal(empty[0].label, "Context")
  assert.equal(empty[0].value, "--")
  assert.equal(empty[1].label, "Savings")
  assert.equal(empty[1].value, "Idle")

  const active = buildCollapsedRows({
    context: { known: true, estimatedTokens: 1000, limitTokens: 10000 },
    shell: { known: true, runs: 2, changed: 1, savedChars: 5000 },
    pruning: { known: true, drops: 3, removedChars: 1200 },
    memory: { enabled: true, active: true, summaries: 4 },
  }, { nativeTokens: 7400, nativeLimitTokens: 10000 })
  assert.equal(active[0].value, "74% (7.4k/10k)")
  assert.equal(active[1].value, "-6.2k | 3 drops")
  assert.equal(active[1].tone, "success")
  assert.equal(active[2].label, "Memory")
  assert.equal(active[2].value, "4 summaries")
})
