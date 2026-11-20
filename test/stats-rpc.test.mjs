import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TRIM_STATS_RPC, TRIM_STATS_RPC_ID, SNAPSHOT_VERSION } from '../src/stats-rpc.js';
import { createTrimStats } from '../src/stats.js';
import { parseOptions } from '../src/config.js';

test('RPC definition: id, snapshot method, changed event', () => {
  assert.equal(TRIM_STATS_RPC.id, 'opencode-trim-stats');
  assert.equal(TRIM_STATS_RPC_ID, 'opencode-trim-stats');
  assert.equal(SNAPSHOT_VERSION, 1);
  assert.deepEqual(TRIM_STATS_RPC.methods.snapshot.input, {
    type: 'object', properties: { sessionID: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['sessionID'], additionalProperties: false,
  });
  assert.equal(TRIM_STATS_RPC.methods.snapshot.output.type, 'object');
  assert.deepEqual(TRIM_STATS_RPC.events.changed.schema, {
    type: 'object', properties: { sessionID: { type: 'string' }, revision: { type: 'number' } }, required: ['sessionID', 'revision'], additionalProperties: false,
  });
  assert.deepEqual(Object.keys(TRIM_STATS_RPC.methods), ['snapshot']);
  assert.deepEqual(Object.keys(TRIM_STATS_RPC.events), ['changed']);
});

test('definition is plain JSON (round-trips) and imports nothing from @opencode', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(TRIM_STATS_RPC)), TRIM_STATS_RPC);
  const src = readFileSync(new URL('../src/stats-rpc.js', import.meta.url), 'utf8');
  assert.ok(!/^\s*import\b/m.test(src), 'no imports at all');
  assert.ok(!/@opencode/.test(src.replace(/\/\/.*$/gm, '')));
});

test('snapshot output is a JSON-safe object round-tripping through the RPC boundary', () => {
  const stats = createTrimStats({ options: parseOptions(), emit: () => {} });
  stats.recordTool({ sessionID: 's', kind: 'shell', changed: true, savedChars: 12 });
  const out = stats.snapshot('s');
  assert.equal(typeof out, 'object');
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
  assert.deepEqual(Object.keys(out), ['version', 'now', 'sessionID', 'since', 'revision', 'engine', 'context', 'shell', 'filtering', 'pruning', 'cache', 'compaction', 'memory']);
  assert.deepEqual(Object.keys(out.compaction), ['known', 'running', 'autoEvents', 'manualEvents', 'failedEvents', 'lastAt', 'lastReason', 'beforeTokens', 'afterTokens', 'reducedTokens', 'beforeChars', 'afterChars', 'reducedChars', 'reducedRatio']);
  assert.deepEqual(Object.keys(out.memory), ['enabled', 'active', 'error', 'summaries', 'searches', 'searchResults', 'lastSummaryAt', 'dbBytes']);
  stats.dispose();
});
