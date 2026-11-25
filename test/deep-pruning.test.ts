import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOptions, DEFAULTS } from '../src/config.ts';
import {
  pruneContext,
  protectedShell,
  recoverableNotice,
  liveDiskNotice,
  expiredNotice,
  scorePruningRelevance,
  PRUNED_SUPERSEDED_WRITE,
  PRUNED_OLD_INPUT,
  PRUNED_RESOLVED_ERROR,
} from '../src/prune.ts';
import { ContextCache } from '../src/cache.ts';
import { openMemoryStore } from '../src/memory-store.ts';
import { processToolEvent, setupTrim, SessionWorkingState } from '../src/plugin.ts';
import { TRIM_STATS_RPC } from '../src/stats-rpc.ts';
import { buildGainReport } from '../src/tui-model.ts';

function makeTail(count = 6) {
  return Array.from({ length: count }, (_, i) => ({
    id: `tail-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `recent turn ${i} working on src/auth.ts ` + 'q'.repeat(1200) }],
  }));
}

test('v0.12.0 config: new deep-pruning & virtualization options validate defaults and bounds', () => {
  const def = parseOptions();
  assert.equal(def.supersedeWrites, true);
  assert.equal(def.pruneOldToolInputs, true);
  assert.equal(def.pruneAgedDiffs, true);
  assert.equal(def.pruneResolvedErrors, true);
  assert.equal(def.adaptivePruning, true);
  assert.equal(def.virtualizeOutputChars, 32000);
  assert.equal(DEFAULTS.virtualizeOutputChars, 32000);

  // Valid overrides (0 disables virtualization)
  const custom = parseOptions({
    supersedeWrites: false,
    pruneOldToolInputs: false,
    pruneAgedDiffs: false,
    pruneResolvedErrors: false,
    adaptivePruning: false,
    virtualizeOutputChars: 0,
  });
  assert.equal(custom.supersedeWrites, false);
  assert.equal(custom.virtualizeOutputChars, 0);

  // Invalid values rejected
  assert.throws(() => parseOptions({ supersedeWrites: 'yes' as any }), /boolean/);
  assert.throws(() => parseOptions({ pruneOldToolInputs: 1 as any }), /boolean/);
  assert.throws(() => parseOptions({ virtualizeOutputChars: 100 }), /virtualizeOutputChars/);
  assert.throws(() => parseOptions({ virtualizeOutputChars: 900_000 }), /virtualizeOutputChars/);
});

test('Pattern 1a: supersedeWrites prunes oversized write/edit inputs superseded by a later read or write on the same file', () => {
  const opts = parseOptions({
    protectRecentMessages: 4,
    protectRecentTokens: 1024,
    keepRecentToolResults: 1,
    pruneAfterToolChars: 10000,
    pruneMinResultChars: 400,
    prunePreviewLines: 0,
  });
  const bigWriteA = 'export const a = 1;\n'.repeat(120);
  const bigWriteB = 'export const b = 2;\n'.repeat(120);
  const bigWriteInstr = '# AGENTS instructions\n'.repeat(120);
  const messages: any[] = [
    // Superseded by later read on src/a.ts
    {
      id: 'w-a-call',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c-wa', name: 'write', input: { filePath: '/proj/src/a.ts', content: bigWriteA } }],
    },
    {
      id: 'w-a-res',
      role: 'tool',
      content: [{ type: 'tool-result', id: 'c-wa', name: 'write', result: { type: 'text', value: 'Wrote /proj/src/a.ts' } }],
    },
    // NOT superseded (no later read or write on src/b.ts)
    {
      id: 'w-b-call',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c-wb', name: 'write', input: { filePath: '/proj/src/b.ts', content: bigWriteB } }],
    },
    {
      id: 'w-b-res',
      role: 'tool',
      content: [{ type: 'tool-result', id: 'c-wb', name: 'write', result: { type: 'text', value: 'Wrote /proj/src/b.ts' } }],
    },
    // Instruction file write: must stay protected even if later read
    {
      id: 'w-i-call',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c-wi', name: 'write', input: { filePath: '/proj/AGENTS.md', content: bigWriteInstr } }],
    },
    {
      id: 'w-i-res',
      role: 'tool',
      content: [{ type: 'tool-result', id: 'c-wi', name: 'write', result: { type: 'text', value: 'Wrote /proj/AGENTS.md' } }],
    },
    // Later read of src/a.ts and AGENTS.md
    {
      id: 'r-a-call',
      role: 'assistant',
      content: [
        { type: 'tool-call', id: 'c-ra', name: 'read', input: { filePath: 'src/a.ts' } },
        { type: 'tool-call', id: 'c-ri', name: 'read', input: { filePath: 'AGENTS.md' } },
      ],
    },
    {
      id: 'r-a-res',
      role: 'tool',
      content: [
        { type: 'tool-result', id: 'c-ra', name: 'read', result: { type: 'text', value: 'latest src/a.ts content' } },
        { type: 'tool-result', id: 'c-ri', name: 'read', result: { type: 'text', value: 'latest AGENTS.md' } },
      ],
    },
    ...makeTail(6),
  ];

  const res = pruneContext(
    { sessionID: 's-sup-w', messages },
    opts,
    { allowNewDrops: true, directory: '/proj', pressure: { ratio: 0.7, usableTokens: 20000 } },
  );
  assert.ok(res.pruned >= 1);
  assert.equal(messages[0].content[0].input.filePath, '/proj/src/a.ts', 'filePath must be preserved');
  assert.ok(
    messages[0].content[0].input.content.includes(PRUNED_SUPERSEDED_WRITE),
    'superseded write content should be pruned',
  );
  assert.equal(messages[2].content[0].input.content, bigWriteB, 'non-superseded write must stay intact');
  assert.equal(messages[4].content[0].input.content, bigWriteInstr, 'instruction file write must stay intact');
});

test('Pattern 1b: pruneOldToolInputs compacts aged oversized delegation/query inputs while preserving sensitive/write/recent calls', () => {
  const opts = parseOptions({
    protectRecentMessages: 4,
    protectRecentTokens: 1024,
    keepRecentToolResults: 1,
    pruneAfterToolChars: 10000,
    pruneMinResultChars: 400,
    prunePreviewLines: 0,
  });
  const longPrompt = 'Investigate memory leak in worker pool\n' + 'detail line about worker pool\n'.repeat(80);
  const longSecretInput = 'secret payload body\n'.repeat(80);
  const messages: any[] = [
    {
      id: 'sub-call',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c-sub', name: 'subagent', input: { role: 'research', prompt: longPrompt } }],
    },
    {
      id: 'sub-res',
      role: 'tool',
      content: [{ type: 'tool-result', id: 'c-sub', name: 'subagent', result: { type: 'text', value: 'Found root cause in pool.ts' } }],
    },
    {
      id: 'auth-call',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c-auth', name: 'auth_check', input: { prompt: longSecretInput } }],
    },
    {
      id: 'auth-res',
      role: 'tool',
      content: [{ type: 'tool-result', id: 'c-auth', name: 'auth_check', result: { type: 'text', value: 'ok' } }],
    },
    ...makeTail(6),
  ];

  const res = pruneContext(
    { sessionID: 's-old-inp', messages },
    opts,
    { allowNewDrops: true, directory: '/proj', pressure: { ratio: 0.72, usableTokens: 20000 } },
  );
  assert.ok(res.pruned >= 1);
  assert.equal(messages[0].content[0].input.role, 'research', 'short metadata fields stay intact');
  assert.ok(messages[0].content[0].input.prompt.includes(PRUNED_OLD_INPUT), 'oversized old subagent prompt pruned');
  assert.ok(messages[0].content[0].input.prompt.includes('Investigate memory leak'), 'keeps concise head preview');
  assert.ok(messages[0].content[0].input.prompt.length < 300);
  assert.equal(messages[2].content[0].input.prompt, longSecretInput, 'sensitive auth tool input must never be pruned');
});

test('Pattern 2a: trim_reduce scope="span" atomically collapses aged read-only tool-call/result pairs without breaking role alternation or writes/errors', () => {
  const opts = parseOptions({
    protectRecentMessages: 4,
    protectRecentTokens: 1024,
    keepRecentToolResults: 1,
    pruneAfterToolChars: 10000,
    pruneMinResultChars: 200,
    prunePreviewLines: 0,
  });
  const messages: any[] = [
    { id: 'u0', role: 'user', content: [{ type: 'text', text: 'Check src/a.ts and src/b.ts' }] },
    {
      id: 'a1',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: 'read', input: { filePath: 'src/a.ts' } }],
    },
    {
      id: 't1',
      role: 'tool',
      content: [{ type: 'tool-result', id: 'c1', name: 'read', result: { type: 'text', value: 'a'.repeat(1200) } }],
    },
    {
      id: 'a2',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c2', name: 'grep', input: { pattern: 'foo', path: 'src/b.ts' } }],
    },
    {
      id: 't2',
      role: 'tool',
      content: [{ type: 'tool-result', id: 'c2', name: 'grep', result: { type: 'text', value: 'b'.repeat(1200) } }],
    },
    // A write call in the span must NOT be collapsed!
    {
      id: 'a3',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c3', name: 'edit', input: { filePath: 'src/a.ts', oldString: 'x', newString: 'y' } }],
    },
    {
      id: 't3',
      role: 'tool',
      content: [{ type: 'tool-result', id: 'c3', name: 'edit', result: { type: 'text', value: 'Edited src/a.ts' } }],
    },
    ...makeTail(6),
  ];

  const res = pruneContext(
    { sessionID: 's-span', messages },
    opts,
    {
      allowNewDrops: true,
      directory: '/proj',
      pressure: { ratio: 0.5, usableTokens: 20000 },
      reduceDirectives: [{ scope: 'span', startIndex: 1, endIndex: 6, summary: 'Inspected src/a.ts and src/b.ts for foo', applyNow: true }],
    },
  );
  assert.ok(res.pruned >= 2, `expected collapsed read-only steps, got ${res.pruned}`);
  // No orphan tool-calls or tool-results; edit pair (c3) preserved; read/grep pairs (c1, c2) collapsed!
  const remainingCalls = new Set<string>();
  const remainingResults = new Set<string>();
  for (const m of messages) {
    assert.ok(Array.isArray(m.content) && m.content.length > 0, 'no empty message content array allowed');
    for (const p of m.content) {
      if (p.type === 'tool-call') remainingCalls.add(p.id);
      if (p.type === 'tool-result') remainingResults.add(p.id);
    }
  }
  assert.equal(remainingCalls.has('c1'), false, 'c1 tool-call collapsed');
  assert.equal(remainingResults.has('c1'), false, 'c1 tool-result collapsed');
  assert.equal(remainingCalls.has('c2'), false, 'c2 tool-call collapsed');
  assert.equal(remainingResults.has('c2'), false, 'c2 tool-result collapsed');
  assert.equal(remainingCalls.has('c3'), true, 'edit tool-call preserved');
  assert.equal(remainingResults.has('c3'), true, 'edit tool-result preserved');
  assert.deepEqual([...remainingCalls], [...remainingResults], 'strict 1:1 call/result pairing invariant');
  const allText = messages.flatMap((m) => m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text)).join('\n');
  assert.match(allText, /Inspected src\/a\.ts and src\/b\.ts for foo/);
});

test('Pattern 2b: TRIM_STATS_RPC exposes flush method and server flush bypasses warm-cache deferral on next context turn', async () => {
  assert.ok(TRIM_STATS_RPC.methods.flush, 'RPC schema must define flush method');
  assert.deepEqual(TRIM_STATS_RPC.methods.flush.input.required, ['sessionID']);

  let contextHook: any;
  let rpcHandlers: any;
  let stepCb: any;
  const ctx: any = {
    options: {
      tui: { enabled: true },
      pruning: true,
      protectRecentMessages: 4,
      protectRecentTokens: 1024,
      keepRecentToolResults: 1,
      pruneAfterToolChars: 10000,
      pruneMinResultChars: 200,
      cacheMinSavingsChars: 50000, // huge floor so warm cache normally defers!
      prunePreviewLines: 0,
    },
    location: { directory: '/proj' },
    model: { list: async () => [{ providerID: 'p', id: 'm', limit: { context: 50000, output: 4096 } }] },
    tool: { hook: async () => ({ dispose: async () => {} }) },
    session: {
      hook: async (name: string, fn: any) => {
        if (name === 'context') contextHook = fn;
        return { dispose: async () => {} };
      },
    },
    rpc: {
      register: async (_def: any, handlers: any) => {
        rpcHandlers = handlers;
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: async () => ({
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => { stepCb = resolve; });
        },
      }),
    },
  };

  const cleanup = await setupTrim(ctx);
  assert.equal(typeof rpcHandlers.flush, 'function');

  // Turn 1: initial context below start band (establishes session in cache)
  const baseMsgs = [
    { id: 'a0', role: 'assistant', content: [{ type: 'tool-call', id: 'c0', name: 'shell', input: { command: 'echo a' } }] },
    { id: 't0', role: 'tool', content: [{ type: 'tool-result', id: 'c0', name: 'shell', result: { type: 'text', value: 'x'.repeat(3000) } }] },
    ...makeTail(6),
  ];
  await contextHook({ sessionID: 's-flush', model: { providerID: 'p', id: 'm' }, system: [], tools: {}, messages: structuredClone(baseMsgs) });

  // Call flush RPC -> queues immediate sweep for next turn
  const flushRes = await rpcHandlers.flush({ sessionID: 's-flush' });
  assert.equal(flushRes.queued, true);
  assert.equal(flushRes.sessionID, 's-flush');

  // Next turn with pressure in force band: even with huge cacheMinSavingsChars, flush forces immediate pruning!
  const turn2Msgs = [
    { id: 'a0', role: 'assistant', content: [{ type: 'tool-call', id: 'c0', name: 'shell', input: { command: 'echo a' } }] },
    { id: 't0', role: 'tool', content: [{ type: 'tool-result', id: 'c0', name: 'shell', result: { type: 'text', value: 'x'.repeat(3000) } }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'shell', input: { command: 'echo b' } }] },
    { id: 't1', role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'shell', result: { type: 'text', value: 'y'.repeat(12000) } }] },
    ...makeTail(6),
  ];
  await contextHook({ sessionID: 's-flush', model: { providerID: 'p', id: 'm' }, system: [], tools: {}, messages: turn2Msgs });
  assert.match(turn2Msgs[1].content[0].result.value, /opencode-trim: omitted|old tool output omitted/);
  assert.match(buildGainReport(null), /flush/, 'gain report tip should mention /trim flush');

  if (stepCb) stepCb();
  await cleanup();
});

test('Pattern 3: persistent plannedDrops survive ContextCache restart via memory.db prune_decisions table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trim-drops-'));
  const dbPath = join(dir, 'memory.db');
  const store = openMemoryStore({ dbPath, project: '/proj' });

  const persistence = {
    load: (sid: string) => store.loadPruneDecisions('/proj', sid),
    save: (sid: string, ids: Iterable<string>) => { store.savePruneDecisions('/proj', sid, ids); },
    clear: (sid: string) => { store.clearPruneDecisions('/proj', sid); },
  };

  const opts = parseOptions({ protectRecentMessages: 4, protectRecentTokens: 1024, keepRecentToolResults: 1, pruneAfterToolChars: 10000 });
  const event = { sessionID: 's-persist', model: { providerID: 'p', id: 'm' }, system: [], tools: {}, messages: makeTail(6) };

  // Session 1 commits drops
  const cache1 = new ContextCache();
  cache1.setPersistence(persistence);
  const g1 = cache1.begin(event, opts, { ratio: 0.9 }, 'context', 1000);
  g1.finish(['drop:1', 'drop:2', 'drop:3']);

  // Simulated restart: brand new ContextCache instance hydrates persisted drops!
  const cache2 = new ContextCache();
  cache2.setPersistence(persistence);
  const g2 = cache2.begin(event, opts, { ratio: 0.4 }, 'context', 2000);
  assert.equal(g2.plannedDrops.has('drop:1'), true);
  assert.equal(g2.plannedDrops.has('drop:2'), true);
  assert.equal(g2.plannedDrops.has('drop:3'), true);

  // resetSession clears persisted drops in DB too
  cache2.resetSession('s-persist');
  assert.deepEqual(store.loadPruneDecisions('/proj', 's-persist'), []);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Pattern 4: compact notices, adaptive pressure thresholds, aged git diff pruning, and resolved error pruning', () => {
  // Compact notices keep all required contract phrases while being concise
  const rec = recoverableNotice('trm_0123456789abcdef0123456789abcdef', 'shell', 500, 40);
  assert.ok(rec.length < 250, `recoverableNotice should be compact, got ${rec.length}`);
  assert.match(rec, /bounded, secret-redacted/i);
  assert.match(rec, /RECOVERABLE, not lost/);
  assert.match(rec, /trim_expand/);
  const live = liveDiskNotice('read', 'src/app.ts', 400, 30);
  assert.ok(live.length < 160, `liveDiskNotice should be compact, got ${live.length}`);
  assert.match(live, /live file\/code output.*Do not use trim_expand/);
  const exp = expiredNotice('trm_abc', 'shell');
  assert.ok(exp.length < 140, `expiredNotice should be compact, got ${exp.length}`);
  assert.match(exp, /unavailable — cached original/);

  // protectedShell('git diff') remains true (existing safety contract untouched)
  assert.equal(protectedShell('git diff'), true);

  const opts = parseOptions({
    protectRecentMessages: 4,
    protectRecentTokens: 1024,
    keepRecentToolResults: 1,
    pruneAfterToolChars: 10000,
    pruneMinResultChars: 800,
    prunePreviewLines: 2,
  });

  // Build > 2*protectRecentMessages (8+) aged history with:
  // (a) small 300-char shell output, (b) short 250-char reasoning, (c) aged git diff, (d) resolved shell error + later passing rerun, (e) unresolved shell error
  const msgs: any[] = [
    // 0-1: aged git diff (very old)
    { id: 'gd-c', role: 'assistant', content: [{ type: 'tool-call', id: 'c-gd', name: 'shell', input: { command: 'git diff src/old.ts' } }] },
    { id: 'gd-r', role: 'tool', content: [{ type: 'tool-result', id: 'c-gd', name: 'shell', result: { type: 'text', value: 'diff --git a/src/old.ts b/src/old.ts\n' + '+line\n'.repeat(250) } }] },
    // 2-3: aged small 300-char shell output + short 250-char reasoning
    {
      id: 'sm-c',
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking about small step ' + 'r'.repeat(240) },
        { type: 'tool-call', id: 'c-sm', name: 'shell', input: { command: 'echo small' } },
      ],
    },
    { id: 'sm-r', role: 'tool', content: [{ type: 'tool-result', id: 'c-sm', name: 'shell', result: { type: 'text', value: 'small output line\n'.repeat(18) } }] },
    // 4-5: failed test command that will be resolved later
    { id: 'ef-c', role: 'assistant', content: [{ type: 'tool-call', id: 'c-ef', name: 'shell', input: { command: 'npm test' } }] },
    { id: 'ef-r', role: 'tool', content: [{ type: 'tool-result', id: 'c-ef', name: 'shell', result: { type: 'text', value: 'FAIL test/a.test.ts\nAssertionError: expected 1 to equal 2\n' + 'stack line\n'.repeat(40) + '\nProcess exited with code 1' } }] },
    // 6-7: unresolved failed command (never passes later)
    { id: 'eu-c', role: 'assistant', content: [{ type: 'tool-call', id: 'c-eu', name: 'shell', input: { command: 'npm run lint' } }] },
    { id: 'eu-r', role: 'tool', content: [{ type: 'tool-result', id: 'c-eu', name: 'shell', result: { type: 'text', value: 'ERROR lint failed\n' + 'lint issue\n'.repeat(40) + '\nProcess exited with code 1' } }] },
    // 8-9: later passing rerun of `npm test` (resolves c-ef!)
    { id: 'ep-c', role: 'assistant', content: [{ type: 'tool-call', id: 'c-ep', name: 'shell', input: { command: 'npm test' } }] },
    { id: 'ep-r', role: 'tool', content: [{ type: 'tool-result', id: 'c-ep', name: 'shell', result: { type: 'text', value: 'ok all 50 tests passed\n'.repeat(10) } }] },
    // 10-13: filler turns to push git diff past 2*protectRecentMessages
    { id: 'f1', role: 'user', content: [{ type: 'text', text: 'continue' }] },
    { id: 'f2', role: 'assistant', content: [{ type: 'text', text: 'continuing' }] },
    ...makeTail(6),
  ];

  const vaultMap = new Map<string, string>();
  const vault = {
    store: (id: string, e: any) => { vaultMap.set(id, e.original); return true; },
    has: (id: string) => vaultMap.has(id),
  };

  const res = pruneContext(
    { sessionID: 's-p4', messages: msgs },
    opts,
    { allowNewDrops: true, pressure: { ratio: 0.95, usableTokens: 20000 }, vault },
  );
  assert.ok(res.pruned >= 4);
  // Aged git diff pruned under force pressure (and vaulted!)
  assert.match(msgs[1].content[0].result.value, /RECOVERABLE, not lost.*trm_/);
  // Adaptive pressure drops preview lines to 0 and prunes <800-char result + short reasoning
  assert.equal(msgs[2].content[0].text, '[opencode-trim: historical reasoning trace omitted]');
  assert.match(msgs[3].content[0].result.value, /opencode-trim: omitted/);
  assert.doesNotMatch(msgs[3].content[0].result.value, /small output line/, 'preview lines collapsed to 0 under force pressure');
  // Resolved error pruned, unresolved error preserved!
  assert.ok(msgs[5].content[0].result.value.includes(PRUNED_RESOLVED_ERROR), 'resolved error output should be pruned');
  assert.match(msgs[7].content[0].result.value, /ERROR lint failed/, 'unresolved error output must be preserved');
});

test('Pattern 5: zero-LLM local semantic relevance scoring prunes cold unrelated outputs before hot active-task outputs', () => {
  const ws = new SessionWorkingState();
  ws.recordTool('s-rel', { tool: 'edit', input: { filePath: '/proj/src/auth.ts' } }, 0, '/proj');

  const hotScore = scorePruningRelevance(
    { name: 'read', input: { filePath: '/proj/src/auth.ts' }, original: 'verifyToken session auth handler' },
    new Set(['auth', 'src/auth.ts', 'verifytoken']),
  );
  const coldScore = scorePruningRelevance(
    { name: 'read', input: { filePath: '/proj/docs/legacy-billing.md' }, original: 'legacy invoice export format' },
    new Set(['auth', 'src/auth.ts', 'verifytoken']),
  );
  assert.ok(hotScore > coldScore, `hot score (${hotScore}) must exceed cold score (${coldScore})`);

  const opts = parseOptions({
    protectRecentMessages: 4,
    protectRecentTokens: 1024,
    keepRecentToolResults: 1,
    pruneAfterToolChars: 10000,
    pruneMinResultChars: 400,
    prunePreviewLines: 0,
  });
  // Two identical-sized aged outputs: msg 1 is HOT (src/auth.ts), msg 3 is COLD (docs/legacy.md).
  // Total = 13,000 > 12,500 (dueToSize), target = 8,000 -> only ONE needs to be pruned to reach <= 8,000!
  const hotBody = 'export function authToken() { return "auth"; }\n'.repeat(130); // ~6110 chars
  const coldBody = 'legacy billing archive entry line\n'.repeat(180); // ~6120 chars
  const recentBody = 'recent check\n'.repeat(60); // ~780 chars
  const msgs: any[] = [
    { id: 'hot-c', role: 'assistant', content: [{ type: 'tool-call', id: 'c-hot', name: 'read', input: { filePath: '/proj/src/auth.ts' } }] },
    { id: 'hot-r', role: 'tool', content: [{ type: 'tool-result', id: 'c-hot', name: 'read', result: { type: 'text', value: hotBody } }] },
    { id: 'cold-c', role: 'assistant', content: [{ type: 'tool-call', id: 'c-cold', name: 'read', input: { filePath: '/proj/docs/legacy.md' } }] },
    { id: 'cold-r', role: 'tool', content: [{ type: 'tool-result', id: 'c-cold', name: 'read', result: { type: 'text', value: coldBody } }] },
    { id: 'rec-c', role: 'assistant', content: [{ type: 'tool-call', id: 'c-rec', name: 'read', input: { filePath: '/proj/src/other.ts' } }] },
    { id: 'rec-r', role: 'tool', content: [{ type: 'tool-result', id: 'c-rec', name: 'read', result: { type: 'text', value: recentBody } }] },
    ...makeTail(6),
  ];

  const res = pruneContext(
    { sessionID: 's-rel', messages: msgs },
    opts,
    { allowNewDrops: true, directory: '/proj', workingState: ws.snapshot('s-rel'), pressure: { ratio: 0.4, usableTokens: 20000 } },
  );
  assert.equal(res.pruned, 1, 'should prune exactly one output to satisfy budget');
  assert.match(msgs[3].content[0].result.value, /old tool output omitted|opencode-trim: omitted/, 'cold unrelated output pruned first');
  assert.equal(msgs[1].content[0].result.value, hotBody, 'hot active-task output preserved!');
});

test('Pattern 6: selective ingestion virtualization vaults huge unstructured ephemeral outputs while skipping live-disk, structured, and error outputs', () => {
  const opts = parseOptions({ virtualizeOutputChars: 10000, maxOutputChars: 500000, maxOutputLines: 2000 });
  const vaulted = new Map<string, any>();
  const vault = {
    store: (id: string, e: any) => { vaulted.set(id, e); return true; },
    has: (id: string) => vaulted.has(id),
  };

  // 1. Huge unstructured ephemeral shell output (npm run script) -> virtualized immediately!
  const hugeLog = Array.from({ length: 400 }, (_, i) => `step ${i}: processed batch item ${i} cleanly ok`).join('\n');
  assert.ok(hugeLog.length > 12000);
  const evEphemeral: any = {
    status: 'completed',
    tool: 'shell',
    sessionID: 's-virt',
    input: { command: 'node scripts/report.js' },
    result: { content: hugeLog, output: { exitCode: 0, output: hugeLog } },
  };
  const changed = processToolEvent(evEphemeral, opts, undefined, { directory: '/proj', sessionID: 's-virt', vault });
  assert.equal(changed, true);
  assert.equal(vaulted.size, 1);
  assert.match(evEphemeral.result.content, /RECOVERABLE, not lost.*trm_/);
  assert.ok(evEphemeral.result.content.length < 2500);

  // 2. Live-disk shell command (cat / sed) -> NOT virtualized into vault!
  const evLiveDisk: any = {
    status: 'completed',
    tool: 'shell',
    sessionID: 's-virt',
    input: { command: 'cat src/big.ts' },
    result: { content: hugeLog, output: { exitCode: 0, output: hugeLog } },
  };
  processToolEvent(evLiveDisk, opts, undefined, { directory: '/proj', sessionID: 's-virt', vault });
  assert.equal(vaulted.size, 1, 'live-disk shell command must NOT be virtualized into vault');

  // 3. Structured JSON output -> NOT virtualized!
  const hugeJson = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ id: i, v: 'payload-item-' + i })) });
  const evJson: any = {
    status: 'completed',
    tool: 'shell',
    sessionID: 's-virt',
    input: { command: 'node scripts/dump.js' },
    result: { content: hugeJson, output: { exitCode: 0, output: hugeJson } },
  };
  processToolEvent(evJson, opts, undefined, { directory: '/proj', sessionID: 's-virt', vault });
  assert.equal(vaulted.size, 1, 'structured JSON must NOT be virtualized');

  // 4. Non-zero exit error -> NOT virtualized!
  const evErr: any = {
    status: 'completed',
    tool: 'shell',
    sessionID: 's-virt',
    input: { command: 'node scripts/fail.js' },
    result: { content: hugeLog + '\nError: crash', output: { exitCode: 1, output: hugeLog + '\nError: crash' } },
  };
  processToolEvent(evErr, opts, undefined, { directory: '/proj', sessionID: 's-virt', vault });
  assert.equal(vaulted.size, 1, 'failed command must NOT be virtualized');
});
