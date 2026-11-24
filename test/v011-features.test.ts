import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextCache, evaluateCacheBreakEven } from '../src/cache.ts';
import { parseOptions } from '../src/config.ts';
import { pruneContext, stableMessageKey } from '../src/prune.ts';
import { estimateRequest } from '../src/pressure.ts';
import { createTrimStats } from '../src/stats.ts';
import { buildGainReport, normalizeSnapshot } from '../src/tui-model.ts';
import { openMemoryStore } from '../src/memory-store.ts';
import { setupMemory, TOOL_NAME } from '../src/memory.ts';

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

test('Feature 1: cold-cache opportunity window (TTL & cache miss) + warm cache break-even gate', () => {
  const opts = parseOptions({ cacheTtlMs: 300_000, cacheMinSavingsChars: 6000 });
  assert.equal(opts.cacheTtlMs, 300_000);
  assert.equal(opts.cacheMinSavingsChars, 6000);

  // Pure break-even math
  assert.equal(evaluateCacheBreakEven({ savedChars: 500, remainingChars: 600_000, isColdCache: true, isCritical: false, minSavingsChars: 6000 }).allow, true);
  assert.equal(evaluateCacheBreakEven({ savedChars: 500, remainingChars: 600_000, isColdCache: false, isCritical: true, minSavingsChars: 6000 }).allow, true);
  assert.equal(evaluateCacheBreakEven({ savedChars: 3000, remainingChars: 600_000, isColdCache: false, isCritical: false, minSavingsChars: 6000 }).allow, false);
  // Warm 600k-char cache with 0.25 write penalty over 4 turns needs > 37.5k chars saved
  assert.equal(evaluateCacheBreakEven({ savedChars: 15_000, remainingChars: 600_000, isColdCache: false, isCritical: false, minSavingsChars: 6000 }).allow, false);
  assert.equal(evaluateCacheBreakEven({ savedChars: 60_000, remainingChars: 600_000, isColdCache: false, isCritical: false, minSavingsChars: 6000 }).allow, true);

  // ContextCache TTL cold window admits drops when idle >= cacheTtlMs even below force band
  const cache = new ContextCache();
  const ev = { sessionID: 's-ttl', model: { providerID: 'p', id: 'm' }, messages: [{ id: 'm1', role: 'user', content: 'hi' }], tools: {}, system: [] };
  const t0 = 1_700_000_000_000;
  const g1 = cache.begin(ev, opts, { ratio: 0.5 }, 'context', t0);
  assert.equal(g1.allowNewDrops, true); // first turn (changed)
  // 10s later, warm cache, still at 0.5 => deferred
  cache.observeCacheRead('s-ttl', 120_000);
  const g2 = cache.begin(ev, opts, { ratio: 0.5 }, 'context', t0 + 10_000);
  assert.equal(g2.allowNewDrops, false);
  assert.equal(g2.warmCache, true);
  // 6 minutes later (> 5m TTL) => cold cache opportunity window opens!
  const g3 = cache.begin(ev, opts, { ratio: 0.5 }, 'context', t0 + 370_000);
  assert.equal(g3.allowNewDrops, true);
  assert.equal(g3.coldCache, true);
  // Explicit cache miss (cache.read === 0) => cold cache opportunity window opens!
  cache.observeCacheRead('s-ttl', 0);
  const g4 = cache.begin(ev, opts, { ratio: 0.5 }, 'context', t0 + 375_000);
  assert.equal(g4.allowNewDrops, true);
  assert.equal(g4.coldCache, true);
});

test('Feature 2: write-invalidated stale-read pruning (success invalidates, failed edit & protected files stay safe)', () => {
  const opts = parseOptions({ protectRecentMessages: 4, protectRecentTokens: 1024, keepRecentToolResults: 2, supersessionMinChars: 1000, pruneMinResultChars: 500 });
  const bigRead = 'const x = 1;\n'.repeat(200); // > 2500 chars
  const makeTail = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `tail-${i}`, role: i % 2 ? 'assistant' : 'user', content: `msg ${i} ` + 'z'.repeat(1200) }));

  // Case A: read src/app.ts -> successful edit src/app.ts -> older read is invalidated & pruned even below pressure
  const msgsA: any[] = [
    { id: 'm1', role: 'assistant', content: [{ type: 'tool', id: 'c1', tool: 'read', input: { filePath: 'src/app.ts' }, state: { status: 'completed', output: bigRead } }] },
    { id: 'm2', role: 'assistant', content: [{ type: 'tool', id: 'c2', tool: 'edit', input: { filePath: './src/app.ts' }, state: { status: 'completed', output: 'edited ok' } }] },
    { id: 'm3', role: 'assistant', content: [{ type: 'tool', id: 'c3', tool: 'read', input: { filePath: 'src/other1.ts' }, state: { status: 'completed', output: bigRead } }] },
    { id: 'm4', role: 'assistant', content: [{ type: 'tool', id: 'c4', tool: 'read', input: { filePath: 'src/other2.ts' }, state: { status: 'completed', output: bigRead } }] },
    ...makeTail(5),
  ];
  const rA = pruneContext({ sessionID: 's-w1', messages: msgsA }, opts, { pressure: { ratio: 0.3, usableTokens: 20_000 }, allowNewDrops: true });
  assert.equal(rA.pruned, 1);
  assert.ok(msgsA[0].content[0].state.output.includes('[opencode-trim:'));

  // Case B: failed edit must NOT invalidate earlier read
  const msgsB: any[] = [
    { id: 'm1', role: 'assistant', content: [{ type: 'tool', id: 'c1', tool: 'read', input: { filePath: 'src/app.ts' }, state: { status: 'completed', output: bigRead } }] },
    { id: 'm2', role: 'assistant', content: [{ type: 'tool', id: 'c2', tool: 'edit', input: { filePath: 'src/app.ts' }, state: { status: 'error', error: 'conflict', output: 'Error: conflict' } }] },
    { id: 'm3', role: 'assistant', content: [{ type: 'tool', id: 'c3', tool: 'read', input: { filePath: 'src/other1.ts' }, state: { status: 'completed', output: bigRead } }] },
    { id: 'm4', role: 'assistant', content: [{ type: 'tool', id: 'c4', tool: 'read', input: { filePath: 'src/other2.ts' }, state: { status: 'completed', output: bigRead } }] },
    ...makeTail(5),
  ];
  const rB = pruneContext({ sessionID: 's-w2', messages: msgsB }, opts, { pressure: { ratio: 0.3, usableTokens: 20_000 }, allowNewDrops: true });
  assert.equal(rB.pruned, 0);
  assert.equal(msgsB[0].content[0].state.output, bigRead);

  // Case C: AGENTS.md (instruction file) is never pruned even after edit
  const msgsC: any[] = [
    { id: 'm1', role: 'assistant', content: [{ type: 'tool', id: 'c1', tool: 'read', input: { filePath: 'AGENTS.md' }, state: { status: 'completed', output: bigRead } }] },
    { id: 'm2', role: 'assistant', content: [{ type: 'tool', id: 'c2', tool: 'edit', input: { filePath: 'AGENTS.md' }, state: { status: 'completed', output: 'ok' } }] },
    { id: 'm3', role: 'assistant', content: [{ type: 'tool', id: 'c3', tool: 'read', input: { filePath: 'src/other1.ts' }, state: { status: 'completed', output: bigRead } }] },
    { id: 'm4', role: 'assistant', content: [{ type: 'tool', id: 'c4', tool: 'read', input: { filePath: 'src/other2.ts' }, state: { status: 'completed', output: bigRead } }] },
    ...makeTail(5),
  ];
  const rC = pruneContext({ sessionID: 's-w3', messages: msgsC }, opts, { pressure: { ratio: 0.3, usableTokens: 20_000 }, allowNewDrops: true });
  assert.equal(rC.pruned, 0);
});

test('Feature 3, 4 & 5: post-compaction verification, top-3 bloat tools, and ghost/system overhead diagnostics', () => {
  const opts = parseOptions({ maxTokens: '250k' });
  const tools: Record<string, any> = {};
  for (let i = 0; i < 30; i++) {
    tools[`tool_${i}`] = { description: 'd'.repeat(1600), parameters: { type: 'object' } };
  }
  const req = {
    model: { providerID: 'p', id: 'm' },
    system: ['S'.repeat(15_000)],
    tools,
    messages: [
      { id: 'u1', role: 'user', content: 'analyze repo' },
      {
        id: 'a1', role: 'assistant', content: [
          { type: 'tool', tool: 'read', state: { status: 'completed', output: 'R'.repeat(60_000) } },
          { type: 'tool', tool: 'grep', state: { status: 'completed', output: 'G'.repeat(24_000) } },
          { type: 'tool', tool: 'shell', state: { status: 'completed', output: 'B'.repeat(12_000) } },
          { type: 'tool', tool: 'glob', state: { status: 'completed', output: 'L'.repeat(2_000) } },
        ],
      },
    ],
  };
  const limits = new Map([['p/m', { context: 1_000_000, output: 16_384 }]]);
  const est = estimateRequest(req, limits, opts);
  assert.ok(est.diagnostics);
  assert.equal(est.diagnostics.toolCount, 30);
  assert.ok(est.diagnostics.toolSchemaChars > 40_000);
  assert.deepEqual(est.diagnostics.topTools.map((t: any) => t.name), ['read', 'grep', 'shell']);

  const stats = createTrimStats({ options: opts });
  stats.recordContext({
    sessionID: 's1', estimatedTokens: 240_000, estimatedChars: 720_000, usableTokens: 250_000, limitTokens: 1_000_000,
    ratio: 0.96, source: 'model-catalog', media: false, breakdown: est.breakdown, diagnostics: est.diagnostics,
  });
  stats.recordCompactionEvent({ sessionID: 's1', type: 'started', reason: 'auto' });
  stats.recordCompactionEvent({ sessionID: 's1', type: 'ended', reason: 'auto' });
  // Under-reduced compaction: still at 220k / 250k (88%)
  stats.recordContext({
    sessionID: 's1', estimatedTokens: 220_000, estimatedChars: 660_000, usableTokens: 250_000, limitTokens: 1_000_000,
    ratio: 0.88, source: 'model-catalog', media: false, breakdown: est.breakdown, diagnostics: est.diagnostics,
  });
  const snapUnder = stats.snapshot('s1');
  assert.equal(snapUnder.compaction.verification, 'under-reduced');
  assert.equal(snapUnder.compaction.afterRatio, 0.88);
  const norm = normalizeSnapshot(snapUnder);
  assert.equal(norm.compaction.verification, 'under-reduced');
  assert.equal(norm.context.diagnostics.toolCount, 30);

  const rep = buildGainReport(snapUnder, Date.now());
  assert.ok(rep.split('\n').every(isAscii), rep);
  assert.match(rep, /Top tools: read .* \| grep .* \| shell/);
  assert.match(rep, /Overhead alert: system\+tools/);
  assert.match(rep, /Compaction check: WARNING under-reduced/);

  // Effective compaction check
  stats.recordCompactionEvent({ sessionID: 's1', type: 'started', reason: 'manual' });
  stats.recordCompactionEvent({ sessionID: 's1', type: 'ended', reason: 'manual' });
  stats.recordContext({
    sessionID: 's1', estimatedTokens: 60_000, estimatedChars: 180_000, usableTokens: 250_000, limitTokens: 1_000_000,
    ratio: 0.24, source: 'model-catalog', media: false, breakdown: est.breakdown, diagnostics: est.diagnostics,
  });
  assert.equal(stats.snapshot('s1').compaction.verification, 'effective');
  const repOk = buildGainReport(stats.snapshot('s1'), Date.now());
  assert.match(repOk, /Compaction check: effective/);
});

test('Feature 6: trim_history_search recent & scope=all + opt-in prompt-cache-safe frozen <recent_work>', async () => {
  const store = openMemoryStore({ dbPath: ':memory:', retentionDays: 90, project: '/proj/alpha' });
  const now = Date.now();
  store.archive({ event_id: 'e1', project: '/proj/alpha', session_id: 'sa1', reason: 'auto', created_at: now - 20_000, text: '## Objective\nRefactor auth token cache for alpha.\n## Decisions\nUse HMAC.' });
  store.archive({ event_id: 'e2', project: '/proj/alpha', session_id: 'sa2', reason: 'manual', created_at: now - 10_000, text: '## Objective\nOptimize TUI sidebar polling.\n## Next Move\nShip v0.11.' });
  store.archive({ event_id: 'e3', project: '/proj/beta', session_id: 'sb1', reason: 'auto', created_at: now - 5_000, text: '## Objective\nMigrate beta worker queue to SQLite.\n## Decisions\nUse WAL.' });

  // recent: true without query
  const rec = store.search({ project: '/proj/alpha', recent: true, limit: 5, now });
  assert.equal(rec.length, 2);
  assert.equal(rec[0].session_id, 'sa2');
  assert.equal(rec[1].session_id, 'sa1');

  // scope: 'all' searches across projects
  const allMatch = store.search({ project: '/proj/alpha', query: 'worker queue', scope: 'all', now });
  assert.equal(allMatch.length, 1);
  assert.equal(allMatch[0].project, '/proj/beta');
  const projOnly = store.search({ project: '/proj/alpha', query: 'worker queue', scope: 'project', now });
  assert.equal(projOnly.length, 0);

  // recentWork formatted block
  const block = store.recentWork({ project: '/proj/alpha', limit: 5, now });
  assert.ok(block && block.startsWith('<recent_work>') && block.endsWith('</recent_work>'));
  assert.match(block, /Optimize TUI sidebar polling/);
  assert.match(block, /Refactor auth token cache/);
  assert.doesNotMatch(block, /beta worker queue/);
  store.close();

  // Integration via setupMemory with memory.recentWork: true
  const opts = parseOptions({ memory: { enabled: true, dbPath: ':memory:', recentWork: true } });
  assert.equal(opts.memory.recentWork, true);

  let contextHook: any = null;
  const tools = new Map<string, any>();
  let storeRef: any = null;
  const fakeCtx = {
    location: { directory: '/proj/alpha' },
    tool: {
      hook: async () => ({ dispose() {} }),
      transform: async (fn: any) => { fn({ add: (t: any) => tools.set(t.name, t) }); return { dispose() {} }; },
    },
    session: {
      hook: async (name: string, fn: any) => { if (name === 'context') contextHook = fn; return { dispose() {} }; },
      get: async ({ sessionID }: any) => (sessionID === 'child-via-api' ? { id: sessionID, parentID: 'top-1' } : { id: sessionID }),
    },
    event: {
      subscribe: async () => ({ async *[Symbol.asyncIterator]() {} }),
    },
  };
  const stop = await setupMemory(fakeCtx, opts, { onReady: ({ store: st }: any) => { storeRef = st; } });
  try {
    storeRef.archive({ event_id: 'e10', project: '/proj/alpha', session_id: 'prev-1', reason: 'auto', created_at: Date.now() - 5000, text: '## Objective\nShip frozen recent work context.' });

    // Top-level session turn 1 gets a valid V2 SystemPart ({ type: 'text', text }) -- NEVER a raw string!
    const ev1: any = { sessionID: 'top-1', location: { directory: '/proj/alpha' }, system: [{ type: 'text', text: 'base system' }], messages: [] };
    await contextHook(ev1);
    assert.equal(ev1.system.length, 2);
    // Simulate V2 provider request compiler: req.system.filter((b) => b.text.length > 0)
    const compiled = ev1.system.filter((b: any) => b.text.length > 0);
    assert.equal(compiled.length, 2);
    const frozenPart1 = ev1.system[1];
    assert.equal(frozenPart1.type, 'text');
    assert.match(frozenPart1.text, /<recent_work>/);
    assert.match(frozenPart1.text, /Ship frozen recent work context/);

    // Archive another summary mid-session; turn 2 of top-1 MUST still receive the exact byte-identical frozen block!
    storeRef.archive({ event_id: 'e11', project: '/proj/alpha', session_id: 'prev-2', reason: 'auto', created_at: Date.now(), text: '## Objective\nNew later summary that must not bust cache.' });
    const ev2: any = { sessionID: 'top-1', location: { directory: '/proj/alpha' }, system: [{ type: 'text', text: 'base system' }], messages: [] };
    await contextHook(ev2);
    assert.equal(ev2.system[1].type, 'text');
    assert.equal(ev2.system[1].text, frozenPart1.text, 'frozen <recent_work> must stay byte-identical across turns for prompt cache stability');

    // Subagent session (via event.parentID OR ctx.session.get().parentID) MUST NOT receive <recent_work>
    const evSub: any = { sessionID: 'sub-1', parentID: 'top-1', location: { directory: '/proj/alpha' }, system: [{ type: 'text', text: 'base system' }], messages: [] };
    await contextHook(evSub);
    assert.equal(evSub.system.length, 1);

    const evChildApi: any = { sessionID: 'child-via-api', location: { directory: '/proj/alpha' }, system: [{ type: 'text', text: 'base system' }], messages: [] };
    await contextHook(evChildApi);
    assert.equal(evChildApi.system.length, 1);

    // trim_history_search tool supports recent: true and scope: 'all'
    const searchTool = tools.get(TOOL_NAME);
    const res = await searchTool.execute({ recent: true, limit: 5 }, { sessionID: 'top-1' });
    assert.equal(res.output.results.length, 2);
  } finally {
    await stop();
  }
});

test('Feature 7: FNV-1a stableMessageKey fallback gives ID-less V2 Prompt.Message deterministic post-prune-invariant keys', () => {
  const big = 'line content ok\n'.repeat(120);
  const msgA = { role: 'assistant', content: [{ type: 'text', text: 'checking file A' }, { type: 'tool', tool: 'read', input: { filePath: 'a.ts' }, state: { status: 'completed', output: big } }] };
  const msgB = { role: 'assistant', content: [{ type: 'text', text: 'checking file B' }, { type: 'tool', tool: 'read', input: { filePath: 'b.ts' }, state: { status: 'completed', output: big } }] };

  const kA1 = stableMessageKey(msgA);
  const kB1 = stableMessageKey(msgB);
  assert.ok(kA1.startsWith('m_'));
  assert.ok(kB1.startsWith('m_'));
  assert.notEqual(kA1, kB1, 'distinct ID-less messages must not collide');
  assert.equal(stableMessageKey(msgA), kA1, 'deterministic across calls');

  // After mutating/pruning the tool output in place, stableMessageKey MUST remain identical!
  msgA.content[1].state.output = '[opencode-trim: old tool output omitted from model context]';
  assert.equal(stableMessageKey(msgA), kA1, 'key must remain invariant after output pruning');

  // Explicit msg.id is always preserved verbatim
  assert.equal(stableMessageKey({ id: 'real-id-42', role: 'user', content: 'hi' }), 'real-id-42');
});

test('Debug hardening: monorepo stale-read path isolation, warm-cache rollback, limit=12, and <recent_work> breakout sanitization', () => {
  // 1. Monorepo same-basename path isolation (Bug #2)
  const opts = parseOptions({ protectRecentMessages: 4, protectRecentTokens: 1024, keepRecentToolResults: 2, supersessionMinChars: 1000, pruneMinResultChars: 500 });
  const bigRead = 'const x = 1;\n'.repeat(200);
  const makeTail = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t-${i}`, role: i % 2 ? 'assistant' : 'user', content: `m ${i} ` + 'z'.repeat(1200) }));
  const msgsMono: any[] = [
    { id: 'm1', role: 'assistant', content: [{ type: 'tool', id: 'c1', tool: 'read', input: { filePath: 'src/index.ts' }, state: { status: 'completed', output: bigRead } }] },
    { id: 'm2', role: 'assistant', content: [{ type: 'tool', id: 'c2', tool: 'edit', input: { filePath: '/proj/packages/a/src/index.ts' }, state: { status: 'completed', output: 'ok' } }] },
    { id: 'm3', role: 'assistant', content: [{ type: 'tool', id: 'c3', tool: 'read', input: { filePath: 'src/other1.ts' }, state: { status: 'completed', output: bigRead } }] },
    { id: 'm4', role: 'assistant', content: [{ type: 'tool', id: 'c4', tool: 'read', input: { filePath: 'src/other2.ts' }, state: { status: 'completed', output: bigRead } }] },
    ...makeTail(5),
  ];
  const rMono = pruneContext({ sessionID: 's-mono', messages: msgsMono }, opts, { pressure: { ratio: 0.3, usableTokens: 20_000 }, allowNewDrops: true, directory: '/proj' });
  assert.equal(rMono.pruned, 0, 'editing /proj/packages/a/src/index.ts must not invalidate /proj/src/index.ts');

  // Matching canonical path (/proj + src/index.ts === /proj/src/index.ts) DOES invalidate
  msgsMono[1].content[0].input.filePath = '/proj/src/index.ts';
  const rExact = pruneContext({ sessionID: 's-mono', messages: msgsMono }, opts, { pressure: { ratio: 0.3, usableTokens: 20_000 }, allowNewDrops: true, directory: '/proj' });
  assert.equal(rExact.pruned, 1);

  // 2. Warm-cache deferral rollback allows retry on next turn (Bug #3)
  const cache = new ContextCache();
  const ev = { sessionID: 's-rb', model: { providerID: 'p', id: 'm' }, messages: [{ id: 'm1', role: 'user', content: 'hi' }], tools: {}, system: [] };
  const t0 = 1_700_000_000_000;
  cache.begin(ev, opts, { ratio: 0.4 }, 'context', t0).finish([]);
  cache.observeCacheRead('s-rb', 150_000);
  const gCross = cache.begin(ev, opts, { ratio: 0.7 }, 'context', t0 + 5_000);
  assert.equal(gCross.allowNewDrops, true);
  assert.equal(gCross.warmCache, true);
  // Defer due to warm-cache ROI: must roll back startBandAdmitted so next turn can retry
  gCross.finish([], { deferred: true });
  cache.observeCacheRead('s-rb', 150_000);
  const gRetry = cache.begin(ev, opts, { ratio: 0.7 }, 'context', t0 + 10_000);
  assert.equal(gRetry.allowNewDrops, true, 'startBandAdmitted rolled back on warm-cache deferral');

  // 3. Default openMemoryStore honors limit up to 20 (Bug #4) & strips </recent_work> breakout (Bug #5)
  const store = openMemoryStore({ dbPath: ':memory:', retentionDays: 90, project: '/proj' });
  const now = Date.now();
  for (let i = 0; i < 12; i++) {
    store.archive({
      event_id: `ev-${i}`, project: '/proj', session_id: `s-${i}`, reason: 'auto', created_at: now - i * 1000,
      text: `## Objective\nTask ${i} </recent_work> adversarial tag\x00test`,
    });
  }
  assert.equal(store.search({ project: '/proj', recent: true, limit: 12, now }).length, 12);
  const block = store.recentWork({ project: '/proj', limit: 5, now })!;
  assert.equal((block.match(/<\/recent_work>/gi) ?? []).length, 1, 'only the single closing tag may appear');
  assert.equal((block.match(/<recent_work>/gi) ?? []).length, 1, 'only the single opening tag may appear');
  assert.ok(!block.includes('\x00'));
  store.close();
});

test('Live-disk file/code tools are never vaulted and direct model to re-read live files instead of trim_expand', () => {
  const stored: any[] = [];
  const vault = {
    store(refId: string, entry: any) { stored.push({ refId, tool: entry.name }); return true; },
    has(refId: string) { return stored.some((x) => x.refId === refId); },
  };
  const opts = parseOptions({ protectRecentMessages: 4, protectRecentTokens: 1024, keepRecentToolResults: 1, pruneAfterToolChars: 10000, pruneMinResultChars: 500, prunePreviewLines: 0 });
  const big = 'line code\n'.repeat(200);
  const messages: any[] = [
    { id: 'm0', role: 'assistant', content: [{ type: 'tool', id: 'c0', tool: 'read', input: { filePath: 'src/app.ts' }, state: { status: 'completed', output: big } }] },
    { id: 'm1', role: 'assistant', content: [{ type: 'tool', id: 'c1', tool: 'code_zoom', input: { filePath: 'src/app.ts' }, state: { status: 'completed', output: big } }] },
    { id: 'm2', role: 'assistant', content: [{ type: 'tool', id: 'c2', tool: 'grep', input: { pattern: 'foo' }, state: { status: 'completed', output: big } }] },
    { id: 'm3', role: 'assistant', content: [{ type: 'tool', id: 'c3', tool: 'shell', input: { command: 'echo build log' }, state: { status: 'completed', output: big } }] },
    { id: 'm4', role: 'assistant', content: [{ type: 'tool', id: 'c4', tool: 'read', input: { filePath: 'src/recent.ts' }, state: { status: 'completed', output: big } }] },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `tail-${i}`, role: i % 2 ? 'assistant' : 'user', content: `t${i} ` + 'z'.repeat(1200) })),
  ];
  const res = pruneContext({ sessionID: 's-live', messages }, opts, { allowNewDrops: true, pressure: { ratio: 0.9, usableTokens: 20_000 }, vault });
  assert.equal(res.pruned, 4);
  // ONLY shell was vaulted; read, code_zoom, grep were NOT vaulted!
  assert.deepEqual(stored.map((x) => x.tool), ['shell']);
  assert.match(messages[0].content[0].state.output, /live file\/code output.*src\/app\.ts.*Do not use trim_expand/);
  assert.doesNotMatch(messages[0].content[0].state.output, /trm_/);
  assert.match(messages[1].content[0].state.output, /live file\/code output.*code_zoom/);
  assert.doesNotMatch(messages[1].content[0].state.output, /trm_/);
  assert.match(messages[2].content[0].state.output, /live file\/code output.*grep/);
  assert.match(messages[3].content[0].state.output, /RECOVERABLE, not lost.*trm_/);

  // Re-running pruneContext must NOT double-prune liveDiskNotice
  const res2 = pruneContext({ sessionID: 's-live', messages }, opts, { allowNewDrops: true, pressure: { ratio: 0.9, usableTokens: 20_000 }, vault });
  assert.equal(res2.pruned, 0);
});
