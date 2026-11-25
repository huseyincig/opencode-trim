# Changelog

## Unreleased (Post-0.11.4 Static Audit Hardening)

- **Wave 1 — Critical Compression, Vault, Dedupe & Security Fixes (`src/compress.ts`, `src/memory-store.ts`, `src/memory.ts`, `src/prune.ts`, `src/plugin.ts`)**:
  - **ANSI Control-Char Misclassification (`TRM-037`):** Strip valid ANSI escape sequences before checking for binary control bytes so colored test/build outputs compress normally instead of short-circuiting as `"structured"`.
  - **Vault ReDoS, 128-bit IDs & Fail-Closed Persistence (`TRM-001`, `TRM-003`, `TRM-004`, `TRM-005`, `TRM-009`):** Reject exponential alternation/quantifier regex groups in `compileSafeGrepRegex`; upgrade vault ref IDs to 128-bit SHA-256 (`trm_<32 hex>`) with `INSERT OR IGNORE`; preserve original output untouched if a new drop fails to persist to the vault; qualify `recoverableNotice` honestly as a bounded, secret-redacted snapshot (with truncation disclosure past 1M chars); push `tool`/`target` filters to SQL with 20-row paged scans in `searchVault`.
  - **Memory ACL & `<recent_work>` Hardening (`TRM-006`, `TRM-007`):** Enforce `agentAllowlist`/`agentDenylist` and fail-closed location checks directly inside `trim_history_search` / `trim_expand` `execute()` handlers as well as `execute.before`; enforce agent ACL and fail-closed `ctx.session.get` child detection on `memory.recentWork` with explicit untrusted historical data framing.
  - **Diagnostic Overflow & ToolDedupeRing Ordering (`TRM-010`, `TRM-011`, `TRM-012`):** Fail closed when `diagnosticText` exceeds `MAX_SCAN_LINES` (`20,000`); guard `ToolDedupeRing` behind `isProtectedCommand`, `looksStructured`, and exit-notice checks, restrict array dedupe to primary part `0` with `keepsNotice`, and reset the ring on `pruneContext` drops.
- **Wave 2 — Pruning, Memory Store, Model Catalog, Filters & TUI Hardening (`src/prune.ts`, `src/memory-store.ts`, `src/pressure.ts`, `src/compress.ts`, `src/filters.ts`, `src/plugin.ts`, `src/tui.tsx`)**:
  - Added message-level signed reasoning protection (`TRM-016`), exact `state.metadata.output` mirror/rollback fidelity (`TRM-021`), nested `result.output.exitCode` failure detection (`TRM-057`), SQL-level `session_id` filtering (`TRM-022`), strict `getVault` line-range validation (`TRM-024`), Unicode-aware (`\p{L}\p{N}`) archive residue check (`TRM-027`), automatic `history_fts` backfill on missing FTS table (`TRM-030`), `AFTER UPDATE OF text` FTS trigger (`TRM-031`), `resetModelLookupAttempts` + full catalog refresh on `model.updated`/`provider.updated` (`TRM-034`), post-`renderSelection` `maxOutputLines` enforcement (`TRM-039`), leading-executable `programOf` parsing (`TRM-040`), sync-throw-isolated reverse disposal (`TRM-043`), `ToolDedupeRing.seq` eviction (`TRM-056`), and TUI single-flight coalescing, session/generation `/trim` guards, snapshot `sessionID` validation, catch-path `latestState` resets, and guarded cleanup (`TRM-050`, `TRM-051`, `TRM-053`, `TRM-059`, `TRM-068`).
- **Wave 3 — Shared Universal Plugin Mesh (`src/bridge.ts` + canonical skill `references/bridge.{ts,js}`)**:
  - Fail-closed provenance verification in `isTrustedMeshMessage` when a session ledger exists (`TRM-008`), identity-checked resolver/provider disposers (`TRM-044`), standby RPC host promotion on primary registration failure (`TRM-045`), `AbortController` timeout cancellation in `callMeshRpc` (`TRM-047`), directory-scoped `hasMeshCapability` legacy fallback (`TRM-049`), and release-on-evict for bounded remote interaction leases (`TRM-064`).

## 0.11.4 — 2026-11-24

- **OpenCode V2.4.1 Deep Audit & Hardening (`src/tui.tsx`, `src/plugin.ts`, `src/stats.ts`, `src/memory.ts`, `src/bridge.ts`)**:
  - **TUI Session Isolation & `v2.4.x` Events (`src/tui.tsx`):** Reset `latestState` on session switch and `activeSessionID` on cleanup so `/trim` never mixes prior-session data; added `session.execution.{succeeded,failed,interrupted}` to `REFRESH_EVENTS` for immediate post-turn sidebar updates; aligned native model limit resolution to `limit.input ?? limit.context` matching `src/pressure.ts`.
  - **Server Dynamic Catalog & Session Cleanup (`src/plugin.ts`, `src/stats.ts`):** Subscribed to `model.updated` and `provider.updated` on the server event stream to refresh `modelLimits` and clear `modelLookups` dynamically under `v2.4.0+` non-blocking startup; added `stats.forgetSession(sid)` invoked on `session.deleted` to evict deleted sessions and cancel pending RPC emits.
  - **Multi-Location Gate & Vault Schema Hygiene (`src/memory.ts`, `src/bridge.ts`):** Added fail-closed `locationState` filtering to the `execute.before` gate, updated `trim_expand` `tool` filter examples to ephemeral tools (`"shell"`, `"webfetch"`), and synced `src/bridge.ts` with canonical `BRIDGE_REVISION: 2.3.1` (`bindingOwner`).
- **Verification**: **`544 / 544`** tests passing across 29 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked.

## 0.11.3 — 2026-11-24

- **Critical Fix: OpenCode V2 `SystemPart` Schema Compliance for `memory.recentWork` (`src/memory.ts`)**:
  - Fixed `memory.recentWork` pushing a raw string into `event.system` instead of a V2 `SystemPart` object (`{ type: "text", text }`), which crashed V2 provider request compilers evaluating `b.text.length`.
  - Added one-time `ctx.session.get({ sessionID })` `parentID` lookup (cached per session) so child/subagent sessions are reliably detected and excluded from `<recent_work>` injection even when `SessionContext` omits `event.parentID`.
- **Verification**: **`543 / 543`** tests passing across 29 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked.

## 0.11.2 — 2026-11-24

- **Prevent Stale Source-Code Reads via `trim_expand` (`src/prune.ts`, `src/memory.ts`, `src/memory-store.ts`)**:
  - Excluded live filesystem/code inspection tools (`read`, `grep`, `glob`, `ls`, `list`, `search`, `find`, and generic read-only `*_read|zoom|outline|search|grep|glob|...` suffixes via `isLiveDiskTool()`) from `vault` storage and `trim_expand` references.
  - Replaced pruned live-disk outputs with `liveDiskNotice()`, directing the model to re-read or re-run live file/code tools on disk instead of reading potentially stale point-in-time vault snapshots.
  - Kept `vault` + `trim_expand` focused strictly on ephemeral/expensive command and web outputs (`shell`, `bash`, `webfetch`) and updated `trim_expand`'s tool description and output header to warn against using historical snapshots for live source files.
- **Verification**: **`543 / 543`** tests passing across 29 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked.

## 0.11.1 — 2026-11-24

- **Performance-Tuned Out-of-the-Box Defaults (`src/config.ts`, `README.md`)**:
  - Updated out-of-the-box engine defaults to the speed/TTFT & prompt-cache sweet spot: `contextWindowCap: 250000` (`"250k"`), `protectRecentMessages: 10`, `keepRecentToolResults: 8`, `pruneAfterToolChars: 75000`, `dedupeWindow: 8`, `prunePreviewLines: 2`, and `memory.retentionDays: 60` (keeping `cacheTtlMs: 300000`, `cacheMinSavingsChars: 6000`, `autoCompact: true`, and opt-in silent-by-default `tui.enabled`, `memory.enabled`, `memory.recentWork`, `compactionInputPruning`, and `reduceTool` intact).
- **Verification**: **`542 / 542`** tests passing across 29 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked.

## 0.11.0 — 2026-11-24

- **Cold-Cache Opportunity Window & Economic Break-Even Gate (`src/cache.ts`, `src/prune.ts`, `src/config.ts`, `src/plugin.ts`)**:
  - Added `cacheTtlMs` (`300_000` ms default) and `cacheMinSavingsChars` (`6000` default) options, plus `ContextCache.observeCacheRead()` fed by `session.step.ended` provider `cache.read` counts.
  - Opens zero-penalty pruning admission whenever the prompt cache is already cold (idle `>= cacheTtlMs` or observed `cache.read === 0`); defers unprofitable small net-new cache busts on verified warm caches via `evaluateCacheBreakEven()` (with automatic `startBandAdmitted`/`sizeMark` rollback on deferral, while always replaying committed `plannedDrops` and honoring critical pressure).
- **Write-Invalidated Stale-Read Pruning (`src/prune.ts`, `src/plugin.ts`)**:
  - Tracks completed, non-failed file writes/edits/patches (`edit`, `write`, `apply_patch`, `patch`, and generic write suffixes) and marks earlier `read` outputs of the exact canonical file path as superseded (archived to `vault` when memory is enabled; failed edits, recent tails, and instruction/secret files remain untouched).
- **Post-Compaction Verification, Top-3 Tool Bloat & System/Schema Overhead Diagnostics (`src/pressure.ts`, `src/stats.ts`, `src/tui-model.ts`)**:
  - Measures `afterRatio` and `verification` (`effective` | `under-reduced` | `grew`) on the first post-compaction turn and displays `Compaction check:` in `/trim`.
  - Computes privacy-safe `diagnostics` (`toolSchemaChars`, `toolCount`, and top-3 sanitized `topTools`) in a single pass inside `estimateRequest()` and renders `Top tools:` and `Overhead alert:` lines in `/trim`.
- **Prompt-Cache-Safe Frozen `<recent_work>` & Expanded `trim_history_search` (`src/memory-store.ts`, `src/memory.ts`, `src/config.ts`)**:
  - Added `recent: true` (chronological listing without query) and `scope: "project" | "all"` to `trim_history_search`, and fixed default `openMemoryStore()` limit clamping so `limit: 1..20` is honored while explicit `maxResults` caps remain enforced.
  - Added opt-in `memory.recentWork` (default `false`): builds a sanitized, redacted `<recent_work>` block once per top-level session from `memory.db` and freezes it byte-identically for the session's lifetime (never injected into subagent, compaction, title, or generate requests).
- **Deterministic FNV-1a `stableMessageKey()` Fallback (`src/prune.ts`)**:
  - Added `stableMessageKey(msg)` for ID-less OpenCode V2 `Prompt.Message` objects without hashing mutable tool outputs, preserving `ContextCache` replay stability across turns and post-prune mutations.
- **Verification**: **`542 / 542`** tests passing across 29 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), zero circular imports, `94 / 94` files syntax-checked, and isolated packed tarball verified on Node 26.

## 0.10.2 — 2026-11-24

- **TUI Sidebar Main-Thread Performance Optimization (`src/tui.tsx`, `src/tui-model.ts`)**:
  - Replaced `JSON.stringify()` in host fallback `messageBreakdown()` with an allocation-free, cycle-safe (`WeakSet`), depth-capped (`<= 4`), and node-budgeted (`4096`) string-length walker that preserves valid `text`/`output`/`content`/`value` payloads even on cyclic objects and stays under ~`2.5 ms` on 600-message histories.
  - Short-circuited host `messageBreakdown(list)` completely whenever the server RPC snapshot already supplies `context.breakdown`.
  - Eliminated duplicate message-list scans in `fetchNow()` (`compactionHistory`, `compactionBreakdown`, `messageBreakdown` now run at most once) and added an O(1) `messageListKey(list)` fingerprint cache so unchanged message lists skip rescanning across debounced RPC `changed` bursts and polls.
  - Throttled idle `setNow()` ticks in the TUI watcher interval to `IDLE_TICK_MS = 30_000` (15x fewer idle Solid memo recomputations while preserving `2 s` live polling during active runs).
- **Verification**: **`536 / 536`** tests passing across 28 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked against `@opencode/plugin@2.4.1`, `@opentui/core@0.9.9`, and `@opentui/solid@0.9.9`.

## 0.10.1 — 2026-11-24

- **TUI Sidebar Header & Bar Separation Polish (`src/tui.tsx`)**:
  - Added 1-row vertical breathing room (`marginTop={1}`) between the `[ trim ]` pill header and the centered 3-color composition bar.
  - Switched the `[ trim ]` pill badge fill to a distinct neutral accent (`theme.text.base` with `theme.background.base` label) so it never blends visually into the purple `sys` segment underneath.
- **Verification**: **`534 / 534`** tests passing across 28 suites (`npm run check`), `tsc --noEmit` clean (`0` errors).

## 0.10.0 — 2026-11-24

- **Lossless List/Search Path-Prefix & Directory Compaction (`src/compress.ts`, `src/plugin.ts`)**:
  - Added `compactListPaths(text, directory, options)` (exported via `./core` and wired into `processToolEvent` for `grep`, `glob`, `find`, `ls`, `list`) to hoist repeated project root prefixes (`[root: ...]`) and group consecutive same-file grep matches and same-directory path listings without dropping any matches or touching structured payloads.
- **Vault-Wide Grep Search in `trim_expand` (`src/memory-store.ts`, `src/memory.ts`)**:
  - Added `store.searchVault()` so calling `trim_expand` without `id` and with `grep` searches across all non-expired project `vault` entries (`tool`, `target`, `regex`, `caseSensitive`, `limit`, `maxChars`, ReDoS-guarded, query-time `retentionDays` enforced) and returns matching `ref_id` + line excerpts.
- **Opt-In, Tagless, Cache-Safe `trim_reduce` Tool (`src/config.ts`, `src/prune.ts`, `src/plugin.ts`)**:
  - Added `reduceTool` option (`DEFAULTS.reduceTool = false`). When enabled alongside `pruning`, registers `trim_reduce` (`codemode: false`) to queue `scope: "older_tools" | "target"` reductions without message tagging (`applyNow: false` defers to cache-safe boundaries; `applyNow: true` applies on next turn), always protecting recent tails, errors, writes, and protected/instruction files while archiving dropped items to `vault`.
- **OpenCode V2 Lifecycle Completeness (`session.deleted` & `session.hook('fork')`) (`src/plugin.ts`)**:
  - Added `'session.deleted'` to the event subscription `types` list so deleted sessions invoke `forgetMeshSession(sid)` and `resetSessionState(sid)`.
  - Registered `session.hook('fork')` (V2.3.0+) to keep forked child sessions free of stale cooldowns or pre-fork token baselines while enforcing `foreignEvent` isolation.
- **Native Pill-Header TUI Sidebar Polish & `/trim` Slash Command (`src/tui.tsx`, `src/tui-model.ts`)**:
  - Polished the borderless 3-mode sidebar with a native `[ trim ]` pill badge header + inline health status, centered 100%-filled 3-color composition bar (`34` cells in Normal/Detail, flex-centered in Minimal), and clean indented two-column `StatRow` rows matching OpenCode V2 sidebar conventions.
  - Added pure `context.keymap.layer` `/trim` (alias `/trim-gain`) slash command displaying `buildGainReport()` savings & composition summary in `ui.dialog.alert` (with toast fallback) plus `/trim minimal | normal | detail | toggle` mode switching.
- **Verification**: **`534 / 534`** tests passing across 28 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked against `@opencode/plugin@2.4.1`, `@opentui/core@0.9.9`, and `@opentui/solid@0.9.9`.

## 0.9.4 — 2026-11-24

- **Separated 100%-Filled Composition Bar & Dynamic Config-Driven TUI Sidebar (`src/tui-model.ts`, `src/tui.tsx`, `src/stats.ts`)**:
  - Decoupled the 3-color composition bar (`sys` purple, `chat` cyan, `tools` green — always 100% filled with aligned `sys X%` / `chat Y%` / `tools Z%` percentages underneath summing strictly to `100%`) from context capacity and health status.
  - Displayed context fill and `● healthy` / `● caution` / `● critical` on a dedicated line dynamically matching each user's active configuration (active `maxTokens` / `pruneAt` cap when smaller than the model window, or full model window otherwise, using configured `pressureStartRatio` / `pressureForceRatio`).
  - Made detail lines (`context`, `session`, `saved` + optional `cache`, and optional `memory`) strictly config-driven across all 3 click-cycled modes (**Normal**, **Detail**, **Minimal**).
- **Non-Blocking Startup Model Catalog Prewarm (`src/plugin.ts`)**:
  - Moved `discoverModelLimits(ctx)` during `setupTrim()` to a non-blocking background prewarm with `disposed` guard so plugin boot never stalls waiting on `ctx.model.list()` (while `ensureModelLimit()` remains lazy on first request).
- **Verification**: **`528 / 528`** tests passing across 28 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked against `@opencode/plugin@2.4.1`, `@opentui/core@0.9.9`, and `@opentui/solid@0.9.9`.

## 0.9.3 — 2026-11-24

- **Authoritative Real Provider Token Math (`session.step.ended`) (`src/plugin.ts`, `src/pressure.ts`)**:
  - Subscribed the single event pump to `session.step.ended` to record real provider token usage (`input + cache.read`, matching the OpenCode screen 1:1) per `assistantMessageID`, with a one-time `ctx.session.context({ sessionID })` seed if no `step.ended` has arrived yet.
  - Updated `estimateRequest()` to treat real provider token counts as authoritative for `effectiveTokens` and subtract only newly pruned characters (`prunedCharsSoFar - baselineChars`), preventing premature pruning/compaction caused by conservative byte/3 overestimation (e.g. `295.9k` real tokens vs. `350k` cap).
  - Cleared `nativeBySession` and `appliedChars` on `session.compaction.ended` and `onCompactionEnded` to prevent stale pre-compaction baselines after compaction completes.
- **3-Mode Segmented-Bar TUI Sidebar & DB Hydration (`src/tui.tsx`, `src/tui-model.ts`, `src/stats.ts`, `src/memory-store.ts`, `src/prune.ts`, `src/memory.ts`)**:
  - Redesigned the borderless OpenTUI sidebar into 3 click-cycled modes (**Open / Default**, **Expanded / Detail**, and **Collapsed / Minimal**) with a color-coded `sys` / `chat` / `tools` segmented bar and `healthy` / `caution` / `critical` status indicator that respects both model limits and active `maxTokens` caps.
  - Added single-pass `breakdown: { systemChars, chatChars, toolChars }` in `estimateRequest()` (with host `messageBreakdown()` fallback), persistent session age from host `SessionInfo.time.created`, and read-only `store.sidebarStats(project, sessionID)` aggregating real session compactions (`reason IS NULL OR reason IN ('auto', 'manual')`) and session/project `vault` savings across restarts.
  - Populated `vault.session_id` when archiving pruned tool outputs via `vault.store(refId, entry, event?.sessionID)`.
- **OpenCode `v2.4.1` Verification**:
  - Verified against `@opencode/plugin@2.4.1`, `@opentui/core@0.9.9`, `@opentui/solid@0.9.9`, and `opencode v2.4.1`.
  - **Verification**: **`527 / 527`** tests passing across 28 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked.

## 0.9.2 — 2026-11-23

- **OpenCode `v2.4.0` Non-Blocking Startup & Hot-Reload Recovery (`src/tui.tsx`, `src/pressure.ts`)**:
  - Subscribed `src/tui.tsx` to `plugin.updated`, `model.updated`, and `provider.updated` events so the TUI sidebar resets `hiddenStopped`, `hiddenRetries`, and `modelsSynced` and re-probes RPC/models automatically when background plugin loading or floating `@latest` hot-reload completes on `v2.4.0`.
  - Updated `ensureModelLimit()` in `src/pressure.ts` to allow up to 3 lookup retries per `providerID/id` without burning attempts on empty catalogs returned during `v2.4.0` non-blocking startup.
- **Code Mode (`event.codemode`) Protection in `ToolDedupeRing` (`src/plugin.ts`)**:
  - Skipped `ToolDedupeRing` placeholder substitution when `event.codemode === true` (added to `tool.hook("execute.after")` in `@opencode/plugin@2.4.0`), ensuring Code Mode `execute` scripts always receive actual tool output rather than a dedupe reference stub.
- **Verification**: **`519 / 519`** tests passing across 28 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked against `@opencode/plugin@2.4.0` and `@opentui/*@0.9.7`.

## 0.9.1 — 2026-11-23

- **Multi-Location Hook Isolation Across `tool.execute.after`, `session.context` & `session.compaction` (`src/plugin.ts`)**:
  - Short-circuited `tool.execute.after` and `runPruning` (`session.context` and `session.compaction`) on `foreignEvent(event)` (inspecting `e`, `e.data`, `e.properties`, `e.context`, and `e.session` locations) before any tool compression, context pruning, vault write, cache admission, session pressure tracking, auto-compaction trigger, or stats recording.
- **`autoCompact` Shrinkage Reset & Unconditional 3-Turn Cooldown (`src/plugin.ts`, `src/memory.ts`)**:
  - Automatically clears `inFlight` and updates `lastMsgCount` when a subsequent `session.context` turn observes transcript shrinkage (`msgCount < prev.lastMsgCount`) or pressure drop (`postPressure.ratio < 1.0`) even when `tui.enabled` and `memory.enabled` are both `false`.
  - Added `onCompactionFailed` hook in `setupMemory` to clear `inFlight` on `session.compaction.failed`, and enforced an unconditional 3-turn cooldown (`prev.turnsSince >= 3`) before any repeat auto-compaction trigger.
- **Vault Query-Time Retention, Strict `50,000` `maxChars` Cap & Bounded Redacted Vault Documentation (`src/memory-store.ts`, `src/memory.ts`, `README.md`, `AUDIT.md`)**:
  - Enforced `created_at >= now - retentionMs` at query time in `hasVault()`, `getVault()`, and `listVault()` so expired vault rows older than `retentionDays` are never reported as available or returned before a physical prune pass.
  - Aligned `getVault()` `maxChars` clamping (`200..50,000`, default `12,000`) and `trim_expand` `execute()` input validation (`startLine`, `endLine`, `grep`, `maxChars`) with the declared tool schema, and documented the bounded, secret-redacted (non-lossless) vault recovery semantics.
- **Verification**: **`516 / 516`** tests passing across 28 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked, and real OpenCode V2 host acceptance verified with `compaction.auto: false` + `autoCompact: true`.

## 0.9.0 — 2026-11-23

- **2-Stage Automatic Compaction Guarantee (`autoCompact`) with Loop Protection (`src/config.ts`, `src/plugin.ts`)**:
  - Added `autoCompact` option (`DEFAULTS.autoCompact = true`). On every primary `session.hook("context")` turn, `opencode-trim` first prunes eligible historical tool outputs and reasoning blocks; if the **post-prune** context still meets or exceeds `usableTokens` (`maxTokens`, default `350k`) and has history beyond `protectRecentMessages`, `opencode-trim` automatically calls `ctx.session.compact({ sessionID, delivery: "queue" })`.
  - Added 3-layer `autoCompactState` loop protection per session (`inFlight` lock with 120s timeout cleared on `session.compaction.ended`/`failed`, 3-turn cooldown, and auxiliary request exclusion for `compaction`, `title`, and `generate`).
- **Post-Prune `reportedTokens` Calibration (`src/pressure.ts`, `src/prune.ts`)**:
  - Recorded per-message pruned character deltas (`recordPrunedMsgChars` / `getPrunedMsgChars` via `WeakMap`) during `pruneContext` (with atomic rollback on error) and subtracted their token equivalent (`Math.floor(prunedCharsSoFar / 3)`) from historical assistant `reportedTokens` in `estimateRequest()`. Prevents stale pre-prune provider token counts from inflating post-prune pressure ratios or triggering unnecessary compaction after pruning has already reduced the context below `maxTokens`.
- **`ContextCache` Start-Band (`65%`) Admission Unlock (`src/cache.ts`)**:
  - Tracked `startBandAdmitted` on `CacheSessionEntry` so sessions growing from below `pressureStartRatio` (`< 65%`) into the start band (`>= 65%`) immediately admit a pruning pass once upon crossing the threshold, while keeping the prompt cache stable on subsequent turns within the band.
- **Cryptographically Signed Reasoning/Thinking Protection & Historical Structured Output Pruning (`src/prune.ts`)**:
  - Added `hasReasoningSignature()` to protect signed `reasoning` / `thinking` parts (`signature`, `thought_signature`, `thoughtSignature`, `encrypted_content`, `redacted_thinking`, `rs_...` IDs, and `metadata` / `providerMetadata` / `providerOptions` signature fields) from in-place mutation, preventing provider HTTP 400 signature-mismatch errors while continuing to prune unsigned historical reasoning traces.
  - Scoped `structured(text)` in `src/prune.ts` to PEM blocks (`-----BEGIN `) and binary NUL streams (`\x00`), allowing historical JSON, XML, and HTML tool outputs outside the protected tail to be archived to the recoverable `tool_vault` and pruned (while `src/compress.ts` continues to protect fresh JSON/XML/HTML from line truncation).
- **Verification**: **`513 / 513`** tests passing across 28 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked.

## 0.8.1 — 2026-11-23

- **Plugin-Agnostic Read-Only Tool & CLI Subcommand Matching (`src/prune.ts`, `src/config.ts`)**:
  - Replaced hardcoded third-party tool/CLI names with generic, plugin-agnostic read-only suffix matching (`<prefix>_search|read|grep|glob|list|find|zoom|outline|inspect|view|lookup|symbols|references|definition|callers|callees|imports|tree|stat`) in `eligibleTool()` and generic read-only CLI subcommand matching (`validate`, `status`, `list`, `show`, `view`, `info`, `doctor`, `--version`, `--help`) in `SAFE_SHELL`.
  - Kept `DEFAULTS.pruneEligibleTools` strictly limited to standard core tool names (`["shell", "bash", "read", "grep", "glob", "ls", "list", "search", "find", "webfetch"]`).

## 0.8.0 — 2026-11-23

- **Out-of-the-Box `350k` Default & Screen-Matched Simple Configuration (`src/config.ts`, `src/pressure.ts`, `README.md`)**:
  - Set `DEFAULTS.contextWindowCap = 350000` so 1M+ context models are automatically kept within a `350k` token budget out of the box with zero configuration.
  - Added human-friendly `maxTokens` (`"350k"`, `"350,000"`, `350000`) and `pruneAt` (`"350k"`, `"35%"`, `35`, `0.35`) options, plus string shorthand support on `contextWindowCap`.
  - When a model window is capped (e.g. `350k` on a `1M` model) and the uncapped hardware headroom (`650k`) already covers the output reserve, `usableTokens` now equals the exact `350,000` screen budget (`1:1` match with the OpenCode `Context` screen, without subtracting internal output reserves from the user's cap).
- **Combined V2 `type: "tool"` `state.content` + `state.metadata.output` & `msg.type: "assistant"` Pruning (`src/prune.ts`, `src/cache.ts`)**:
  - Added full pruning and `ContextCache.toolChars` support for combined V2 `type: "tool"` parts whose output resides in `state.content: [{ type: "text", text: "..." }]` and is mirrored in `state.metadata.output`.
  - Updated `candidates()` to recognize `msg.type === "assistant"` alongside `msg.role === "assistant"` when pruning historical `reasoning` / `thinking` traces.
- **Expanded Read-Only Shell & Generic Read-Only Tool Eligibility (`src/prune.ts`, `src/config.ts`)**:
  - Added safe read-only `node -e` / `bun -e` inline inspection scripts (rejecting any mutating FS/process/network APIs or protected files), `node ... --test`, `sqlite3 -readonly`, `seq`, `date`, `$?` exit-status checks, and generic read-only CLI subcommands (`validate`, `status`, `list`, `show`, `view`, `info`, `doctor`, `--version`, `--help`) to `readOnlyCommand()`.
  - Added `webfetch` to `DEFAULTS.pruneEligibleTools` and generic plugin-agnostic read-only tool suffix matching (`*_search`, `*_read`, `*_grep`, `*_glob`, `*_list`, `*_find`, `*_zoom`, `*_outline`, `*_inspect`, `*_view`, `*_lookup`, `*_symbols`, `*_references`, `*_definition`, `*_callers`, `*_callees`, `*_imports`, `*_tree`, `*_stat`) in `eligibleTool()`.
- **Verification**: **`508 / 508`** tests passing across 28 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked, and verified against a real `681k`-token (`775`-message) OpenCode V2 session (`413` items / `1.58 MB` + `700 KB` duplicate metadata output reclaimed in one pass).

## 0.7.3 — 2026-11-23

- **`contextWindowCap` vs. Large `model.output` Reserve Fix & V2 `step-finish` Token Calibration (`src/pressure.ts`, `src/plugin.ts`)**:
  - Bounded `model.output` contribution to `reserve` at `Math.floor(context * 0.25)` so models with large output limits (e.g. `context: 1000000, output: 384000`) combined with `contextWindowCap` (e.g. `350000`) always compute valid `usableTokens` and pressure `ratio` instead of returning `undefined`.
  - Extended `extractMsgReportedTokens()` to read provider token counts from `msg.info.tokens`/`usage` and V2 `step-finish` parts (`input + output + reasoning + cache.read + cache.write`), and recorded the calibrated token count in `contextStats`.
- **Compound Read-Only Shell Pruning (`src/prune.ts`, `test/synthesis-upgrades.test.ts`)**:
  - Updated `readOnlyCommand()` to strip harmless descriptor merges (`2>&1`, `1>&2`, `>/dev/null`, `2>/dev/null`), split top-level `&&` / `|` / `;` segments via `splitSegments()`, and validate each segment independently against `SAFE_SHELL` and `!mutatingArgs()`.
  - Added `cd`, `cat`, `nl`, `sed` (rejecting `-i`/`--in-place`/`-f`/`--file` and `w` write commands), generic read-only CLI subcommands, and `git -C <dir> ...` to `SAFE_SHELL`, while continuing to block mutating compound commands, file redirects, and instruction/secret files (`protectedShell`).
- **Verification**: **`505 / 505`** tests passing across 28 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked.

## 0.7.2 — 2026-11-23

- **Vault Ref Discovery Mode, Safe Regex/Case Grep & Bounded Expansion (`src/memory-store.ts`, `src/memory.ts`, `test/synthesis-upgrades.test.ts`)**:
  - Added `store.listVault()` and made `id` optional on `trim_expand`: omitting `id` enters discovery mode, returning recent cached vault refs (`id`, `tool`, `target`, `totalLines`, `date`) and `totalVaultRows` capacity with optional `tool`, `target`, and `limit` (`1..50`) filters.
  - Added ReDoS-guarded `regex` and `caseSensitive` options to `trim_expand` `grep` filtering and tightened default `maxChars` from `20,000` to `12,000` characters (configurable `200..50000`).
- **Compaction History Search Filters (`src/memory-store.ts`, `src/memory.ts`)**:
  - Extended `trim_history_search` and `store.search()` with optional `sessionID`, `days` (`1..3650` recency window), `limit` (`1..20`), and `fullSection` (`2,400`-char expanded excerpt) filters.
- **Verification**: **`503 / 503`** tests passing across 28 suites (`npm run check`), `tsc --noEmit` clean (`0` errors), `94 / 94` files syntax-checked.

## 0.7.1 — 2026-11-22

- **Node.js 26 `node_modules` Package Exports Fix (`package.json`, `test/tui-package.test.ts`)**:
  - Updated `package.json` `exports` (`.`, `./core`, `./prune`, `./pressure`, `./rpc`, `./tui`) to target compiled `./dist/*.js` entrypoints and `./dist/*.d.ts` type declarations instead of raw `.ts`/`.tsx` sources, resolving `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` when imported from `node_modules` under Node.js 26.
  - Enabled public package publishing by removing `"private": true` from `package.json`.
- **Live OpenCode V2 Host Acceptance & Verification**:
  - Verified against isolated **OpenCode V2 (`v2.3.2`)** host (`opencode plugin list`, `opencode serve`, live sessions, `trim_expand` / `trim_history_search`, `agentDenylist`, foreign-directory isolation, malformed config fail-safe, and Node `26.13.1` + Bun `1.4.5` package exports).
  - **`500 / 500`** tests passing (`npm run check`), `tsc --noEmit` clean, `94 / 94` files syntax-checked.

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
- **Advanced Context Pruning & Bounded Secret-Redacted Vault (`src/prune.ts`, `src/memory-store.ts`, `src/memory.ts`)**:
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
