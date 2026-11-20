import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const root = new URL("../", import.meta.url)
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"))
const tsx = readFileSync(new URL("src/tui.tsx", root), "utf8")
const peers = ["@opencode/plugin", "@opentui/core", "@opentui/solid", "solid-js"]

test("package exposes ./tui and keeps existing exports", () => {
  assert.equal(pkg.version, "0.6.0")
  assert.equal(pkg.exports["./tui"], "./src/tui.tsx")
  assert.equal(pkg.exports["./rpc"], "./src/stats-rpc.js")
  for (const k of [".", "./core", "./prune", "./pressure"]) assert.ok(pkg.exports[k], k)
  assert.ok(pkg.files.includes("src/"))
})

test("TUI deps are optional peers, no dependencies", () => {
  assert.equal(pkg.dependencies, undefined)
  const floors = { "@opencode/plugin": ">=2.3.0", "@opentui/core": ">=0.8.4", "@opentui/solid": ">=0.8.4", "solid-js": ">=1.9.0" }
  for (const p of peers) {
    assert.equal(pkg.peerDependencies[p], floors[p], p)
    assert.equal(pkg.peerDependenciesMeta[p].optional, true, p)
  }
})

test("tui.tsx contract", () => {
  assert.ok(tsx.startsWith("/** @jsxImportSource @opentui/solid */"))
  assert.match(tsx, /import \{ Plugin \} from "@opencode\/plugin\/tui"/)
  assert.match(tsx, /Plugin\.define\(/)
  assert.match(tsx, /id: "opencode-trim\.tui"/)
  assert.match(tsx, /append: "sidebar\.content"/)
  assert.doesNotMatch(tsx, /prepend:|footer:/)
  assert.match(tsx, /options\?\.tui\?\.enabled === false/)
  assert.doesNotMatch(tsx, /snapshot\(\s*\{\s*\}/)
  assert.match(tsx, /rpc\.snapshot\(\{ sessionID \}/)
  assert.match(tsx, /setVisible\(true\)/)
  assert.match(tsx, /<Show when=\{visible\(\)\}>/)
  assert.match(tsx, /TRIM_STATS_RPC/)
  assert.doesNotMatch(tsx, /replace:\s*"/)
})

test("visual contract: borderless section, header toggle, label/value rows", () => {
  assert.doesNotMatch(tsx, /\bborder\b|borderStyle|borderColor|backgroundColor|panelBg|padding/)
  assert.match(tsx, /<box flexDirection="column" flexShrink=\{0\} width="100%" gap=\{0\}>/)
  assert.match(tsx, /onMouseUp=\{toggle\}/)
  assert.match(tsx, /justifyContent="space-between"/)
  assert.match(tsx, /buildCollapsedRows\(/)
  assert.match(tsx, /buildSections\(/)
  assert.match(tsx, /buildHeader\(/)
  assert.match(tsx, /<b>Trim<\/b>/)
  assert.match(tsx, /isExpanded\(\) \? "▼ " : "▶ "/)
  assert.doesNotMatch(tsx, /row\.line/)
  assert.doesNotMatch(tsx, /row\.bar|meter|"\["|"\]"/)
  assert.doesNotMatch(tsx, /"ctx"|"mem"/)
  assert.match(tsx, /\{row\.label\}/)
  assert.match(tsx, /\{row\.value\}/)
  assert.match(tsx, /flexShrink=\{1\}/)
  assert.match(tsx, /wrapMode="none"/)
  assert.match(tsx, /onCleanup\(/)
})

test("native context wiring", () => {
  assert.match(tsx, /nativeContextTokens\(/)
  assert.match(tsx, /messages\.list\(sessionID\)/)
  assert.match(tsx, /messages\.sync\(sessionID\)/)
  assert.ok(tsx.indexOf("messages.sync(sessionID)") < tsx.lastIndexOf("messages.list(sessionID)"))
  assert.match(tsx, /nativeTokens: nativeTokens\(\)/)
  assert.match(tsx, /nativeLimitTokens: nativeLimit\(\)/)
  assert.match(tsx, /context\.data\?\.session\?\.get\?\.\(id\)/)
  assert.match(tsx, /location\?\.model/)
  assert.match(tsx, /limit\?\.context/)
})

test("header version matches package.json", async () => {
  const { TRIM_VERSION } = await import("../src/tui-model.js")
  assert.equal(TRIM_VERSION, pkg.version)
})

test("tui sources avoid node: and server imports", () => {
  for (const f of ["src/tui.tsx", "src/tui-model.js", "src/tui-format.js"]) {
    const text = readFileSync(new URL(f, root), "utf8")
    const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1])
    for (const s of specs) {
      assert.ok(!s.startsWith("node:"), `${f}: ${s}`)
      assert.doesNotMatch(s, /config\.js|plugin\.js|prune\.js|memory|sqlite|hi|orchestrat/i, `${f}: ${s}`)
    }
  }
})

test("tui model and format sources are ASCII; tsx uses only disclosure glyphs", () => {
  for (const f of ["src/tui-model.js", "src/tui-format.js"]) {
    assert.match(readFileSync(new URL(f, root), "utf8"), /^[\x09\x0a\x0d\x20-\x7e]*$/, f)
  }
  const nonAscii = [...tsx].filter((ch) => ch.charCodeAt(0) > 0x7e)
  assert.ok(nonAscii.every((ch) => ch === "▼" || ch === "▶"), `unexpected non-ASCII: ${nonAscii.join("")}`)
})

test("tui lifecycle: RPC-first probe, bounded hidden retries, single sync, location filter", () => {
  assert.match(tsx, /MAX_HIDDEN_RETRIES/)
  assert.match(tsx, /isRpcUnavailable/)
  assert.match(tsx, /messagesSynced = true/)
  assert.match(tsx, /modelsSynced = true/)
  assert.match(tsx, /if \(foreign\(event\)\) return/)
  assert.ok(tsx.indexOf("rpc.snapshot(") < tsx.indexOf("messages.sync(sessionID)"))
})

test("compaction history fallback wiring", async () => {
  const model = await import("../src/tui-model.js")
  assert.equal(typeof model.compactionHistory, "function")
  assert.match(tsx, /compactionHistory\(list\)/)
  assert.match(tsx, /compactionHistory: history\(\)/)
  assert.match(tsx, /setHistory\(null\)/)
  // same list as the native context read, including the post-sync re-read
  assert.ok(tsx.indexOf("messages.sync(sessionID)") < tsx.indexOf("compactionHistory(list)"))
})
