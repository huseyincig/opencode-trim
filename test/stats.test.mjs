import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrimStats } from '../src/stats.js';
import { parseOptions } from '../src/config.js';

function fakeTimers() {
  const timers = new Map(); let next = 1;
  return {
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    pending: () => timers.size,
    fire: () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } },
  };
}
function mk(extra = {}, optionOverrides = {}) {
  const t = fakeTimers();
  const emits = [];
  let clock = 1000;
  const stats = createTrimStats({
    options: parseOptions({ memory: { enabled: false }, ...optionOverrides }),
    now: () => clock++, emit: (s, r) => emits.push([s, r]),
    setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, ...extra,
  });
  return { stats, t, emits };
}
const ctxOf = (o = {}) => ({ estimatedTokens: 1000, estimatedChars: 3000, usableTokens: 10000, limitTokens: 18192, ratio: 0.1, source: 'event-model', media: false, ...o });

test('unknown values are null, measured zero stays 0', () => {
  const { stats } = mk();
  const s = stats.snapshot('s1');
  assert.equal(s.version, 1);
  assert.equal(s.sessionID, 's1');
  assert.equal(s.since, null);
  assert.equal(s.revision, 0);
  assert.deepEqual(s.context, { known: false, estimatedTokens: null, estimatedChars: null, usableTokens: null, limitTokens: null, ratio: null, source: null, media: null, at: null });
  assert.equal(s.compaction.known, false);
  assert.equal(s.compaction.autoEvents, null);
  assert.equal(s.cache.policy, null);
  assert.deepEqual(s.shell, { known: true, runs: 0, changed: 0, savedChars: 0 });
  assert.equal(s.pruning.lastReason, null);
  assert.deepEqual(s.engine.thresholds, { start: 0.65, force: 0.85, critical: 0.94 });
  stats.recordTool({ sessionID: 's1', kind: 'shell', changed: false });
  assert.deepEqual(stats.snapshot('s1').shell, { known: true, runs: 1, changed: 0, savedChars: 0 });
  // disabled features are unknown, not zero
  const off = mk({}, { shell: false, pruning: false }).stats.snapshot('s1');
  assert.deepEqual(off.shell, { known: false, runs: null, changed: null, savedChars: null });
  assert.equal(off.pruning.known, false);
  assert.equal(off.cache.policy, 'off');
});

test('snapshot is JSON-safe and leaks no paths, commands, queries, text or model names', () => {
  const { stats } = mk({ location: { directory: '/secret/project' } });
  stats.recordTool({ sessionID: 's1', kind: 'filtering', changed: true, savedChars: 500, command: 'rm -rf /', text: 'TOPSECRET' });
  stats.recordContext({ sessionID: 's1', ...ctxOf(), model: { id: 'secret-model' } });
  stats.recordMemorySearch({ sessionID: 's1', results: 2, query: 'password' });
  const json = JSON.stringify(stats.snapshot('s1'));
  for (const bad of ['/secret', 'rm -rf', 'TOPSECRET', 'secret-model', 'password']) assert.ok(!json.includes(bad), bad);
  assert.ok(!/NaN|Infinity|undefined/.test(json));
});

test('per-session isolation', () => {
  const { stats } = mk();
  stats.recordTool({ sessionID: 'a', kind: 'shell', changed: true, savedChars: 100 });
  stats.recordTool({ sessionID: 'b', kind: 'shell', changed: false });
  stats.recordContext({ sessionID: 'a', ...ctxOf({ estimatedTokens: 5 }) });
  assert.equal(stats.snapshot('a').shell.savedChars, 100);
  assert.equal(stats.snapshot('b').shell.savedChars, 0);
  assert.equal(stats.snapshot('b').context.known, false);
  assert.equal(stats.snapshot('a').context.estimatedTokens, 5);
  assert.equal(stats.snapshot('c').shell.runs, 0);
});

test('LRU keeps at most maxSessions and evicts the least recently used', () => {
  const { stats } = mk({ maxSessions: 3 });
  for (const id of ['a', 'b', 'c']) stats.recordTool({ sessionID: id, kind: 'shell', changed: false });
  stats.recordTool({ sessionID: 'a', kind: 'shell', changed: false }); // refresh a
  stats.recordTool({ sessionID: 'd', kind: 'shell', changed: false }); // evicts b
  assert.equal(stats.snapshot('b').since, null);
  assert.equal(stats.snapshot('a').shell.runs, 2);
  for (const id of ['c', 'd']) assert.equal(stats.snapshot(id).shell.runs, 1);
  const big = mk({}).stats;
  for (let i = 0; i < 400; i++) big.recordTool({ sessionID: `s${i}`, kind: 'shell', changed: false });
  assert.equal(big.snapshot('s0').since, null); // default cap 256
  assert.equal(big.snapshot('s399').shell.runs, 1);
});

test('revision is monotonic and every method validates without throwing', () => {
  const { stats } = mk();
  let last = 0;
  for (let i = 0; i < 5; i++) {
    stats.recordTool({ sessionID: 's', kind: 'shell', changed: true, savedChars: i });
    const r = stats.snapshot('s').revision;
    assert.ok(r > last); last = r;
  }
  const junk = [undefined, null, 5, {}, [], '', 'x'.repeat(600), NaN, Symbol('x'), () => 1];
  for (const j of junk) {
    assert.doesNotThrow(() => {
      stats.recordTool(j); stats.recordTool({ sessionID: j, kind: 'shell' }); stats.recordTool({ sessionID: 's', kind: j });
      stats.recordContext(j); stats.recordContext({ sessionID: 's', estimatedTokens: j, ratio: j, source: j, media: j });
      stats.recordPrune(j); stats.recordPrune({ sessionID: 's', pruned: j, removedChars: j, reason: j, allowNewDrops: j });
      stats.recordCompactionEvent(j); stats.recordCompactionEvent({ sessionID: 's', type: j, reason: j });
      stats.recordMemorySearch(j); stats.recordMemorySearch({ sessionID: 's', results: j });
      stats.setMemoryProvider(j); stats.setMemoryState(j);
      stats.snapshot(j);
    });
  }
  assert.equal(stats.recordTool({ sessionID: '', kind: 'shell' }), false);
  const s = stats.snapshot('s');
  assert.ok(s.revision >= last);
  const q = mk({ options: { throw: true }, now: () => { throw new Error('clock'); }, emit: () => { throw new Error('emit'); } });
  assert.doesNotThrow(() => { q.stats.recordTool({ sessionID: 's', kind: 'shell' }); q.stats.snapshot('s'); q.t.fire(); });
});

test('emit is coalesced/throttled per interval and carries {sessionID, revision}', () => {
  const { stats, t, emits } = mk({ emitIntervalMs: 250 });
  for (let i = 0; i < 10; i++) stats.recordTool({ sessionID: 'a', kind: 'shell', changed: false });
  stats.recordTool({ sessionID: 'b', kind: 'shell', changed: false });
  assert.equal(t.pending(), 1, 'a single timer for all sessions');
  assert.deepEqual(emits, []);
  t.fire();
  assert.deepEqual(emits, [['a', 10], ['b', 1]]);
  t.fire();
  assert.equal(emits.length, 2, 'nothing new, nothing emitted');
  stats.recordTool({ sessionID: 'a', kind: 'shell', changed: false });
  t.fire();
  assert.deepEqual(emits.at(-1), ['a', 11]);
});

test('dispose clears timers and stops emits; later records are no-ops', () => {
  const { stats, t, emits } = mk();
  stats.recordTool({ sessionID: 'a', kind: 'shell', changed: false });
  assert.equal(t.pending(), 1);
  stats.dispose();
  assert.equal(t.pending(), 0);
  t.fire();
  assert.deepEqual(emits, []);
  assert.equal(stats.recordTool({ sessionID: 'a', kind: 'shell', changed: false }), false);
  assert.equal(t.pending(), 0);
  stats.dispose(); // idempotent
  assert.equal(stats.snapshot('a').shell.runs, 1);
});

test('pruning/cache policy', () => {
  const { stats } = mk();
  assert.equal(stats.snapshot('s').cache.policy, null);
  stats.recordPrune({ sessionID: 's', pruned: 0, removedChars: 0, reason: 'cache-deferred', allowNewDrops: false });
  assert.equal(stats.snapshot('s').cache.policy, 'deferred');
  stats.recordPrune({ sessionID: 's', pruned: 3, removedChars: 900, reason: 'pruned', allowNewDrops: true });
  const s = stats.snapshot('s');
  assert.equal(s.cache.policy, 'bust');
  assert.deepEqual([s.pruning.calls, s.pruning.drops, s.pruning.removedChars, s.pruning.lastReason], [2, 3, 900, 'pruned']);
  stats.recordPrune({ sessionID: 's', pruned: 0, removedChars: 0, reason: 'below-pressure', allowNewDrops: false });
  assert.equal(stats.snapshot('s').cache.policy, 'deferred');
  stats.recordPrune({ sessionID: 's', pruned: 0, removedChars: 0, reason: 'bogus' });
  assert.equal(stats.snapshot('s').pruning.lastReason, null);
  assert.equal(stats.snapshot('s').cache.policy, 'stable');
});

test('compaction: counts by reason, before from latest context, after from next context, reduced only when both known', () => {
  const { stats } = mk();
  stats.recordCompactionEvent({ sessionID: 's', type: 'started' }); // no context known yet
  stats.recordCompactionEvent({ sessionID: 's', type: 'ended', reason: 'auto' });
  let k = stats.snapshot('s').compaction;
  assert.equal(k.known, true);
  assert.deepEqual([k.autoEvents, k.manualEvents, k.failedEvents, k.running], [1, 0, 0, false]);
  assert.equal(k.beforeTokens, null);
  stats.recordContext({ sessionID: 's', ...ctxOf({ estimatedTokens: 100, estimatedChars: 300 }) });
  k = stats.snapshot('s').compaction;
  assert.equal(k.afterTokens, 100);
  assert.equal(k.reducedTokens, null, 'before unknown => reduced unknown');
  assert.equal(k.reducedRatio, null);
  stats.recordContext({ sessionID: 's', ...ctxOf({ estimatedTokens: 9000, estimatedChars: 27000 }) });
  stats.recordCompactionEvent({ sessionID: 's', type: 'started' });
  assert.equal(stats.snapshot('s').compaction.running, true);
  stats.recordCompactionEvent({ sessionID: 's', type: 'ended', reason: 'manual' });
  assert.equal(stats.snapshot('s').compaction.afterTokens, null, 'after waits for the next context hook');
  assert.equal(stats.snapshot('s').compaction.reducedTokens, null);
  stats.recordContext({ sessionID: 's', ...ctxOf({ estimatedTokens: 1000, estimatedChars: 3000 }) });
  k = stats.snapshot('s').compaction;
  assert.deepEqual([k.autoEvents, k.manualEvents, k.lastReason], [1, 1, 'manual']);
  assert.deepEqual([k.beforeTokens, k.afterTokens, k.reducedTokens], [9000, 1000, 8000]);
  assert.deepEqual([k.beforeChars, k.afterChars, k.reducedChars], [27000, 3000, 24000]);
  assert.ok(Math.abs(k.reducedRatio - 24000 / 27000) < 1e-9);
  stats.recordContext({ sessionID: 's', ...ctxOf({ estimatedTokens: 5 }) }); // not a compaction "after" again
  assert.equal(stats.snapshot('s').compaction.afterTokens, 1000);
  stats.recordCompactionEvent({ sessionID: 's', type: 'failed' });
  k = stats.snapshot('s').compaction;
  assert.deepEqual([k.failedEvents, k.running], [1, false]);
  assert.equal(stats.snapshot('other').compaction.known, false);
});

test('memory section: counters per session, provider values, off state', () => {
  const on = createTrimStats({ options: parseOptions({ memory: { enabled: true, dbPath: ':memory:' } }), emit: () => {} });
  assert.equal(on.snapshot('s').memory.active, false);
  assert.equal(on.snapshot('s').memory.searches, null);
  on.setMemoryProvider(() => ({ summaries: 4, lastSummaryAt: 77, dbBytes: 2048 }));
  on.setMemoryState({ active: true });
  on.recordMemorySearch({ sessionID: 's', results: 3 });
  on.recordMemorySearch({ sessionID: 's', results: 0 });
  assert.deepEqual(on.snapshot('s').memory, { enabled: true, active: true, error: null, summaries: 4, searches: 2, searchResults: 3, lastSummaryAt: 77, dbBytes: 2048 });
  assert.equal(on.snapshot('t').memory.searches, 0);
  on.setMemoryProvider(() => { throw new Error('closed'); });
  assert.equal(on.snapshot('s').memory.summaries, null);
  on.setMemoryState({ active: false, error: 'setup-failed' });
  const m = on.snapshot('s').memory;
  assert.deepEqual([m.active, m.error, m.searches], [false, 'setup-failed', null]);
});
