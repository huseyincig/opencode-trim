import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTrim } from '../src/plugin.ts';
import { setupMemory, memoryDbBytes } from '../src/memory.ts';
import { parseOptions } from '../src/config.ts';
import { openMemoryStore } from '../src/memory-store.ts';

const DAY = 86400000;
const tick = () => new Promise((r) => setTimeout(r, 15));
function tmpDb() { const d = mkdtempSync(join(tmpdir(), 'trim-mstats-')); return { d, p: join(d, 'm.db') }; }

function harness({ options, directory = '/proj/a' } = {}) {
  const queue = []; let wake; let done = false; let tool; let handlers;
  const ctx = {
    options, location: { directory },
    tool: { hook: async () => ({ dispose: async () => {} }), transform: async (fn) => { fn({ add: (t) => { tool = t; } }); return { dispose: async () => {} }; } },
    session: { hook: async () => ({ dispose: async () => {} }) },
    event: { subscribe: async (args) => {
      args.signal.addEventListener('abort', () => { done = true; wake?.(); });
      return (async function* () { while (!done) { if (queue.length) yield queue.shift(); else await new Promise((r) => { wake = r; }); } })();
    } },
    rpc: { register: async (def, h) => { handlers = h; return { events: { emit: async () => {} }, dispose: async () => {} }; } },
  };
  return { ctx, get tool() { return tool; }, snapshot: (sessionID) => handlers.snapshot({ sessionID }), push: (e) => { queue.push(e); wake?.(); } };
}
const ended = (o = {}) => ({ type: 'session.compaction.ended', location: { directory: '/proj/a' }, data: { sessionID: 's1', text: 'We decided to use sqlite fts5', reason: 'auto', id: 'ev1', ...o } });
const search = (h, q, sessionID = 's1') => h.tool.execute({ query: q }, { signal: new AbortController().signal, agent: 'build', ...(sessionID ? { sessionID } : {}) });

test('store.stats: project scoped, retention-aware, empty project safe', () => {
  const now = Date.now();
  const s = openMemoryStore({ dbPath: ':memory:', retentionDays: 10 });
  s.archive({ event_id: 'a1', project: 'A', text: 'alpha one', created_at: now - 2 * DAY });
  s.archive({ event_id: 'a2', project: 'A', text: 'alpha two', created_at: now - DAY });
  s.archive({ event_id: 'a-old', project: 'A', text: 'alpha ancient', created_at: now - 30 * DAY });
  s.archive({ event_id: 'b1', project: 'B', text: 'beta one', created_at: now });
  assert.deepEqual(s.stats('A', now), { summaries: 2, lastSummaryAt: now - DAY });
  assert.deepEqual(s.stats('B', now), { summaries: 1, lastSummaryAt: now });
  assert.deepEqual(s.stats('C', now), { summaries: 0, lastSummaryAt: null });
  assert.deepEqual(s.stats('', now), { summaries: 0, lastSummaryAt: null });
  assert.deepEqual(s.stats(undefined), { summaries: 0, lastSummaryAt: null });
  s.close();
  assert.throws(() => s.stats('A'), /closed/);
});

test('store.sidebarStats: separates real compactions from custom reasons and aggregates session/project vault', () => {
  const now = Date.now();
  const s = openMemoryStore({ dbPath: ':memory:', retentionDays: 10 });
  s.archive({ event_id: 'c1', project: 'A', session_id: 's1', reason: 'manual', text: 'manual summary 1', created_at: now - 3 * DAY });
  s.archive({ event_id: 'c2', project: 'A', session_id: 's1', reason: 'auto', text: 'auto summary 2', created_at: now - DAY });
  s.archive({ event_id: 'other-kind', project: 'A', session_id: 's1', reason: 'custom:note', text: 'non compaction note', created_at: now - 1000 });
  s.archive({ event_id: 'other-sess', project: 'A', session_id: 's2', reason: 'manual', text: 'other session summary', created_at: now - 2000 });
  s.saveVault({ project: 'A', session_id: 's1', ref_id: 'trm_1', tool: 'read', target: 'a.ts', text: 'x'.repeat(1200), created_at: now - 2 * DAY });
  s.saveVault({ project: 'A', session_id: 's2', ref_id: 'trm_2', tool: 'shell', target: 'ls', text: 'y'.repeat(800), created_at: now - DAY });
  const st = s.sidebarStats('A', 's1', now);
  assert.equal(st.summaries, 4);
  assert.equal(st.vaultRefs, 2);
  assert.equal(st.vaultChars, 2000);
  assert.equal(st.sessionCompactions, 2);
  assert.equal(st.sessionAutoCompactions, 1);
  assert.equal(st.sessionManualCompactions, 1);
  assert.equal(st.sessionLastCompactionAt, now - DAY);
  assert.equal(st.sessionLastCompactionReason, 'auto');
  assert.equal(st.sessionFirstAt, now - 3 * DAY);
  assert.equal(st.sessionVaultRefs, 1);
  assert.equal(st.sessionVaultChars, 1200);
  s.close();
});

test('memoryDbBytes: file + wal, null for :memory:, missing file, bad input', () => {
  const { d, p } = tmpDb();
  assert.equal(memoryDbBytes(':memory:'), null);
  assert.equal(memoryDbBytes(join(d, 'missing.db')), null);
  assert.equal(memoryDbBytes(undefined), null);
  assert.equal(memoryDbBytes(''), null);
  writeFileSync(p, Buffer.alloc(1000));
  assert.equal(memoryDbBytes(p), 1000);
  writeFileSync(`${p}-wal`, Buffer.alloc(234));
  assert.equal(memoryDbBytes(p), 1234);
  rmSync(d, { recursive: true });
});

test('setupMemory hooks: onReady/onSearch/onClose fire; a throwing hook never affects memory', async () => {
  const { d, p } = tmpDb();
  const calls = [];
  const h = harness();
  const opts = parseOptions({ memory: { enabled: true, dbPath: p } });
  const stop = await setupMemory(h.ctx, opts, {
    onReady: ({ project, store, dbPath }) => { calls.push(['ready', project, typeof store.stats, dbPath === p]); throw new Error('hook boom'); },
    onSearch: ({ sessionID, results }) => { calls.push(['search', sessionID, results.length]); throw new Error('hook boom'); },
    onClose: ({ project }) => { calls.push(['close', project]); throw new Error('hook boom'); },
  });
  h.push(ended()); await tick(); await tick();
  const r = await search(h, 'sqlite');
  assert.match(r.content, /sqlite/);
  await stop(); await stop();
  assert.deepEqual(calls, [['ready', '/proj/a', 'function', true], ['search', 's1', 1], ['close', '/proj/a']]);
  rmSync(d, { recursive: true });
});

test('plugin stats: memory summaries, searches, db size, project isolation', async () => {
  const { d, p } = tmpDb();
  const seed = openMemoryStore({ dbPath: p });
  seed.archive({ event_id: 'other', project: '/proj/b', text: 'foreign sqlite summary', created_at: Date.now() });
  seed.close();
  const h = harness({ options: { tui: { enabled: true }, memory: { enabled: true, dbPath: p } } });
  const stop = await setupTrim(h.ctx);
  let m = (await h.snapshot('s1')).memory;
  assert.deepEqual([m.enabled, m.active, m.error, m.summaries, m.searches, m.searchResults], [true, true, null, 0, 0, 0]);
  assert.ok(m.dbBytes > 0);
  h.push(ended()); await tick(); await tick();
  await search(h, 'sqlite'); await search(h, 'nomatchzzz'); await search(h, 'sqlite', 's2');
  m = (await h.snapshot('s1')).memory;
  assert.equal(m.summaries, 1, 'only this project');
  assert.ok(m.lastSummaryAt > 0);
  assert.deepEqual([m.searches, m.searchResults], [2, 1]);
  const m2 = (await h.snapshot('s2')).memory;
  assert.deepEqual([m2.searches, m2.searchResults, m2.summaries], [1, 1, 1]);
  assert.ok(!JSON.stringify(await h.snapshot('s1')).includes('sqlite'));
  await stop();
  assert.ok(existsSync(p));
  rmSync(d, { recursive: true });
});

test('plugin stats: memory in-memory DB => dbBytes null; memory off => inactive and null counts', async () => {
  const mem = harness({ options: { tui: { enabled: true }, memory: { enabled: true, dbPath: ':memory:' } } });
  const stopMem = await setupTrim(mem.ctx);
  const m = (await mem.snapshot('s1')).memory;
  assert.deepEqual([m.active, m.dbBytes, m.summaries], [true, null, 0]);
  await stopMem();
  const off = harness({ options: { tui: { enabled: true } } });
  const stopOff = await setupTrim(off.ctx);
  const o = (await off.snapshot('s1')).memory;
  assert.deepEqual(o, { enabled: false, active: false, error: null, summaries: null, searches: null, searchResults: null, lastSummaryAt: null, dbBytes: null });
  await stopOff();
});

test('plugin stats: memory setup failure is reported as error, Trim keeps working', async () => {
  const { d, p } = tmpDb();
  writeFileSync(p, 'x');
  const h = harness({ options: { tui: { enabled: true }, memory: { enabled: true, dbPath: join(p, 'sub', 'm.db') } } }); // parent is a file
  const stop = await setupTrim(h.ctx);
  const m = (await h.snapshot('s1')).memory;
  assert.deepEqual([m.enabled, m.active, m.error, m.summaries], [true, false, 'setup-failed', null]);
  await stop();
  rmSync(d, { recursive: true });
});

test('plugin stats: after cleanup memory is inactive; archive persistence unchanged', async () => {
  const { d, p } = tmpDb();
  const h = harness({ options: { tui: { enabled: true }, memory: { enabled: true, dbPath: p } } });
  const stop = await setupTrim(h.ctx);
  h.push(ended({ id: 'persist' })); await tick(); await tick();
  await stop();
  const s = openMemoryStore({ dbPath: p });
  assert.equal(s.search({ project: '/proj/a', query: 'sqlite' }).length, 1);
  assert.deepEqual(s.stats('/proj/a').summaries, 1);
  s.close();
  rmSync(d, { recursive: true });
});

test('stats: foreign-location context event cannot consume local compaction awaitingAfter', async () => {
  const { d, p } = tmpDb();
  let ctxCb, compHandler, rpcHandler;
  const ctx = {
    location: { directory: '/proj/local' },
    options: { pruning: false, shell: false, toolFiltering: false, tui: { enabled: true }, memory: { enabled: false } },
    tool: { hook: async () => ({ dispose() {} }) },
    session: { hook: async (name, cb) => { if (name === 'context') ctxCb = cb; return { dispose() {} }; } },
    rpc: { register: async (_def, impl) => { rpcHandler = impl; return { dispose() {}, events: { emit() {} } }; } },
    event: {
      subscribe: async () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'session.compaction.started', location: { directory: '/proj/local' }, data: { sessionID: 's1' } };
          yield { type: 'session.compaction.ended', location: { directory: '/proj/local' }, data: { sessionID: 's1', reason: 'auto' } };
          await new Promise(r => setTimeout(r, 20));
        },
      }),
    },
  };
  const stop = await setupTrim(ctx);
  await new Promise(r => setTimeout(r, 10));
  // Foreign-location context event with same sessionID must be ignored.
  await ctxCb({ sessionID: 's1', location: { directory: '/proj/foreign' }, messages: [{ role: 'user', content: 'foreign'.repeat(50) }] });
  let snap = await rpcHandler.snapshot({ sessionID: 's1' });
  assert.equal(snap.compaction.afterTokens, null);
  assert.equal(snap.context.known, false);
  // Local context event fills afterTokens normally.
  await ctxCb({ sessionID: 's1', location: { directory: '/proj/local' }, messages: [{ role: 'user', content: 'local'.repeat(20) }] });
  snap = await rpcHandler.snapshot({ sessionID: 's1' });
  assert.ok(snap.compaction.afterTokens > 0);
  await stop(); rmSync(d, { recursive: true });
});
