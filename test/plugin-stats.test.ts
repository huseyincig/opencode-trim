import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTrim } from '../src/plugin.ts';
import { TRIM_STATS_RPC } from '../src/stats-rpc.ts';
import { PRUNED } from '../src/prune.ts';

const BASE = { minOutputChars: 200, maxOutputLines: 25, maxOutputChars: 2500, minSavingsRatio: 0.05, protectRecentMessages: 4, pruneAfterToolChars: 10000 };
const EVENT_TYPES = ['session.compaction.started', 'session.compaction.ended', 'session.compaction.failed', 'session.step.ended'];

function harness(options = {}, { rpc = true, event = true, rpcRegister, events } = {}) {
  const log = { hooks: [], disposed: [], rpcRegistered: [], emitted: [], subscribed: [] };
  let toolCb; let contextCb; const hookFns = {};
  const queue = []; let wake; let done = false;
  const ctx = {
    options, location: { directory: '/proj/secret' },
    tool: { hook: async (name, fn) => { log.hooks.push(`tool:${name}`); toolCb = fn; return { dispose: async () => log.disposed.push(`tool:${name}`) }; } },
    session: { hook: async (name, fn) => { log.hooks.push(`session:${name}`); hookFns[name] = fn; if (name === 'context') contextCb = fn; return { dispose: async () => log.disposed.push(`session:${name}`) }; } },
  };
  let handlers;
  if (rpc) {
    ctx.rpc = { register: rpcRegister ?? (async (def, h) => {
      log.rpcRegistered.push(def); handlers = h;
      return { events: { emit: async (n, p) => { if (events?.emit) return events.emit(n, p); log.emitted.push([n, p]); } }, dispose: async () => log.disposed.push('rpc') };
    }) };
  }
  if (event) {
    ctx.event = { subscribe: async (args) => {
      log.subscribed.push(args);
      args.signal.addEventListener('abort', () => { done = true; wake?.(); });
      return (async function* () { while (!done) { if (queue.length) yield queue.shift(); else await new Promise((r) => { wake = r; }); } })();
    } };
  }
  return {
    ctx, log, get toolCb() { return toolCb; }, get contextCb() { return contextCb; }, hookFns,
    snapshot: (sessionID) => handlers.snapshot({ sessionID }),
    get handlers() { return handlers; },
    push: (e) => { queue.push(e); wake?.(); },
    isDone: () => done,
  };
}
const tick = () => new Promise((r) => setTimeout(r, 15));
const shellEvent = (content, sessionID = 's1') => ({ status: 'completed', sessionID, tool: 'shell', input: { command: 'npm test' }, result: { content, metadata: { exitCode: 0 } } });
const bigShell = () => [...Array.from({ length: 180 }, (_, i) => `status ${i}`), 'Tests: 180 passed'].join('\n');
function toolMessages(n = 20) {
  const messages = [];
  for (let i = 0; i < n; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool-call', id: `id${i}`, name: 'shell', input: { command: 'npm test' } }] });
    messages.push({ role: 'tool', content: [{ type: 'tool-result', id: `id${i}`, name: 'shell', result: { value: 'x'.repeat(1100) } }] });
  }
  return messages;
}
const ctxEvent = (messages, sessionID = 's1') => ({ sessionID, model: { providerID: 'test', id: 'model', limit: { context: 100000, output: 4000 } }, messages, tools: {}, system: [], options: {} });

test('tui disabled (default and explicit): no RPC, subscription or stats hooks; hook set unchanged', async () => {
  for (const options of [BASE, { ...BASE, tui: { enabled: false } }]) {
    const h = harness(options);
    h.ctx.rpc.register = () => assert.fail('rpc.register called');
    h.ctx.event.subscribe = () => assert.fail('subscribed');
    const stop = await setupTrim(h.ctx);
    assert.deepEqual(h.log.hooks, ['tool:execute.after', 'session:context']);
    await stop(); await stop();
    assert.deepEqual(h.log.disposed, ['session:context', 'tool:execute.after']);
  }
  const noPrune = harness({ ...BASE, pruning: false });
  const stop = await setupTrim(noPrune.ctx);
  assert.deepEqual(noPrune.log.hooks, ['tool:execute.after'], 'no stats-only context hook without tui');
  await stop();
});

test('tui disabled vs enabled: identical tool and context results', async () => {
  const run = async (tui) => {
    const h = harness({ ...BASE, ...(tui ? { tui: { enabled: true } } : {}) });
    const stop = await setupTrim(h.ctx);
    const e = shellEvent(bigShell());
    await h.toolCb(e);
    const messages = toolMessages();
    await h.contextCb(ctxEvent(messages));
    await stop();
    return { e, messages };
  };
  const off = await run(false);
  const on = await run(true);
  assert.deepEqual(on.e, off.e);
  assert.deepEqual(on.messages, off.messages);
  assert.equal(on.messages[1].content[0].result.value, PRUNED);
});

test('tui enabled: registers the RPC contract and records shell, filtering, pruning, context', async () => {
  const h = harness({ ...BASE, tui: { enabled: true } });
  const stop = await setupTrim(h.ctx);
  assert.equal(h.log.rpcRegistered.length, 1);
  assert.equal(h.log.rpcRegistered[0], TRIM_STATS_RPC);
  assert.equal(h.log.subscribed.length, 1);
  assert.deepEqual(h.log.subscribed[0].types, EVENT_TYPES);

  const e = shellEvent(bigShell());
  const before = e.result.content.length;
  await h.toolCb(e);
  assert.match(e.result.content, /lines omitted/);
  await h.toolCb(shellEvent('ok')); // eligible but below threshold: a run, no change
  await h.toolCb({ status: 'completed', sessionID: 's1', tool: 'custom-mcp-tool', input: {}, result: { content: 'x'.repeat(5000) } }); // not ours
  await h.toolCb(shellEvent(bigShell(), 's2'));
  const grep = { status: 'completed', sessionID: 's1', tool: 'grep', input: {}, result: { content: 'src/a.js:1:match line\n'.repeat(400) } };
  await h.toolCb(grep);

  const messages = toolMessages();
  await h.contextCb(ctxEvent(messages));

  const s = await h.snapshot('s1');
  assert.equal(s.shell.runs, 2);
  assert.equal(s.shell.changed, 1);
  assert.equal(s.shell.savedChars, before - e.result.content.length);
  assert.equal(s.filtering.runs, 1);
  assert.equal(s.filtering.changed, 1);
  assert.ok(s.filtering.savedChars > 0);
  assert.equal(s.pruning.calls, 1);
  assert.ok(s.pruning.drops > 0);
  assert.equal(s.pruning.lastReason, 'pruned');
  assert.ok(s.pruning.removedChars > 0);
  assert.equal(s.context.known, true);
  assert.equal(s.context.limitTokens, 100000);
  assert.equal(s.context.source, 'event-model');
  assert.equal(s.context.media, false);
  assert.ok(s.context.estimatedTokens > 0 && s.context.estimatedChars > 0 && s.context.ratio > 0);
  assert.ok(s.revision > 0);
  assert.ok(['stable', 'bust', 'deferred'].includes(s.cache.policy));
  const s2 = await h.snapshot('s2');
  assert.equal(s2.shell.runs, 1);
  assert.equal(s2.filtering.runs, 0);
  assert.equal(s2.pruning.calls, 0, 'isolation between sessions');
  assert.ok(!JSON.stringify(s).includes('/proj/secret'));
  await stop();
});

test('context estimate is taken after pruning (smaller than before)', async () => {
  const h = harness({ ...BASE, tui: { enabled: true } });
  const stop = await setupTrim(h.ctx);
  const messages = toolMessages();
  const raw = structuredClone(messages);
  const { estimateRequest } = await import('../src/pressure.ts');
  const full = estimateRequest(ctxEvent(raw), new Map(), { outputReserveTokens: 8192 }).estimatedChars;
  await h.contextCb(ctxEvent(messages));
  const s = await h.snapshot('s1');
  assert.ok(s.context.estimatedChars < full, `${s.context.estimatedChars} < ${full}`);
  await stop();
});

test('compaction events from a foreign location are ignored; local/unknown locations count', async () => {
  const h = harness({ ...BASE, tui: { enabled: true } });
  const stop = await setupTrim(h.ctx);
  h.push({ type: 'session.compaction.ended', location: { directory: '/proj/other' }, data: { sessionID: 'foreign', reason: 'auto' } });
  h.push({ type: 'session.compaction.ended', data: { sessionID: 'foreign2', reason: 'auto', location: { directory: '/proj/other/../other2' } } });
  h.push({ type: 'session.compaction.ended', location: { directory: '/proj/x/../secret' }, data: { sessionID: 'local', reason: 'auto' } });
  h.push({ type: 'session.compaction.ended', data: { sessionID: 'unknown', reason: 'auto' } });
  h.push({ type: 'session.compaction.ended', data: { sessionID: 'foreign3', reason: 'auto' }, properties: { location: { directory: '/proj/other' } } });
  h.push({ type: 'session.compaction.ended', data: { sessionID: 'local2', reason: 'auto' }, properties: { location: { directory: '/proj/secret' } } });
  await tick();
  assert.equal((await h.snapshot('local2')).compaction.autoEvents, 1);
  for (const id of ['foreign', 'foreign2', 'foreign3']) {
    const s = await h.snapshot(id);
    assert.equal(s.compaction.known, false);
    assert.equal(s.compaction.autoEvents, null);
    assert.equal(s.revision, 0);
  }
  assert.equal((await h.snapshot('local')).compaction.autoEvents, 1);
  assert.equal((await h.snapshot('unknown')).compaction.autoEvents, 1);
  assert.ok(h.log.emitted.every(([, p]) => ['local', 'local2', 'unknown'].includes(p.sessionID)));
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(h.log.emitted.every(([, p]) => ['local', 'local2', 'unknown'].includes(p.sessionID)));
  assert.ok(h.log.emitted.length >= 1);
  await stop();
});

test('compaction events: counts by reason, before from latest context, after from next context hook', async () => {
  const h = harness({ ...BASE, tui: { enabled: true } });
  const stop = await setupTrim(h.ctx);
  await h.contextCb(ctxEvent(toolMessages(2)));
  const beforeSnap = await h.snapshot('s1');
  h.push({ type: 'session.compaction.started', data: { sessionID: 's1' } });
  h.push({ type: 'session.compaction.ended', data: { sessionID: 's1', reason: 'auto', text: 'summary SECRETTEXT' } });
  h.push({ type: 'session.compaction.ended', properties: { sessionID: 's1', reason: 'manual' } });
  h.push({ type: 'session.compaction.failed', data: { sessionID: 's1' } });
  h.push({ type: 'session.compaction.ended', data: { sessionID: 's2', reason: 'auto' } });
  h.push({ type: 'session.other', data: { sessionID: 's1' } });
  await tick();
  let k = (await h.snapshot('s1')).compaction;
  assert.deepEqual([k.autoEvents, k.manualEvents, k.failedEvents, k.running], [1, 1, 1, false]);
  assert.equal(k.beforeTokens, beforeSnap.context.estimatedTokens);
  assert.equal(k.afterTokens, null);
  assert.equal((await h.snapshot('s2')).compaction.autoEvents, 1);
  h.push({ type: 'session.compaction.started', data: { sessionID: 's1' } });
  h.push({ type: 'session.compaction.ended', data: { sessionID: 's1', reason: 'auto' } });
  await tick();
  await h.contextCb(ctxEvent([{ role: 'user', content: 'short summary' }]));
  k = (await h.snapshot('s1')).compaction;
  assert.equal(k.autoEvents, 2);
  assert.ok(k.afterTokens !== null && k.afterTokens < k.beforeTokens);
  assert.equal(k.reducedTokens, k.beforeTokens - k.afterTokens);
  assert.ok(k.reducedRatio > 0 && k.reducedRatio < 1);
  assert.ok(!JSON.stringify(await h.snapshot('s1')).includes('SECRETTEXT'));
  await stop();
});

test('changed event is emitted (throttled) with {sessionID, revision}', async () => {
  const h = harness({ ...BASE, tui: { enabled: true } });
  const stop = await setupTrim(h.ctx);
  for (let i = 0; i < 5; i++) await h.toolCb(shellEvent(bigShell()));
  assert.deepEqual(h.log.emitted, []);
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(h.log.emitted.length, 1);
  assert.deepEqual(h.log.emitted[0][0], 'changed');
  assert.deepEqual(Object.keys(h.log.emitted[0][1]).sort(), ['revision', 'sessionID']);
  assert.equal(h.log.emitted[0][1].sessionID, 's1');
  assert.equal(h.log.emitted[0][1].revision, (await h.snapshot('s1')).revision);
  await stop();
});

test('cleanup: aborts subscription, disposes RPC and timers, idempotent, no emits afterwards', async () => {
  const h = harness({ ...BASE, tui: { enabled: true } });
  const stop = await setupTrim(h.ctx);
  await h.toolCb(shellEvent(bigShell()));
  await stop(); await stop();
  assert.equal(h.isDone(), true);
  assert.equal(h.log.disposed.filter((x) => x === 'rpc').length, 1);
  assert.equal(h.log.subscribed[0].signal.aborted, true);
  await new Promise((r) => setTimeout(r, 350));
  assert.deepEqual(h.log.emitted, []);
  await h.toolCb(shellEvent(bigShell())); // still harmless after cleanup
});

test('tui enabled without RPC or event APIs: engine unaffected; no reader', async () => {
  const h = harness({ ...BASE, tui: { enabled: true } }, { rpc: false, event: false });
  const stop = await setupTrim(h.ctx);
  const e = shellEvent(bigShell());
  await h.toolCb(e);
  assert.match(e.result.content, /lines omitted/);
  await stop();
});

test('failing RPC registration/emit/subscription never breaks the engine', async () => {
  const h = harness({ ...BASE, tui: { enabled: true } }, { rpcRegister: async () => { throw new Error('rpc unavailable'); } });
  h.ctx.event.subscribe = async () => { throw new Error('no events'); };
  const stop = await setupTrim(h.ctx);
  const e = shellEvent(bigShell());
  await h.toolCb(e);
  assert.match(e.result.content, /lines omitted/);
  await stop();
  const h2 = harness({ ...BASE, tui: { enabled: true } }, { events: { emit: async () => { throw new Error('emit failed'); } } });
  const stop2 = await setupTrim(h2.ctx);
  await h2.toolCb(shellEvent(bigShell()));
  await new Promise((r) => setTimeout(r, 300));
  await stop2();
});

test('tui enabled with pruning disabled: stats-only context hook records context, nothing is pruned', async () => {
  const h = harness({ ...BASE, pruning: false, tui: { enabled: true } });
  const stop = await setupTrim(h.ctx);
  assert.deepEqual(h.log.hooks, ['tool:execute.after', 'session:context']);
  const messages = toolMessages();
  const raw = structuredClone(messages);
  await h.contextCb(ctxEvent(messages));
  assert.deepEqual(messages, raw);
  const s = await h.snapshot('s1');
  assert.equal(s.context.known, true);
  assert.equal(s.pruning.known, false);
  assert.equal(s.cache.policy, 'off');
  await stop();
});

test('RPC snapshot handler tolerates bad input', async () => {
  const h = harness({ ...BASE, tui: { enabled: true } });
  const stop = await setupTrim(h.ctx);
  for (const bad of [undefined, null, {}, { sessionID: 5 }]) {
    const out = await h.handlers.snapshot(bad);
    assert.equal(out.sessionID, null);
    assert.equal(out.revision, 0);
  }
  await stop();
});
