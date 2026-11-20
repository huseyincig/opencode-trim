import test from 'node:test';
import assert from 'node:assert/strict';
import * as d from '../src/diagnostics.js';

test('failure vocabulary positives', () => {
  for (const l of ['Error: boom', 'build failed', 'FATAL: x', 'panic: nil', 'Traceback (most recent call last):', 'Segmentation fault',
    'Unhandled rejection', 'src/a.ts(1,2): error TS2304: x', 'E404 not found', 'FAIL src/a.test.js', '✗ case', '✘ a', '✖ a', '✕ a', '× a', '❌ a',
    'operation timed out', 'process killed', 'cancelled', 'canceled', 'terminated', 'Permission denied', 'access denied', 'CVE-2024-12345', 'critical vulnerability'])
    assert.ok(d.FAILURE.test(l), l);
});

test('ordinary prose and names are not failures', () => {
  for (const l of ['export function errorHandler() {}', 'const failedCount = 0', 'the quick brown fox', 'PASS src/a.test.js', 'PASS src/a.test.js', 'ok 1 - handles errors', 'terminology', 'Elapsed 12ms'])
    assert.equal(d.FAILURE.test(l), false, l);
  assert.equal(d.hasFailureText('all good\nfine\n'), false);
});

test('codes: ruff, tsc', () => {
  assert.ok(d.CODE.test('a.py:1:8: F401 `os` imported but unused'));
  assert.ok(d.CODE.test('a.ts(1,1): error TS1234: bad'));
  assert.ok(d.isDiagnosticLine('a.py:1:8: F401 `os` imported'));
  assert.ok(d.isDiagnosticLine('x W123 thing'));
  assert.equal(d.CODE.test('hello TS12 world'), false);
});

test('anchors and stacks', () => {
  assert.ok(d.ANCHOR.test('src/a/b.js:10:5'));
  assert.ok(d.ANCHOR.test('src\\a\\b.js:10'));
  assert.equal(d.ANCHOR.test('http:80'), false);
  assert.equal(d.ANCHOR.test('file.js:10'), false);
  assert.ok(d.STACK.test('    at foo (/x/y.js:1:2)'));
  assert.ok(d.STACK.test('  File "a.py", line 3, in f'));
  assert.ok(d.STACK.test('Caused by: java.io.IOException'));
  assert.equal(d.STACK.test('we arrived at noon'), false);
});

test('summary vs test name', () => {
  for (const l of ['Tests:       2 failed, 3 passed', 'Test Suites: 1 passed', ' Test Files  1 passed', 'Ran 5 tests in 0.1s', '3 passing', '1 failing',
    '=== 2 failed, 1 passed in 0.5s ===', 'test result: ok. 3 passed', '# pass 4', 'Found 2 errors.', 'added 12 packages in 2s', 'Build succeeded'])
    assert.ok(d.SUMMARY.test(l), l);
  for (const l of ['it passed the smoke test', 'test_added 12 packages', '✓ should report 3 passing items', 'ok 1 - Tests: 3 passed'])
    assert.equal(d.SUMMARY.test(l), false, l);
  assert.ok(d.hasSummaryText('x\n3 passing\ny'));
  assert.equal(d.hasSummaryText('✓ test passed'), false);
});

test('important line', () => {
  assert.ok(d.isImportantLine('3 passing'));
  assert.ok(d.isImportantLine('deprecated api'));
  assert.equal(d.isImportantLine('just text'), false);
});

test('exit notices', () => {
  assert.ok(d.isExitNotice('out\nProcess exited with code 2'));
  assert.ok(d.isExitNotice('exit code: 1'));
  assert.equal(d.isExitNotice('no exit here'), false);
  assert.equal(d.parseExitCode('x\nProcess exited with code 137\n'), 137);
  assert.equal(d.parseExitCode('exit code: 3'), 3);
  assert.equal(d.parseExitCode('nothing'), null);
});

test('long-line safety', () => {
  const t = Date.now();
  const long = 'a/'.repeat(50000) + ':';
  for (const s of [long, 'x'.repeat(200000), ' '.repeat(200000), 'at ' + 'a:1'.repeat(50000), '='.repeat(100000), '1 '.repeat(100000)]) {
    d.isImportantLine(s); d.hasFailureText(s); d.hasSummaryText(s); d.isExitNotice(s); d.parseExitCode(s);
  }
  assert.ok(Date.now() - t < 2000);
});

test('timeout/killed text', () => {
  assert.ok(d.hasFailureText('ok\nCommand timed out after 30s'));
  assert.ok(d.hasFailureText('Killed'));
});
