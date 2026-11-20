/**
 * Conservative test-runner output-shape compressor.
 * Only positive evidence that a report is a completed test run permits
 * dropping individual passing-test progress rows. Diagnostics never match.
 */
import { FAILURE, WARNING, STACK, CODE, MAX_LINE } from './diagnostics.js';
// isDiagnosticLine minus ANCHOR: a bare file:line on a recognized passing row is not a diagnostic.
const isDiagnosticLine = (line) => { const l = line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line; return FAILURE.test(l) || WARNING.test(l) || STACK.test(l) || CODE.test(l); };
const TEST_SUMMARY = /(?:^|\n)\s*(?:Test Files\s+\d+|Test Suites:\s+\d+|Tests:\s+\d+|={2,}\s*\d+\s+(?:passed|failed|errors?|skipped)\b|(?:Ran\s+\d+\s+tests?\s+in\s+\d)|(?:\d+\s+passed(?:,\s*\d+\s+failed)?\b))/im;
const TEST_SIGNATURE = /(?:\b(?:vitest|jest|pytest|go\s+test|cargo\s+test)\b|\b(?:npm|pnpm|bun|yarn)\s+(?:run\s+)?test\b)/i;
const DIAGNOSTIC = /(?:\b(?:failed|failure|error|fatal|panic|exception|warning|warn|assert|traceback|denied|timeout|timed out)\b|\bTS\d{4}\b|(?:^|\s)[✗✘✖✕❌]|^\s*×(?=\s)|\bat\s+\S[^\n]{0,300}?:\d+|\b(?:FAIL|ERROR)\b)/i;
const PASSES = [
  /^\s*(?:✓|✔|√)\s+\S.*(?:\(\d+\s+tests?\))?\s*$/u,
  /^\s*PASS\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?\s*$/,
  /^\s*test\s+[^\n]{1,250}\s+\.\.\.\s+ok\s*$/i,
  /^\s*ok\s+\S+\/\S+\s+[\d.]+s\s*$/,
  /^\s*\.{10,}\s*(?:\[\s*\d+%\s*\])?\s*$/,
];
export function compressPassingTests(command, text) {
  if (typeof command !== 'string' || typeof text !== 'string') return {text,dropped:0};
  if (!TEST_SIGNATURE.test(command) || !TEST_SUMMARY.test(text)) return {text,dropped:0};
  const lines = text.split('\n');
  const kept=[];let dropped=0;
  for (const line of lines) {
    if (DIAGNOSTIC.test(line) || isDiagnosticLine(line) || TEST_SUMMARY.test(line)) {kept.push(line);continue;}
    if (PASSES.some(pattern => pattern.test(line))) {dropped++;continue;}
    kept.push(line);
  }
  if (!dropped || !kept.some(line=>TEST_SUMMARY.test(line))) return {text,dropped:0};
  return {text:`[${dropped} passing test progress lines omitted]\n${kept.join('\n')}`,dropped};
}
