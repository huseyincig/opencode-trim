import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions } from '../src/config.ts';
import { processToolEvent } from '../src/plugin.ts';
import { hasTestSummary } from '../src/families/util.ts';

const passingRun = [...Array.from({ length: 200 }, (_, i) => ` ✓ src/t_${i}.test.ts (1 test)`), 'Test Files 200 passed (200)'].join('\n');
const shellEvent = (result) => ({ tool: 'shell', status: 'completed', input: { command: 'vitest run' }, result });

test('contradictory bounds are rejected', () => {
  assert.throws(() => parseOptions({ minOutputChars: 20000, maxOutputChars: 2000, maxInputScanChars: 10000 }), /minOutputChars/);
  assert.throws(() => parseOptions({ minOutputChars: 20000, maxOutputChars: 10000, maxInputScanChars: 10000 }), /minOutputChars/);
  assert.throws(() => parseOptions({ minOutputChars: 5000, maxOutputChars: 2000, maxInputScanChars: 2000000 }), /minOutputChars/);
});

test('string shell result: exit 1 keeps notice or stays raw; exit 0 compresses', () => {
  assert.equal(processToolEvent(shellEvent({ content: passingRun, output: { exitCode: 0 } }), parseOptions()), true);
  const e = shellEvent({ content: passingRun, output: { exitCode: 1 } });
  processToolEvent(e, parseOptions());
  assert.ok(e.result.content === passingRun || /exit|fail/i.test(e.result.content));
  const n = shellEvent({ content: `${passingRun}\nExit code: 1`, output: { exitCode: 1 } });
  processToolEvent(n, parseOptions());
  assert.match(n.result.content, /Exit code: 1/);
});

test('nonzero exit wins in either metadata/output field order', () => {
  const a = shellEvent({ content: passingRun, metadata: { exit: 0 }, output: { exitCode: 1 } });
  const b = shellEvent({ content: passingRun, output: { exitCode: 0 }, metadata: { exit: 1 } });
  const c = shellEvent({ content: passingRun, output: { exitCode: 1 }, metadata: { exit: 0 } });
  assert.equal(processToolEvent(a, parseOptions()), false);
  assert.equal(processToolEvent(b, parseOptions()), false);
  assert.equal(processToolEvent(c, parseOptions()), false);
});

test('hasTestSummary is line-anchored', () => {
  assert.equal(hasTestSummary('✓ keeps 3 passed rows'), false);
  assert.equal(hasTestSummary('noise\n5 passed in 1.2s'), true);
  assert.equal(hasTestSummary('Test Files 2 passed (2)'), true);
});
