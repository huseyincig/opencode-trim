import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOptions } from '../src/config.ts';
import { setupMemory, EXPAND_TOOL_NAME } from '../src/memory.ts';
import { openMemoryStore } from '../src/memory-store.ts';
import { pruneContext, recoverableNotice } from '../src/prune.ts';

function makeMockCtx(dbPath: string, directory = '/proj/ref-contract') {
  const tools = new Map<string, any>();
  const ctx = {
    options: { memory: { enabled: true, dbPath } },
    location: { directory },
    tool: {
      hook: async () => ({ dispose: async () => {} }),
      transform: async (fn: any) => {
        fn({ add: (t: any) => tools.set(t.name, t) });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async () => ({ dispose: async () => {} }),
      context: async () => ({ messages: [] }),
    },
    event: {
      subscribe: async () => (async function* () {})(),
    },
  };
  return { ctx, tools };
}

test('trim_expand schema enforces ^trm_[0-9a-f]{32}$ pattern, declares output.reason, and forbids external task/job IDs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trim-ref-schema-'));
  const dbPath = join(dir, 'm.db');
  const { ctx, tools } = makeMockCtx(dbPath);
  const stop = await setupMemory(ctx, parseOptions(ctx.options));
  try {
    const expandTool = tools.get(EXPAND_TOOL_NAME);
    assert.ok(expandTool, 'trim_expand tool registered');
    assert.equal(expandTool.input.properties.id.pattern, '^trm_[0-9a-f]{32}$');
    assert.ok(expandTool.output.properties.reason, 'output schema must declare reason when returned');
    assert.match(expandTool.description, /trm_<32 hex>/);
    assert.match(expandTool.description, /task\/job\/process ID/i);
    assert.doesNotMatch(expandTool.description, /\bbash\b/i, 'description should not bait external bash task IDs');
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trim_expand and getVault reject non-trm external IDs with invalid_ref_format instead of expired', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trim-ref-invalid-'));
  const dbPath = join(dir, 'm.db');
  const { ctx, tools } = makeMockCtx(dbPath);
  const stop = await setupMemory(ctx, parseOptions(ctx.options));
  try {
    const expandTool = tools.get(EXPAND_TOOL_NAME);
    for (const badId of ['bash-c1acd9a8894925a6', 'src/plugin.ts', 'msg_abc123', 'job-42']) {
      const res = await expandTool.execute(
        { id: badId },
        { signal: new AbortController().signal, sessionID: 's1' },
      );
      assert.equal(res.output.found, false, `${badId} must not be found`);
      assert.equal(res.output.reason, 'invalid_ref_format', `${badId} must report invalid_ref_format`);
      assert.match(res.content, /invalid vault ref/i, `${badId} must explain invalid vault ref`);
      assert.match(res.content, /trm_<32 hex>/, `${badId} must tell caller expected format`);
      assert.doesNotMatch(res.content, /expired or was cleared/i, `${badId} must not mislead model with expired`);
    }
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trim_expand and getVault report missing_or_expired for absent valid-format trm_ refs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trim-ref-expired-'));
  const dbPath = join(dir, 'm.db');
  const { ctx, tools } = makeMockCtx(dbPath);
  const stop = await setupMemory(ctx, parseOptions(ctx.options));
  try {
    const expandTool = tools.get(EXPAND_TOOL_NAME);
    const validMissing = 'trm_0123456789abcdef0123456789abcdef';
    const res = await expandTool.execute(
      { id: validMissing },
      { signal: new AbortController().signal, sessionID: 's1' },
    );
    assert.equal(res.output.found, false);
    assert.equal(res.output.reason, 'missing_or_expired');
    assert.match(res.content, /expired or was cleared/i);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverableNotice stays compact (<250 chars) and embeds trim_expand({id}) call hint', () => {
  const refId = 'trm_5b9d6e4109920ec3de7dddd85ef2f860';
  const notice = recoverableNotice(refId, 'shell', 420, 95);
  assert.ok(notice.length < 250, `recoverableNotice must stay compact (<250), got ${notice.length}`);
  assert.match(notice, new RegExp(`ref "${refId}"; trim_expand\\(\\{id\\}\\)`));
  assert.match(notice, /RECOVERABLE, not lost/);
});

test('pruned ephemeral output generates ref matching trim_expand schema pattern and round-trips cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trim-ref-e2e-'));
  const dbPath = join(dir, 'm.db');
  const project = '/proj/ref-e2e';
  const { ctx, tools } = makeMockCtx(dbPath, project);
  const stop = await setupMemory(ctx, parseOptions(ctx.options));
  const store = openMemoryStore({ dbPath, project });
  try {
    const expandTool = tools.get(EXPAND_TOOL_NAME);
    const pattern = new RegExp(expandTool.input.properties.id.pattern);
    const vault = {
      store(refId: string, entry: any, sessionID?: string): boolean {
        return store.saveVault({
          project,
          session_id: sessionID ?? null,
          ref_id: refId,
          tool: entry?.name ?? 'tool',
          target: String(entry?.input?.command ?? ''),
          text: entry?.original ?? '',
          tokens: Math.max(1, Math.ceil((entry?.length ?? 0) / 3)),
        }).saved;
      },
      has(refId: string): boolean {
        return store.hasVault(project, refId);
      },
    };
    const bigLog = Array.from({ length: 600 }, (_, i) => `log-line-${i + 1}: ok ` + 'x'.repeat(20)).join('\n');
    const pad = 'tail-context '.repeat(120);
    const messages: any[] = [
      { id: 'm1', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'shell', input: { command: 'git log -n 200 --oneline' } }] },
      { id: 'm2', role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'shell', result: { type: 'text', value: bigLog } }] },
      { id: 'm3', role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'shell', input: { command: 'git status' } }] },
      { id: 'm4', role: 'tool', content: [{ type: 'tool-result', id: 'c2', name: 'shell', result: { type: 'text', value: pad } }] },
      { id: 'm5', role: 'user', content: [{ type: 'text', text: pad }] },
      { id: 'm6', role: 'assistant', content: [{ type: 'text', text: pad }] },
    ];
    const opts = parseOptions({
      pruneAfterToolChars: 10000,
      protectRecentMessages: 4,
      protectRecentTokens: 1024,
      keepRecentToolResults: 1,
      prunePreviewLines: 0,
    });
    const res = pruneContext({ sessionID: 's1', messages }, opts, {
      vault,
      allowNewDrops: true,
      pressure: { ratio: 0.85, usableTokens: 20_000 },
    });
    assert.ok(res.pruned >= 1, 'ephemeral shell output should be pruned');
    const stub = messages[1].content[0].result.value;
    const match = stub.match(/ref "(trm_[0-9a-f]{32})"; trim_expand\(\{id\}\)/);
    assert.ok(match, `stub must contain 32-hex ref with trim_expand({id}) hint, got: ${stub}`);
    assert.equal(pattern.test(match[1]), true, 'generated ref must satisfy JSON schema pattern');

    const expanded = await expandTool.execute(
      { id: match[1], startLine: 1, endLine: 2 },
      { signal: new AbortController().signal, sessionID: 's1' },
    );
    assert.equal(expanded.output.found, true);
    assert.match(expanded.content, /1: log-line-1: ok/);
    assert.match(expanded.content, /2: log-line-2: ok/);
  } finally {
    store.close();
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
