import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTrim } from '../src/plugin.js';
import { setupMemory } from '../src/memory.js';
import { parseOptions } from '../src/config.js';
import { openMemoryStore } from '../src/memory-store.js';

const tick = () => new Promise(r => setTimeout(r, 15));
function harness({ memory, directory = '/proj/a', dbPath, ctxTokens = [] } = {}) {
  const queue = []; let wake; let done = false;
  const regs = { hooks: [], disposed: [] };
  let tool, before, subArgs;
  const ctx = {
    options: memory === undefined ? {} : { memory: { dbPath, ...memory } },
    location: { directory },
    tool: {
      hook: async (name, fn) => { if (name === 'execute.before') before = fn; else if (name !== 'execute.after') assert.fail(name); return { dispose: async () => regs.disposed.push(name) }; },
      transform: async (fn) => { fn({ add: (t) => { tool = t; } }); return { dispose: async () => regs.disposed.push('transform') }; },
    },
    session: {
      hook: async (name, fn) => { regs.hooks.push({ name, fn }); return { dispose: async () => regs.disposed.push(`session:${name}`) }; },
      context: async () => ({ messages: [{ role: 'user', content: 'x'.repeat(ctxTokens.shift() ?? 300) }] }),
    },
    event: {
      subscribe: async (args) => {
        subArgs = args;
        args.signal.addEventListener('abort', () => { done = true; wake?.(); });
        return (async function* () {
          while (!done) {
            if (queue.length) yield queue.shift();
            else await new Promise(r => { wake = r; });
          }
        })();
      },
    },
  };
  return {
    ctx, regs, push: (e) => { queue.push(e); wake?.(); },
    get ctxHooks() { return regs.hooks.filter(x => x.name === 'context').map(x => x.fn); },
    get tool() { return tool; }, get before() { return before; }, get subArgs() { return subArgs; },
  };
}
const LOC = { directory: '/proj/a' };
const ended = (o = {}) => ({ type: 'session.compaction.ended', location: LOC, data: { sessionID: 's1', text: 'We decided to use sqlite fts5 for memory', reason: 'auto', model: { id: 'm1' }, tokens: { input: 5 }, cost: 0.1, id: 'ev1', ...o } });
const started = (sid = 's1') => ({ type: 'session.compaction.started', location: LOC, data: { sessionID: sid } });
const run = (h, q = 'sqlite', agent = 'build') => h.tool.execute({ query: q }, { signal: new AbortController().signal, agent });
function tmpDb() { const d = mkdtempSync(join(tmpdir(), 'trim-mem-')); return { d, p: join(d, 'm.db') }; }

test('config: defaults, validation, unknown keys, frozen', () => {
  const o = parseOptions();
  assert.deepEqual({ ...o.memory, agentAllowlist: [...o.memory.agentAllowlist], agentDenylist: [...o.memory.agentDenylist] }, { enabled: false, agentAllowlist: [], agentDenylist: [], retentionDays: 90 });
  assert.ok(Object.isFrozen(o.memory) && Object.isFrozen(o.memory.agentAllowlist) && Object.isFrozen(o.memory.agentDenylist));
  assert.throws(() => parseOptions({ memory: { agentDenylist: [1] } }));
  assert.throws(() => parseOptions({ memory: { bogus: 1 } }), /unknown memory/);
  assert.throws(() => parseOptions({ memory: { enabled: 'yes' } }));
  assert.throws(() => parseOptions({ memory: { retentionDays: 0 } }));
  assert.throws(() => parseOptions({ memory: { agentAllowlist: [''] } }));
  assert.throws(() => parseOptions({ memory: [] }));
  assert.equal(parseOptions({ memory: { enabled: true, dbPath: '/x/y.db' } }).memory.dbPath, '/x/y.db');
});

test('config: memory.dbPath must be absolute or :memory:', () => {
  for (const bad of ['rel.db', './rel.db', 'a/b.db', '../x.db']) assert.throws(() => parseOptions({ memory: { dbPath: bad } }), /absolute/, bad);
  assert.equal(parseOptions({ memory: { dbPath: ':memory:' } }).memory.dbPath, ':memory:');
  assert.equal(parseOptions({ memory: { dbPath: '/abs/m.db' } }).memory.dbPath, '/abs/m.db');
  assert.throws(() => parseOptions({ memory: { dbPath: '' } }));
  assert.throws(() => parseOptions({ memory: { dbPath: '/a\0b' } }));
});

test('oversized compaction summary is skipped by the handler; large one still stored', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p });
  const stop = await setupTrim(h.ctx);
  h.push(ended({ id: 'big', text: 'z'.repeat(1_000_001) })); await tick();
  h.push(ended({ id: 'ok', text: 'quokka ' + 'y'.repeat(900_000) })); await tick(); await tick();
  assert.deepEqual((await rows(p)).map(r => r.e), ['ok']);
  await stop(); rmSync(d, { recursive: true });
});

test('cleanup: a throwing/invalid registration cannot skip the others or store close', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p });
  const orig = h.ctx.tool.hook;
  h.ctx.tool.hook = async (n, f) => { const r = await orig(n, f); return { dispose: () => { throw new Error('sync boom'); } }; };
  const opts = parseOptions({ memory: { enabled: true, dbPath: p } });
  const stop = await setupMemory(h.ctx, opts);
  await assert.doesNotReject(stop());
  await assert.doesNotReject(stop());
  assert.ok(h.regs.disposed.includes('transform'));
  assert.ok(h.regs.disposed.includes('session:context'));
  const bad = harness({ memory: { enabled: true }, dbPath: p });
  bad.ctx.tool.transform = async () => ({});
  await assert.rejects(setupMemory(bad.ctx, opts), /dispose/);
  assert.ok(bad.regs.disposed.includes('execute.before'), 'earlier registration disposed on failed setup');
  rmSync(d, { recursive: true });
});

test('disabled: no tool/event/DB; existing behavior intact', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: false }, dbPath: p });
  h.ctx.event = { subscribe: () => assert.fail('subscribed') };
  h.ctx.tool.transform = () => assert.fail('transform');
  const stop = await setupTrim(h.ctx);
  assert.equal(h.tool, undefined);
  assert.equal(existsSync(p), false);
  await stop();
  rmSync(d, { recursive: true });
});

test('enabled: registers tool (codemode false), gate, subscription; cleanup', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p });
  const stop = await setupTrim(h.ctx);
  assert.equal(h.tool.name, 'trim_history_search');
  assert.deepEqual(h.tool.options, { codemode: false });
  assert.equal(h.tool.input.properties.query.type, 'string');
  assert.deepEqual(h.subArgs.types, ['session.compaction.started', 'session.compaction.ended', 'session.compaction.failed']);
  await stop(); await stop();
  // Trim's own context hook is also registered; each registration is disposed exactly once.
  assert.equal(h.regs.disposed.filter(x => x === 'session:context').length, h.ctxHooks.length);
  assert.equal(h.subArgs.signal.aborted, true);
  assert.ok(h.regs.disposed.includes('transform'));
  assert.equal(h.regs.disposed.filter(x => x === 'execute.before').length, 1);
  rmSync(d, { recursive: true });
});

test('auto/manual archive, tokens, search with snippet/date/session', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p, ctxTokens: [3000, 300, 600, 90] });
  const stop = await setupTrim(h.ctx);
  h.push(started()); h.push(ended()); await tick();
  h.push(started()); h.push(ended({ id: 'ev2', reason: 'manual', text: 'manual summary about pgvector' })); await tick();
  const r = await run(h, 'sqlite');
  assert.match(r.content, /session s1/); assert.match(r.content, /\d{4}-\d\d-\d\d/); assert.match(r.content, /sqlite fts5/);
  assert.match((await run(h, 'pgvector')).content, /manual summary/);
  await stop();
  const s = openMemoryStore({ dbPath: p });
  const hits = s.search({ project: '/proj/a', query: 'sqlite' }); s.close();
  assert.equal(hits[0].reason, 'auto'); assert.equal(hits[0].model, 'm1');
  rmSync(d, { recursive: true });
});

async function rows(p) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(p);
  const r = db.prepare('SELECT event_id e, context_before_tokens b, context_after_tokens a FROM history ORDER BY id').all();
  db.close();
  return r;
}
const ctxEvt = (sessionID, n = 900) => ({ sessionID, model: { id: 'm1' }, messages: [{ role: 'user', content: 'x'.repeat(n) }], system: [], tools: {}, options: {} });
const fire = (h, e) => { for (const fn of h.ctxHooks) fn(e); };

test('memory registers exactly one context hook when enabled, none when disabled', async () => {
  const { d, p } = tmpDb();
  const on = harness({ memory: { enabled: true }, dbPath: p });
  const stopOn = await setupTrim(on.ctx);
  const mine = on.ctxHooks.length;
  await stopOn();
  const off = harness({ memory: { enabled: false }, dbPath: p });
  const stopOff = await setupTrim(off.ctx);
  assert.equal(mine - off.ctxHooks.length, 1);
  await stopOff(); rmSync(d, { recursive: true });
});

test('ended archives null after; next context hook for same session fills it once', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p, ctxTokens: [3000] });
  const stop = await setupTrim(h.ctx);
  h.push(started()); h.push(ended()); await tick();
  let [row] = await rows(p);
  assert.ok(row.b > 0); assert.equal(row.a, null);
  fire(h, ctxEvt('other')); await tick();
  assert.equal((await rows(p))[0].a, null, 'wrong session must not update');
  fire(h, ctxEvt('s1', 600));
  row = (await rows(p))[0];
  assert.ok(row.a > 0);
  const first = row.a;
  fire(h, ctxEvt('s1', 9000));
  assert.equal((await rows(p))[0].a, first, 'pending cleared after one update');
  await stop();
  assert.ok(h.regs.disposed.includes('session:context'));
  rmSync(d, { recursive: true });
});

test('host {type,text} message array: before counts text (>50k), after fills from hook, before > after', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p });
  const msgs = Array.from({ length: 6 }, () => ({ type: 'user', text: 'w'.repeat(60000) }));
  const snapshot = JSON.stringify(msgs);
  h.ctx.session.context = async () => msgs;
  const stop = await setupTrim(h.ctx);
  h.push(started()); h.push(ended()); await tick();
  assert.equal(JSON.stringify(msgs), snapshot, 'host objects not mutated');
  const [row] = await rows(p);
  assert.ok(row.b > 50000, `before=${row.b}`);
  assert.equal(row.a, null);
  fire(h, ctxEvt('s1', 9000));
  const after = (await rows(p))[0].a;
  assert.ok(after > 2000 && after < row.b, `after=${after}`);
  await stop(); rmSync(d, { recursive: true });
});

test('parts-shaped messages are counted', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p });
  h.ctx.session.context = async () => ({ messages: [
    { type: 'assistant', parts: [{ type: 'text', text: 'p'.repeat(30000) }] },
  ] });
  const stop = await setupTrim(h.ctx);
  h.push(started()); h.push(ended()); await tick();
  const [row] = await rows(p);
  assert.ok(row.b > 9000 && row.b < 60000, `before=${row.b}`);
  await stop(); rmSync(d, { recursive: true });
});

test('duplicate ended with same event id does not drop pending after-update', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p });
  const stop = await setupTrim(h.ctx);
  h.push(started()); h.push(ended()); await tick();
  h.push(ended()); await tick();
  assert.equal((await rows(p)).length, 1);
  assert.equal((await rows(p))[0].a, null);
  fire(h, ctxEvt('s1', 900));
  assert.ok((await rows(p))[0].a > 0);
  await stop(); rmSync(d, { recursive: true });
});

test('context hook without pending performs no write; bad events never throw and clear pending', async () => {
  const { d, p } = tmpDb();
  const pre = openMemoryStore({ dbPath: p });
  pre.archive({ event_id: 'old1', project: '/proj/a', session_id: 's1', text: 'older note', context_after_tokens: 7 });
  pre.close();
  const h = harness({ memory: { enabled: true }, dbPath: p });
  const stop = await setupTrim(h.ctx);
  fire(h, ctxEvt('s1'));
  assert.equal((await rows(p))[0].a, 7);
  h.push(ended({ id: 'ev9' })); await tick();
  for (const bad of [null, undefined, 5, { sessionID: 7 }]) assert.doesNotThrow(() => fire(h, bad));
  assert.equal((await rows(p)).find(x => x.e === 'ev9').a, null, 'invalid events leave pending intact');
  const hostile = { sessionID: 's1', get messages() { throw new Error('boom'); } };
  assert.doesNotThrow(() => fire(h, hostile));
  fire(h, ctxEvt('s1', 900));
  assert.equal((await rows(p)).find(x => x.e === 'ev9').a, null, 'pending cleared even when estimate failed/garbage');
  await stop(); rmSync(d, { recursive: true });
});

test('empty / native / failed are skipped; dedupe by event_id', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p });
  const stop = await setupTrim(h.ctx);
  h.push(ended({ id: 'e1', text: '   ' })); h.push(ended({ id: 'e2', text: 42 }));
  h.push(ended({ id: 'e3', native: { summary: 'x' } }));
  h.push(started()); h.push({ type: 'session.compaction.failed', data: { sessionID: 's1' } });
  h.push(ended({ id: 'e4', text: 'unique zebra summary' })); h.push(ended({ id: 'e4', text: 'unique zebra summary' }));
  await tick();
  assert.match((await run(h, 'summary')).content, /zebra/);
  assert.equal((await run(h, 'summary')).content.split('\n').length, 1);
  assert.equal((await run(h, 'decided')).content, 'No matching compaction history for this project.');
  await stop(); rmSync(d, { recursive: true });
});

test('host errors never propagate (context failure, bad events)', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p });
  h.ctx.session.context = async () => { throw new Error('boom'); };
  const stop = await setupTrim(h.ctx);
  h.push(null); h.push({ type: 'session.compaction.started' }); h.push(started()); h.push(ended()); await tick();
  assert.match((await run(h, 'sqlite')).content, /sqlite/);
  await stop(); rmSync(d, { recursive: true });
});

test('project isolation', async () => {
  const { d, p } = tmpDb();
  const a = harness({ memory: { enabled: true }, dbPath: p, directory: '/proj/a' });
  const b = harness({ memory: { enabled: true }, dbPath: p, directory: '/proj/b' });
  const sa = await setupTrim(a.ctx), sb = await setupTrim(b.ctx);
  a.push(ended({ text: 'alpha secret-free note about quokka' })); await tick();
  assert.match((await run(a, 'quokka')).content, /quokka/);
  assert.match((await run(b, 'quokka')).content, /No matching/);
  await sa(); await sb(); rmSync(d, { recursive: true });
});

test('execute.before: default allows any agent; host permissions decide', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p });
  const stop = await setupTrim(h.ctx);
  for (const agent of ['build', 'anything-else', undefined]) assert.doesNotThrow(() => h.before({ tool: 'trim_history_search', agent }));
  assert.doesNotThrow(() => h.before({ tool: 'shell' }));
  await stop(); rmSync(d, { recursive: true });
});

test('execute.before: allowlist restricts, missing agent fails closed', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true, agentAllowlist: ['a1', 'x1'] }, dbPath: p });
  const stop = await setupTrim(h.ctx);
  const call = (e) => h.before(e);
  assert.doesNotThrow(() => call({ tool: 'trim_history_search', agent: 'x1' }));
  assert.throws(() => call({ tool: 'trim_history_search', agent: 'build' }));
  assert.throws(() => call({ tool: 'trim_history_search' }));
  assert.throws(() => call({ tool: 'trim_history_search', agent: {} }));
  assert.doesNotThrow(() => call({ tool: 'shell' }));
  await stop(); rmSync(d, { recursive: true });
});

test('execute.before: denylist denies; deny wins over allow', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true, agentDenylist: ['bad'] }, dbPath: p });
  const stop = await setupTrim(h.ctx);
  assert.throws(() => h.before({ tool: 'trim_history_search', agent: 'bad' }));
  assert.doesNotThrow(() => h.before({ tool: 'trim_history_search', agent: 'good' }));
  await stop();
  const h2 = harness({ memory: { enabled: true, agentAllowlist: ['bad'], agentDenylist: ['bad'] }, dbPath: p });
  const stop2 = await setupTrim(h2.ctx);
  assert.throws(() => h2.before({ tool: 'trim_history_search', agent: 'bad' }));
  await stop2(); rmSync(d, { recursive: true });
});

test('source hardcodes no agent names', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['../src/memory.js', '../src/config.js'])
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /hi-manager|'build'/);
});

test('retention: expired rows not searchable and pruned on archive', async () => {
  const { d, p } = tmpDb();
  const old = openMemoryStore({ dbPath: p });
  old.archive({ event_id: 'old', project: '/proj/a', text: 'ancient mammoth note', created_at: Date.now() - 200 * 86400000 });
  old.close();
  const h = harness({ memory: { enabled: true, retentionDays: 30 }, dbPath: p });
  const stop = await setupTrim(h.ctx);
  assert.match((await run(h, 'mammoth')).content, /No matching/);
  h.push(ended({ text: 'fresh note' })); await tick();
  await stop();
  const s = openMemoryStore({ dbPath: p, retentionDays: 36500 });
  assert.equal(s.search({ project: '/proj/a', query: 'mammoth' }).length, 0);
  s.close(); rmSync(d, { recursive: true });
});

test('tool rejects invalid input and aborted signal', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p });
  const stop = await setupTrim(h.ctx);
  await assert.rejects(h.tool.execute({ query: 5 }, { signal: new AbortController().signal }));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(h.tool.execute({ query: 'a' }, { signal: ac.signal }));
  await stop(); rmSync(d, { recursive: true });
});

test('tool: section filter, aliases, label, invalid; query-only unchanged', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p });
  const stop = await setupTrim(h.ctx);
  const sch = h.tool.input.properties.section;
  assert.equal(sch.type, 'string');
  assert.equal(sch.enum, undefined, 'aliases must pass host schema validation');
  for (const n of ['objective', 'requirements', 'decisions', 'work_state', 'next_move', 'relevant_files', 'important_context']) assert.ok(sch.description.includes(n), n);
  assert.match(sch.description, /case/i);
  assert.deepEqual(h.tool.options, { codemode: false });
  h.push(ended({ id: 'sec1', text: '## Objective\nship quokka goal\n## Decisions\nchose quokka storage\n## Work State\nidle' })); await tick(); await tick();
  const ex = (input) => h.tool.execute(input, { signal: new AbortController().signal, agent: 'build' });
  const plain = await ex({ query: 'quokka' });
  assert.doesNotMatch(plain.content, /\[Decisions\]/);
  assert.match(plain.content, /ship quokka goal/);
  for (const alias of ['decisions', 'Decisions', 'DECISIONS']) {
    const r = await ex({ query: 'quokka', section: alias });
    assert.match(r.content, /session s1: \[Decisions\] chose quokka storage/);
    assert.doesNotMatch(r.content, /goal/);
  }
  assert.match((await ex({ query: 'idle', section: 'Work State' })).content, /\[Work State\] idle/);
  assert.match((await ex({ query: 'idle', section: 'work-state' })).content, /\[Work State\] idle/);
  assert.match((await ex({ query: 'decisions', section: 'Decisions' })).content, /\[Decisions\]/);
  await assert.rejects(ex({ query: 'quokka', section: 'bogus' }), /section/);
  await assert.rejects(ex({ query: 'quokka', section: 5 }), /section/);
  await stop(); rmSync(d, { recursive: true });
});

// Location-free builders for attribution tests (the default helpers carry a local top-level location).
const bare = (type, sid, extra = {}) => ({ type, data: { sessionID: sid, ...extra } });
const bareEnded = (sid, id, text) => ({ type: 'session.compaction.ended', data: { sessionID: sid, id, text, reason: 'manual' } });
const at = (dir) => ({ directory: dir });
function ctxCounting(h) { const o = h.ctx.session.context; const c = { n: 0 }; h.ctx.session.context = async (...a) => { c.n++; return o(...a); }; return c; }

test('multi-location: foreign events (any location shape) are ignored before pending/archive work', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p, directory: '/proj/a' });
  const calls = ctxCounting(h);
  const stop = await setupTrim(h.ctx);
  const shapes = [
    (e) => ({ ...e, location: at('/proj/b') }),
    (e) => ({ ...e, data: { ...e.data, location: at('/proj/b') } }),
    (e) => ({ ...e, properties: { location: at('/proj/b') } }),
  ];
  let i = 0;
  for (const shape of shapes) {
    const sid = `foreign${i++}`;
    h.push(shape(bare('session.compaction.started', sid)));
    h.push(shape(bareEnded(sid, `f-${sid}`, `foreign summary ${sid}`)));
    h.push(shape(bare('session.compaction.failed', sid)));
    await tick();
  }
  await tick();
  assert.equal(calls.n, 0, 'foreign started must not read context / seed pending');
  assert.deepEqual(await rows(p), []);
  fire(h, ctxEvt('foreign0', 1200));
  assert.deepEqual(await rows(p), []);
  await stop(); rmSync(d, { recursive: true });
});

test('multi-location: only local and lexically equivalent absolute locations archive; absent/empty/malformed/relative do not', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p, directory: '/proj/a' });
  const calls = ctxCounting(h);
  const stop = await setupTrim(h.ctx);
  const good = [
    ['local-1', { location: at('/proj/a') }],
    ['canon-top', { location: at('/proj/x/../a') }],
    ['canon-data', { data: { location: at('/proj/a/') } }],
    ['canon-props', { properties: { location: at('/proj/./a') } }],
    ['same-twice', { location: at('/proj/a'), data: { location: at('/proj/x/../a') } }],
  ];
  const bad = [
    ['absent', {}],
    ['empty', { location: at('') }],
    ['number', { location: at(42) }],
    ['relative', { location: at('proj/a') }],
    ['dotrel', { location: at('./a') }],
    ['nul', { location: at('/proj/a\0') }],
    ['loc-string', { location: '/proj/a' }],
    ['bad-props', { properties: { location: at('') } }],
  ];
  for (const [id, shape] of [...good, ...bad]) {
    const e = bareEnded('s-' + id, id, 'unique ' + id);
    h.push({ ...e, ...shape, data: { ...e.data, ...(shape.data ?? {}) } });
    await tick();
  }
  await tick();
  assert.deepEqual((await rows(p)).map(r => r.e).sort(), good.map(g => g[0]).sort());
  const before = calls.n;
  for (const [, shape] of bad) h.push({ ...bare('session.compaction.started', 'sx'), ...shape });
  await tick(); await tick();
  assert.equal(calls.n, before, 'unattributed started must not read context');
  await stop(); rmSync(d, { recursive: true });
});

test('multi-location: conflicting location shapes are dropped with no pending/context side effects', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p, directory: '/proj/a' });
  const calls = ctxCounting(h);
  const stop = await setupTrim(h.ctx);
  const combos = {
    'top-local+data-foreign': { location: at('/proj/a'), data: { location: at('/proj/b') } },
    'top-foreign+data-local': { location: at('/proj/b'), data: { location: at('/proj/a') } },
    'data-local+props-foreign': { data: { location: at('/proj/a') }, properties: { location: at('/proj/b') } },
  };
  for (const [name, shape] of Object.entries(combos)) {
    const mk = (type, extra = {}) => ({ type, ...shape, data: { sessionID: 'c-' + name, ...extra, ...(shape.data ?? {}) } });
    h.push(mk('session.compaction.started'));
    h.push(mk('session.compaction.ended', { id: 'c-' + name, text: 'B text conflicting', reason: 'auto' }));
    await tick();
  }
  await tick();
  assert.equal(calls.n, 0);
  assert.deepEqual(await rows(p), []);
  await stop(); rmSync(d, { recursive: true });
});

test('multi-location: two instances on one DB receiving a location-less ended event: neither archives; located events archive once each', async () => {
  const { d, p } = tmpDb();
  const a = harness({ memory: { enabled: true }, dbPath: p, directory: '/proj/a' });
  const b = harness({ memory: { enabled: true }, dbPath: p, directory: '/proj/b' });
  const stopA = await setupTrim(a.ctx); const stopB = await setupTrim(b.ctx);
  const nl = bareEnded('sn', 'noloc', 'nolocation summary');
  a.push(nl); b.push(nl);
  await tick(); await tick();
  assert.deepEqual(await rows(p), []);
  const evtA = { ...bareEnded('sa', 'ea', 'alphaonly summary'), location: at('/proj/a') };
  const evtB = { ...bareEnded('sb', 'eb', 'bravoonly summary'), location: at('/proj/b') };
  for (const e of [evtA, evtB]) { a.push(e); b.push(e); }
  await tick(); await tick();
  const s = openMemoryStore({ dbPath: p });
  assert.equal(s.search({ project: '/proj/a', query: 'alphaonly' }).length, 1);
  assert.equal(s.search({ project: '/proj/a', query: 'bravoonly' }).length, 0);
  assert.equal(s.search({ project: '/proj/b', query: 'bravoonly' }).length, 1);
  assert.equal(s.search({ project: '/proj/b', query: 'alphaonly' }).length, 0);
  assert.equal(s.search({ project: '/proj/a', query: 'nolocation' }).length + s.search({ project: '/proj/b', query: 'nolocation' }).length, 0);
  s.close();
  await stopA(); await stopB(); rmSync(d, { recursive: true });
});

test('multi-location: foreign session.context cannot consume the local awaitingAfter entry', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p, directory: '/proj/a', ctxTokens: [3000] });
  const stop = await setupTrim(h.ctx);
  h.push(started('s1')); h.push(ended({ id: 'evx' })); await tick(); await tick();
  const before = (await rows(p))[0].b;
  assert.ok(before > 0);
  assert.equal((await rows(p))[0].a, null);
  for (const loc of [at('/proj/b'), at('')]) fire(h, { ...ctxEvt('s1', 60), location: loc });
  fire(h, { ...ctxEvt('s1', 60), location: at('/proj/a'), data: { location: at('/proj/b') } });
  assert.equal((await rows(p))[0].a, null, 'foreign/ambiguous/conflicting context must not fill');
  fire(h, { ...ctxEvt('s1', 900), location: at('/proj/a') });
  const after = (await rows(p))[0].a;
  assert.ok(after > 0 && after < before, `after=${after} before=${before}`);
  fire(h, ctxEvt('s1', 9000));
  assert.equal((await rows(p))[0].a, after, 'consumed once');
  await stop(); rmSync(d, { recursive: true });
});

test('multi-location: a throwing location getter drops that event; the subscription continues', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p, directory: '/proj/a' });
  const stop = await setupTrim(h.ctx);
  const evil = bareEnded('se', 'evil', 'getter summary');
  Object.defineProperty(evil, 'location', { enumerable: true, get() { throw new Error('boom'); } });
  h.push(evil); await tick();
  h.push({ ...bareEnded('sg', 'good', 'after getter'), location: at('/proj/a') }); await tick(); await tick();
  assert.deepEqual((await rows(p)).map(r => r.e), ['good']);
  await stop(); rmSync(d, { recursive: true });
});

test('multi-location: failed clears pending for local/absent, not for foreign/conflicting', async () => {
  const { d, p } = tmpDb();
  const h = harness({ memory: { enabled: true }, dbPath: p, directory: '/proj/a', ctxTokens: [3000, 300] });
  const stop = await setupTrim(h.ctx);
  h.push(started('s1')); await tick();
  h.push({ ...bare('session.compaction.failed', 's1'), location: at('/proj/b') });
  h.push({ type: 'session.compaction.failed', location: at('/proj/a'), data: { sessionID: 's1', location: at('/proj/b') } });
  await tick();
  h.push(ended({ id: 'keep' })); await tick(); await tick();
  assert.ok((await rows(p))[0].b > 0, 'pending survived foreign/conflicting failed');
  h.push(started('s2')); h.push(bare('session.compaction.failed', 's2')); h.push(ended({ id: 'after-fail', sessionID: 's2' })); await tick(); await tick();
  assert.equal((await rows(p)).find(r => r.e === 'after-fail').b, null, 'absent-location failed cleared pending');
  await stop(); rmSync(d, { recursive: true });
});

test('setupMemory: rejects non-absolute location and canonicalizes trailing slashes', async () => {
  const { setupMemory } = await import('../src/memory.js');
  const { d, p } = tmpDb();
  const hRel = harness({ memory: { enabled: true }, dbPath: p, directory: './relative-proj' });
  await assert.rejects(setupMemory(hRel.ctx, parseOptions(hRel.ctx.options)), /absolute path/);

  const hSlash = harness({ memory: { enabled: true }, dbPath: p, directory: '/proj/a/' });
  const stop = await setupTrim(hSlash.ctx);
  hSlash.push(ended({ id: 'canon-1', location: { directory: '/proj/a' }, text: '## Objective\ncanonical project key\n' }));
  await tick(); await tick();
  const res = await hSlash.tool.execute({ query: 'canonical' }, { signal: new AbortController().signal, agent: 'build' });
  assert.match(res.content, /canonical project key/);
  await stop(); rmSync(d, { recursive: true });
});
