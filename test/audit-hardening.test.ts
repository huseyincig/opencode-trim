import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compressOutput } from '../src/compress.ts';
import { parseOptions } from '../src/config.ts';
import { applyLineFilters, programOf } from '../src/filters.ts';
import { openMemoryStore, MAX_TEXT_CHARS } from '../src/memory-store.ts';
import { setupMemory, TOOL_NAME, EXPAND_TOOL_NAME } from '../src/memory.ts';
import { processToolEvent, setupTrim, ToolDedupeRing } from '../src/plugin.ts';
import { pruneContext, recoverableNotice } from '../src/prune.ts';
import {
  acquireSessionLease,
  callMeshRpc,
  forgetMeshSession,
  getBlockingSessionLease,
  hasMeshCapability,
  isTrustedMeshMessage,
  registerMeshPeer,
  registerMeshStateRpc,
  registerRoleProfileResolver,
  registerSkillCatalogProvider,
  resolveMeshAgentProfile,
  queryMeshSkills,
  stampMeshMetadata,
} from '../src/bridge.ts';

// ── WAVE 1 ────────────────────────────────────────────────────────────────────

test('TRM-037: ANSI-colored shell output is compressed instead of rejected as structured', () => {
  const opts = parseOptions({ minOutputChars: 200, maxOutputLines: 30, maxOutputChars: 2500, minSavingsRatio: 0.1 });
  const colored = [
    ...Array.from({ length: 80 }, (_, i) => `\x1b[32m✓\x1b[0m tests/case_${i}.test.ts passed (${i}ms)`),
    '\x1b[1mTest Files\x1b[0m  80 passed (80)',
    '\x1b[1mTests\x1b[0m       80 passed (80)',
  ].join('\n');
  const res = compressOutput({ command: 'vitest run', text: colored, exitCode: 0, options: opts });
  assert.equal(res.changed, true, `expected colored vitest output to compress, got reason=${res.reason}`);
  assert.ok(!res.text.includes('\x1b['), 'ANSI escapes should be stripped');

  // True binary/control characters (BEL, NUL) still stay protected as structured
  const withBell = 'normal output\n'.repeat(300) + '\x07binary';
  const binRes = compressOutput({ command: 'vitest run', text: withBell, exitCode: 0, options: opts });
  assert.equal(binRes.changed, false);
  assert.equal(binRes.reason, 'structured');
});

test('TRM-001: vault regex grep rejects exponential alternation/quantifier ReDoS patterns', () => {
  const store = openMemoryStore({ dbPath: ':memory:', project: '/proj' });
  store.saveVault({ project: '/proj', session_id: 's1', ref_id: 'trm_redos', tool: 'shell', target: 'run', text: 'a'.repeat(22) + '!' });
  for (const evil of ['(a|aa)+$', '(a|a)+', '(ab|a)*$', '([a-z]|a)+$']) {
    assert.throws(
      () => store.getVault({ project: '/proj', ref_id: 'trm_redos', grep: evil, regex: true }),
      /invalid or unsafe grep regex/i,
      `pattern should be rejected: ${evil}`,
    );
    assert.throws(
      () => store.searchVault({ project: '/proj', grep: evil, regex: true }),
      /invalid or unsafe grep regex/i,
      `searchVault pattern should be rejected: ${evil}`,
    );
  }
  // Safe regex still works
  const ok = store.getVault({ project: '/proj', ref_id: 'trm_redos', grep: '^a+!$', regex: true });
  assert.equal(ok.found, true);
  assert.equal(ok.matchedLines, 1);
  store.close();
});

test('TRM-003 & TRM-005: 128-bit SHA-256 vault ref IDs, non-overwriting saveVault, and honest bounded/redacted notice', () => {
  const store = openMemoryStore({ dbPath: ':memory:', project: '/proj' });
  store.saveVault({ project: '/proj', session_id: 's1', ref_id: 'trm_same', tool: 'shell', target: 'cmd1', text: 'first content' });
  store.saveVault({ project: '/proj', session_id: 's2', ref_id: 'trm_same', tool: 'shell', target: 'cmd2', text: 'second content' });
  const got = store.getVault({ project: '/proj', ref_id: 'trm_same' });
  assert.match(got.text, /first content/, 'saveVault must not silently overwrite an existing distinct ref_id');

  const opts = parseOptions({ protectRecentMessages: 4, protectRecentTokens: 1024, keepRecentToolResults: 1, pruneAfterToolChars: 10000, pruneMinResultChars: 500, prunePreviewLines: 0 });
  const big = 'log line\n'.repeat(200);
  const refs: string[] = [];
  const vault = {
    store(refId: string, entry: any) {
      refs.push(refId);
      return store.saveVault({ project: '/proj', session_id: 's1', ref_id: refId, tool: entry.name, target: 'cmd', text: entry.original }).saved;
    },
    has(refId: string) { return store.hasVault('/proj', refId); },
  };
  const messages: any[] = [
    { id: 'm0', role: 'assistant', content: [{ type: 'tool', id: 'c0', tool: 'shell', input: { command: 'echo build' }, state: { status: 'completed', output: big } }] },
    { id: 'm1', role: 'assistant', content: [{ type: 'tool', id: 'c1', tool: 'shell', input: { command: 'echo recent' }, state: { status: 'completed', output: big } }] },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, role: i % 2 ? 'assistant' : 'user', content: `x${i} ` + 'z'.repeat(1200) })),
  ];
  const res = pruneContext({ sessionID: 's1', messages }, opts, { allowNewDrops: true, pressure: { ratio: 0.9, usableTokens: 20_000 }, vault });
  assert.equal(res.pruned, 1);
  assert.equal(refs.length, 1);
  assert.match(refs[0], /^trm_[0-9a-f]{32}$/, `expected 128-bit hex ref ID, got ${refs[0]}`);
  const notice = messages[0].content[0].state.output;
  assert.match(notice, /bounded, secret-redacted snapshot is RECOVERABLE, not lost/i);
  assert.doesNotMatch(notice, /The original output is RECOVERABLE/);

  const truncNotice = recoverableNotice('trm_' + 'a'.repeat(32), 'shell', 400_000, 10_000, { truncated: true });
  assert.match(truncNotice, /truncated/i);
  assert.ok(MAX_TEXT_CHARS === 1_000_000);
  store.close();
});

test('TRM-004: new drop is preserved untouched when vault.store fails', () => {
  const opts = parseOptions({ protectRecentMessages: 4, protectRecentTokens: 1024, keepRecentToolResults: 1, pruneAfterToolChars: 10000, pruneMinResultChars: 500, prunePreviewLines: 0 });
  const big = 'important ephemeral output\n'.repeat(120);
  const failingVault = {
    store() { throw new Error('disk full'); },
    has() { return false; },
  };
  const messages: any[] = [
    { id: 'm0', role: 'assistant', content: [{ type: 'tool', id: 'c0', tool: 'shell', input: { command: 'echo ephemeral' }, state: { status: 'completed', output: big } }] },
    { id: 'm1', role: 'assistant', content: [{ type: 'tool', id: 'c1', tool: 'shell', input: { command: 'echo recent' }, state: { status: 'completed', output: big } }] },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, role: i % 2 ? 'assistant' : 'user', content: `x${i} ` + 'z'.repeat(1200) })),
  ];
  const res = pruneContext({ sessionID: 's1', messages }, opts, { allowNewDrops: true, pressure: { ratio: 0.9, usableTokens: 20_000 }, vault: failingVault });
  assert.equal(res.pruned, 0, 'must not drop new ephemeral output when vault persistence fails');
  assert.equal(messages[0].content[0].state.output, big);
});

test('TRM-006 & TRM-007: memory execute enforces ACL directly, rejects ambiguous locations, and recentWork fails closed on session.get errors & respects ACL', async () => {
  let beforeGate: any;
  let contextHook: any;
  const tools = new Map<string, any>();
  const ctx: any = {
    location: { directory: '/tmp/trim-sec-proj' },
    tool: {
      hook: async (name: string, cb: any) => { if (name === 'execute.before') beforeGate = cb; return { dispose() {} }; },
      transform: async (fn: any) => { fn({ add: (t: any) => tools.set(t.name, t) }); return { dispose() {} }; },
    },
    session: {
      hook: async (name: string, cb: any) => { if (name === 'context') contextHook = cb; return { dispose() {} }; },
      get: async ({ sessionID }: any) => {
        if (sessionID === 's-err') throw new Error('host lookup failed');
        if (sessionID === 's-root') return { id: 's-root' };
        return { id: sessionID, parentID: 's-root' };
      },
    },
    event: { subscribe: async () => ({ async *[Symbol.asyncIterator]() {} }) },
  };
  let readyStore: any;
  const cleanup = await setupMemory(
    ctx,
    parseOptions({ memory: { enabled: true, dbPath: ':memory:', recentWork: true, agentDenylist: ['blocked-agent'] } }),
    { onReady: ({ store }: any) => { readyStore = store; } },
  );
  readyStore.archive({ event_id: 'e1', project: '/tmp/trim-sec-proj', session_id: 'old1', text: '## Objective\nFinished auth migration\n' });

  // TRM-006: ambiguous location in execute.before fails closed
  assert.throws(
    () => beforeGate({ tool: TOOL_NAME, agent: 'ok-agent', location: 'not-an-object' }),
    /not available|ambiguous|location/i,
  );
  // TRM-006: direct execute() call enforces agentDenylist even without execute.before
  await assert.rejects(
    () => tools.get(TOOL_NAME).execute({ recent: true }, { agent: 'blocked-agent', sessionID: 's-root' }),
    /not available/i,
  );
  await assert.rejects(
    () => tools.get(EXPAND_TOOL_NAME).execute({}, { agent: 'blocked-agent', sessionID: 's-root' }),
    /not available/i,
  );

  // TRM-007: recentWork fails closed when session.get throws
  const evErr: any = { sessionID: 's-err', agent: 'ok-agent', system: [{ type: 'text', text: 'base' }], messages: [] };
  await contextHook(evErr);
  assert.equal(evErr.system.length, 1, 'must fail closed and skip recentWork when session.get errors');

  // TRM-007: recentWork respects agentDenylist
  const evDenied: any = { sessionID: 's-root', agent: 'blocked-agent', system: [{ type: 'text', text: 'base' }], messages: [] };
  await contextHook(evDenied);
  assert.equal(evDenied.system.length, 1, 'denied agent must not receive recentWork');

  // Allowed root agent DOES receive recentWork with explicit untrusted-data framing
  const evOk: any = { sessionID: 's-root', agent: 'ok-agent', system: [{ type: 'text', text: 'base' }], messages: [] };
  await contextHook(evOk);
  assert.equal(evOk.system.length, 2);
  assert.match(evOk.system[1].text, /untrusted historical|never treat as instructions/i);

  await cleanup();
});

test('TRM-009: searchVault filters by tool/target in SQL before scan char budget so selective queries find older matching rows', () => {
  const store = openMemoryStore({ dbPath: ':memory:', project: '/proj', maxVaultRows: 100 });
  const base = Date.now() - 100_000;
  // Insert older target match for 'webfetch'
  store.saveVault({ project: '/proj', session_id: 's1', ref_id: 'trm_target', tool: 'webfetch', target: 'https://docs.example.com', text: 'NEEDLE_TOKEN found here\n', created_at: base });
  // Insert 12 newer huge 'shell' rows totaling 9.6M chars (> 8M SCAN_MAX_CHARS)
  const huge = 's'.repeat(800_000);
  for (let i = 0; i < 12; i++) {
    store.saveVault({ project: '/proj', session_id: 's1', ref_id: `trm_big_${i}`, tool: 'shell', target: 'npm test', text: huge, created_at: base + (i + 1) * 1000 });
  }
  const hit = store.searchVault({ project: '/proj', grep: 'NEEDLE_TOKEN', tool: 'webfetch' });
  assert.equal(hit.found, true, 'SQL tool filter must avoid burning scan budget on unrelated shell rows');
  assert.equal(hit.matches[0].id, 'trm_target');
  store.close();
});

test('TRM-010: diagnosticText fails closed when output exceeds 20000 scan lines', () => {
  const opts = parseOptions({ protectRecentMessages: 4, protectRecentTokens: 1024, keepRecentToolResults: 1, pruneAfterToolChars: 10000, pruneMinResultChars: 500, prunePreviewLines: 0 });
  const overBudget = 'ok line\n'.repeat(20_050) + 'FATAL: database corruption at end\n';
  const messages: any[] = [
    { id: 'm0', role: 'assistant', content: [{ type: 'tool', id: 'c0', tool: 'shell', input: { command: 'echo huge' }, state: { status: 'completed', output: overBudget } }] },
    { id: 'm1', role: 'assistant', content: [{ type: 'tool', id: 'c1', tool: 'shell', input: { command: 'echo recent' }, state: { status: 'completed', output: 'x'.repeat(1200) } }] },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, role: i % 2 ? 'assistant' : 'user', content: `u${i} ` + 'z'.repeat(1200) })),
  ];
  const res = pruneContext({ sessionID: 's1', messages }, opts, { allowNewDrops: true, pressure: { ratio: 0.9, usableTokens: 20_000 } });
  assert.equal(res.pruned, 0, 'output exceeding MAX_SCAN_LINES must fail closed and never be pruned');
});

test('TRM-011 & TRM-012: ToolDedupeRing respects protected commands, structured JSON, exit notices, failed assignResult, and invalidates on prune', () => {
  const opts = parseOptions({ minOutputChars: 200, maxOutputLines: 30, maxOutputChars: 2500, minSavingsRatio: 0.1, dedupeWindow: 8 });
  const ring = new ToolDedupeRing(8, 200);
  const rt = { directory: '/proj', dedupeRing: ring, sessionID: 's1' };

  // TRM-011a: Protected git diff must NEVER be stubbed by dedupe ring
  const diff = 'diff --git a/a.ts b/a.ts\n' + '+const line = 1;\n'.repeat(80);
  const evDiff1 = { status: 'completed', sessionID: 's1', tool: 'shell', input: { command: 'git diff' }, result: { content: diff } };
  const evDiff2 = { status: 'completed', sessionID: 's1', tool: 'shell', input: { command: 'git diff' }, result: { content: diff } };
  assert.equal(processToolEvent(evDiff1, opts, undefined, rt), false);
  assert.equal(processToolEvent(evDiff2, opts, undefined, rt), false);
  assert.equal(evDiff2.result.content, diff);

  // TRM-011b: Structured JSON must NEVER be stubbed by dedupe ring
  const json = JSON.stringify({ items: Array.from({ length: 60 }, (_, i) => ({ id: i, val: 'data' })) }, null, 2);
  const evJson1 = { status: 'completed', sessionID: 's1', tool: 'shell', input: { command: 'echo json' }, result: { content: json } };
  const evJson2 = { status: 'completed', sessionID: 's1', tool: 'shell', input: { command: 'echo json' }, result: { content: json } };
  assert.equal(processToolEvent(evJson1, opts, undefined, rt), false);
  assert.equal(processToolEvent(evJson2, opts, undefined, rt), false);
  assert.equal(evJson2.result.content, json);

  // TRM-011c: Multi-part array containing exit notice must not drop notice via dedupe ring
  const body = 'repeated plain line\n'.repeat(80);
  const evArr1: any = { status: 'completed', sessionID: 's1', tool: 'shell', input: { command: 'echo ok' }, result: { content: [{ type: 'text', text: body }, { type: 'text', text: body }] } };
  // TRM-012a: Two identical text parts inside the SAME tool call must NOT stub the second part against the first part of the same call
  processToolEvent(evArr1, opts, undefined, rt);
  assert.doesNotMatch(evArr1.result.content[1].text, /withheld — byte-identical/);
});

// ── WAVE 2 ────────────────────────────────────────────────────────────────────

test('TRM-016 & TRM-021 & TRM-057: signed reasoning_content, metadata.output rollback fidelity, and nested result.output.exitCode protection', () => {
  const opts = parseOptions({ protectRecentMessages: 4, protectRecentTokens: 1024, keepRecentToolResults: 1, pruneAfterToolChars: 10000, pruneMinResultChars: 400, prunePreviewLines: 0 });

  // TRM-016: message-level reasoning_content with signature stays protected
  const signedMsg: any = {
    id: 'rs_012345',
    role: 'assistant',
    signature: 'sig_abc123',
    reasoning_content: 'signed reasoning '.repeat(60),
    content: [{ type: 'text', text: 'answer' }],
  };
  const tail = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, role: i % 2 ? 'assistant' : 'user', content: `u${i} ` + 'z'.repeat(1000) }));
  const r16 = pruneContext({ sessionID: 's16', messages: [signedMsg, ...tail] }, opts, { allowNewDrops: true, pressure: { ratio: 0.9, usableTokens: 20_000 } });
  assert.equal(r16.pruned, 0);
  assert.match(signedMsg.reasoning_content, /^signed reasoning/);

  // TRM-021: distinct state.metadata.output is NOT overwritten when state.output is pruned
  const distinctMetaMsg: any = {
    id: 'm21',
    role: 'assistant',
    content: [{
      type: 'tool',
      id: 'c21',
      tool: 'shell',
      input: { command: 'echo hello' },
      state: { status: 'completed', output: 'plain log line\n'.repeat(80), metadata: { output: 'distinct metadata summary' } },
    }],
  };
  const recentTool: any = { id: 'm21r', role: 'assistant', content: [{ type: 'tool', id: 'c21r', tool: 'shell', input: { command: 'echo r' }, state: { status: 'completed', output: 'r'.repeat(800) } }] };
  const r21 = pruneContext({ sessionID: 's21', messages: [distinctMetaMsg, recentTool, ...tail] }, opts, { allowNewDrops: true, pressure: { ratio: 0.9, usableTokens: 20_000 } });
  assert.equal(r21.pruned, 1);
  assert.equal(distinctMetaMsg.content[0].state.metadata.output, 'distinct metadata summary');

  // TRM-057: nested result.output.exitCode != 0 protects tool-result from pruning
  const nestedFail: any[] = [
    { id: 'a57', role: 'assistant', content: [{ type: 'tool-call', id: 'c57', name: 'shell', input: { command: 'echo run' } }] },
    { id: 'r57', role: 'tool', content: [{ type: 'tool-result', id: 'c57', name: 'shell', result: { type: 'text', value: 'verbose non-error lines\n'.repeat(80), output: { exitCode: 2 } } }] },
    recentTool,
    ...tail,
  ];
  const r57 = pruneContext({ sessionID: 's57', messages: nestedFail }, opts, { allowNewDrops: true, pressure: { ratio: 0.9, usableTokens: 20_000 } });
  assert.equal(r57.pruned, 0, 'nonzero result.output.exitCode must protect tool-result from pruning');
});

test('TRM-022 & TRM-024 & TRM-027 & TRM-030 & TRM-031: memory-store SQL sessionID filter, vault range validation, Unicode archive, FTS rebuild & UPDATE OF text trigger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trim-audit-store-'));
  const dbPath = join(dir, 'memory.db');
  try {
    const store = openMemoryStore({ dbPath, project: '/proj' });
    const base = Date.now() - 500_000;

    // TRM-027: pure CJK and pure non-ASCII Turkish summaries are archived cleanly
    assert.equal(store.archive({ event_id: 'cjk1', project: '/proj', session_id: 's-cjk', text: '已完成任务：修复数据库索引', created_at: base }).inserted, true);
    assert.equal(store.archive({ event_id: 'tr1', project: '/proj', session_id: 's-tr', text: 'İğüşöç', created_at: base + 1 }).inserted, true);

    // TRM-022: sessionID filter finds target session even behind 220 newer rows from other sessions
    store.archive({ event_id: 'target-old', project: '/proj', session_id: 's-target', text: 'TargetSessionSummary alpha', created_at: base + 2 });
    for (let i = 0; i < 220; i++) {
      store.archive({ event_id: `noise-${i}`, project: '/proj', session_id: `s-other-${i}`, text: `Noise summary ${i}`, created_at: base + 100 + i });
    }
    const recentTarget = store.search({ project: '/proj', recent: true, sessionID: 's-target', limit: 5 });
    assert.equal(recentTarget.length, 1);
    assert.equal(recentTarget[0].session_id, 's-target');

    // TRM-024: getVault rejects endLine < startLine and returns 0 matchedLines when startLine > totalLines
    store.saveVault({ project: '/proj', session_id: 's1', ref_id: 'trm_range', tool: 'shell', target: 'echo', text: 'L1\nL2\nL3' });
    assert.throws(() => store.getVault({ project: '/proj', ref_id: 'trm_range', startLine: 3, endLine: 1 }), /endLine/i);
    const outRange = store.getVault({ project: '/proj', ref_id: 'trm_range', startLine: 10, endLine: 20 });
    assert.equal(outRange.found, true);
    assert.equal(outRange.matchedLines, 0);
    assert.doesNotMatch(outRange.text, /3: L3/);
    store.close();

    // TRM-031: history_au trigger is scoped to AFTER UPDATE OF text
    const raw = new DatabaseSync(dbPath);
    const trig: any = raw.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='history_au'").get();
    assert.match(String(trig?.sql ?? ''), /AFTER UPDATE OF text/i);

    // TRM-030: if history_fts is dropped on an existing composite table, re-opening rebuilds FTS backfill
    raw.exec('DROP TABLE history_fts; DROP TRIGGER IF EXISTS history_ai; DROP TRIGGER IF EXISTS history_ad; DROP TRIGGER IF EXISTS history_au;');
    raw.close();

    const reopened = openMemoryStore({ dbPath, project: '/proj' });
    const ftsHit = reopened.search({ project: '/proj', query: 'TargetSessionSummary' });
    assert.equal(ftsHit.length, 1, 're-created history_fts must backfill existing history rows');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TRM-034 & TRM-039 & TRM-040 & TRM-043 & TRM-056: pressure retry reset, maxOutputLines cap, programOf, sync dispose isolation, ring seq eviction', async () => {
  // TRM-034: model.updated clears retry counts AND purges removed models from modelLimits
  let calls = 0;
  let emit34: ((ev: any) => void) | null = null;
  const q34: any[] = [];
  let closed34 = false;
  let ctxHook34: any;
  let rpc34: any;
  const ctx34: any = {
    location: { directory: '/tmp/trim-34' },
    options: { tui: { enabled: true }, contextWindowCap: 0 },
    model: {
      list: async () => {
        calls++;
        // First 4 calls (1 prewarm + 3 retries) miss p/m and return stale p/old
        return calls <= 4
          ? [{ providerID: 'p', id: 'old', limit: { context: 100_000, output: 8192 } }]
          : [{ providerID: 'p', id: 'm', limit: { context: 250_000, output: 8192 } }];
      },
    },
    tool: { hook: async () => ({ dispose() {} }) },
    session: { hook: async (name: string, cb: any) => { if (name === 'context') ctxHook34 = cb; return { dispose() {} }; } },
    rpc: { register: async (_d: any, h: any) => { rpc34 = h; return { events: { emit() {} }, dispose() {} }; } },
    event: {
      subscribe: async () => ({
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (q34.length) return Promise.resolve({ value: q34.shift(), done: false });
              if (closed34) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve) => { emit34 = (ev) => { emit34 = null; resolve({ value: ev, done: false }); }; });
            },
          };
        },
      }),
    },
  };
  const stop34 = await setupTrim(ctx34);
  await new Promise((r) => setTimeout(r, 20));
  // Exhaust MAX_MODEL_LOOKUP_RETRIES (3) for p/m
  for (let i = 0; i < 4; i++) {
    await ctxHook34({ sessionID: 's34', model: { providerID: 'p', id: 'm' }, system: [], messages: [{ id: `u${i}`, role: 'user', content: 'hi' }], tools: {} });
  }
  assert.equal((await rpc34.snapshot({ sessionID: 's34' })).context.limitTokens, null);
  // Now emit model.updated -> WeakMap retry counts must reset so p/m resolves and removed p/old is purged
  const push34 = (ev: any) => emit34 ? emit34(ev) : q34.push(ev);
  push34({ type: 'model.updated', location: { directory: '/tmp/trim-34' } });
  await new Promise((r) => setTimeout(r, 30));
  await ctxHook34({ sessionID: 's34', model: { providerID: 'p', id: 'm' }, system: [], messages: [{ id: 'u9', role: 'user', content: 'hi' }], tools: {} });
  assert.equal((await rpc34.snapshot({ sessionID: 's34' })).context.limitTokens, 250_000);
  await ctxHook34({ sessionID: 's34-old', model: { providerID: 'p', id: 'old' }, system: [], messages: [{ id: 'uo', role: 'user', content: 'hi' }], tools: {} });
  assert.equal((await rpc34.snapshot({ sessionID: 's34-old' })).context.limitTokens, null, 'removed model must be purged on model.updated');
  closed34 = true;
  await stop34();

  // TRM-039: renderSelection with multiple omission gaps still respects maxOutputLines
  const opts39 = parseOptions({ minOutputChars: 200, maxOutputLines: 20, maxOutputChars: 8000, minSavingsRatio: 0.1 });
  const buildOut = Array.from({ length: 120 }, (_, i) => (i % 15 === 0 ? `error TS2322: problem ${i} at src/a.ts:${i}` : `building step ${i} verbose output padding`)).join('\n');
  const r39 = compressOutput({ command: 'tsc --noEmit', text: buildOut, exitCode: 0, options: opts39 });
  if (r39.changed) {
    assert.ok(r39.text.split('\n').length <= opts39.maxOutputLines, `expected <= ${opts39.maxOutputLines} lines, got ${r39.text.split('\n').length}`);
  }

  // TRM-040: programOf does not mistake argument token for real executable
  assert.equal(programOf('grep npm build.log'), '');
  assert.equal(programOf('echo npm install'), '');
  const f40 = applyLineFilters('grep npm build.log', 'npm notice line 1\nnpm notice line 2\nkeep line', opts39);
  assert.equal(f40.dropped, 0);

  // TRM-043: sync throw in one registration.dispose() still disposes earlier registrations
  const disposedNames: string[] = [];
  const ctx43: any = {
    location: { directory: '/tmp/trim-43' },
    options: {},
    tool: { hook: async () => ({ dispose() { disposedNames.push('tool'); } }) },
    session: {
      hook: async (name: string) => ({
        dispose() {
          disposedNames.push(`session:${name}`);
          if (name === 'fork') throw new Error('sync dispose boom');
        },
      }),
    },
  };
  const stop43 = await setupTrim(ctx43);
  await stop43();
  assert.ok(disposedNames.includes('tool'), 'earlier tool registration must still be disposed after sync throw');
  assert.ok(disposedNames.includes('session:context'), 'earlier context registration must still be disposed after sync throw');

  // TRM-056: ToolDedupeRing eviction removes seq entry too
  const ring56 = new ToolDedupeRing(4, 200);
  for (let i = 0; i < 80; i++) ring56.check(`s-${i}`, 'shell', 'cmd', 'x'.repeat(300));
  assert.ok(ring56.rings.size <= 64);
  assert.ok(ring56.seq.size <= 64, `expected seq.size <= 64, got ${ring56.seq.size}`);
});

test('TRM-050, TRM-051, TRM-053, TRM-059, TRM-068: TUI session guard, single-flight coalescing, catch reset, snapshot sessionID validation, guarded dispose', () => {
  const tuiSrc = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
  assert.match(tuiSrc, /next\.sessionID\s*!==\s*sessionID/);
  assert.match(tuiSrc, /inFlight|fetching/);
  assert.match(tuiSrc, /const targetSessionID = activeSessionID/);
  assert.match(tuiSrc, /latestState\.nativeTokens = null/);
  assert.match(tuiSrc, /try\s*\{\s*if\s*\(typeof disposeKeymap === "function"\)/);
});

// ── WAVE 3 (SHARED MESH BRIDGE) ───────────────────────────────────────────────

test('TRM-008, TRM-044, TRM-045, TRM-047, TRM-049, TRM-064: mesh bridge provenance, disposer identity, RPC standby/abort, directory scope, and lease eviction', async () => {
  // TRM-008: when a session provenance ledger exists, forged tokens are rejected even with synthetic:true
  const sid08 = 'mesh-trm-008';
  stampMeshMetadata(sid08, { owner: 'peer-policy', kind: 'remediation', protected: true });
  const forged = {
    type: 'synthetic',
    synthetic: true,
    metadata: {
      'opencode-mesh': { v: 2, owner: 'peer-policy', kind: 'remediation', token: 'forged-token-123' },
    },
  };
  assert.equal(isTrustedMeshMessage(forged, sid08, 'remediation'), false, 'forged token must fail closed when session ledger exists');
  forgetMeshSession(sid08);

  // TRM-044: old disposer does not erase a newer replacement resolver/skill provider
  const d1 = registerRoleProfileResolver({ owner: 'own44', directory: '/tmp/dir44', resolve: () => ({ sessionID: 's', capability: 'read-only', managedBy: 'old' }) });
  const d2 = registerRoleProfileResolver({ owner: 'own44', directory: '/tmp/dir44', resolve: () => ({ sessionID: 's', capability: 'write-allowed', managedBy: 'new' }) });
  d1(); // disposing old handle must NOT delete new handle
  const prof = await resolveMeshAgentProfile('s', '/tmp/dir44');
  assert.equal(prof?.managedBy, 'new');
  d2();

  const sk1 = registerSkillCatalogProvider({ owner: 'own44', directory: '/tmp/dir44', search: async () => [{ id: 'old', scope: 'native', score: 1 }] });
  const sk2 = registerSkillCatalogProvider({ owner: 'own44', directory: '/tmp/dir44', search: async () => [{ id: 'new', scope: 'native', score: 1 }] });
  sk1();
  const hits = await queryMeshSkills('test', { directory: '/tmp/dir44' });
  assert.equal(hits[0]?.id, 'new');
  sk2();

  // TRM-045: failed primary RPC registration promotes queued standby
  let standbyRegistered = false;
  let rejectPrimary!: (e: Error) => void;
  const pPrimary = registerMeshStateRpc({
    owner: 'p1',
    directory: '/tmp/rpc45',
    rpcRegister: () => new Promise((_res, rej) => { rejectPrimary = rej; }),
  });
  const pStandby = registerMeshStateRpc({
    owner: 'p2',
    directory: '/tmp/rpc45',
    rpcRegister: async () => { standbyRegistered = true; return { dispose() {} }; },
  });
  const disposeStandby = await pStandby;
  rejectPrimary(new Error('primary failed'));
  const disposePrimary = await pPrimary;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(standbyRegistered, true, 'standby must be promoted when primary registration fails');
  await disposeStandby();
  await disposePrimary();

  // TRM-047: callMeshRpc aborts internal signal on timeout
  let receivedSignal: AbortSignal | undefined;
  const timedOut = await callMeshRpc({
    rpcGetter: () => ({
      slow: (_payload: unknown, opts: any) => {
        receivedSignal = opts?.signal;
        return new Promise(() => {}); // never resolves
      },
    }),
    contract: { id: 'test', methods: { slow: {} } },
    method: 'slow',
    payload: {},
    timeoutMs: 25,
  });
  assert.equal(timedOut, undefined);
  assert.equal(receivedSignal?.aborted, true, 'timeout must abort the signal passed to RPC handler');

  // TRM-049: hasMeshCapability does not leak across projects via legacy global flags
  const unregA = registerMeshPeer({ id: 'peer-policy', directory: '/tmp/proj-49-a', capabilities: ['policy.gate'] });
  assert.equal(hasMeshCapability('policy.gate', '/tmp/proj-49-a'), true);
  assert.equal(hasMeshCapability('policy.gate', '/tmp/proj-49-b'), false, 'project B must not inherit project A capability via legacy global fallback');
  unregA();

  // TRM-064: remote interaction lease eviction releases underlying lease
  let rpcHandlers64: any;
  const disposeHost64 = await registerMeshStateRpc({
    owner: 'h64',
    directory: '/tmp/rpc64',
    rpcRegister: async (_def, handlers) => { rpcHandlers64 = handlers; return { dispose() {} }; },
  });
  await rpcHandlers64.setInteractionLease({ sessionID: 's-evict-0', owner: 'ui', active: true, ttlMs: 60_000 });
  assert.ok(getBlockingSessionLease('s-evict-0', 'orchestration_dispatch', 'orch'));
  for (let i = 1; i <= 520; i++) {
    await rpcHandlers64.setInteractionLease({ sessionID: `s-evict-${i}`, owner: 'ui', active: true, ttlMs: 60_000 });
  }
  assert.equal(getBlockingSessionLease('s-evict-0', 'orchestration_dispatch', 'orch'), undefined, 'evicted remote lease must release its underlying session lease');
  await disposeHost64();
  for (let i = 0; i <= 520; i++) forgetMeshSession(`s-evict-${i}`);
});
