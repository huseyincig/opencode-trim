import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { openMemoryStore, redactSecrets, buildMatchQuery, SCAN_MAX_ROWS, SCAN_MAX_CHARS } from '../src/memory-store.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'trim-mem-'));
  return { dir, path: join(dir, 'sub', 'mem.db'), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const rec = (o = {}) => ({
  event_id: 'e1', project: 'p', session_id: 's1', model: 'm', reason: 'compaction',
  created_at: Date.now(), text: 'the quick brown fox jumps', tokens_json: [1, 2],
  context_before_tokens: 100, context_after_tokens: 40, ...o,
});

test('insert, search, fields, perms', () => {
  const t = tmp();
  const s = openMemoryStore({ dbPath: t.path });
  assert.equal(s.archive(rec()).inserted, true);
  const r = s.search({ project: 'p', query: 'brown fox' });
  assert.equal(r.length, 1);
  assert.equal(r[0].session_id, 's1');
  assert.match(r[0].date, /^\d{4}-\d\d-\d\dT/);
  assert.match(r[0].snippet, /quick brown/);
  s.close();
  assert.equal(statSync(t.path).mode & 0o777, 0o600);
  assert.equal(statSync(join(t.dir, 'sub')).mode & 0o777, 0o700);
  const raw = new DatabaseSync(t.path);
  assert.equal(raw.prepare('SELECT tokens_json t, context_after_tokens c FROM history').get().t, '[1,2]');
  raw.close();
  t.done();
});

test('project isolation', () => {
  const s = openMemoryStore({ dbPath: ':memory:' });
  s.archive(rec({ event_id: 'a', project: 'A', text: 'shared needle A' }));
  s.archive(rec({ event_id: 'b', project: 'B', text: 'shared needle B' }));
  assert.deepEqual(s.search({ project: 'A', query: 'needle' }).map((x) => x.event_id), ['a']);
  assert.deepEqual(s.search({ project: 'C', query: 'needle' }), []);
  assert.deepEqual(s.search({ query: 'needle' }), []);
  s.close();
});

test('event_id dedupe', () => {
  const s = openMemoryStore({ dbPath: ':memory:' });
  assert.equal(s.archive(rec()).inserted, true);
  assert.equal(s.archive(rec({ text: 'different words' })).inserted, false);
  assert.equal(s.search({ project: 'p', query: 'different' }).length, 0);
  assert.equal(s.search({ project: 'p', query: 'quick' }).length, 1);
  s.close();
});

test('retention prune and search cutoff', () => {
  const now = Date.now();
  const s = openMemoryStore({ dbPath: ':memory:', retentionDays: 10 });
  s.archive(rec({ event_id: 'old', text: 'ancient relic', created_at: now - 11 * 86400000 }));
  s.archive(rec({ event_id: 'new', text: 'fresh relic', created_at: now - 86400000 }));
  assert.deepEqual(s.search({ project: 'p', query: 'relic' }).map((x) => x.event_id), ['new']);
  assert.equal(s.prune(now).deleted, 0, 'missing project never deletes');
  assert.equal(s.prune('', now).deleted, 0);
  assert.equal(s.prune('other', now).deleted, 0);
  assert.equal(s.prune('p', now).deleted, 1);
  assert.equal(s.prune('p', now).deleted, 0);
  assert.equal(s.search({ project: 'p', query: 'ancient' }).length, 0);
  assert.equal(s.search({ project: 'p', query: 'fresh' }).length, 1);
  s.close();
});

test('redaction', () => {
  const samples = [
    'key sk-abcdefghijklmnopqrstuvwx1234',
    'Authorization: Bearer abcdef1234567890XYZ',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
    'API_KEY=supersecretvalue',
    'export DB_URL=postgres://u:hunter2pw@host/db',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAABCDEFGHIJKLMNOP',
    '{"password": "hunter2"}',
  ];
  for (const x of samples) {
    const out = redactSecrets(x);
    assert.match(out, /\[REDACTED\]/, x);
    assert.doesNotMatch(out, /abcdefghijklmnop|supersecret|MIIabc|hunter2|abcdef1234567890/, out);
  }
  assert.equal(redactSecrets('plain text stays'), 'plain text stays');
  const s = openMemoryStore({ dbPath: ':memory:' });
  s.archive(rec({ text: 'note TOKEN=abc123secret done' }));
  const r = s.search({ project: 'p', query: 'abc123secret' });
  assert.equal(r.length, 0);
  assert.match(s.search({ project: 'p', query: 'note done' })[0].snippet, /\[REDACTED\]/);
  s.close();
});

test('empty / redaction-empty text rejected', () => {
  const s = openMemoryStore({ dbPath: ':memory:' });
  assert.throws(() => s.archive(rec({ text: '   ' })), /empty/);
  assert.throws(() => s.archive(rec({ text: 'API_KEY=abcdefgh' })), /empty/);
  assert.throws(() => s.archive(rec({ text: undefined })), /text/);
  assert.throws(() => s.archive(rec({ event_id: '' })), /event_id/);
  s.close();
});

test('invalid and FTS-operator queries are safe', () => {
  const s = openMemoryStore({ dbPath: ':memory:' });
  s.archive(rec({ text: 'alpha beta gamma NOT delta' }));
  for (const q of ['', '   ', '"', '***', 'AND', '(', 'alpha OR', 'a:b', 'text:alpha', '^alpha', 'alpha*', null, undefined, 42]) {
    assert.doesNotThrow(() => s.search({ project: 'p', query: q }), String(q));
  }
  assert.deepEqual(s.search({ project: 'p', query: '"' }), []);
  // operators treated as literal words: NOT is a plain term, AND semantics over tokens
  assert.equal(s.search({ project: 'p', query: 'alpha NOT delta' }).length, 1);
  assert.equal(s.search({ project: 'p', query: 'alpha NOT zeta' }).length, 0);
  assert.equal(s.search({ project: 'p', query: 'alph*' }).length, 0);
  assert.equal(buildMatchQuery('a" OR "b'), '"a" "OR" "b"');
  s.close();
});

test('snippet, date and result limits', () => {
  const s = openMemoryStore({ dbPath: ':memory:', maxResults: 3, maxSnippetChars: 50 });
  const long = 'x '.repeat(200) + 'needle ' + 'y '.repeat(200);
  for (let i = 0; i < 6; i++) s.archive(rec({ event_id: `e${i}`, text: long + i }));
  const r = s.search({ project: 'p', query: 'needle', limit: 100, maxSnippetChars: 5000 });
  assert.equal(r.length, 3);
  for (const x of r) {
    assert.ok(x.snippet.length <= 50);
    assert.match(x.snippet, /needle/);
  }
  assert.equal(s.search({ project: 'p', query: 'needle', limit: 2 }).length, 2);
  s.close();
});

test('bm25 ordering prefers better match', () => {
  const s = openMemoryStore({ dbPath: ':memory:' });
  s.archive(rec({ event_id: 'weak', text: 'zebra ' + 'filler '.repeat(50) }));
  s.archive(rec({ event_id: 'strong', text: 'zebra zebra zebra' }));
  assert.equal(s.search({ project: 'p', query: 'zebra' })[0].event_id, 'strong');
  s.close();
});

test('updateContextAfter updates only the matching row; FTS intact', () => {
  const t = tmp();
  const s = openMemoryStore({ dbPath: t.path });
  s.archive(rec({ event_id: 'a', context_after_tokens: null }));
  s.archive(rec({ event_id: 'b', text: 'second note about zebras', context_after_tokens: null }));
  assert.deepEqual(s.updateContextAfter('p', 'b', 123.9), { updated: true });
  assert.deepEqual(s.updateContextAfter('p', 'nope', 5), { updated: false });
  assert.equal(s.search({ project: 'p', query: 'zebras' }).length, 1);
  assert.equal(s.search({ project: 'p', query: 'fox' }).length, 1);
  s.close();
  const raw = new DatabaseSync(t.path);
  const m = Object.fromEntries(raw.prepare('SELECT event_id e, context_after_tokens c FROM history').all().map(r => [r.e, r.c]));
  raw.close();
  assert.deepEqual(m, { a: null, b: 123 });
  t.done();
});

test('updateContextAfter ignores invalid tokens', () => {
  const t = tmp();
  const s = openMemoryStore({ dbPath: t.path });
  s.archive(rec({ event_id: 'a', context_after_tokens: 40 }));
  for (const bad of [undefined, null, NaN, Infinity, -1, 'abc', '', {}, true]) {
    assert.deepEqual(s.updateContextAfter('p', 'a', bad), { updated: false }, String(bad));
  }
  assert.deepEqual(s.updateContextAfter('p', undefined, 5), { updated: false });
  assert.deepEqual(s.updateContextAfter(undefined, 'a', 5), { updated: false });
  s.close();
  const raw = new DatabaseSync(t.path);
  assert.equal(raw.prepare('SELECT context_after_tokens c FROM history').get().c, 40);
  raw.close();
  t.done();
});

test('nested structured secrets are fully redacted', () => {
  const cases = [
    ['{"password": {"value": "s3cr3t", "n": {"x": 1}}, "ok": 1}', /s3cr3t/, '{"password": [REDACTED], "ok": 1}'],
    ['{"api_key": ["aaa-111", {"b": "bbb-222"}], "ok": 1}', /aaa-111|bbb-222/, '{"api_key": [REDACTED], "ok": 1}'],
    ['{"secret": "he said \\"pa55word\\" loudly", "ok": 1}', /pa55word|loudly/, '{"secret": [REDACTED], "ok": 1}'],
    ["{'token': 'a\\'b-leak'}", /leak/, "{'token': [REDACTED]}"],
    ['{"token": 12345}', /12345/, '{"token": [REDACTED]}'],
    ['credential: {"user": "bob", "pw": "zzz999"} end', /zzz999|bob/, 'credential: [REDACTED] end'],
  ];
  for (const [input, leak, expected] of cases) {
    const out = redactSecrets(input);
    assert.doesNotMatch(out, leak, out);
    assert.equal(out, expected);
  }
  assert.equal(redactSecrets('{"token": [REDACTED]}'), '{"token": [REDACTED]}');
  assert.equal(redactSecrets('{"name": "plain", "list": [1, 2]}'), '{"name": "plain", "list": [1, 2]}');
  assert.doesNotThrow(() => redactSecrets('{"password": {"a": ' + '['.repeat(5000)));
  assert.doesNotMatch(redactSecrets('{"password": {"a": "unterminated-leak'), /unterminated-leak/);
});

function storedText(text, event_id = 'x') {
  const t = tmp();
  const s = openMemoryStore({ dbPath: t.path });
  s.archive(rec({ event_id, text }));
  s.close();
  const raw = new DatabaseSync(t.path);
  const stored = raw.prepare('SELECT text FROM history').get().text;
  const fts = (w) => raw.prepare('SELECT count(*) c FROM history_fts WHERE history_fts MATCH ?').get(w).c;
  const out = { stored, fts, done: () => { raw.close(); t.done(); } };
  return out;
}

test('structured redaction fails closed (window, depth, key cap, mismatch, unbalanced)', () => {
  const cases = {
    window: ['start note {"password": {"a": "' + 'x '.repeat(130000) + ' zqxwindowleak"}} tail', 'zqxwindowleak'],
    depth: ['start note {"password": ' + '['.repeat(33) + 'zqxdeepleak' + ']'.repeat(33) + '} tail', 'zqxdeepleak'],
    keys: ['start note ' + 'token: a1\n'.repeat(10_050) + 'password: zqxkeyleak', 'zqxkeyleak'],
    mismatch: ['start note {"secret": {"a": "v"] more zqxmismatchleak}', 'zqxmismatchleak'],
    unbalanced1m: ['start note {"password": {"a": "' + 'y'.repeat(900_000) + ' zqxbigleak', 'zqxbigleak'],
    unquoted: ['start note password: ' + 'u'.repeat(250_000) + 'zqxunquotedleak', 'zqxunquotedleak'],
    quoted: ['start note secret: "unclosed zqxquotedleak and more', 'zqxquotedleak'],
  };
  for (const [name, [text, leak]] of Object.entries(cases)) {
    const r = storedText(text);
    assert.ok(!r.stored.includes(leak), `${name}: leaked in text`);
    assert.equal(r.fts(leak), 0, `${name}: leaked in fts`);
    assert.ok(r.stored.startsWith('start note'), name);
    r.done();
  }
  // Normal, fully parsed values keep working and the suffix stays visible.
  const ok = storedText('start note {"password": {"a": [1, {"b": "z"}]}, "keep": "zqxvisible"} end');
  assert.match(ok.stored, /"keep": "zqxvisible"/);
  assert.ok(!ok.stored.includes('"b"'));
  ok.done();
});

test('existing marker followed by a suffix fails closed; exact markers unchanged', () => {
  const marker = '[RED' + 'ACTED]';
  for (const [key, sep] of [['pass' + 'word', ': '], ['tok' + 'en', '='], ['sec' + 'ret', ': '], ['author' + 'ization', '=']]) {
    const leak = `zqxmarker${key}`;
    const r = storedText(`start note ${key}${sep}${marker}${leak} and later zqxlater`);
    assert.ok(!r.stored.includes(leak), `${key}: text`);
    assert.ok(!r.stored.includes('zqxlater'), `${key}: fails closed to end`);
    assert.equal(r.fts(leak), 0, `${key}: fts`);
    r.done();
  }
  for (const tail of ['', ' next', ', next', '; next', '& next', '} next', '] next', ') next']) {
    const input = `start note pass${'word'}: ${marker}${tail}`;
    assert.equal(redactSecrets(input), input, JSON.stringify(tail));
  }
  const ok = redactSecrets('start note pass' + 'word: hunter2 and zqxsafe text');
  assert.ok(!ok.includes('hunter2') && ok.includes('zqxsafe'));
});

test('updateContextAfter never coerces objects', () => {
  const s = openMemoryStore({ dbPath: ':memory:' });
  s.archive(rec({ event_id: 'a', context_after_tokens: 40 }));
  let called = false;
  const hostile = { valueOf() { called = true; return 5; }, toString() { called = true; return '5'; } };
  assert.deepEqual(s.updateContextAfter('p', 'a', hostile), { updated: false });
  assert.deepEqual(s.updateContextAfter('p', 'a', [5]), { updated: false });
  assert.equal(called, false);
  assert.deepEqual(s.updateContextAfter('p', 'a', 77), { updated: true });
  s.close();
});

test('updateContextAfter is project scoped', () => {
  const s = openMemoryStore({ dbPath: ':memory:' });
  s.archive(rec({ event_id: 'x', project: 'A', context_after_tokens: 1 }));
  s.archive(rec({ event_id: 'x', project: 'B', context_after_tokens: 2 }));
  assert.deepEqual(s.updateContextAfter('C', 'x', 99), { updated: false });
  assert.deepEqual(s.updateContextAfter('A', 'x', 50), { updated: true });
  s.close();
});

test('same event_id in two projects creates two rows; dedupe stays per project', () => {
  const t = tmp();
  const s = openMemoryStore({ dbPath: t.path });
  assert.equal(s.archive(rec({ event_id: 'dup', project: 'A', text: 'alpha shared' })).inserted, true);
  assert.equal(s.archive(rec({ event_id: 'dup', project: 'B', text: 'beta shared' })).inserted, true);
  assert.equal(s.archive(rec({ event_id: 'dup', project: 'A', text: 'again' })).inserted, false);
  assert.deepEqual(s.search({ project: 'A', query: 'shared' }).map(x => x.event_id), ['dup']);
  assert.match(s.search({ project: 'B', query: 'shared' })[0].snippet, /beta/);
  s.close();
  const raw = new DatabaseSync(t.path);
  assert.equal(raw.prepare('SELECT count(*) c FROM history').get().c, 2);
  assert.match(raw.prepare("SELECT sql FROM sqlite_master WHERE name='history'").get().sql, /UNIQUE\s*\(\s*project\s*,\s*event_id\s*\)/i);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1);
  raw.close();
  t.done();
});

const LEGACY_SQL = `
  CREATE TABLE history (
    id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, project TEXT NOT NULL, session_id TEXT,
    model TEXT, reason TEXT, created_at INTEGER NOT NULL, text TEXT NOT NULL, tokens_json TEXT,
    context_before_tokens INTEGER, context_after_tokens INTEGER);
  CREATE INDEX history_project_created ON history(project, created_at);
  CREATE INDEX history_created ON history(created_at);
  CREATE VIRTUAL TABLE history_fts USING fts5(text, content='history', content_rowid='id', tokenize='unicode61');
  CREATE TRIGGER history_ai AFTER INSERT ON history BEGIN INSERT INTO history_fts(rowid, text) VALUES (new.id, new.text); END;
  CREATE TRIGGER history_ad AFTER DELETE ON history BEGIN INSERT INTO history_fts(history_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
  CREATE TRIGGER history_au AFTER UPDATE ON history BEGIN
    INSERT INTO history_fts(history_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO history_fts(rowid, text) VALUES (new.id, new.text); END;`;

function legacyDb(path) {
  const db = new DatabaseSync(path);
  db.exec(LEGACY_SQL);
  const ins = db.prepare('INSERT INTO history (id, event_id, project, session_id, model, reason, created_at, text, tokens_json, context_before_tokens, context_after_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const now = Date.now();
  ins.run(3, 'e-a', 'A', 's1', 'm', 'r', now - 2000, '## Decisions\nlegacy marmot decision\n', '[1]', 10, 5);
  ins.run(7, 'e-b', 'B', 's2', null, null, now - 1000, 'other project otter text', null, null, null);
  ins.run(9, 'e-c', 'A', 's1', 'm', 'r', now, 'newer marmot note', null, 1, 2);
  db.close();
}

test('migration: legacy global UNIQUE(event_id) -> UNIQUE(project,event_id), lossless and idempotent', () => {
  const t = tmp();
  mkdirSync(join(t.dir, 'sub'), { recursive: true });
  legacyDb(t.path);
  let s = openMemoryStore({ dbPath: t.path });
  assert.equal(s.search({ project: 'A', query: 'marmot' }).length, 2);
  assert.equal(s.search({ project: 'B', query: 'otter' }).length, 1);
  const sec = s.search({ project: 'A', query: 'marmot', section: 'decisions' });
  assert.match(sec.find(x => x.section === 'decisions').snippet, /legacy marmot decision/);
  assert.equal(s.archive(rec({ event_id: 'e-a', project: 'B', text: 'post migration cross project' })).inserted, true);
  assert.equal(s.archive(rec({ event_id: 'e-a', project: 'A', text: 'dup' })).inserted, false);
  s.close();
  const snapshot = () => {
    const raw = new DatabaseSync(t.path);
    const rows = raw.prepare('SELECT id, event_id, project, session_id, model, reason, created_at, text, tokens_json, context_before_tokens b, context_after_tokens a FROM history ORDER BY id').all().map(r => ({ ...r }));
    const meta = {
      v: raw.prepare('PRAGMA user_version').get().user_version,
      sql: raw.prepare("SELECT sql FROM sqlite_master WHERE name='history'").get().sql,
      objs: raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'history%' ORDER BY name").all().map(r => r.name),
      fts: raw.prepare("SELECT count(*) c FROM history_fts WHERE history_fts MATCH 'marmot'").get().c,
      legacy: raw.prepare("SELECT count(*) c FROM sqlite_master WHERE name='history_legacy'").get().c,
    };
    raw.close();
    return { rows: rows.map(r => ({ ...r })), meta };
  };
  const a = snapshot();
  assert.deepEqual(a.rows.slice(0, 3).map(r => [r.id, r.event_id, r.project]), [[3, 'e-a', 'A'], [7, 'e-b', 'B'], [9, 'e-c', 'A']]);
  assert.equal(a.rows[0].text, '## Decisions\nlegacy marmot decision\n');
  assert.equal(a.rows[0].tokens_json, '[1]');
  assert.equal(a.rows[0].b, 10);
  assert.equal(a.rows[0].a, 5);
  assert.equal(a.rows.length, 4);
  assert.equal(a.meta.v, 1);
  assert.match(a.meta.sql, /UNIQUE\s*\(\s*project\s*,\s*event_id\s*\)/i);
  assert.doesNotMatch(a.meta.sql, /event_id TEXT NOT NULL UNIQUE/i);
  assert.equal(a.meta.fts, 2);
  assert.equal(a.meta.legacy, 0);
  s = openMemoryStore({ dbPath: t.path }); // second open: no-op
  assert.equal(s.search({ project: 'A', query: 'marmot' }).length, 2);
  s.close();
  assert.deepEqual(snapshot(), a);
  t.done();
});

test('migration failure rolls back and leaves legacy data intact', () => {
  const t = tmp();
  mkdirSync(join(t.dir, 'sub'), { recursive: true });
  legacyDb(t.path);
  // A table already named history_legacy makes the RENAME step fail after triggers/FTS were dropped.
  const raw = new DatabaseSync(t.path);
  raw.exec('CREATE TABLE history_legacy (blocker INTEGER)');
  raw.close();
  assert.throws(() => openMemoryStore({ dbPath: t.path }));
  const check = new DatabaseSync(t.path);
  assert.equal(check.prepare('SELECT count(*) c FROM history').get().c, 3);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 0);
  assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE name='history_fts'").get());
  assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE name='history_ai'").get());
  assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE name='history_project_created'").get());
  check.close();
  t.done();
});

// ---- freshness ordering ----
const DAY = 86400000;
function fresh(rows) {
  const s = openMemoryStore({ dbPath: ':memory:' });
  for (const r of rows) s.archive(rec(r));
  return s;
}
const ids = (r) => r.map(x => x.event_id);

test('freshness: same session, equal hits => newer first', () => {
  const now = Date.now();
  const s = fresh([
    { event_id: 'old', session_id: 'S', text: 'zebra plan', created_at: now - 3 * DAY },
    { event_id: 'new', session_id: 'S', text: 'zebra plan', created_at: now - DAY },
  ]);
  assert.deepEqual(ids(s.search({ project: 'p', query: 'zebra' })), ['new', 'old']);
  assert.equal(s.search({ project: 'p', query: 'zebra' }).length, 2);
  s.close();
});

test('freshness: older record with strictly more literal term hits stays ahead; nothing deleted', () => {
  const now = Date.now();
  // FTS5 folds diacritics, so "café plan" matches the query "cafe plan" but contains only one literal term.
  const s = fresh([
    { event_id: 'old', session_id: 'S', text: 'cafe plan', created_at: now - 5 * DAY },
    { event_id: 'new', session_id: 'S', text: 'café plan', created_at: now - DAY },
  ]);
  const r = s.search({ project: 'p', query: 'cafe plan' });
  assert.deepEqual(ids(r), ['old', 'new']);
  assert.equal(s.search({ project: 'p', query: 'plan' }).length, 2);
  assert.deepEqual(ids(s.search({ project: 'p', query: 'plan' })), ['new', 'old']);
  s.close();
});

test('freshness: cross-session ties ordered by rank then recency; deterministic', () => {
  const now = Date.now();
  const s = fresh([
    { event_id: 'weak', session_id: 'A', text: 'zebra ' + 'filler '.repeat(50), created_at: now },
    { event_id: 'strong', session_id: 'B', text: 'zebra zebra zebra', created_at: now - 9 * DAY },
    { event_id: 'tie1', session_id: 'C', text: 'quokka alpha', created_at: now - 2 * DAY },
    { event_id: 'tie2', session_id: 'D', text: 'quokka alpha', created_at: now - DAY },
  ]);
  assert.deepEqual(ids(s.search({ project: 'p', query: 'zebra' })), ['strong', 'weak']);
  const q = ids(s.search({ project: 'p', query: 'quokka' }));
  assert.deepEqual(q, ['tie2', 'tie1']);
  assert.deepEqual(ids(s.search({ project: 'p', query: 'quokka' })), q);
  s.close();
});

test('freshness: no pairwise cycle (session grouping keeps a total order)', () => {
  const now = Date.now();
  const s = fresh([
    { event_id: 'a-old', session_id: 'A', text: 'zebra zebra zebra zebra', created_at: now - 3 * DAY },
    { event_id: 'a-new', session_id: 'A', text: 'zebra ' + 'pad '.repeat(80), created_at: now - DAY },
    { event_id: 'c', session_id: 'C', text: 'zebra zebra ' + 'pad '.repeat(20), created_at: now - 2 * DAY },
  ]);
  const order = ids(s.search({ project: 'p', query: 'zebra' }));
  assert.ok(order.indexOf('a-new') < order.indexOf('a-old'), order.join());
  assert.equal(order.length, 3);
  assert.deepEqual(ids(s.search({ project: 'p', query: 'zebra' })), order);
  s.close();
});

for (const [name, heading] of [['Work State', 'Work State'], ['Next Move', 'Next Move']]) {
  test(`freshness: ${name} section prefers newer same-session on equal hits`, () => {
    const now = Date.now();
    const doc = (x) => `## Objective\ngoal\n## ${heading}\n${x}\n`;
    const s = fresh([
      { event_id: 'old', session_id: 'S', text: doc('ship parser fix'), created_at: now - 4 * DAY },
      { event_id: 'new', session_id: 'S', text: doc('ship parser fix'), created_at: now - DAY },
      { event_id: 'elsewhere', session_id: 'S', text: `## Objective\nship parser fix\n## ${heading}\nnothing\n`, created_at: now },
    ]);
    const r = s.search({ project: 'p', query: 'parser fix', section: name });
    assert.deepEqual(ids(r), ['new', 'old']);
    assert.ok(r.every(x => x.section === name.toLowerCase().replace(' ', '_')));
    assert.equal(s.search({ project: 'p', query: 'parser fix' }).length, 3);
    s.close();
  });
}

test('tokens and metadata are bounded before coercion/redaction', () => {
  const t = tmp();
  const s = openMemoryStore({ dbPath: t.path });
  const cyc = { a: 1 }; cyc.self = cyc;
  let toJsonCalled = false;
  const getter = { get x() { toJsonCalled = true; return 1; } };
  const withToJson = { toJSON() { toJsonCalled = true; return 'x'; } };
  const wide = Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`k${i}`, i]));
  const deep = {}; let cur = deep; for (let i = 0; i < 20; i++) { cur.n = {}; cur = cur.n; }
  const hostile = { toString() { throw new Error('toString'); }, valueOf() { throw new Error('valueOf'); } };
  const cases = [
    ['multi-MB string', { tokens_json: 'a'.repeat(3_000_000) }, (v) => v.length <= 65536 && v.length > 0],
    ['large acyclic object', { tokens_json: { a: 'x'.repeat(100_000) } }, (v) => v === null],
    ['too many nodes', { tokens_json: wide }, (v) => v === null],
    ['too deep', { tokens_json: deep }, (v) => v === null],
    ['cyclic', { tokens_json: cyc }, (v) => v === null],
    ['getter', { tokens_json: getter }, (v) => v === null],
    ['toJSON', { tokens_json: withToJson }, (v) => v === null],
    ['function/symbol', { tokens_json: { f() {}, s: Symbol('x') } }, (v) => v === null],
    ['normal object', { tokens_json: { input: 5, cost: 0.1 } }, (v) => v === '{"input":5,"cost":0.1}'],
  ];
  cases.forEach(([name, extra, check], i) => {
    assert.doesNotThrow(() => s.archive(rec({ event_id: `t${i}`, text: `tok note ${i}`, ...extra })), name);
  });
  assert.equal(toJsonCalled, false, 'getters/toJSON never invoked');
  const metaBig = 'r'.repeat(5_000_000);
  assert.doesNotThrow(() => s.archive(rec({ event_id: 'meta', text: 'meta note', session_id: metaBig, model: metaBig, reason: metaBig })));
  assert.doesNotThrow(() => s.archive(rec({ event_id: 'hostile', text: 'hostile note', session_id: hostile, model: hostile, reason: hostile, context_before_tokens: hostile, context_after_tokens: hostile, created_at: hostile })));
  assert.doesNotThrow(() => s.archive(rec({ event_id: 'sym', text: 'sym note', model: Symbol('m'), reason: () => 1, session_id: [1, 2] })));
  assert.equal(s.search({ project: 'p', query: 'hostile' }).length, 1);
  s.close();
  const raw = new DatabaseSync(t.path);
  const get = (id) => raw.prepare('SELECT * FROM history WHERE event_id = ?').get(id);
  cases.forEach(([name, , check], i) => assert.ok(check(get(`t${i}`).tokens_json), name));
  const m = get('meta');
  assert.ok(m.session_id.length <= 256 && m.model.length <= 256 && m.reason.length <= 512);
  const h = get('hostile');
  assert.deepEqual([h.session_id, h.model, h.reason, h.context_before_tokens, h.context_after_tokens], [null, null, null, null, null]);
  assert.ok(Number.isFinite(h.created_at));
  const y = get('sym');
  assert.deepEqual([y.session_id, y.model, y.reason], [null, null, null]);
  raw.close();
  t.done();
});

test('oversized text rejected before redaction; 900k text stored', () => {
  const s = openMemoryStore({ dbPath: ':memory:' });
  assert.throws(() => s.archive(rec({ event_id: 'big', text: 'a'.repeat(1_000_001) })), TypeError);
  assert.equal(s.archive(rec({ event_id: 'ok', text: 'lorem ' + 'b'.repeat(900_000) })).inserted, true);
  s.close();
});

test('existing parent directory mode is kept; new directory is 0700; file 0600', () => {
  const t = tmp();
  const shared = join(t.dir, 'shared');
  mkdirSync(shared, { mode: 0o755 });
  chmodSync(shared, 0o755);
  const s = openMemoryStore({ dbPath: join(shared, 'm.db') });
  s.close();
  assert.equal(statSync(shared).mode & 0o777, 0o755);
  assert.equal(statSync(join(shared, 'm.db')).mode & 0o777, 0o600);
  const s2 = openMemoryStore({ dbPath: join(t.dir, 'fresh', 'm.db') });
  s2.close();
  assert.equal(statSync(join(t.dir, 'fresh')).mode & 0o777, 0o700);
  t.done();
});

test('expired rows are physically removed on open', () => {
  const t = tmp();
  const s = openMemoryStore({ dbPath: t.path, retentionDays: 90 });
  s.archive(rec({ event_id: 'old', text: 'ancient mammoth', created_at: Date.now() - 100 * 86400000 }));
  s.archive(rec({ event_id: 'new', text: 'recent otter' }));
  s.close();
  const s2 = openMemoryStore({ dbPath: t.path, retentionDays: 90, project: 'p' });
  s2.close();
  const raw = new DatabaseSync(t.path);
  assert.deepEqual(raw.prepare('SELECT event_id e FROM history').all().map(r => r.e), ['new']);
  assert.equal(raw.prepare("SELECT count(*) c FROM history_fts WHERE history_fts MATCH 'mammoth'").get().c, 0);
  assert.equal(raw.prepare("SELECT count(*) c FROM history_fts WHERE history_fts MATCH 'otter'").get().c, 1);
  raw.close();
  t.done();
});

test('retention is project scoped: open/prune never delete another project', () => {
  const t = tmp();
  mkdirSync(join(t.dir, 'sub'), { recursive: true });
  const now = Date.now();
  const seed = openMemoryStore({ dbPath: t.path, retentionDays: 36500 });
  seed.archive(rec({ event_id: 'a-old', project: 'A', text: 'relic aold', created_at: now - 5 * 86400000 }));
  seed.archive(rec({ event_id: 'a-new', project: 'A', text: 'relic anew', created_at: now }));
  seed.archive(rec({ event_id: 'b-old', project: 'B', text: 'relic bold', created_at: now - 5 * 86400000 }));
  seed.close();
  const count = () => { const r = new DatabaseSync(t.path); const c = r.prepare('SELECT count(*) c FROM history').get().c; r.close(); return c; };
  let s = openMemoryStore({ dbPath: t.path, retentionDays: 1 }); // no project: deletes nothing
  assert.equal(s.prune(undefined).deleted, 0);
  s.close();
  assert.equal(count(), 3);
  s = openMemoryStore({ dbPath: t.path, retentionDays: 1, project: 'A' });
  assert.equal(count(), 2);
  s.close();
  s = openMemoryStore({ dbPath: t.path, retentionDays: 36500 });
  assert.deepEqual(s.search({ project: 'B', query: 'relic' }).map(x => x.event_id), ['b-old']);
  assert.deepEqual(s.search({ project: 'A', query: 'relic' }).map(x => x.event_id), ['a-new']);
  s.close();
  s = openMemoryStore({ dbPath: t.path, retentionDays: 1 });
  assert.equal(s.prune('B').deleted, 1);
  assert.equal(s.prune('B').deleted, 0);
  s.close();
  assert.equal(count(), 1);
  t.done();
});

test('section search finds a valid row behind 150 higher-ranked decoys (bounded paging)', () => {
  const s = openMemoryStore({ dbPath: ':memory:' });
  const now = Date.now();
  for (let i = 0; i < 150; i++) {
    s.archive(rec({ event_id: `d${i}`, session_id: `x${i}`, created_at: now - 1000 + i,
      text: `## Objective\n${'alpha beta '.repeat(20)}\n## Decisions\nnothing relevant ${i}\n` }));
  }
  s.archive(rec({ event_id: 'valid', session_id: 'v', created_at: now - 5000,
    text: `## Objective\nother\n## Decisions\nalpha beta ${'pad '.repeat(100)}\n` }));
  const r = s.search({ project: 'p', query: 'alpha beta', section: 'decisions', limit: 5, maxSnippetChars: 60 });
  assert.deepEqual(r.map(x => x.event_id), ['valid']);
  assert.equal(r[0].section, 'decisions');
  assert.ok(r[0].snippet.length <= 60);
  assert.equal(SCAN_MAX_ROWS, 1000); // documented ceiling: rows beyond it are never scanned
  assert.ok(s.search({ project: 'p', query: 'alpha beta', limit: 5 }).length <= 5);
  s.close();
});

test('query-only search scans past the first 100 BM25 candidates (hits primary)', () => {
  const s = openMemoryStore({ dbPath: ':memory:', maxResults: 5 });
  const now = Date.now();
  // FTS folds diacritics, so every "café" row matches the query "cafe" but holds no literal "cafe".
  for (let i = 0; i < 120; i++) {
    s.archive(rec({ event_id: `d${i}`, session_id: `x${i}`, created_at: now - 1000 + i, text: `café café café café ${i}` }));
  }
  s.archive(rec({ event_id: 'literal', session_id: 'lit', created_at: now - 9000, text: 'cafe ' + 'padding words '.repeat(40) }));
  const r = s.search({ project: 'p', query: 'cafe' });
  assert.equal(r[0].event_id, 'literal');
  assert.ok(r.length <= 5);
  assert.ok(r.every((x) => x.snippet.length <= 400));
  s.close();
});

test('strict 1000-row cap: target beyond row 1000 is not scanned; row 1000 is', () => {
  const now = Date.now();
  const build = (decoys) => {
    const s = openMemoryStore({ dbPath: ':memory:', maxResults: 5 });
    for (let i = 0; i < decoys; i++) s.archive(rec({ event_id: `d${i}`, session_id: `x${i}`, created_at: now - i, text: 'café café café café' }));
    // Longer, single literal term: FTS rank is worse than every decoy, but its literal hits (1) beat the decoys' (0).
    s.archive(rec({ event_id: 'target', session_id: 't', created_at: now - 5000, text: 'cafe ' + 'padding words '.repeat(60) }));
    return s;
  };
  assert.equal(SCAN_MAX_ROWS, 1000);
  const over = build(1000); // target is row 1001
  const r1 = over.search({ project: 'p', query: 'cafe' });
  assert.ok(r1.length >= 1 && r1.length <= 5);
  assert.ok(!r1.some((x) => x.event_id === 'target'));
  over.close();
  const edge = build(999); // target is row 1000
  const r2 = edge.search({ project: 'p', query: 'cafe' });
  assert.equal(r2[0].event_id, 'target');
  assert.ok(r2.length <= 5);
  edge.close();
});

test('strict char ceiling: rows past the 8MB cap are never processed; transaction closed after stop', () => {
  const t = tmp();
  mkdirSync(join(t.dir, 'sub'), { recursive: true });
  const s = openMemoryStore({ dbPath: t.path, maxResults: 5 });
  const now = Date.now();
  const decoy = 'zeta '.repeat(180_000); // 900k chars, very high tf => ranks before the valid row
  assert.ok(9 * 899_999 > SCAN_MAX_CHARS && 8 * 899_999 <= SCAN_MAX_CHARS);
  for (let i = 0; i < 9; i++) s.archive(rec({ event_id: `d${i}`, session_id: `x${i}`, created_at: now - i, text: decoy }));
  s.archive(rec({ event_id: 'valid', session_id: 'v', created_at: now - 100, text: 'zeta ' + 'pad '.repeat(224_000) }));
  const r = s.search({ project: 'p', query: 'zeta' });
  assert.ok(r.length >= 1 && r.length <= 5);
  assert.ok(!r.some((x) => x.event_id === 'valid'), 'row beyond the cap must not be scanned');
  assert.ok(r.every((x) => x.snippet.length <= 400));
  // Same row IS reachable when the cap is not hit (control).
  const s2 = openMemoryStore({ dbPath: ':memory:', maxResults: 5 });
  for (let i = 0; i < 3; i++) s2.archive(rec({ event_id: `d${i}`, session_id: `x${i}`, created_at: now - i, text: decoy }));
  s2.archive(rec({ event_id: 'valid', session_id: 'v', created_at: now - 100, text: 'zeta ' + 'pad '.repeat(224_000) }));
  assert.ok(s2.search({ project: 'p', query: 'zeta' }).some((x) => x.event_id === 'valid'));
  s2.close();
  // No read transaction lingers: archive works, and a second connection can write without waiting.
  assert.equal(s.archive(rec({ event_id: 'after', text: 'after the scan' })).inserted, true);
  const other = new DatabaseSync(t.path);
  other.exec('PRAGMA busy_timeout = 0');
  other.exec("INSERT INTO history (event_id, project, created_at, text) VALUES ('ext', 'p', 1, 'external')");
  other.close();
  assert.equal(s.prune('p').deleted >= 0, true);
  s.close();
  t.done();
});

test('search closes its read transaction on every path; archive/prune follow immediately', () => {
  const t = tmp();
  mkdirSync(join(t.dir, 'sub'), { recursive: true });
  const s = openMemoryStore({ dbPath: t.path });
  s.archive(rec({ event_id: 'a', text: '## Objective\nfoo bar\n## Decisions\nnothing\n' }));
  const other = new DatabaseSync(t.path);
  other.exec('PRAGMA busy_timeout = 0');
  let n = 0;
  const writeOther = () => other.exec(`INSERT INTO history (event_id, project, created_at, text) VALUES ('o${n++}', 'p', ${Date.now()}, 'ext')`);
  s.search({ project: 'p', query: 'foo' }); writeOther();
  s.search({ project: 'p', query: 'foo bar', section: 'decisions' }); writeOther(); // section skip path
  s.search({ project: 'p', query: 'nomatchhere' }); writeOther(); // empty page path
  assert.throws(() => s.search({ project: 'p', query: 'foo', section: 'bogus' }), TypeError); writeOther();
  assert.equal(s.archive(rec({ event_id: 'b', text: 'second foo' })).inserted, true);
  assert.equal(s.prune('p').deleted, 0);
  other.close();
  s.close();
  t.done();
});

test('concurrent open waits on a write lock held by another process (busy_timeout)', async () => {
  const t = tmp();
  mkdirSync(join(t.dir, 'sub'), { recursive: true });
  openMemoryStore({ dbPath: t.path }).close();
  const code = `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA busy_timeout=5000');d.exec('BEGIN IMMEDIATE');console.log('locked');setTimeout(()=>{d.exec('COMMIT');d.close();},300);`;
  const child = spawn(process.execPath, ['-e', code, t.path], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((res) => child.once('exit', res));
  await new Promise((res, rej) => {
    child.stdout.once('data', res);
    child.once('error', rej);
    child.once('exit', (c) => rej(new Error(`child exited early ${c}: ${err}`)));
  });
  const t0 = Date.now();
  const s = openMemoryStore({ dbPath: t.path, project: 'p' }); // prune on open needs the write lock
  assert.ok(Date.now() - t0 >= 100, 'waited for the lock');
  assert.equal(s.archive(rec()).inserted, true);
  s.close();
  assert.equal(await exited, 0, err);
  t.done();
});

test('non-busy migration errors still throw', () => {
  const t = tmp();
  mkdirSync(join(t.dir, 'sub'), { recursive: true });
  const raw = new DatabaseSync(t.path);
  raw.exec('CREATE TABLE history (id INTEGER PRIMARY KEY, event_id TEXT UNIQUE)');
  raw.close();
  assert.throws(() => openMemoryStore({ dbPath: t.path }));
  t.done();
});
