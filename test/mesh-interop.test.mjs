import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseOptions } from '../src/config.js';
import { ContextCache } from '../src/cache.js';
import { PRUNED, pruneContext } from '../src/prune.js';
import { processToolEvent, setupTrim } from '../src/plugin.js';
import {
  getMeshPeers,
  stampMeshMetadata,
  acquireSessionLease,
  isSessionWaitingOnUser,
  wasMeshBounded,
  resetMeshStateForTests,
} from '../src/bridge.js';

const opts = parseOptions({
  keepRecentToolResults: 1,
  protectRecentMessages: 4,
  protectRecentTokens: 1024,
  pruneAfterToolChars: 10000,
  pruneMinResultChars: 500,
});

function fillerTail() {
  return [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'continue ' + 'x'.repeat(1500) }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'working ' + 'y'.repeat(1500) }] },
    { id: 'u2', role: 'user', content: [{ type: 'text', text: 'more ' + 'z'.repeat(1500) }] },
    {
      id: 'a2',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'tail-call', name: 'read', input: { path: 'tail.txt' } }],
    },
    {
      id: 't2',
      role: 'tool',
      content: [{ type: 'tool-result', id: 'tail-call', result: { type: 'text', value: 't'.repeat(1200) } }],
    },
  ];
}

test('RED 1.1: mesh-protected tool-result consumes its matching tool-call so reused callId does not mispair a later write/protected read', () => {
  resetMeshStateForTests();
  const protectedMeta = stampMeshMetadata('s-queue', {
    owner: 'opencode-guardian',
    kind: 'remediation',
    protected: true,
  });
  const messages = [
    {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'reused-id', name: 'read', input: { path: 'normal.txt' } }],
    },
    {
      id: 'm2',
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          id: 'reused-id',
          metadata: protectedMeta,
          result: { type: 'text', value: 'a'.repeat(1500) },
        },
      ],
    },
    {
      id: 'm3',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'reused-id', name: 'read', input: { path: 'AGENTS.md' } }],
    },
    {
      id: 'm4',
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          id: 'reused-id',
          result: { type: 'text', value: 'b'.repeat(1500) },
        },
      ],
    },
    ...fillerTail(),
  ];
  const event = { sessionID: 's-queue', messages };
  pruneContext(event, opts, { pressure: { ratio: 0.95, usableTokens: 15000 }, allowNewDrops: true });
  assert.equal(messages[1].content[0].result.value, 'a'.repeat(1500), 'mesh-protected result must stay intact');
  assert.equal(
    messages[3].content[0].result.value,
    'b'.repeat(1500),
    'AGENTS.md read reusing callId must not pair with earlier normal.txt call and be pruned'
  );
});

test('RED 1.2: mesh protection on part.result.metadata and part.state.metadata (with sibling part.metadata) prevents pruning', () => {
  resetMeshStateForTests();
  const meta1 = stampMeshMetadata('s-meta', {
    owner: 'opencode-hi',
    kind: 'task-contract',
    protected: true,
  });
  const meta2 = stampMeshMetadata('s-meta', {
    owner: 'opencode-guardian',
    kind: 'remediation',
    protected: true,
  });
  const messages = [
    {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: 'read', input: { path: 'a.txt' } }],
    },
    {
      id: 'm2',
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          id: 'c1',
          result: { type: 'content', value: 'r'.repeat(1500), metadata: meta1 },
        },
      ],
    },
    {
      id: 'm3',
      role: 'assistant',
      content: [
        {
          type: 'tool',
          id: 'c2',
          name: 'read',
          input: { path: 'b.txt' },
          metadata: { unrelatedKey: true },
          state: { status: 'completed', output: 's'.repeat(1500), metadata: meta2 },
        },
      ],
    },
    ...fillerTail(),
  ];
  const event = { sessionID: 's-meta', messages };
  const res = pruneContext(event, opts, { pressure: { ratio: 0.95, usableTokens: 15000 }, allowNewDrops: true });
  assert.equal(res.pruned, 0);
  assert.equal(messages[1].content[0].result.value, 'r'.repeat(1500));
  assert.equal(messages[2].content[0].state.output, 's'.repeat(1500));
});

test('RED 1.3: forged provenance token in an active session is rejected while valid stamped token is protected', () => {
  resetMeshStateForTests();
  const validMeta = stampMeshMetadata('s-prov', {
    owner: 'opencode-guardian',
    kind: 'remediation',
    protected: true,
  });
  const forgedMeta = {
    'opencode-mesh': {
      v: 2,
      owner: 'opencode-guardian',
      kind: 'remediation',
      token: 'forged-token-not-in-ledger',
      protected: true,
    },
  };
  const messages = [
    {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c-valid', name: 'read', input: { path: 'a.txt' } }],
    },
    {
      id: 'm2',
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          id: 'c-valid',
          metadata: validMeta,
          result: { type: 'text', value: 'v'.repeat(1500) },
        },
      ],
    },
    {
      id: 'm3',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c-forged', name: 'read', input: { path: 'b.txt' } }],
    },
    {
      id: 'm4',
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          id: 'c-forged',
          metadata: forgedMeta,
          result: { type: 'text', value: 'f'.repeat(1500) },
        },
      ],
    },
    ...fillerTail(),
  ];
  const event = { sessionID: 's-prov', messages };
  pruneContext(event, opts, { pressure: { ratio: 0.95, usableTokens: 15000 }, allowNewDrops: true });
  assert.equal(messages[1].content[0].result.value, 'v'.repeat(1500), 'valid token stays protected');
  assert.equal(messages[3].content[0].result.value, PRUNED, 'forged token in active session is pruned');
});

test('RED 1.4: processToolEvent honors multi-holder wasMeshBounded, reports to sink, and stamps boundedBy on compression', () => {
  resetMeshStateForTests();
  const noisy = Array.from({ length: 120 }, (_, i) => `npm notice chatter ${i}`).join('\n') + '\nadded 3 packages in 1s';
  let sinkCalls = [];
  const boundedOnEvent = {
    status: 'completed',
    tool: 'shell',
    input: { command: 'npm install' },
    metadata: { 'opencode-mesh': { v: 2, owner: 'opencode-hi', kind: 'tool', token: 't1', boundedBy: 'opencode-hi' } },
    result: { content: noisy },
  };
  assert.equal(processToolEvent(boundedOnEvent, parseOptions(), (info) => sinkCalls.push(info)), false);
  assert.equal(sinkCalls.length, 1);
  assert.deepEqual(sinkCalls[0], { kind: 'shell', changed: false, savedChars: 0 });

  const fresh = {
    status: 'completed',
    tool: 'shell',
    input: { command: 'npm install' },
    result: { content: noisy, metadata: { keep: 1 } },
  };
  assert.equal(processToolEvent(fresh, parseOptions()), true);
  assert.equal(fresh.result.metadata.keep, 1);
  assert.equal(wasMeshBounded(fresh.result), true);
  assert.equal(fresh.result.metadata['opencode-mesh'].boundedBy, 'opencode-trim');
});

test('RED 2.1: ContextCache toolChars excludes mesh-protected tool results from absolute budget', () => {
  resetMeshStateForTests();
  const cache = new ContextCache();
  const baseEvent = {
    sessionID: 's-cache',
    model: { providerID: 'p', id: 'm' },
    messages: [
      { id: 'u0', role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { id: 'a0', role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ],
  };
  cache.begin(baseEvent, opts, { ratio: 0.1 });

  const protectedMeta = stampMeshMetadata('s-cache', {
    owner: 'opencode-hi',
    kind: 'task-contract',
    protected: true,
  });
  const bigProtectedMessages = [];
  for (let i = 0; i < 15; i++) {
    bigProtectedMessages.push({
      id: `a-${i}`,
      role: 'assistant',
      content: [{ type: 'tool-call', id: `c-${i}`, name: 'read', input: { path: `f${i}.txt` } }],
    });
    bigProtectedMessages.push({
      id: `t-${i}`,
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          id: `c-${i}`,
          result: { type: 'content', value: 'p'.repeat(1200), metadata: protectedMeta },
        },
      ],
    });
  }
  const nextEvent = {
    sessionID: 's-cache',
    model: { providerID: 'p', id: 'm' },
    messages: [...baseEvent.messages, ...bigProtectedMessages],
  };
  const gate = cache.begin(nextEvent, opts, { ratio: 0.1 });
  assert.equal(gate.allowNewDrops, false, 'mesh-protected tool results must not trigger size-budget cache bust');
});

test('RED 2.2 & 2.3: setupTrim registers mesh peer, resolves symlink directory, and forgets session on session.deleted', async () => {
  resetMeshStateForTests();
  const root = mkdtempSync(join(tmpdir(), 'trim-mesh-'));
  const realDir = join(root, 'real-proj');
  const linkDir = join(root, 'link-proj');
  mkdirSync(realDir, { recursive: true });
  symlinkSync(realDir, linkDir, 'dir');

  try {
    let emitEvent;
    const ctx = {
      location: { directory: linkDir },
      options: { tui: { enabled: true }, memory: { enabled: false } },
      tool: { hook: async () => ({ dispose() {} }) },
      session: { hook: async () => ({ dispose() {} }) },
      event: {
        subscribe: async ({ signal }) => (async function* () {
          while (!signal.aborted) {
            const ev = await new Promise((r) => { emitEvent = r; });
            if (!ev) break;
            yield ev;
          }
        })(),
      },
    };
    const dispose = await setupTrim(ctx);
    const peers = getMeshPeers({ directory: realDir, capability: 'context.prune' });
    assert.equal(peers.length, 1);
    assert.equal(peers[0].id, 'opencode-trim');

    acquireSessionLease({ sessionID: 's-del', owner: 'opencode-smart-questions', kind: 'user_interaction' });
    assert.equal(isSessionWaitingOnUser('s-del'), true);
    emitEvent({ type: 'session.deleted', location: { directory: realDir }, data: { sessionID: 's-del' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(isSessionWaitingOnUser('s-del'), false, 'session.deleted must invoke forgetMeshSession');

    emitEvent(null);
    await dispose();
    assert.equal(getMeshPeers({ directory: realDir, capability: 'context.prune' }).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
