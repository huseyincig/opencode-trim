import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTION_NAMES, normalizeSection, parseSections, sectionSnippet } from '../src/memory-sections.js';
import { openMemoryStore } from '../src/memory-store.js';

const body = (text, name) => { const r = parseSections(text).get(name); return r && text.slice(r.start, r.end).trim(); };

const FULL = `## Objective
obj text
## Requirements
req text
## Decisions
dec text
## Work State
work text
## Next Move
next text
## Relevant Files
files text
## Important Context
ctx text
`;

test('SECTION_NAMES is the seven canonical names', () => {
  assert.deepEqual([...SECTION_NAMES], ['objective', 'requirements', 'decisions', 'work_state', 'next_move', 'relevant_files', 'important_context']);
});

test('normalizeSection: canonical, aliases, invalid', () => {
  for (const n of SECTION_NAMES) assert.equal(normalizeSection(n), n);
  assert.equal(normalizeSection('Work State'), 'work_state');
  assert.equal(normalizeSection('next-move'), 'next_move');
  assert.equal(normalizeSection('RELEVANT FILES'), 'relevant_files');
  assert.equal(normalizeSection('  Decisions '), 'decisions');
  for (const bad of ['', 'bogus', 'work state!', null, undefined, 5, {}]) assert.equal(normalizeSection(bad), null);
});

test('parseSections: all seven headings', () => {
  const m = parseSections(FULL);
  assert.deepEqual([...m.keys()], [...SECTION_NAMES]);
  assert.equal(body(FULL, 'objective'), 'obj text');
  assert.equal(body(FULL, 'important_context'), 'ctx text');
  assert.equal(body(FULL, 'work_state'), 'work text');
});

test('parseSections: colon, case, spacing, numbering', () => {
  const t = '##   OBJECTIVE:  \nA\n## 1. requirements\nB\n## 2 Decisions\nC\n## 4) work state:\nD\n## Next Move ##\nE\n';
  assert.equal(body(t, 'objective'), 'A');
  assert.equal(body(t, 'requirements'), 'B');
  assert.equal(body(t, 'work_state'), 'D');
  assert.equal(body(t, 'next_move'), 'E');
  assert.equal(parseSections('##Objective\nx').size, 0, 'no space after ## is not a heading');
});

test('parseSections: nested ### stays inside current section', () => {
  const t = '## Work State\nintro\n### Sub\nnested detail\n## Next Move\nnext\n';
  assert.match(body(t, 'work_state'), /nested detail/);
  assert.match(body(t, 'work_state'), /### Sub/);
  assert.equal(body(t, 'next_move'), 'next');
});

test('parseSections: ## inside fenced code is ignored (``` and ~~~)', () => {
  const t = '## Decisions\nuse x\n```md\n## Objective\nfake\n```\nmore\n~~~\n## Requirements\nfake2\n~~~\n## Next Move\nreal\n';
  const m = parseSections(t);
  assert.deepEqual([...m.keys()], ['decisions', 'next_move']);
  assert.match(body(t, 'decisions'), /fake2/);
  assert.match(body(t, 'decisions'), /more/);
});

test('parseSections: CRLF', () => {
  const t = FULL.replace(/\n/g, '\r\n');
  assert.deepEqual([...parseSections(t).keys()], [...SECTION_NAMES]);
  assert.equal(body(t, 'decisions'), 'dec text');
});

test('parseSections: unknown headings do not erase or break known ones', () => {
  const t = '## Objective\nA\n## Random Stuff\nignored\n## Decisions\nB\n';
  assert.deepEqual([...parseSections(t).keys()], ['objective', 'decisions']);
  assert.equal(body(t, 'objective'), 'A');
  assert.equal(body(t, 'decisions'), 'B');
});

test('parseSections: empty / missing headings / non-string', () => {
  assert.equal(parseSections('').size, 0);
  assert.equal(parseSections('just text\n# Objective\n').size, 0);
  assert.equal(parseSections(null).size, 0);
  assert.equal(parseSections(undefined).size, 0);
  const t = '## Objective\n## Decisions\nx';
  assert.equal(body(t, 'objective'), '');
  assert.equal(body(t, 'decisions'), 'x');
});

test('sectionSnippet: bounded, from section, around token or start', () => {
  const t = `## Objective\nobjective alpha\n## Decisions\n${'a '.repeat(300)}needle ${'b '.repeat(300)}\n## Next Move\nzzz`;
  const s = sectionSnippet(t, 'decisions', 'needle', 100);
  assert.ok(s.length <= 100);
  assert.match(s, /needle/);
  assert.ok(!/alpha|zzz/.test(s));
  const start = sectionSnippet(t, 'Decisions', 'absent', 40);
  assert.equal(start, ('a '.repeat(300)).slice(0, 40));
  assert.equal(sectionSnippet(t, 'objective', 'x', 1000), 'objective alpha');
  assert.equal(sectionSnippet(t, 'work_state', 'x', 100), '');
  assert.equal(sectionSnippet(t, 'decisions', 'x', 0), '');
});

// ---- store ----
const P = '/proj/a';
const NOW = 1_700_000_000_000;
function mk() { return openMemoryStore({ dbPath: ':memory:' }); }
function add(s, id, text, project = P, at = NOW) { s.archive({ event_id: id, project, session_id: 's-' + id, created_at: at, text }); }
const doc = (o) => `## Objective\n${o.obj ?? 'o'}\n## Decisions\n${o.dec ?? 'd'}\n## Work State\n${o.work ?? 'w'}\n`;

test('store: query-only is unchanged (no section field)', () => {
  const s = mk();
  add(s, 'e1', doc({ dec: 'use sqlite', obj: 'goal' }));
  const r = s.search({ project: P, query: 'sqlite', now: NOW });
  assert.equal(r.length, 1);
  assert.ok(!('section' in r[0]));
  assert.equal(r[0].snippet, doc({ dec: 'use sqlite', obj: 'goal' }).trim());
  s.close();
});

test('store: section filter keeps only rows whose section has all tokens', () => {
  const s = mk();
  add(s, 'both', doc({ dec: 'adopt sqlite fts5', work: 'nothing' }));
  add(s, 'split', doc({ dec: 'adopt sqlite', work: 'fts5 tuning' }));
  add(s, 'other', doc({ obj: 'sqlite fts5', dec: 'none' }));
  const r = s.search({ project: P, query: 'SQLite fts5', section: 'Decisions', now: NOW });
  assert.deepEqual(r.map(x => x.event_id), ['both']);
  assert.equal(r[0].section, 'decisions');
  assert.match(r[0].snippet, /adopt sqlite fts5/);
  assert.ok(!/nothing|goal/.test(r[0].snippet));
  const w = s.search({ project: P, query: 'fts5', section: 'work-state', now: NOW });
  assert.deepEqual(w.map(x => x.event_id), ['split']);
  s.close();
});

test('store: heading-only and label queries match the requested section', () => {
  const s = mk();
  add(s, 'e1', '## Objective\ngoal\n## Decisions\nuse sqlite\n## Next Move\nwrite docs\n');
  const d = s.search({ project: P, query: 'decisions', section: 'decisions', now: NOW });
  assert.equal(d.length, 1);
  assert.equal(d[0].section, 'decisions');
  assert.match(d[0].snippet, /use sqlite/);
  const n = s.search({ project: P, query: 'next move', section: 'next_move', now: NOW });
  assert.equal(n.length, 1);
  assert.equal(n[0].section, 'next_move');
  assert.match(n[0].snippet, /write docs/);
  assert.equal(s.search({ project: P, query: 'next move docs', section: 'Next-Move', now: NOW }).length, 1);
  // content query still works; label of another section does not leak in
  assert.equal(s.search({ project: P, query: 'sqlite', section: 'decisions', now: NOW })[0].section, 'decisions');
  assert.equal(s.search({ project: P, query: 'sqlite', section: 'next_move', now: NOW }).length, 0);
  // no section: unchanged, no section field
  const plain = s.search({ project: P, query: 'decisions', now: NOW });
  assert.equal(plain.length, 1);
  assert.ok(!('section' in plain[0]));
  s.close();
});

test('store: section-only term is not found by other sections', () => {
  const s = mk();
  add(s, 'e1', doc({ dec: 'zebra', obj: 'plain' }));
  assert.equal(s.search({ project: P, query: 'zebra', section: 'objective', now: NOW }).length, 0);
  assert.equal(s.search({ project: P, query: 'zebra', section: 'decisions', now: NOW }).length, 1);
  s.close();
});

test('store: section snippet bounded and from the section', () => {
  const s = mk();
  add(s, 'e1', `## Objective\nneedle in objective\n## Decisions\n${'x '.repeat(400)}needle ${'y '.repeat(400)}\n`);
  const r = s.search({ project: P, query: 'needle', section: 'decisions', maxSnippetChars: 80, now: NOW });
  assert.equal(r.length, 1);
  assert.ok(r[0].snippet.length <= 80);
  assert.match(r[0].snippet, /needle/);
  assert.ok(!/objective/.test(r[0].snippet));
  s.close();
});

test('store: legacy text without headings falls back to full text, section null', () => {
  const s = mk();
  add(s, 'old', 'We chose sqlite long ago');
  const r = s.search({ project: P, query: 'sqlite', section: 'decisions', now: NOW });
  assert.equal(r.length, 1);
  assert.equal(r[0].section, null);
  assert.equal(r[0].snippet, 'We chose sqlite long ago');
  s.close();
});

test('store: headings present but requested section missing falls back, section null', () => {
  const s = mk();
  add(s, 'e1', '## Objective\nsqlite goal\n');
  const r = s.search({ project: P, query: 'sqlite', section: 'decisions', now: NOW });
  assert.equal(r.length, 1);
  assert.equal(r[0].section, null);
  s.close();
});

test('store: stored text is not mutated; project isolation; ordering preserved', () => {
  const s = mk();
  add(s, 'a', doc({ dec: 'kiwi' }), P, NOW - 1000);
  add(s, 'b', doc({ dec: 'kiwi' }), P, NOW);
  add(s, 'c', doc({ dec: 'kiwi' }), '/proj/other', NOW);
  const r = s.search({ project: P, query: 'kiwi', section: 'decisions', now: NOW });
  assert.deepEqual(r.map(x => x.event_id), ['b', 'a']);
  const plain = s.search({ project: P, query: 'kiwi', now: NOW });
  assert.equal(plain[0].snippet, doc({ dec: 'kiwi' }).trim());
  s.close();
});

test('store: invalid section throws TypeError; null/undefined means none', () => {
  const s = mk();
  add(s, 'e1', doc({ dec: 'kiwi' }));
  assert.throws(() => s.search({ project: P, query: 'kiwi', section: 'bogus' }), TypeError);
  assert.throws(() => s.search({ project: P, query: 'kiwi', section: '' }), TypeError);
  assert.throws(() => s.search({ project: P, query: 'kiwi', section: 5 }), TypeError);
  assert.equal(s.search({ project: P, query: 'kiwi', section: null, now: NOW }).length, 1);
  s.close();
});

test('store: FTS operator query is treated literally with section', () => {
  const s = mk();
  add(s, 'e1', doc({ dec: 'alpha beta' }));
  for (const q of ['alpha OR beta', 'alpha AND NOT beta', '"alpha" NEAR beta', 'alp*', 'dec: alpha', '(((']) {
    assert.doesNotThrow(() => s.search({ project: P, query: q, section: 'decisions', now: NOW }), q);
  }
  assert.equal(s.search({ project: P, query: 'alpha NOT beta', section: 'decisions', now: NOW }).length, 0);
  assert.equal(s.search({ project: P, query: 'alpha beta', section: 'decisions', now: NOW }).length, 1);
  s.close();
});
