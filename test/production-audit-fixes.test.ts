import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions, DEFAULTS } from '../src/config.ts';
import { estimateRequest } from '../src/pressure.ts';
import { pruneContext, PRUNED, PRUNED_OLD_INPUT, isLiveDiskOutput } from '../src/prune.ts';
import { setupTrim } from '../src/plugin.ts';
import { ContextCache } from '../src/cache.ts';
import { messageBreakdown } from '../src/tui-model.ts';

function makeTail(count = 6) {
  return Array.from({ length: count }, (_, i) => ({
    id: `tail-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `recent turn ${i} ` + 'q'.repeat(600) }],
  }));
}

test('BUG-01a: estimateRequest never counts base64 image/file payloads as text tokens or toolChars and detects nested media', () => {
  const b64Png = 'data:image/png;base64,' + 'A'.repeat(350_000);
  const b64Jpg = 'data:image/jpeg;base64,' + 'B'.repeat(140_000);
  const opts = parseOptions({ maxTokens: '250k' });
  const catalog = new Map([['provider-a/model-1m', { context: 1_000_000, output: 384_000 }]]);

  // Real-world screenshot trailing shape: 172k real tokens on m-last, followed by 2 newly read PNGs in tool-result
  const event = {
    sessionID: 's-png-trailing',
    model: { providerID: 'provider-a', id: 'model-1m', limit: { context: 1_000_000, output: 384_000 } },
    system: [],
    tools: {},
    messages: [
      { id: 'm-user', role: 'user', content: [{ type: 'text', text: 'Check the screenshots' }] },
      {
        id: 'm-last',
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'c1', name: 'read', input: { path: 'screenshot/02_tasks.png' } },
          { type: 'tool-call', id: 'c2', name: 'read', input: { path: 'screenshot/06_dependencies.png' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            id: 'c1',
            name: 'read',
            result: {
              type: 'content',
              value: [
                { type: 'text', text: 'Read image attachment (image/png, 1024x576, 136 KB).' },
                { type: 'file', uri: b64Jpg },
              ],
            },
          },
          {
            type: 'tool-result',
            id: 'c2',
            name: 'read',
            result: {
              type: 'content',
              value: [
                { type: 'text', text: 'Read image attachment (image/png, 1024x576, 355 KB).' },
                { type: 'file', uri: b64Png },
              ],
            },
          },
        ],
      },
    ],
  };

  const est = estimateRequest(event, catalog, opts, { tokens: new Map([['m-last', 172_081]]), baselineChars: 0 });
  assert.equal(est.mediaPresent, true, 'nested file/image attachment inside tool-result must set mediaPresent=true');
  assert.ok(est.breakdown!.toolChars < 2_000, `base64 bytes must not bloat toolChars, got ${est.breakdown!.toolChars}`);
  assert.ok(est.estimatedChars < 5_000, `base64 bytes must not bloat estimatedChars, got ${est.estimatedChars}`);
  assert.ok(
    est.effectiveTokens < 180_000,
    `2 screenshots must add ~2.4k vision tokens, not +163k base64/3 tokens; got ${est.effectiveTokens}`,
  );
  assert.ok(est.ratio! < 0.75, `172k + 2 screenshots on 250k cap must stay well below 1.0, got ${est.ratio}`);
});

test('BUG-01b: setupTrim does NOT queue autoCompact when screenshots are read at 172k real tokens on 250k cap', async () => {
  const compactCalls: any[] = [];
  let contextCb: any;
  const queue: any[] = [];
  let wake: any;
  let done = false;
  const ctx = {
    options: { maxTokens: '250k', autoCompact: true, protectRecentMessages: 4, tui: { enabled: false }, memory: { enabled: false } },
    model: { list: async () => ({ data: [{ providerID: 'p', id: 'm', limit: { context: 1_000_000, output: 384_000 } }] }) },
    tool: { hook: async () => ({ dispose: async () => {} }) },
    session: {
      hook: async (name: string, fn: any) => { if (name === 'context') contextCb = fn; return { dispose: async () => {} }; },
      compact: async (input: any) => { compactCalls.push(input); return { id: 'c' }; },
    },
    event: {
      subscribe: async (args: any) => {
        args.signal?.addEventListener('abort', () => { done = true; wake?.(); });
        return (async function* () { while (!done) { if (queue.length) yield queue.shift(); else await new Promise((r) => { wake = r; }); } })();
      },
    },
  };
  const stop = await setupTrim(ctx);
  const messages: any[] = [];
  for (let i = 0; i < 12; i++) {
    messages.push({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `msg ${i} ` + 'w'.repeat(400) }] });
  }
  messages.push({
    id: 'm-assist-last',
    role: 'assistant',
    content: [
      { type: 'tool-call', id: 'c1', name: 'read', input: { path: 'a.png' } },
      { type: 'tool-call', id: 'c2', name: 'read', input: { path: 'b.png' } },
    ],
  });
  messages.push({
    role: 'tool',
    content: [
      { type: 'tool-result', id: 'c1', name: 'read', result: { type: 'content', value: [{ type: 'text', text: 'Read image a.png' }, { type: 'file', uri: 'data:image/jpeg;base64,' + 'A'.repeat(140_000) }] } },
      { type: 'tool-result', id: 'c2', name: 'read', result: { type: 'content', value: [{ type: 'text', text: 'Read image b.png' }, { type: 'file', uri: 'data:image/png;base64,' + 'B'.repeat(355_000) }] } },
    ],
  });

  queue.push({
    type: 'session.step.ended',
    data: { sessionID: 's-live', assistantMessageID: 'm-assist-last', tokens: { input: 32_177, output: 110, reasoning: 0, cache: { read: 139_904, write: 0 } } },
  });
  wake?.();
  await new Promise((r) => setTimeout(r, 30));
  await contextCb({ sessionID: 's-live', model: { providerID: 'p', id: 'm' }, tools: {}, system: [], messages });
  await new Promise((r) => setTimeout(r, 20));
  await stop();

  assert.equal(compactCalls.length, 0, 'must NOT queue autoCompact at 172k real tokens after reading screenshots');
});

test('BUG-01c: TUI messageBreakdown ignores base64 file/image attachments inside tool parts', () => {
  const b64 = 'data:image/png;base64,' + 'Z'.repeat(300_000);
  const bd = messageBreakdown([
    { type: 'user', text: 'Look at this screenshot and explain the layout in detail.' },
    {
      type: 'assistant',
      parts: [
        {
          type: 'tool',
          name: 'read',
          state: {
            status: 'completed',
            input: { path: 'screen.png' },
            content: [
              { type: 'text', text: 'Read image attachment (image/png, 1024x576, 300 KB).' },
              { type: 'file', uri: b64 },
            ],
          },
        },
      ],
    },
  ]);
  assert.ok(bd !== null);
  assert.ok(bd!.toolChars < 500, `messageBreakdown must exclude base64 file payloads, got toolChars=${bd!.toolChars}`);
});

test('BUG-02: pruneOldToolInputs defaults to false and NEVER rewrites subagent/delegation/prompt inputs even when opted in', () => {
  assert.equal(DEFAULTS.pruneOldToolInputs, false, 'pruneOldToolInputs must default to false to prevent LLM few-shot stub imitation');

  const opts = parseOptions({
    pruneOldToolInputs: true,
    protectRecentMessages: 4,
    protectRecentTokens: 1024,
    keepRecentToolResults: 1,
    pruneAfterToolChars: 10000,
    pruneMinResultChars: 400,
    prunePreviewLines: 0,
  });
  const subPrompt = 'Task 123 (worker). Detailed instructions:\n' + 'step detail line\n'.repeat(100);
  const taskDesc = 'Long task contract description:\n' + 'requirement line\n'.repeat(100);
  const bigBlob = 'raw unstructured blob payload '.repeat(80);
  const messages: any[] = [
    { id: 'c-sub-m', role: 'assistant', content: [{ type: 'tool-call', id: 'c-sub', name: 'subagent', input: { agent: 'worker', prompt: subPrompt } }] },
    { id: 'r-sub-m', role: 'tool', content: [{ type: 'tool-result', id: 'c-sub', name: 'subagent', result: { type: 'text', value: 'done' } }] },
    { id: 'c-task-m', role: 'assistant', content: [{ type: 'tool-call', id: 'c-task', name: 'work_task', input: { action: 'create', description: taskDesc } }] },
    { id: 'r-task-m', role: 'tool', content: [{ type: 'tool-result', id: 'c-task', name: 'work_task', result: { type: 'text', value: 'created' } }] },
    { id: 'c-custom-m', role: 'assistant', content: [{ type: 'tool-call', id: 'c-custom', name: 'custom_analyzer', input: { prompt: subPrompt, payload: bigBlob } }] },
    { id: 'r-custom-m', role: 'tool', content: [{ type: 'tool-result', id: 'c-custom', name: 'custom_analyzer', result: { type: 'text', value: 'analyzed' } }] },
    ...makeTail(6),
  ];

  pruneContext({ sessionID: 's-no-poison', messages }, opts, { allowNewDrops: true, pressure: { ratio: 0.88, usableTokens: 20000 } });
  assert.equal(messages[0].content[0].input.prompt, subPrompt, 'subagent prompt must NEVER be rewritten');
  assert.equal(messages[2].content[0].input.description, taskDesc, 'protected task description must NEVER be rewritten');
  assert.equal(messages[4].content[0].input.prompt, subPrompt, 'natural-language prompt field must NEVER be rewritten');
  assert.ok(messages[4].content[0].input.payload.includes(PRUNED_OLD_INPUT), 'opt-in pruneOldToolInputs still compacts non-prompt data payload on non-protected tools');
});

test('BUG-03: pressure pruning stays active in media sessions once real reportedTokens are available', () => {
  const opts = parseOptions({
    protectRecentMessages: 4,
    protectRecentTokens: 1024,
    keepRecentToolResults: 1,
    pruneAfterToolChars: 500_000, // high size threshold so ONLY pressure triggers pruning
    pruneMinResultChars: 400,
    prunePreviewLines: 0,
  });
  const messages: any[] = [
    { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'grep', input: { pattern: 'foo' } }] },
    { id: 't1', role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'grep', result: { type: 'text', value: 'match line\n'.repeat(120) } }] },
    { id: 'a2', role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'grep', input: { pattern: 'bar' } }] },
    { id: 't2', role: 'tool', content: [{ type: 'tool-result', id: 'c2', name: 'grep', result: { type: 'text', value: 'recent match\n'.repeat(120) } }] },
    ...makeTail(6),
  ];

  // Without real reportedTokens, mediaPresent still conservatively blocks pressure pruning
  const cloneNoReal = structuredClone(messages);
  const resNoReal = pruneContext({ sessionID: 's-media-1', messages: cloneNoReal }, opts, {
    allowNewDrops: true,
    pressure: { ratio: 0.8, usableTokens: 20_000, mediaPresent: true },
  });
  assert.equal(resNoReal.pruned, 0, 'unverified estimate with mediaPresent stays conservative');

  // With real reportedTokens from provider, pressure pruning MUST run even when mediaPresent=true!
  const resWithReal = pruneContext({ sessionID: 's-media-2', messages }, opts, {
    allowNewDrops: true,
    pressure: { ratio: 0.8, usableTokens: 20_000, mediaPresent: true, reportedTokens: 16_000 },
  });
  assert.equal(resWithReal.pruned, 1, 'real provider reportedTokens must allow pressure pruning even with mediaPresent=true');
  assert.equal(messages[1].content[0].result.value, PRUNED);
});

test('BUG-04: estimateRequest diagnostics.topTools extracts part.toolName instead of falling back to role', () => {
  const est = estimateRequest(
    {
      model: { providerID: 'p', id: 'm', limit: { context: 100_000, output: 8_000 } },
      system: [],
      tools: {},
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'grep', input: { pattern: 'abc' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'grep', result: { type: 'text', value: 'x'.repeat(5000) } }] },
      ],
    },
    new Map(),
    parseOptions(),
  );
  assert.deepEqual(
    est.diagnostics!.topTools.map((t) => t.name),
    ['grep'],
    `expected topTools=['grep'], got ${JSON.stringify(est.diagnostics!.topTools)}`,
  );
});

test('BUG-05: post-restart seeded native tokens do not double-subtract already-persisted replayed drops', async () => {
  let contextCb: any;
  const snapshots: any[] = [];
  const ctx = {
    options: { maxTokens: '250k', protectRecentMessages: 4, keepRecentToolResults: 1, pruneAfterToolChars: 10000, pruneMinResultChars: 200, prunePreviewLines: 0, tui: { enabled: true }, memory: { enabled: false } },
    model: { list: async () => ({ data: [{ providerID: 'p', id: 'm', limit: { context: 1_000_000, output: 16_000 } }] }) },
    tool: { hook: async () => ({ dispose: async () => {} }) },
    rpc: {
      register: async (_def: any, handlers: any) => {
        snapshots.push(handlers.snapshot);
        return { dispose: async () => {}, events: { emit: () => {} } };
      },
    },
    session: {
      hook: async (name: string, fn: any) => { if (name === 'context') contextCb = fn; return { dispose: async () => {} }; },
      // Real provider token count from BEFORE restart already reflects pruned context (170k)!
      context: async () => [{ id: 'm-assist-end', type: 'assistant', tokens: { input: 20_000, output: 200, reasoning: 0, cache: { read: 150_000, write: 0 } } }],
    },
  };
  const stop = await setupTrim(ctx);
  // Simulate turn 1 (establishes drops) followed by abort (no step.ended) and turn 2
  const mkMsgs = () => {
    const msgs: any[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ id: `ac-${i}`, role: 'assistant', content: [{ type: 'tool-call', id: `c-${i}`, name: 'read', input: { path: `src/f${i}.ts` } }] });
      msgs.push({ id: `tr-${i}`, role: 'tool', content: [{ type: 'tool-result', id: `c-${i}`, name: 'read', result: { type: 'text', value: 'x'.repeat(30_000) } }] });
    }
    msgs.push(...makeTail(4));
    msgs.push({ id: 'm-assist-end', role: 'assistant', content: [{ type: 'text', text: 'continuing' }] });
    return msgs;
  };

  // Turn 1: pruned 6 * 30k = 180k chars; seeded native = 170k.
  // Turn 2 (before any step.ended arrives — e.g. aborted turn 1!): baseline for seeded nat must still match!
  await contextCb({ sessionID: 's-seed', model: { providerID: 'p', id: 'm' }, tools: {}, system: [], messages: mkMsgs() });
  const snap1 = await snapshots[0]({ sessionID: 's-seed' });
  await contextCb({ sessionID: 's-seed', model: { providerID: 'p', id: 'm' }, tools: {}, system: [], messages: mkMsgs() });
  const snap2 = await snapshots[0]({ sessionID: 's-seed' });
  await stop();

  // On Turn 2 (replay of identical drops without any step.ended), estimatedTokens must match Turn 1 (not jump +60k!)
  assert.ok(
    Math.abs(snap2.context.estimatedTokens - snap1.context.estimatedTokens) < 2000,
    `aborted turn without step.ended must not desync baselineChars: snap1=${snap1.context.estimatedTokens}, snap2=${snap2.context.estimatedTokens}`,
  );
});

test('BUG-05b: hydrated prune_decisions after restart do not double-subtract from seeded provider tokens', () => {
  const opts = parseOptions({
    maxTokens: '250k',
    protectRecentMessages: 4,
    protectRecentTokens: 1024,
    keepRecentToolResults: 1,
    pruneAfterToolChars: 10000,
    pruneMinResultChars: 200,
    prunePreviewLines: 0,
  });
  const mkMsgs = () => {
    const msgs: any[] = [];
    for (let i = 0; i < 4; i++) {
      msgs.push({ id: `ac-${i}`, role: 'assistant', content: [{ type: 'tool-call', id: `c-${i}`, name: 'read', input: { path: `src/f${i}.ts` } }] });
      msgs.push({ id: `tr-${i}`, role: 'tool', content: [{ type: 'tool-result', id: `c-${i}`, name: 'read', result: { type: 'text', value: 'x'.repeat(30_000) } }] });
    }
    msgs.push(...makeTail(4));
    msgs.push({ id: 'm-assist-end', role: 'assistant', content: [{ type: 'text', text: 'continuing' }] });
    return msgs;
  };
  const persisted = new Set<string>();
  const cache1 = new ContextCache();
  cache1.setPersistence({ load: () => [...persisted], save: (_s, ids) => { for (const id of ids) persisted.add(id); } });
  const ev1 = { sessionID: 's-hyd', model: { providerID: 'p', id: 'm', limit: { context: 1_000_000, output: 16_000 } }, messages: mkMsgs() };
  const g1 = cache1.begin(ev1, opts, { ratio: 0.8 }, 'context');
  const r1 = pruneContext(ev1, opts, { pressure: { ratio: 0.8, usableTokens: 250_000 }, ...g1 });
  g1.finish(r1.plannedIds);
  assert.ok(persisted.size >= 2, 'must persist drops to store');

  // Restart: fresh ContextCache hydrates persisted drops
  const cache2 = new ContextCache();
  cache2.setPersistence({ load: () => [...persisted], save: (_s, ids) => { for (const id of ids) persisted.add(id); } });
  const ev2 = { sessionID: 's-hyd', model: { providerID: 'p', id: 'm', limit: { context: 1_000_000, output: 16_000 } }, messages: mkMsgs() };
  const g2 = cache2.begin(ev2, opts, { ratio: 0.7 }, 'context');
  const r2 = pruneContext(ev2, opts, { pressure: { ratio: 0.7, usableTokens: 250_000 }, ...g2 });
  assert.ok((r2.replayedChars ?? 0) >= 59_000, `hydrated drops must report replayedChars, got ${r2.replayedChars}`);
  const post = estimateRequest(ev2, new Map(), opts, { tokens: new Map([['m-assist-end', 170_000]]), baselineChars: r2.replayedChars });
  assert.ok(
    post.effectiveTokens >= 165_000 && post.effectiveTokens <= 175_000,
    `replaying hydrated drops must not double-subtract from 170k seeded tokens, got ${post.effectiveTokens}`,
  );
});

test('BUG-06: read-only ephemeral status/watch tools and git ls-files are eligible for pruning and archived (not live-disk)', () => {
  const opts = parseOptions({
    protectRecentMessages: 4,
    protectRecentTokens: 1024,
    keepRecentToolResults: 1,
    pruneAfterToolChars: 10000,
    pruneMinResultChars: 400,
    prunePreviewLines: 0,
  });
  const messages: any[] = [
    { id: 'c1', role: 'assistant', content: [{ type: 'tool-call', id: 'id1', name: 'bash_watch', input: { id: 'job1' } }] },
    { id: 'r1', role: 'tool', content: [{ type: 'tool-result', id: 'id1', name: 'bash_watch', result: { type: 'text', value: 'log line\n'.repeat(120) } }] },
    { id: 'c2', role: 'assistant', content: [{ type: 'tool-call', id: 'id2', name: 'bash_status', input: { id: 'job1' } }] },
    { id: 'r2', role: 'tool', content: [{ type: 'tool-result', id: 'id2', name: 'bash_status', result: { type: 'text', value: 'status line\n'.repeat(120) } }] },
    { id: 'c3', role: 'assistant', content: [{ type: 'tool-call', id: 'id3', name: 'shell', input: { command: 'git ls-files src docs' } }] },
    { id: 'r3', role: 'tool', content: [{ type: 'tool-result', id: 'id3', name: 'shell', result: { type: 'text', value: 'src/a.ts\n'.repeat(120) } }] },
    // Protected status tools must STILL stay untouched!
    { id: 'c4', role: 'assistant', content: [{ type: 'tool-call', id: 'id4', name: 'skill_status', input: {} }] },
    { id: 'r4', role: 'tool', content: [{ type: 'tool-result', id: 'id4', name: 'skill_status', result: { type: 'text', value: 'skill detail\n'.repeat(120) } }] },
    // One recent eligible tool kept by keepRecentToolResults=1
    { id: 'c5', role: 'assistant', content: [{ type: 'tool-call', id: 'id5', name: 'grep', input: { pattern: 'recent' } }] },
    { id: 'r5', role: 'tool', content: [{ type: 'tool-result', id: 'id5', name: 'grep', result: { type: 'text', value: 'recent grep hit\n'.repeat(120) } }] },
    ...makeTail(6),
  ];

  assert.equal(isLiveDiskOutput('bash_watch', {}), false, 'bash_watch is ephemeral, not live disk');
  assert.equal(isLiveDiskOutput('bash_status', {}), false, 'bash_status is ephemeral, not live disk');

  const stored = new Map<string, any>();
  const vault = { store: (id: string, e: any) => { stored.set(id, e); return true; }, has: (id: string) => stored.has(id) };
  const res = pruneContext({ sessionID: 's-ro-eph', messages }, opts, {
    allowNewDrops: true,
    pressure: { ratio: 0.8, usableTokens: 20_000 },
    vault,
  });
  assert.ok(res.pruned >= 3, `expected bash_watch, bash_status, and git ls-files pruned; got ${res.pruned}`);
  assert.ok(messages[1].content[0].result.value.includes('trim_expand'), 'bash_watch archived to vault');
  assert.ok(messages[3].content[0].result.value.includes('trim_expand'), 'bash_status archived to vault');
  assert.ok(messages[5].content[0].result.value.includes('trim_expand'), 'git ls-files archived to vault');
  assert.equal(messages[7].content[0].result.value, 'skill detail\n'.repeat(120), 'protected skill_status must never be pruned');
});
