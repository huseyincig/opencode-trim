# Changelog

## 0.7.0 — 2026-11-22

- **Full Strict TypeScript Migration & `dist/` Build (`tsconfig.json`, `src/**/*.ts`, `scripts/emit-tui.ts`, `dist/`)**:
  - Migrated all source modules, command families, benchmarks, validation scripts, and all 28 test suites (`500 / 500` tests) to strict TypeScript (`"strict": true`, `tsc --noEmit`), emitting compiled ESM `.js` + `.d.ts` declarations and adaptive Solid Universal TUI bundles (`dist/tui-runtime.js`, `dist/tui-standalone.js`, `dist/tui.js`).
  - Synced canonical TypeScript Universal Mesh Bridge (`src/bridge.ts`, `BRIDGE_REVISION: 2.3.1`).
- **Smart Context Window Cap, Provider Token Calibration & Compaction Boundary Reset (`src/config.ts`, `src/pressure.ts`, `src/cache.ts`, `src/plugin.ts`)**:
  - Added `contextWindowCap` (`min(catalog, cap)`) to cap 1M+ model context windows without losing `contextWindow` as an unknown-model fallback.
  - Calibrated `estimateRequest()` ratio using provider-reported assistant token usage (`input + output + cache.read + cache.write`) plus trailing unmeasured turn tokens.
  - Added `ContextCache.resetSession(sessionID)` triggered on `session.compaction.ended` and `session.deleted`.
- **Structural Noise Cleaners, RAM LRU Memoization, Pressure-Adaptive Compression & `ToolDedupeRing` (`src/compress.ts`, `src/plugin.ts`)**:
  - Added `scrubBlobs` (data URI/base64/hex elision), `filterDebugLogs`, `collapseStackTraces`, `collapseTablePadding`, and `collapseRepetitionLoops` (single-char & multi-line block loops) to the shell compression pipeline.
  - Added bounded RAM LRU memoization (`128` entries / `512 KB`) to `compressOutput()`, reducing median per-family compression latency to **0.04–0.20 ms**.
  - Added pressure-adaptive `effectiveToolOptions()`, `compactReadEnvelope()` relative path shortening for `read`, `ToolDedupeRing` (`dedupeWindow`, invalidated on edits/compaction), `pruneEditDiagnostics()` (`pruneUnrelatedDiagnostics`) for `edit`/`write`/`apply_patch`, and zero-LLM `SessionWorkingState` tracking (`activeFiles` & `openErrors`).
- **Advanced Context Pruning & Lossless Retrievable Vault (`src/prune.ts`, `src/memory-store.ts`, `src/memory.ts`)**:
  - Added `purgeErrorInputs` (blanks oversized inputs on old failed discrete and combined V2 `type: "tool"` calls while keeping error outputs intact), `pruneHistoricalReasoning` (omits old `reasoning`/`thinking` traces outside the protected tail), `prunePreviewLines` (`buildPreviewNotice` idempotent head/tail previews), and `scorePruningCandidate`.
  - Added secret-redacted `vault` table (`maxVaultRows: 500`, multilingual & nested `pwd`/`PIN` redaction) to `memory.db`, `recoverableNotice`/`expiredNotice` markers with prompt-injection boundary text, and `trim_expand` tool + structured Code Mode `output` JSON schemas on both `trim_expand` and `trim_history_search`.
- **Verification**: **`500 / 500`** tests passing across 28 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked, `npm run bench` and `npm run pack:dry` (`147` files) passing.

## 0.6.0 — 2026-11-20

- **Universal OpenCode V2 Plugin Mesh Interoperability (`src/bridge.js` v2.3.0, `src/plugin.js`, `src/prune.js`, `src/cache.js`)**:
  - Added zero-dependency OpenCode V2 Universal Plugin Mesh bridge (`BRIDGE_REVISION: 2.3.0`, `Symbol.for("opencode.mesh.v2")`) enabling automatic N-way coordination with `opencode-guardian`, `opencode-smart-questions`, `opencode-hi`, and `opencode-lazy-skill-engine` in any $2^N$ combination while remaining 100% standalone (`Solo`).
  - **Call-ID FIFO Queue Synchronization (`src/prune.js`)**: Evaluated `isTrimMeshProtected(part, msg, event?.sessionID)` after `tool-call` insertion and `queue.shift()` consumption so a mesh-protected `tool-result` consumes its matching invocation and never shifts a reused `callId` onto a subsequent `write` or protected instruction `read`.
  - **Multi-Holder Metadata & Provenance Verification (`src/prune.js`, `src/cache.js`)**: Inspected all metadata holders (`part`, `part.result`, `part.state`, `part.payload`, `msg`, `msg.payload`, `msg.state` and their `.metadata` records) so `part.result.metadata` and `part.state.metadata` are never missed or shadowed by sibling keys; verified provenance tokens via `verifyMeshMetadata` when an active session ledger exists; excluded mesh-protected outputs from `ContextCache` `toolChars` budget calculations.
  - **Bidirectional Mesh Bounding & Lifecycle (`src/plugin.js`, `src/memory.js`)**: Checked `wasMeshBounded` across `event.result`, `event`, and `event.result.output`, reported `{ changed: false, savedChars: 0 }` to the stats observer on already-bounded outputs, and stamped `metadata["opencode-mesh"].boundedBy = "opencode-trim"` after compression. Added `realpathSync` symlink resolution (with `path.resolve` fallback) in `canonDir` and `forgetMeshSession(sessionID)` cleanup on `session.deleted`.
- **Package Exports & Documentation Overhaul (`package.json`, `README.md`, `CHANGELOG.md`, `AUDIT.md`)**:
  - Exposed `./rpc` (`./src/stats-rpc.js`) in `package.json` `exports` alongside `.`, `./tui`, `./core`, `./prune`, and `./pressure`.
  - Rebuilt `README.md` to match the OpenCode ecosystem documentation architecture (`opencode-guardian` and `opencode-smart-questions`), adding full Global, Project-Local, `.opencode/plugins/` Symlink/Wrapper, Local `file://`, and Remote TUI (`cli.json`) installation guides, Mermaid lifecycle architecture diagrams, and mesh coordination specifications.
- **Verification**: **473 / 473** unit, security, mesh interoperability, multi-location isolation, TUI, and regression tests passing (`npm run check`); `sync-bridge.mjs --status` verified `UP_TO_DATE` (`2.3.0`).

## 0.5.0 — 2026-11-17

- **Guardian-Grade TUI Sidebar Redesign (`src/tui.tsx`, `src/tui-model.js`)**:
  - Upgraded the optional TUI sidebar to match `opencode-guardian`: `▶` / `▼` disclosure header (`<b>Trim</b>` + `v0.5.0`), reusable two-column `StatRow` components with bold values (`<b>{row.value}</b>`), semantic theme colors (`status.{success,warning,error}.base` and `text.{feedback,accent,muted,base}`), and `buildCollapsedRows` (`Context`, `Savings`, optional `Memory`).
- **TUI Lifecycle, Polling & Isolation Hardening (`src/tui.tsx`, `src/plugin.js`, `src/memory.js`)**:
  - Probed `rpc.snapshot` before `messages.sync` / `models.sync`, capped hidden retries (`MAX_HIDDEN_RETRIES = 3`, stopping immediately on `rpc.unavailable`), enforced one-time `messages.sync` and `models.sync` per session mount, unified `watcher` + `poll` into a single `.unref()` interval, preserved `visible` across session switches to eliminate unmount/remount flicker, and applied fail-closed location filtering to both RPC events and `REFRESH_EVENTS`.
  - Guarded `stats` recording in `runPruning`, `statsOnlyContext`, and `execute.after` against foreign-location events; validated `ctx.location.directory` as an absolute path and canonicalized `project` keys in `setupMemory`; added `-journal` sidecar support to `memoryDbBytes`.
- **Content-Shape Pruning Parity (`src/prune.js`)**:
  - Added `{ type: "content", content: [{ type: "text", text: "..." }] }` support to `accessor()` and `messageTokensImpl()` so `result.content` arrays prune and count toward `tokenTail` identically to `result.value`.
- **Verification**: **467 / 467** automated tests passing; packed `.tgz` verified in Node `v26.13.1` and Bun `1.4.4`.

## 0.4.0 — 2026-11-16

- **Optional Compaction-Summary Memory Store (`src/memory.js`, `src/memory-store.js`, `src/memory-sections.js`)**:
  - Added optional, default-off Phase 1 & 1.1 memory module using Node 26 built-in `node:sqlite` with FTS5, composite `UNIQUE(project, event_id)` deduplication, automatic legacy schema migration, per-project retention pruning, fail-closed structured secret redaction (`[REDACTED]`), `0600` DB / `0700` created-dir permissions, section-aware `trim_history_search` (`codemode: false`), freshness-first ranking, and fail-closed multi-location event attribution.
- **Optional TUI Stats Sidebar & RPC Bridge (`src/stats.js`, `src/stats-rpc.js`, `src/tui.tsx`, `src/tui-model.js`, `src/tui-format.js`)**:
  - Added location-scoped `opencode-trim-stats` RPC contract, per-session operational counters, host-native context token reading (`input + cache.read`) with `~` estimate fallback, and read-only persisted compaction-history fallback across server restarts.
- **Verification**: **462 / 462** automated tests passing and live OpenCode `v2.3.0` host acceptance verified.

## 0.3.0 — 2026-11-15

- **24 Command-Family Compressors & Diagnostic Preservation (`src/compress.js`, `src/families/*`, `src/diagnostics.js`, `src/filters.js`, `src/git.js`, `src/runners.js`)**:
  - Implemented 24 deterministic command-family compressors (`git`, `npm`, `pnpm`, `bun`, `cargo`, `pytest`, `vitest`, `jest`, `tsc`, `eslint`, `biome`, `go`, `ruff`, `prettier`, `playwright`, `docker`, `kubectl`, `terraform`, `gradle`, `make`, `pip`, `uv`, `curl`, `wget`) with fail-closed quote/escape-aware Git patch protection, structured-data guards (JSON, JSONC, YAML, TOML, INI, CSV, TSV, XML, PEM), and failure/warning/stack/summary preservation.
- **Prompt-Cache-Aware Context Pruning & Supersession (`src/prune.js`, `src/cache.js`, `src/pressure.js`, `src/config.js`)**:
  - Implemented call-ID-paired outgoing context pruning, range-coverage `read` supersession, message-count and token-sized tail protection, instruction/secret file protection, and prompt-cache-aware decision replay targeting Node.js 26 Active LTS (`^26.0.0`).
