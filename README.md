# ✂️ OpenCode Trim

[![npm version](https://img.shields.io/npm/v/opencode-trim?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/opencode-trim)
[![npm downloads](https://img.shields.io/npm/dm/opencode-trim?color=blue&logo=npm&logoColor=white)](https://www.npmjs.com/package/opencode-trim)
[![OpenCode: V2 (>=2.3.0)](https://img.shields.io/badge/OpenCode-V2%20(%3E%3D2.3.0)-10b981?logo=terminal&logoColor=white)](https://opencode.ai)
[![V2 host baseline](https://img.shields.io/badge/Host%20baseline-v2.4.1%20verified-10b981?logo=checkmarx&logoColor=white)](AUDIT.md)
[![Tests: 577/577 Passing](https://img.shields.io/badge/Tests-577%2F577%20Passing-339933?logo=githubactions&logoColor=white)](AUDIT.md)
[![Node.js](https://img.shields.io/badge/node-%5E26.0.0-339933?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[Installation](#-installation) · [How Compression & Pruning Work](#-how-compression--pruning-work) · [24 Command Families](#-the-24-command-families) · [TUI Sidebar](#️-tui-sidebar-interface) · [Compaction Memory (FTS5)](#-optional-compaction-memory-phase-1--11--sqlite-fts5) · [Plugin Mesh Coordination](#-universal-plugin-mesh-coordination) · [Configuration](#️-configuration) · [Validation](#-validation--testing)

A high-performance, deterministic, silent-by-default **OpenCode V2** (`@opencode/plugin` `>=2.3.0`) tool-output compression, prompt-cache-aware context pruning, recoverable pruning vault, and optional FTS5 compaction-memory plugin for AI coding agents.

OpenCode Trim operates **100% standalone (`Solo`)** with zero runtime dependencies and automatically coordinates in any $2^N$ combination with **[OpenCode Guardian](https://github.com/huseyincig/opencode-guardian)**, **[OpenCode Smart Questions](https://github.com/huseyincig/opencode-smart-questions)**, **[OpenCode Hi](https://github.com/huseyincig/opencode-hi)**, and **[OpenCode Lazy Skill Engine](https://github.com/huseyincig/opencode-lazy-skill-engine)** via the Universal OpenCode V2 Plugin Mesh Bridge (`src/bridge.ts`).

---

## 📊 Verification & Live Acceptance

> OpenCode Trim **v0.12.1** was verified on **25 November 2026** against **OpenCode V2 (`v2.4.1`, `>=2.3.0`)** on Node **26.13.1** and Bun **1.4.5**.

- **Current Automated Verification:** **577 / 577** unit, diagnostic-preservation, security, multi-location isolation, Universal Plugin Mesh interoperability, list-path prefix compaction, cold-cache break-even gating, write-invalidated stale-read pruning, `supersedeWrites` & aged oversized `tool-call` input pruning, atomic `trim_reduce` span collapse (with stable replay & rollback) & `/trim flush`, persistent `prune_decisions` across restarts, pressure-adaptive thresholds, aged read-only diff & resolved verification-error pruning, zero-LLM local semantic relevance ranking, selective ingestion virtualization (`virtualizeOutputChars` across `shell` and `webfetch`), OpenCode V2 `ReasoningPart.encrypted` protection, live-disk vault exclusion (`liveDiskNotice` across read-only tools and pure file-reading shell commands), FNV-1a `stableMessageKey` replay, post-compaction verification, top-3 tool bloat & overhead diagnostics, SQLite FTS5 memory (`recent`/`scope: "all"` + opt-in frozen `<recent_work>`), vault-wide `trim_expand` search (with smart line-numbering and ReDoS-hardened regex grep), real provider token accounting (`session.step.ended`), `session.deleted`/`fork` lifecycle, non-blocking startup prewarm, 2-stage auto-compaction fallback, OpenCode `v2.4.1` Code Mode, and low-overhead dynamic 3-mode TUI + `/trim` slash command tests passing (`npm run check` — strict `tsc --noEmit`, `dist/` build, 96-file syntax check, 31 test suites).
- **Deterministic Compression & Pruning Benchmark (`npm run bench`):**
  - **24 Command Families:** `1,801,616 B` input → `2,483 B` output (`≈99.86%` reduction on the adversarial progress/noise corpus, `allChanged: true`, per-family median **0.04–0.20 ms** with RAM LRU memoization).
  - **Context Pruning:** `388 / 400` eligible historical tool results pruned (`757,266` characters / `≈252,422` estimated tokens reclaimed, median `≈7 ms`).
- **Packed Tarball & Dual-Runtime Verification:** `npm pack` `.tgz` artifact verified in isolated Node **26.13.1** and Bun **1.4.4** sandboxes across `.`, `./tui`, `./rpc`, `./core`, `./prune`, and `./pressure` entrypoints.
- **Live OpenCode V2 Host Acceptance:** Verified plugin load, `tool.execute.after` shell compression, `session.context` pruning, real-provider compression/pruning (`opencode-go/deepseek-v4.1-flash` and `opencode-go/beam-free`), SQLite FTS5 compaction archiving & `trim_history_search`, multi-location fail-closed isolation, and TUI sidebar rendering across 80–200 column widths.

Read the comprehensive [Audit & Production Acceptance Report](AUDIT.md) for reproduction commands, host evidence, and documented boundaries, and see the [0.12.1 release notes](CHANGELOG.md) for the latest changes.

---

## ✨ Key Highlights

- **Pure OpenCode V2 Architecture:** Built natively for **OpenCode V2** (`@opencode/plugin >=2.3.0`) with dedicated `.` (server), `./tui` (OpenTUI/Solid sidebar), `./rpc` (`opencode-trim-stats`), `./core`, `./prune`, and `./pressure` exports.
- **24 Deterministic Command-Family Compressors:** Purpose-built compressors for `git`, `npm`, `pnpm`, `bun`, `cargo`, `pytest`, `vitest`, `jest`, `tsc`, `eslint`, `biome`, `go`, `ruff`, `prettier`, `playwright`, `docker`, `kubectl`, `terraform`, `gradle`, `make`, `pip`, `uv`, `curl`, and `wget`.
- **Fail-Closed Diagnostic & Structured-Data Preservation:** Independently verifies that every error, warning, stack frame, exit notice, and summary line survives before accepting any candidate. Leaves JSON, JSONC, YAML, TOML, INI, CSV, TSV, XML, PEM, binary streams, mixed media, and Git diffs/patches (`diff`, `show`, `blame`, `apply`, `patch`, `format-patch`, `diff-tree`, `range-diff`, `am`, `request-pull`, `diff-index`, `diff-files`, `cherry-pick`, `log -p`, `stash show -p`, `show-branch -p`, `status -v`) byte-identical.
- **Prompt-Cache-Aware Context Pruning:** Retains per-session pruning decisions in memory and replays them byte-identically across turns so provider prompt caches are never churned on stable history. Admits new drops only on natural identity changes, force-band pressure (`>= 85%`), compaction-input passes, or absolute tool-char budget growth.
- **Evidence-Based Supersession:** Replaces earlier read-only tool outputs when superseded by an identical command/query or a wider `read` line range (`later.start <= earlier.start && later.end >= earlier.end`).
- **Instruction, Secret & Write Protection:** Never prunes user/assistant prose, system prompts, write/edit/patch/task/question/todo/permission/security/memory/MCP tools, failed or nonzero-exit tool runs, or instruction/secret files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `PROTOCOL.md`, `SKILL.md`, `.env*`, `.pem`, `.key`, `.npmrc`, `.netrc`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`, `secrets.json`).
- **Compact Guardian-Grade TUI Sidebar (`./tui`):** Opt-in (`tui.enabled: true`), borderless `sidebar.content` widget featuring `▶` / `▼` disclosure, two-column `StatRow` metrics, host-native context usage (`input + cache.read` over catalog limit), persisted compaction-history fallback after server restarts, and RPC-first probing with bounded hidden retries.
- **Optional SQLite FTS5 Compaction Memory (`memory.enabled: true`):** Default-off Phase 1 & 1.1 archive using Node 26 built-in `node:sqlite` + FTS5. Observes native compaction summaries, scrubs secrets fail-closed (`[REDACTED]`), enforces composite `UNIQUE(project, event_id)` isolation, and exposes section-aware `trim_history_search` (`codemode: false`).
- **Universal V2 Plugin Mesh Bridge (`src/bridge.ts`):** Zero-dependency N-way interoperability (`BRIDGE_REVISION: 2.3.1`) with sibling OpenCode V2 plugins: honors `isTrimMeshProtected` and cryptographic provenance tokens (`verifyMeshMetadata`), skips already-bounded outputs (`wasMeshBounded`), stamps `boundedBy: "opencode-trim"`, and cleans up session state on `session.deleted`.
- **Smart Context Cap, 2-Stage Auto-Compact Fallback, Token Calibration & Bounded Secret-Redacted Vault (`trim_expand`):** Supports `contextWindowCap` (`"250k"` out-of-the-box default) for 1M+ models, 2-stage automatic compaction fallback (`autoCompact: true` — prunes first, then triggers `ctx.session.compact({ sessionID, delivery: "queue" })` with in-flight/cooldown loop protection if post-prune context still reaches `maxTokens`), post-prune provider-reported token calibration, start-band (`65%`) prompt-cache admission unlocking, cold-cache opportunity window (`cacheTtlMs: 300000`) + warm-cache break-even gating (`cacheMinSavingsChars: 6000`), write-invalidated stale-read pruning, signed reasoning/thinking block protection (`signature`, `thought_signature`, `encrypted_content`), historical JSON/XML/HTML pruning, compaction-boundary cache reset, structural cleaners (`scrubBlobs`, `filterDebugLogs`, `collapseStackTraces`, `collapseTablePadding`, `collapseRepetitionLoops`) with bounded RAM LRU memoization, `pruneHistoricalReasoning`, `pruneUnrelatedDiagnostics`, `purgeErrorInputs`, `ToolDedupeRing` (`dedupeWindow: 8`), `prunePreviewLines: 2`, and a bounded, secret-redacted SQLite `vault` (`trim_expand` with ref discovery, line-range & bounded regex `grep` slicing).
- **Strict TypeScript & Zero Runtime Dependencies:** Pure strict TypeScript (`src/*.ts`, `src/tui.tsx`) compiled to `dist/*.js` + `.d.ts` targeting Node.js 26 Active LTS (`^26.0.0`) with zero external runtime dependencies.

---

## 📦 Installation

The current version is **0.12.1** (OpenCode **V2 `>=2.3.0`**, verified on **`v2.4.1`**, Node.js **`^26.0.0`**).

OpenCode Trim supports **Global**, **Project-Local**, **`.opencode/plugins/` Local Wrapper / Symlink**, **Local Development (`file://`)**, and **Remote TUI Client (`cli.json`)** installation modes.

> [!IMPORTANT]
> OpenCode V2 automatically discovers `./tui` and `./rpc` from `package.json` `exports` when loading `opencode-trim` — do **not** duplicate `"opencode-trim/tui"` in `opencode.json`.

### 1. 🌍 Global Installation (All Workspaces — Recommended)

To enable OpenCode Trim across **all** repositories and workspaces on your machine, add `opencode-trim@latest` to your global OpenCode configuration file (`~/.config/opencode/opencode.json`, `~/.config/opencode/opencode.jsonc`, `$XDG_CONFIG_HOME/opencode/opencode.json`, or `$OPENCODE_CONFIG_DIR/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-trim@latest"
  ]
}
```

Or pin an exact version and configure optional features (such as the TUI sidebar and FTS5 compaction memory):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    [
      "opencode-trim@0.12.1",
      {
        "maxTokens": "250k",
        "tui": {
          "enabled": true
        },
        "memory": {
          "enabled": true,
          "retentionDays": 60,
          "recentWork": true
        }
      }
    ]
  ]
}
```

You can also install the package globally via npm so it is cached offline across all environments:

```bash
npm install -g opencode-trim
```

### 2. 📁 Project-Local Installation (Single Repository / Team Setup)

To enable OpenCode Trim **only** for a specific repository, add `opencode-trim@latest` to `<project>/opencode.json` (or `<project>/.opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-trim@latest"
  ]
}
```

Or install it into your project's `node_modules` via npm:

```bash
npm install -D opencode-trim
```

- **Strict Multi-Location Isolation:** When running on a shared multi-location OpenCode server, Trim canonicalizes workspace directories via `realpathSync` / `path.resolve` and short-circuits foreign or conflicting events (`foreignEvent`) across `tool.execute.after`, `session.context`, `session.compaction`, compaction event subscriptions, and stats so tool compression, context pruning, vault writes, cache/session state, auto-compaction triggers, and TUI stats never cross project boundaries.

### 3. 🔗 `.opencode/plugins/` Directory or Symlink Installation (Monorepo & Air-Gapped)

If you manage plugins via OpenCode's `plugins/` directory (globally at `~/.config/opencode/plugins/opencode-trim` or project-locally at `<project>/.opencode/plugins/opencode-trim`):

1. Copy or symlink the repository into your OpenCode plugins directory:
   ```bash
   mkdir -p ~/.config/opencode/plugins
   ln -s /absolute/path/to/opencode-trim ~/.config/opencode/plugins/opencode-trim
   ```
2. Reference it in `~/.config/opencode/opencode.json` (note that relative `package` paths resolve relative to the **config directory**):
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [
       {
         "package": "./plugins/opencode-trim",
         "options": {
           "enabled": true,
           "shell": true,
           "toolFiltering": true,
           "pruning": true,
           "tui": { "enabled": true }
         }
       }
     ]
   }
   ```

### 4. 🧩 Package Exports & Entrypoints

OpenCode V2 automatically resolves the server and TUI entrypoints from `"opencode-trim"`, or you can import subpaths directly in custom hosts and scripts:

| Subpath | Export Target | Description |
| :--- | :--- | :--- |
| `opencode-trim` (`.`) | `./index.ts` | OpenCode V2 Promise server plugin (`id: "opencode-trim"`, `setup(ctx)`) |
| `opencode-trim/tui` | `./src/tui.tsx` | OpenCode V2 TUI sidebar plugin (`id: "opencode-trim.tui"`, `sidebar.content` slot) |
| `opencode-trim/rpc` | `./src/stats-rpc.ts` | Shared JSON-Schema RPC definition (`id: "opencode-trim-stats"`) |
| `opencode-trim/core` | `./src/compress.ts` | Standalone shell output compressor & 24 command-family dispatcher |
| `opencode-trim/prune` | `./src/prune.ts` | Standalone outgoing context pruner & supersession analyzer |
| `opencode-trim/pressure` | `./src/pressure.ts` | Model limit resolver & conservative token/pressure estimator |

### 5. 🛠️ Local Development (`file://` Source Checkout)

Clone the repository and load it directly via a `file://` URL in your global or project `opencode.json`:

```bash
git clone https://github.com/huseyincig/opencode-trim.git
cd opencode-trim
npm run check
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    [
      "file:///absolute/path/to/opencode-trim",
      {
        "tui": { "enabled": true },
        "memory": { "enabled": true }
      }
    ]
  ]
}
```

### 6. 🖥️ Remote Server / Split TUI Client (`cli.json`)

For CLI-only remote-server connections where the OpenCode server runs on a remote host and your local terminal runs only the TUI client, configure `"opencode-trim/tui"` in `~/.config/opencode/cli.json`:

```json
{
  "plugins": [
    "opencode-trim/tui"
  ]
}
```

### Installation Scope & Storage Summary

| Mode / Feature | Config Location | Active Scope | Disk Persistence | Touches `<project>/.opencode/`? |
| :--- | :--- | :--- | :--- | :---: |
| **Default (Silent)** | Global or Project `opencode.json` | Configured workspace(s) | **None** (100% in-memory) | **No** |
| **TUI Sidebar (`tui.enabled: true`)** | `options.tui.enabled` | Per-location RPC & sidebar | Only boolean `expanded` in host UI storage | **No** |
| **Memory (`memory.enabled: true`)** | `options.memory.enabled` | Per-project isolated FTS5 rows | `$XDG_DATA_HOME/opencode-trim/memory.db` (`0600`) | **No** |

---

## ⚡ How Compression & Pruning Work

1. **Post-Execution Tool Hook (`ctx.tool.hook("execute.after")`)**:
   - Inspects completed `shell` / `bash` and list/search (`grep`, `glob`, `ls`, `list`, `find`) results.
   - If a sibling mesh plugin already bounded the output (`wasMeshBounded`), records the run in stats and skips re-compression.
   - Bypasses protected Git patch/diff commands, secret-viewing commands, structured payloads (JSON/YAML/TOML/INI/CSV/TSV/XML/PEM), binary streams, and mixed-media results.
   - Routes shell outputs through user `filterRules` and the **24 command-family compressors** (or generic consecutive-duplicate folding and passing-test compaction).
   - Verifies that every failure, warning, stack frame, exit notice, and summary line survived and at least `minSavingsRatio` (`15%`) was saved; stamps `metadata["opencode-mesh"].boundedBy = "opencode-trim"`.
2. **Outgoing Model Context Hook (`ctx.session.hook("context")`)**:
   - Pairs `tool-call` parts with `tool-result` parts in strict FIFO order per `callId`.
   - Protects mesh-stamped parts (`isTrimMeshProtected` with provenance token verification), failed/nonzero-exit results, write/edit/task/question/todo/security/MCP tools, instruction/secret files, structured/diagnostic outputs, the newest `protectRecentMessages` (`10`), a token-sized tail (`protectRecentTokens`, `4096` floor / `6%–25%` of usable window), and the newest `keepRecentToolResults` (`8`).
   - Replays committed per-session drops from `ContextCache` for prompt-cache stability, admitting new drops only when context pressure, range supersession, or the absolute tool-char budget authorizes reclamation.

---

## 🔄 Architecture & Turn Lifecycle

```mermaid
flowchart TD
    subgraph ToolHook["1. Post-Execution Tool Hook (tool.execute.after)"]
        TE["Completed tool result received"] --> MB{"Already mesh-bounded?"}
        MB -->|Yes| SkipMB["Record run in stats; skip re-compression"]
        MB -->|No| Kind{"Tool category?"}
        Kind -->|Shell / Bash| Guard{"Protected Git / Secret / Structured / Binary?"}
        Guard -->|Yes| KeepRaw["Preserve byte-identical output"]
        Guard -->|No| Fam["Dispatch 24 Command Families -> Generic Filter & Runner Compaction"]
        Kind -->|List / Search| Dedup["Fold consecutive identical lines only"]
        Fam --> Verify{"Diagnostics, summaries, exit notice & >=15% savings intact?"}
        Dedup --> Verify
        Verify -->|No| KeepRaw
        Verify -->|Yes| Stamp["Apply compressed output & stamp boundedBy='opencode-trim'"]
    end

    subgraph ContextHook["2. Outgoing Context Hook (session.context / session.compaction)"]
        CE["Outgoing model request"] --> Pair["Pair tool-call & tool-result in FIFO callId order"]
        Pair --> Filter["Exclude mesh-protected (provenance verified), errors, writes, instructions, diagnostics & live tail"]
        Filter --> Cache{"ContextCache admission (identity / >=85% force / supersession / size budget)?"}
        Cache -->|Deferred| Replay["Replay previously committed plannedDrops only"]
        Cache -->|Admitted| Select["Select superseded & oldest eligible results to meet target"]
        Replay --> Rewrite["Replace selected tool outputs with deterministic PRUNED placeholder"]
        Select --> Rewrite
    end
```

---

## 🧰 The 24 Command Families

Each command family removes only its own low-value progress chatter or passing-row noise while preserving diagnostics, warnings, file/line anchors, and final summaries:

| Category | Families | What Is Compressed | What Is Always Preserved |
| :--- | :--- | :--- | :--- |
| **Version Control** | `git` | Clone/fetch/push transfer progress (`Counting`, `Compressing`, `Receiving %`) | Status records, branch refs, commit log rows, all diffs/patches/blames |
| **JS / TS Package Managers** | `npm`, `pnpm`, `bun` | Registry download bars, `npm notice/sill/verb`, resolution spinners | Lifecycle errors, peer warnings, audit summaries, final `added N packages` |
| **Test Runners** | `vitest`, `jest`, `pytest`, `playwright`, `go` | Individual passing test rows (`✓`, `PASS`, `... ok`, dot progress) once summary is confirmed | Any failing test, assertion diff, stack trace, warning, or suite summary |
| **Compilers & Linters** | `tsc`, `eslint`, `biome`, `ruff`, `prettier` | Watch-mode clear-screen chatter, clean file check lines | Every compiler/lint code (`TS####`, `[EFW]###`), file:line:col anchor, and summary |
| **Rust & Native Builds** | `cargo`, `make`, `gradle` | `Compiling` / `Downloading` / `> Task UP-TO-DATE` / `Entering directory` chatter | Compiler warnings/errors, linker failures, `BUILD SUCCESSFUL/FAILED` |
| **Python Packaging** | `pip`, `uv` | `Downloading`, `Collecting`, progress bars, `Resolved/Prepared` lines | Dependency conflicts, build errors, `Successfully installed` summary |
| **Containers & Cloud** | `docker`, `kubectl`, `terraform` | Layer pull/extract progress, `Refreshing state...`, dot waits | Failed layers, pod errors, plan/apply changes, resource summaries |
| **Network Transfers** | `curl`, `wget` | Multi-line `% Total / % Received` and `[===>]` progress meters | HTTP headers, response bodies, TLS/connection errors, final transfer line |

---

## 🖥️ TUI Sidebar Interface

OpenCode Trim includes an optional V2 TUI extension (`./tui`) that mounts a borderless native-style section at the bottom of OpenCode's `sidebar.content` slot.

### 🔌 Enabling the TUI Sidebar

Because OpenCode V2 auto-discovers `./tui` from `package.json`, the sidebar uses server-side `tui.enabled: true` as its single opt-in and stays completely hidden (stopping background probes after bounded retries) when `tui.enabled` is `false`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    [
      "opencode-trim@latest",
      {
        "tui": { "enabled": true }
      }
    ]
  ]
}
```

### 🔽 Open / Normal View (Default)

```text
▼ [ trim ] v0.11.4 · ● healthy

  ██████████████████████████████████
  sys 10%      chat 24%     tools 66%
  Context             106k/250k · 42%
  Compactions       1 compact · 12m ago
```

- **Header:** Clickable 3-mode pill header (`▼ [ trim ]` / `▶ [ trim ]`) cycling **Normal → Detail → Minimal**, showing current version (`v0.11.4`), live health status (`● healthy` / `● caution` / `● critical`), and status marker (`!` when stale, `?` before first snapshot).
- **Centered 100%-Filled 3-Color Composition Bar:** Always fills 100% of the bar width centered inside the sidebar with `sys` (purple), `chat` (cyan), and `tools` (green) estimated character shares, with bold aligned `sys X%` / `chat Y%` / `tools Z%` percentages directly underneath (`sys + chat + tools = 100%`).
- **Dynamic Two-Column `StatRow` Metrics & `/trim` Command:** `Context` adapts automatically to the user's active configuration (`maxTokens` / `pruneAt` cap when active, or full model window otherwise, evaluated against configured `pressureStartRatio` / `pressureForceRatio`). Run **`/trim`** (or `/trim-gain`) in the prompt for a full savings breakdown (including top-3 tool consumers, system/schema overhead diagnostics, and post-compaction effectiveness check), or `/trim minimal | normal | detail | toggle` to switch sidebar modes.

### 🔼 Expanded / Detail View & Minimal Collapsed View

Clicking the `trim` header cycles to the two-column detail breakdown and then to the 1-line minimal bar:

```text
▼ [ trim ] v0.11.4 · ● healthy

  ██████████████████████████████████
  sys 10%      chat 24%     tools 66%
  Context       106k/250k · 42% (1M)
  Session                        14d
  Compactions       1 manual compact
  Saved                   -18M chars
  Cache                       stable
  Memory             3 sum · 12 vault
```

```text
▶ [ trim ]   ██████████████   30%
```

- **Config-Driven & Session vs. Project Separation:** `Session` (host `session.time.created`), `Compactions`, `Saved`, and `Cache` (hidden when `pruning: false`) stay strictly session-scoped; `Memory` appears only when `memory.enabled: true` (or reporting an error) and displays project-wide summaries and vault refs.
- **Restart-Resilient DB & Host Fallback:** When live in-memory counters reset on server restart, the sidebar hydrates real session compaction counts/ages and session `vault` savings from persisted host messages and SQLite `memory.db` (`sidebarStats`).
- **Privacy-Safe RPC (`opencode-trim-stats`):** Snapshots carry only numeric counters, character breakdowns, and enum states — never file paths, commands, queries, prompt text, or model names.

---

## 🧠 Optional Compaction Memory (Phase 1 & 1.1 — SQLite FTS5)

When `memory.enabled: true` is configured, OpenCode Trim archives native compaction summaries into a local SQLite FTS5 database and exposes the `trim_history_search` tool (`codemode: false`).

- **Observe-Only Archiving:** Listens to `session.compaction.started`, `session.compaction.ended`, and `session.compaction.failed`. Never triggers compaction or synthesizes summaries.
- **Fail-Closed Multi-Location Isolation:** Collects canonical absolute locations from `event.location`, `event.data.location`, and `event.properties.location`; rejects absent, relative, ambiguous, conflicting, or foreign events before archiving.
- **Structured Secret Redaction:** Scrubs PEM blocks, `Bearer`/`Basic` tokens, JWTs, OpenAI/Anthropic/GitHub/GitLab/Slack/AWS/Google/npm keys, URL passwords, and nested secret-keyed JSON/env values (`[REDACTED]`). Unclosed or over-depth structured values fail closed through the end of the text.
- **Section-Aware FTS5 Search (`trim_history_search`):**
  - Parses canonical Markdown `##` headings (`objective`, `requirements`, `decisions`, `work_state`, `next_move`, `relevant_files`, `important_context`), tolerating case, spaces, hyphens, numbering, and colons while ignoring headings inside fenced code blocks.
  - Supports optional `section`, `sessionID`, `days` (recency window), `limit` (`1..20`), and `fullSection` (`2,400`-char expanded excerpt vs `400`-char snippet) filters.
  - Ranks matches by distinct query-term hits first, then newest within the same session, then BM25 rank and recency (scanning up to `1,000` rows / `8,000,000` chars inside a read transaction).
  - Enforces `agentAllowlist` and `agentDenylist` in `ctx.tool.hook("execute.before")`.
- **Bounded, Secret-Redacted Recoverable Pruning Vault & Ref Discovery (`trim_expand`):**
  - Stores pruned tool outputs in a project-scoped SQLite `vault` table (`maxVaultRows: 500` per project, `retentionDays: 60` default).
  - **Not Byte-For-Byte Lossless (Redaction, Truncation & Retention Boundaries):**
    1. **Secret Redaction:** Every stored output is scrubbed via `redactSecrets` (`[REDACTED]`) before insertion; unclosed or over-depth (`>32` nesting or `>200,000`-char scan window) structured secret values fail closed and redact through the end of the text. Redacted secrets cannot be recovered verbatim.
    2. **Storage & Retrieval Truncation:** Inputs over `MAX_TEXT_CHARS` (`1,000,000` chars) are sliced before storage. On retrieval, `trim_expand` prepends 1-based line numbers (`1: ...`), caps per-line regex testing at `4,096` chars, and truncates the returned text at `maxChars` (default `12,000`, configurable `200..50,000` chars).
    3. **Capacity & Time Retention:** Oldest entries are evicted past `500` rows per project (`maxVaultRows`), and entries older than `retentionDays` (`1..3650` days) are excluded at query time (`hasVault`, `getVault`, `listVault`) and physically pruned on store open/prune. Evicted or expired refs fail closed to `expiredNotice`.
  - **Ref Discovery Mode:** Calling `trim_expand` without `id` lists active non-expired cached refs (`id`, `tool`, `target`, `totalLines`, `date`, and `totalVaultRows` capacity) with optional `tool`, `target`, and `limit` (`1..50`) filters.
  - **Slicing & Bounded Regex Grep:** Passing `id` (`"trm_..."`) restores the redacted excerpt with optional `startLine`, `endLine`, `grep` (`<=200` chars), `regex` (ReDoS-guarded), `caseSensitive`, and `maxChars` (`200..50,000`) bounds.

---

## 🤝 Universal Plugin Mesh Coordination

OpenCode Trim includes the Universal OpenCode V2 Plugin Mesh Bridge (`src/bridge.ts`, `BRIDGE_REVISION: 2.3.1`, `Symbol.for("opencode.mesh.v2")`):

- **Publishes `context.prune`:** Registers `opencode-trim` in the directory-scoped mesh registry (`registerMeshPeer`) and unregisters cleanly on teardown.
- **Respects Protected Turns & Provenance (`isTrimMeshProtected`):** Never prunes tool outputs or synthetic remediation/handoff/task-contract/skill-injection turns protected by **[OpenCode Guardian](https://github.com/huseyincig/opencode-guardian)**, **[OpenCode Smart Questions](https://github.com/huseyincig/opencode-smart-questions)**, **[OpenCode Hi](https://github.com/huseyincig/opencode-hi)**, or **[OpenCode Lazy Skill Engine](https://github.com/huseyincig/opencode-lazy-skill-engine)**. Inspects all metadata holders (`part`, `part.result`, `part.state`, `part.payload`, `msg`) and verifies cryptographic provenance tokens (`verifyMeshMetadata`) against active session ledgers.
- **Bidirectional Output Bounding (`wasMeshBounded` / `boundedBy`):** Skips re-compressing tool results already bounded by a sibling plugin and stamps `metadata["opencode-mesh"].boundedBy = "opencode-trim"` on compressed results so downstream plugins never double-truncate.
- **Session Lifecycle Hygiene:** Excludes mesh-protected tool results from `ContextCache` absolute character budgets and invokes `forgetMeshSession(sessionID)` on `session.deleted`.

---

## ⚙️ Configuration

OpenCode Trim works **out of the box with zero configuration** (automatically capping 1M+ model context windows at **`250k` tokens** with **`autoCompact: true`**, `dedupeWindow: 8`, `prunePreviewLines: 2`, and cold-cache/break-even gating so sessions stay fast, focused, and cache-friendly).

### 🎯 Recommended Full `opencode.json` Setup (Best Stability & Performance)

For the most stable, low-latency experience in `opencode.json`, combine OpenCode's compaction setting with OpenCode Trim's screen-matched `"maxTokens": "250k"`, 2-stage `autoCompact` guarantee, TUI sidebar, and compact 60-day memory + frozen `<recent_work>`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": {
    "auto": false
  },
  "plugins": [
    {
      "package": "opencode-trim@latest",
      "options": {
        "maxTokens": "250k",
        "autoCompact": true,
        "compactionInputPruning": true,
        "tui": {
          "enabled": true
        },
        "memory": {
          "enabled": true,
          "retentionDays": 60,
          "recentWork": true
        }
      }
    }
  ]
}
```

#### 🔄 How the 2-Stage `"250k"` Lifecycle Works in Practice

1. **Stage 1 — Continuous Pruning First (Keep Context Under `250k` Without Resetting Memory):**
   - As your session grows (or even if you install the plugin on an existing **`650k+` token** session), OpenCode Trim first prunes old read-only tool outputs (`shell`, `read`, `grep`, `glob`, `webfetch`, `<prefix>_search|zoom|outline...`), write-invalidated stale `read`s, and unsigned historical reasoning traces into the recoverable SQLite `tool_vault` (`<trim-ref id="trm_..." />` with 2-line head/tail preview), while protecting the last 10 messages, last 8 tool results, and active diagnostics.
   - **65% (`~162k` tokens):** Soft pruning begins (and cold-cache idle `>= 5m` or cache-miss turns clean up with zero cache penalty).
   - **85% (`~212k` tokens):** Force-band pruning reclaims older tool outputs.
   - **94% (`~235k` tokens):** Critical-band pruning reclaims maximum eligible tool mass.
   - If pruning brings a large session back down below `250k` (e.g. to `~140k–180k`), **compaction is skipped** so your conversation history is not reset.
2. **Stage 2 — Automatic Compaction Fallback (`autoCompact: true`):**
   - When plain conversation text alone fills `250k+` tokens (so even **after** pruning all eligible old tool outputs, the remaining context still meets or exceeds `maxTokens`), OpenCode Trim automatically triggers `ctx.session.compact({ sessionID, delivery: "queue" })` (with a 3-layer `inFlight` + 3-turn cooldown + message-count hysteresis guard so it never loops) and verifies post-compaction reduction on the next turn.

### 🎛️ Simple Options Reference

You only need to enter the exact **token count** (e.g. `"250k"` or `250000`) or **`% used`** (e.g. `"25%"`) you see on the OpenCode `Context` screen — no manual reserve or ratio math required:

| Simple Option | Default | Examples | What It Does |
| :--- | :---: | :--- | :--- |
| `maxTokens` | `"250k"` (`250000`) | `"250k"`, `"350k"`, `250000`, `0` | Direct target context ceiling matching the OpenCode `Context` token counter (`0` = uncapped model limit). |
| `pruneAt` | — | `"250k"`, `"25%"`, `25`, `0.25` | Direct threshold by token count (`"250k"`) or percentage of model window (`"25%"`). |
| `autoCompact` | `true` | `true` / `false` | 2-stage automatic guarantee: prunes eligible old tool/reasoning outputs first, then triggers `ctx.session.compact({ sessionID, delivery: "queue" })` if post-prune context still reaches `maxTokens`. |
| `compactionInputPruning` | `false` (Recommended: `true`) | `true` / `false` | Also prune old tool outputs from native compaction summarization inputs so compaction summaries finish faster and cleaner. |
| `tui.enabled` | `false` (Recommended: `true`) | `true` / `false` | Show the compact `Trim` sidebar widget and `/trim` command in the OpenCode TUI. |
| `memory.enabled` | `false` (Recommended: `true`) | `true` / `false` | Enable the SQLite FTS5 compaction archive (`trim_history_search`) and recoverable pruning vault (`trim_expand`). |

### 🔧 Advanced Engine Options (Optional)

All options are validated strictly at startup (unknown keys or out-of-range numbers throw immediately):

| Option | Default | Allowed Range / Type | Description |
| :--- | :---: | :---: | :--- |
| `enabled` | `true` | `boolean` | Master switch for the plugin. |
| `shell` | `true` | `boolean` | Compress eligible `shell` / `bash` outputs. |
| `toolFiltering` | `true` | `boolean` | Fold consecutive identical lines and compact path prefixes in `grep`, `glob`, `ls`, `list`, `find`. |
| `pruning` | `true` | `boolean` | Prune old, safe, completed tool outputs from outgoing model context. |
| `compactionInputPruning` | `false` | `boolean` | Also prune old tool outputs from native compaction request inputs. |
| `autoCompact` | `true` | `boolean` | Trigger `ctx.session.compact({ sessionID, delivery: "queue" })` with in-flight/cooldown loop protection when post-prune context still reaches `usableTokens`. |
| `reduceTool` | `false` | `boolean` | Opt-in: register the tagless, cache-safe `trim_reduce` tool (`codemode: false`) for agent-requested pruning. |
| `minOutputChars` | `1600` | `200..200000` | Minimum tool output length before compression runs. |
| `minSavingsRatio` | `0.15` | `0..0.9` | Minimum relative character reduction required to accept compression. |
| `maxOutputLines` | `160` | `20..2000` | Maximum lines allowed in a compressed shell output. |
| `maxOutputChars` | `16000` | `2000..1000000` | Maximum characters allowed in a compressed shell output. |
| `maxInputScanChars` | `2000000` | `10000..5000000` | Hard input scan ceiling; larger outputs pass through untouched. |
| `protectRecentMessages` | `10` | `4..100` | Number of newest messages protected from pruning. |
| `protectRecentTokens` | `4096` | `1024..64000` | Token tail protection floor (also at least `6%` of usable context, capped at `25%`). |
| `keepRecentToolResults` | `8` | `1..100` | Number of newest eligible tool results always kept unpruned. |
| `pruneAfterToolChars` | `75000` | `10000..2000000` | Absolute tool-result character budget when model pressure is unavailable. |
| `pruneMinResultChars` | `800` | `100..200000` | Minimum length of an individual tool result to be eligible for pruning. |
| `pruneEligibleTools` | `["shell", "bash", "read", "grep", "glob", "ls", "list", "search", "find", "webfetch"]` | Up to 40 tool names | Allowlist of core tool names eligible for read-only context pruning (generic read-only `<prefix>_search\|read\|grep\|glob\|list\|find\|zoom\|outline\|inspect\|view\|lookup\|symbols\|references\|definition\|callers\|callees\|imports\|tree\|stat` tools are also recognized automatically). |
| `pressureStartRatio` | `0.65` | `0.2..0.9` | Context usage ratio where pressure-based pruning begins. |
| `pressureForceRatio` | `0.85` | `0.5..0.98` | Context usage ratio that authorizes a prompt-cache bust (`allowNewDrops`). |
| `pressureCriticalRatio` | `0.94` | `0.7..0.999` | Critical context usage ratio for aggressive target reclamation. |
| `outputReserveTokens` | `8192` | `1024..100000` | Output token reserve subtracted from uncapped model context windows. |
| `contextWindow` | `0` | `0..10000000` | Explicit context window fallback for custom providers (`0` = disabled). |
| `contextWindowCap` | `250000` | `0..10000000` (or `"250k"`) | Default cap (`min(catalog, cap)`) on large 1M+ model windows (`0` = uncapped). |
| `supersessionMinChars` | `5000` | `100..200000` | Minimum superseded character mass required to trigger supersession pruning. |
| `purgeErrorInputs` | `true` | `boolean` | Blank oversized input arguments on stale failed tool calls outside the protected tail while keeping error outputs intact. |
| `supersedeWrites` | `true` | `boolean` | Prune oversized write/edit/patch input payloads once a later completed read or write touches the same canonical file path (preserving `filePath`). |
| `pruneOldToolInputs` | `true` | `boolean` | Compact aged oversized (`>= 1000` chars) non-write, non-sensitive `tool-call` string inputs outside the protected tail while retaining a redacted head preview and metadata fields. |
| `pruneAgedDiffs` | `true` | `boolean` | Under force/critical pressure, allow pure read-only `git diff`/`git show`/`git blame` outputs older than `2 * protectRecentMessages` (excluding instruction/secret paths) to be pruned & vaulted. |
| `pruneResolvedErrors` | `true` | `boolean` | Prune older failed verification shell outputs (`test`/`lint`/`check`/`typecheck`/`build`) once a strictly later identical command succeeds cleanly (excludes timeouts/kills). |
| `adaptivePruning` | `true` | `boolean` | Under force/critical pressure, adaptively lower min-result/reasoning thresholds (`250`/`160` chars) and preview lines (`1`/`0`) to prevent small-output accumulation. |
| `virtualizeOutputChars` | `32000` | `0` or `4000..500000` | When `memory.enabled` is active, immediately vault massive unstructured ephemeral outputs (`>= N` chars) in `tool.execute.after` and return a 4-line preview + `trim_expand` ref (`0` = disabled; skips live-disk/structured/error outputs). |
| `pruneHistoricalReasoning` | `true` | `boolean` | Omit historical `reasoning` / `thinking` traces on assistant turns outside the protected tail while preserving current-turn reasoning and prose. |
| `pruneUnrelatedDiagnostics` | `true` | `boolean` | Filter `metadata.diagnostics` on completed `edit`, `write`, and `apply_patch` calls so only diagnostics for the edited file(s) are retained. |
| `prunePreviewLines` | `2` | `0..20` | Preserve `N` head and `N` tail preview lines around the pruning notice when the combined preview is significantly smaller than the original (`0` = notice only). |
| `dedupeWindow` | `8` | `0..32` | Same-session verified content-hash deduplication window for consecutive identical non-`read` tool outputs (`0` = disabled; skipped in Code Mode). |
| `cacheTtlMs` | `300000` | `0..3600000` | Idle prompt-cache TTL in ms (5 min default): opens zero-penalty cold-cache pruning when idle `>= cacheTtlMs` (`0` = disabled). |
| `cacheMinSavingsChars` | `6000` | `0..200000` | Minimum net-new character savings floor required before breaking a verified warm prompt cache. |
| `filterRules` | `[]` | Up to 24 rules | Custom per-program `{ program, dropPrefixes, dropExact }` line filters. |
| `memory.enabled` | `false` | `boolean` | Enable the SQLite FTS5 compaction-summary archive (`trim_history_search`) and recoverable pruned-output vault (`trim_expand`). |
| `memory.dbPath` | `$XDG_DATA_HOME/opencode-trim/memory.db` | Absolute path or `":memory:"` | SQLite database file path (`0600` file, `0700` newly created directory). |
| `memory.retentionDays` | `60` | `1..3650` | Per-project retention window in days. |
| `memory.recentWork` | `false` | `boolean` | Opt-in: inject a byte-identical frozen `<recent_work>` block once per top-level session from `memory.db` (skipped for subagents). |
| `memory.agentAllowlist` | `[]` | Up to 20 agent names | Optional allowlist for `trim_history_search` (empty = host permissions decide). |
| `memory.agentDenylist` | `[]` | Up to 20 agent names | Optional denylist for `trim_history_search` (denylist wins over allowlist). |
| `tui.enabled` | `false` | `boolean` | Enable the `opencode-trim-stats` RPC provider and TUI sidebar widget. |

---

## 🧪 Validation & Testing

Run the full verification suite locally:

```bash
npm run check     # Strict tsc --noEmit, dist/ build, 96-file syntax check + 577 tests
npm test          # Node.js test runner (577 tests across 31 suites)
npm run bench     # Deterministic 24-family compression & 800-message pruning benchmark
npm run pack:dry  # Verify packed npm tarball contents
```

---

## 🏗️ Project Layout

- `index.ts`: OpenCode V2 Promise server plugin entrypoint (`id: "opencode-trim"`, `setup: setupTrim`).
- `src/plugin.ts`: V2 hook orchestrator (`tool.execute.after`, `session.context`, `session.compaction`, `opencode-trim-stats` RPC, mesh peer lifecycle).
- `src/compress.ts`: Shell output compression pipeline, structured/binary guards, program resolver, and diagnostic preservation verifier.
- `src/families/*`: 24 deterministic command-family compressors and shared `util.ts` helpers.
- `src/prune.ts`: Call-ID FIFO context pruner, range-aware `read` supersession, instruction/secret guards, and `isTrimMeshProtected`.
- `src/cache.ts`: Prompt-cache-aware per-session drop replay (`ContextCache`) and absolute tool-char budget gate.
- `src/pressure.ts`: Model catalog limit discovery and conservative UTF-8 byte/3 token estimator.
- `src/diagnostics.ts`, `src/filters.ts`, `src/git.ts`, `src/runners.ts`: Linear-time diagnostic predicates, declarative line filters, quote-aware Git patch inspector, and test-runner progress compactor.
- `src/memory.ts`, `src/memory-store.ts`, `src/memory-sections.ts`: Optional Node 26 `node:sqlite` FTS5 compaction-summary archive, fail-closed secret redactor, section parser, and `trim_history_search` / `trim_expand` tools.
- `src/tui.tsx`, `src/tui-model.ts`, `src/tui-format.ts`, `src/stats.ts`, `src/stats-rpc.ts`: Optional OpenTUI/Solid sidebar widget, pure view-model, and location-scoped stats RPC.
- `src/bridge.ts`: Universal OpenCode V2 Plugin Mesh bridge (`BRIDGE_REVISION: 2.3.1`).

---

## 📄 License

MIT © [Hüseyin Hadi Çığ](https://github.com/huseyincig) — see [LICENSE](LICENSE).
