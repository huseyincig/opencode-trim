import test from 'node:test';
import assert from 'node:assert/strict';
import { compressOutput, dedupToolOutput, looksStructured, resolveProgram, tokenizeCommand } from '../src/compress.js';
import { applyLineFilters, isProtectedCommand, programOf } from '../src/filters.js';
import { processToolEvent } from '../src/plugin.js';
import { parseOptions } from '../src/config.js';
import { gitSubcommands } from '../src/families/util.js';
import { hasTopLevelChain, isProtectedGit } from '../src/git.js';

const opts = parseOptions({ minOutputChars: 200, maxOutputLines: 25, maxOutputChars: 2500, minSavingsRatio: 0.05 });
const run = (command, text, exitCode = 0, options = opts) => compressOutput({ command, text, exitCode, options });
const prog = (command) => resolveProgram(tokenizeCommand(command));
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('package-manager subcommands resolve to the wrapper program', () => {
  for (const [cmd, want] of [
    ['npm install', 'npm'], ['npm install lodash', 'npm'], ['npm test', 'npm'], ['npm run build', 'npm'],
    ['pnpm install', 'pnpm'], ['bun install', 'bun'], ['uv sync', 'uv'],
    ['npx eslint .', 'eslint'], ['python -m pytest', 'pytest'], ['go test ./...', 'go'],
    ['uv run pytest -q', 'pytest'], ['pnpm dlx prettier .', 'prettier'], ['FOO=1 sudo npm ci', 'npm'],
  ]) assert.equal(prog(cmd), want, cmd);
});

test('npm/pnpm/bun/uv families fire for install-style commands', () => {
  const cases = [
    ['npm install', (i) => `npm notice step ${i}`, 'npm chatter lines omitted'],
    ['pnpm install', (i) => `Progress: resolved ${i}, reused 0, downloaded 0`, 'pnpm progress lines omitted'],
    ['bun install', (i) => `Downloaded pkg-${i}`, 'bun install progress lines omitted'],
    ['uv sync', (i) => `Downloading pkg-${i}`, 'uv progress rows omitted'],
  ];
  for (const [cmd, row, marker] of cases) {
    const text = [...lines(60, row), 'added 3 packages in 2s'].join('\n');
    const result = run(cmd, text);
    assert.equal(result.changed, true, cmd);
    assert.ok(result.text.includes(marker), `${cmd}: ${result.text.slice(0, 80)}`);
    assert.ok(result.text.includes('added 3 packages in 2s'));
  }
});

test('git global options cannot bypass diff/patch protection', () => {
  const body = lines(80, (i) => `+ line ${i} of a patch that must never be rewritten`).join('\n');
  for (const cmd of ['git -C repo diff', 'git --no-pager show HEAD', 'git -c color.ui=always blame file.js', 'git format-patch -1', 'git --git-dir=.git diff', 'git -C repo -c a=b diff HEAD~1']) {
    assert.equal(isProtectedCommand(cmd), true, cmd);
    const r = run(cmd, body);
    assert.equal(r.changed, false, cmd);
    assert.equal(r.text, body, cmd);
  }
  assert.equal(isProtectedCommand('git -C repo status'), false);
});

test('git -C status/log use the git family and disclose omissions', () => {
  const text = [...lines(40, (i) => `Receiving objects: ${i}% (${i}/100)`), 'On branch main', 'Your branch is up to date'].join('\n');
  for (const cmd of ['git -C repo status', 'git --no-pager log', 'git -c a=b pull']) {
    const r = run(cmd, text);
    assert.equal(r.changed, true, cmd);
    assert.equal(r.reason, 'family:git', cmd);
    assert.match(r.text, /^\[40 git progress lines omitted\]\n/, cmd);
    assert.ok(r.text.includes('On branch main'));
  }
});

test('tsc family discloses omitted watch chatter', () => {
  const text = [...lines(30, () => 'File change detected. Starting incremental compilation'), 'Found 0 errors. Watching for file changes.'].join('\n');
  const r = run('tsc --watch', text);
  assert.equal(r.changed, true);
  assert.match(r.text, /^\[30 tsc watch\/status lines omitted\]\n/);
});

test('stack-frame and path patterns scale linearly on adversarial input', () => {
  const big = { ...opts, maxInputScanChars: 10 ** 7 };
  const time = (unit, kb) => {
    const text = unit.repeat(Math.floor((kb * 1024) / unit.length));
    const t = performance.now();
    run('npm test', text, 1, big); run('pytest', text, 0, big); run('ls', text, 0, big);
    return performance.now() - t;
  };
  for (const unit of ['at a ', 'a/b/c/', 'x.']) {
    const t = time(unit, 200);
    // Quadratic behavior took ~8s for 200 KB; linear stays far below this ceiling.
    assert.ok(t < 3000, `${JSON.stringify(unit)} took ${t}ms`);
  }
});

test('JSON arrays and incomplete JSON are structured and left byte-identical', () => {
  const samples = [
    JSON.stringify(lines(200, (i) => `src/file-${i}.js`)),
    JSON.stringify(lines(200, (i) => i), null, 2),
    JSON.stringify(lines(100, (i) => `path/${i}`), null, 2),
    '[\n  "a",\n' + lines(150, (i) => `  "item-${i}",`).join('\n'),
    '[true, false, null,' + ' 1,'.repeat(200),
    '  \n[ 1, 2, 3,' + ' 4,'.repeat(200),
    '{"a": [' + '1,'.repeat(300),
  ];
  for (const s of samples) {
    assert.equal(looksStructured(s), true, s.slice(0, 20));
    const r = run('npm test --json', s);
    assert.deepEqual(r, { text: s, changed: false, reason: 'structured' });
    const d = dedupToolOutput(s.replace(/,/g, ',\n,\n,\n,\n,'), opts);
    assert.equal(d.changed, false);
  }
  assert.equal(looksStructured('[INFO] building'), false);
  assert.equal(looksStructured('[12:00:01 AM] Starting compilation'), false);
  const dup = '[\n' + '  "same",\n'.repeat(80) + ']';
  assert.deepEqual(dedupToolOutput(dup, opts), { text: dup, changed: false });
});

test('generic output never exceeds line or char caps after filtering', () => {
  // 'git remote' is a listing: not selected, not protected, never middle-truncated.
  const text = [...lines(60, (i) => `Receiving objects: ${i}% (${i}/100)`), ...lines(80, (i) => `remote ${i}`)].join('\n');
  const r = run('git remote -v', text);
  for (let i = 0; i < 80; i++) assert.ok(r.text.includes(`remote ${i}`), `remote ${i} lost`);
  const generic = [...lines(100, (i) => `record-${i} value`), 'x'].join('\n');
  const g = run('mycmd --list', generic);
  assert.equal(g.changed, false);
  assert.equal(g.text, generic);
  // Filtered docker output that would still exceed the caps is returned raw.
  const dock = [...lines(20, () => '12%'), ...lines(60, (i) => `layer ${i} data`)].join('\n');
  const d = run('docker pull x', dock);
  if (d.changed) assert.ok(d.text.split('\n').length <= opts.maxOutputLines);
});

test('filters recognize every BUILTINS program', () => {
  for (const [cmd, want] of [
    ['prettier --check .', 'prettier'], ['npx playwright test', 'playwright'], ['xcodebuild build', 'xcodebuild'],
    ['helm install x y', 'helm'], ['ansible-playbook site.yml'.replace('-playbook site.yml', ' all'), 'ansible'],
    ['aws s3 sync . s3://b', 'aws'], ['psql -f x.sql', 'psql'], ['deno task build', 'deno'], ['gh pr list', 'gh'],
  ]) assert.equal(programOf(cmd), want, cmd);
  const text = ['Checking formatting...', 'src/a.js', 'All matched files use Prettier code style!'].join('\n');
  const f = applyLineFilters('prettier --check .', text, opts);
  assert.equal(f.dropped, 1);
  const g = applyLineFilters('gh run download', ['✓ Downloaded artifact.zip', 'done'].join('\n'), opts);
  assert.equal(g.dropped, 1);
});

test('pytest keeps failure/error progress positions', () => {
  const text = ['============ test session starts ============', 'collected 90 items', '',
    ...lines(8, () => '.'.repeat(30) + ' [ 10%]'), '..F..E...s.x.. [ 99%]', 'F', 'E',
    ...lines(30, (i) => `tests/test_${i}.py ........`), '=========== 85 passed, 1 failed, 1 error in 1.0s ==========='].join('\n');
  const r = run('pytest', text, 1);
  assert.ok(r.text.includes('..F..E...s.x.. [ 99%]'));
  assert.ok(/^F$/m.test(r.text) && /^E$/m.test(r.text));
  const clean = ['============ test session starts ============', 'collected 90 items', ...lines(30, () => '.'.repeat(30) + ' [ 10%]'), 'sss', '=========== 90 passed in 1.0s ==========='].join('\n');
  const c = run('pytest', clean, 0);
  assert.equal(c.changed, true);
  assert.match(c.text, /passing pytest rows omitted/);
});

test('character cuts never split a surrogate pair', () => {
  let cut = 0;
  for (let max = 900; max < 1000; max++) {
    const o = { ...opts, maxOutputChars: max, maxOutputLines: 400 };
    const text = [...lines(300, (i) => `ok ${i} ` + '😀'.repeat(40)), 'Tests: 1 passed'].join('\n');
    const r = run('vitest', text, 0, o);
    assert.equal(r.text.isWellFormed(), true, `max=${max}`);
    if (r.changed && /characters omitted/.test(r.text)) cut++;
  }
  assert.ok(cut > 0, 'expected the character cut path to run');
});

test('string tool content mirrors compressed output', () => {
  const text = ['Running', ...lines(300, (i) => `progress ${i}`), 'Tests: 300 passed, 0 failed'].join('\n');
  const event = { status: 'completed', tool: 'shell', input: { command: 'npm test' }, result: { content: text, output: { output: text, exitCode: 0 } } };
  assert.equal(processToolEvent(event, parseOptions({})), true);
  assert.notEqual(event.result.content, text);
  assert.equal(event.result.output.output, event.result.content);
  const other = { status: 'completed', tool: 'shell', input: { command: 'npm test' }, result: { content: text, output: { output: 'different', exitCode: 0 } } };
  processToolEvent(other, parseOptions({}));
  assert.equal(other.result.output.output, 'different');
});

test('resolveProgram consumes prefix option values and launcher options', () => {
  const cases = {
    'sudo -u root npm test': 'npm', 'env -u FOO npm test': 'npm', 'nice -n 5 npm test': 'npm', 'time -f x npm test': 'npm',
    'npx --yes eslint .': 'eslint', 'npx --package some-eslint-pkg eslint .': 'eslint', 'uvx --from pkg pytest': 'pytest',
    'uv run --with dep pytest': 'pytest', 'uv run --python 3.12 --with-editable . --index-url https://x ruff check': 'ruff',
    'uv run --env-file .env --directory sub --project p --config-file c.toml -p 3.11 pytest -q': 'pytest',
    'uv run --with-requirements r.txt --constraints c.txt --overrides o.txt --default-index i --extra-index-url e --index j pytest': 'pytest',
    'pipx run ruff check .': 'ruff', 'npx eslint .': 'eslint', 'python -m pytest -q': 'pytest', 'go test ./...': 'go',
  };
  for (const [cmd, want] of Object.entries(cases)) assert.equal(prog(cmd), want, cmd);
});

test('tokenizeCommand normalizes Windows executable paths', () => {
  assert.equal(tokenizeCommand('C:\\Tools\\npm.cmd install')[0], 'npm');
  assert.equal(tokenizeCommand('"C:\\Program Files\\npm.cmd" install')[0], 'npm');
  assert.equal(tokenizeCommand('"C:\\Program Files\\npm.cmd" install')[1], 'install');
  assert.equal(tokenizeCommand('echo "a\\nb"')[1], 'a\\nb');
  assert.equal(prog('C:\\Tools\\npm.cmd install'), 'npm');
});

test('git prefix wrappers with option values are protected and classified', () => {
  const diff = ['diff --git a/x b/x', ...lines(120, (i) => `+line ${i} receiving`), ' '.repeat(3)].join('\n');
  for (const p of ['sudo -u root', 'env -u FOO', 'nice -n 5', 'time -f x']) {
    for (const sub of ['diff', 'format-patch', 'diff-tree', 'range-diff', 'am']) {
      const r = run(`${p} git -C repo ${sub}`, diff);
      assert.equal(r.changed, false, `${p} ${sub}`);
      assert.equal(r.text, diff);
    }
  }
  assert.deepEqual(gitSubcommands('sudo -u root git status'), ['status']);
  assert.deepEqual(gitSubcommands('nice -n 5 git -C repo diff'), ['diff']);
});

test('quoted or escaped separators in git arguments do not hide protected subcommands', () => {
  const body = lines(80, (i) => `+ line ${i} of a patch that must never be rewritten`).join('\n');
  for (const cmd of [
    "git -C '/tmp/a&b' diff", "git -c core.pager='delta | less' diff", 'git -C /tmp/a\\&b diff',
    'git -C "/tmp/a;b" diff', "git -C '/tmp/a|b' show HEAD", 'git -C /tmp/a\\;b diff', 'git -C /tmp/a\\|b diff',
  ]) {
    assert.deepEqual(gitSubcommands(cmd).length, 1, cmd);
    assert.equal(isProtectedCommand(cmd), true, cmd);
    const r = run(cmd, body);
    assert.equal(r.changed, false, cmd);
    assert.equal(r.text, body, cmd);
  }
  // Real separators and unterminated quotes must still reveal a protected subcommand.
  assert.equal(isProtectedCommand("echo 'a;b' ; git diff"), true);
  assert.equal(isProtectedCommand("git -C '/tmp/a&b' status && git diff"), true);
  assert.equal(isProtectedCommand("echo 'oops; git diff"), true);
  assert.deepEqual(gitSubcommands('C:\\git\\git.exe diff'), ['diff']);
});

test('git listing with quoted separators in paths keeps every unique row', () => {
  for (const cmd of ["git -C '/tmp/a&b' remote -v", "git -c core.pager='a | b' ls-files", 'git -C /tmp/a\\&b remote -v']) {
    const text = lines(150, (i) => `unique-row-${i} payload`).join('\n');
    assert.deepEqual(gitSubcommands(cmd).length, 1, cmd);
    assert.equal(run(cmd, text).text, text, cmd);
  }
});

test('git listing subcommands keep every unique row', () => {
  for (const cmd of ['git remote -v', 'git grep foo', 'git ls-files', 'git tag', 'git stash list', 'git reflog', 'sudo -u root git ls-files']) {
    const text = lines(150, (i) => `unique-row-${i} payload`).join('\n');
    const r = run(cmd, text);
    assert.equal(r.text, text, cmd);
  }
});

test('incomplete primitive JSON arrays are structured', () => {
  for (const s of ['[tru', '[fals', '[nul', '[tru  \n', '[ nul\n\n', '[t', '[fa']) assert.equal(looksStructured(s), true, JSON.stringify(s));
  assert.equal(looksStructured('[INFO] building'), false);
  assert.equal(looksStructured('[12:00:01] tru'), false);
  assert.equal(looksStructured('[test] done'), false);
});

test('incomplete primitive JSON prefixes stay byte-identical even with trailing lines', () => {
  for (const head of ['[t', '[tr', '[tru', '[f', '[fa', '[fal', '[fals', '[n', '[nu', '[nul', '[ tru', '[\n  fals', '[\r\nnul']) {
    const text = head + '\n' + lines(40, (i) => `npm notice step ${i} repeated repeated repeated`).join('\n');
    assert.equal(looksStructured(text), true, JSON.stringify(head));
    assert.equal(compressOutput({ command: 'npm install', text, exitCode: 0, options: opts }).text, text, head);
    assert.equal(dedupToolOutput(text, opts).text, text, head);
  }
});

test('ordinary bracket logs are not mistaken for incomplete primitives', () => {
  for (const head of ['[INFO] start', '[12:00:01] start', '[test] done']) {
    assert.equal(looksStructured(head + '\n' + lines(40, () => 'same line').join('\n')), false, head);
  }
});

const wide = parseOptions({ minOutputChars: 200, maxOutputLines: 160, maxOutputChars: 16000, minSavingsRatio: 0.15 });
const runWide = (command, text, exitCode = 0, options = wide) => compressOutput({ command, text, exitCode, options });

test('ruff: 200 F401 diagnostics are all preserved', () => {
  const rows = lines(200, (i) => `src/pkg/mod_${i}.py:1:8: F401 [*] \`os${i}\` imported but unused`);
  const text = [...rows, 'Found 200 errors.', '[*] 200 fixable with the `--fix` option.'].join('\n');
  for (const o of [wide, opts]) {
    const r = run('ruff check .', text, 1, o);
    for (const row of rows) assert.ok(r.text.includes(row), row);
    assert.ok(r.text.includes('Found 200 errors.'));
  }
});

test('ruff: bare [EFW]### codes without paths are never dropped', () => {
  const rows = lines(200, (i) => `F401 unused import number ${i}`);
  const r = runWide('ruff check .', [...rows, 'Found 200 errors.'].join('\n'), 1);
  for (const row of rows) assert.ok(r.text.includes(row), row);
});

test('git: patch-producing and verbose forms are never compressed', () => {
  const body = lines(200, (i) => `Receiving objects: ${i}% (${i}/200), 1.00 MiB`).join('\n');
  for (const cmd of [
    'git log -p', 'git log --patch -n 5', 'git log --diff-merges=first-parent', 'git log --diff-merges first-parent -p',
    'git log -n3 -p', 'git status -v', 'git status --verbose', 'git status -vv', 'git stash show -p', 'git stash show --patch stash@{0}',
    'git request-pull v1 https://example.com/repo', 'git diff', 'git show HEAD', 'git blame file.js', 'git apply x.patch',
    'git format-patch -1', 'git diff-tree HEAD', 'git range-diff a...b', 'git am x.mbox', 'git patch',
  ]) {
    assert.equal(isProtectedGit(cmd), true, cmd);
    assert.equal(isProtectedCommand(cmd), true, cmd);
    const r = runWide(cmd, body);
    assert.equal(r.changed, false, cmd);
    assert.equal(r.text, body, cmd);
  }
});

test('git: plain log/status/stash list are not protected', () => {
  for (const cmd of ['git log --oneline', 'git status', 'git status -sb', 'git stash list', 'git stash show --stat', 'git fetch']) {
    assert.equal(isProtectedGit(cmd), false, cmd);
  }
  assert.deepEqual(gitSubcommands("git -C '/tmp/a;b' log -p"), ['log']);
});

test('git: fail-closed when the command exceeds analysis limits', () => {
  const body = lines(200, (i) => `Receiving objects: ${i}% (${i}/200), 1.00 MiB`).join('\n');
  const longCmd = `echo ${'x'.repeat(9000)}; git status`;
  const manySegments = `${lines(40, () => 'true').join('; ')}; git status`;
  const manyWords = `git status ${lines(60, (i) => `p${i}`).join(' ')}`;
  for (const cmd of [longCmd, manySegments, manyWords]) {
    assert.equal(isProtectedGit(cmd), true, cmd.slice(0, 40));
    assert.equal(runWide(cmd, body).text, body);
  }
  assert.equal(isProtectedGit(`echo ${'x'.repeat(9000)}`), false);
});

test('top-level chain detection is quote/escape/redirect aware', () => {
  assert.equal(hasTopLevelChain("git -C '/tmp/a|b' status"), false);
  assert.equal(hasTopLevelChain('npm test 2>&1'), false);
  assert.equal(hasTopLevelChain('npm test | tail'), true);
  assert.equal(hasTopLevelChain('a && b'), true);
  assert.equal(hasTopLevelChain('a; b'), true);
});

test('custom filterRules apply before family dispatch (through compressOutput)', () => {
  const o = parseOptions({ minOutputChars: 200, maxOutputLines: 160, maxOutputChars: 16000, minSavingsRatio: 0.15,
    filterRules: [{ program: 'ruff', dropPrefixes: ['acme-noise'] }, { program: 'prettier', dropExact: ['acme banner line'] }] });
  const text = [...lines(120, (i) => `acme-noise detail ${i}`), 'src/a.py:1:1: F401 unused import', 'Found 1 error.'].join('\n');
  const r = runWide('ruff check .', text, 1, o);
  assert.equal(r.changed, true, r.reason);
  assert.ok(!r.text.includes('acme-noise'));
  assert.ok(r.text.includes('src/a.py:1:1: F401 unused import'));
  assert.ok(r.text.includes('Found 1 error.'));
  const text2 = [...lines(150, () => 'acme banner line'), '[warn] src/x.ts', 'Code style issues found in 1 file.'].join('\n');
  const r2 = runWide('pnpm dlx -- prettier --check .', text2, 1, o);
  assert.equal(r2.changed, true, r2.reason);
  assert.ok(!r2.text.includes('acme banner line'));
  assert.ok(r2.text.includes('[warn] src/x.ts'));
  const text3 = [...lines(120, (i) => `acme-noise detail ${i}`), 'acme-noise error: boom', 'Found 1 error.'].join('\n');
  assert.ok(runWide('ruff check .', text3, 1, o).text.includes('acme-noise error: boom'));
});

test('CSV/TSV/YAML/TOML/INI/JSONC are detected as structured and never altered', () => {
  const csv = ['id,name,city', ...lines(300, (i) => `${i},name ${i},city ${i}`)].join('\n');
  const tsv = ['id\tname\tcity', ...lines(300, (i) => `${i}\tname ${i}\tcity ${i}`)].join('\n');
  const yaml = ['name: demo', 'version: 1', 'services:', ...lines(300, (i) => `  svc${i}: image-${i}`)].join('\n');
  const yamlDoc = ['---', ...lines(300, (i) => `item${i}: value ${i}`)].join('\n');
  const toml = ['[package]', 'name = "demo"', ...lines(300, (i) => `dep${i} = "1.${i}"`)].join('\n');
  const ini = ['[core]', 'editor = vim', ...lines(300, (i) => `key${i} = value${i}`)].join('\n');
  const jsonc = ['// comment', '/* block */', '{', ...lines(300, (i) => `  "k${i}": ${i},`), '  "end": 0', '}'].join('\n');
  for (const [name, text] of Object.entries({ csv, tsv, yaml, yamlDoc, toml, ini, jsonc })) {
    assert.equal(looksStructured(text), true, name);
    const r = runWide('cat data.txt', text);
    assert.equal(r.changed, false, name);
    assert.equal(r.text, text, name);
  }
});

test('structured detection does not flag ordinary progress logs', () => {
  const pnpm = lines(20, (i) => `Progress: resolved ${i}, reused 0, downloaded ${i}, added 0`).join('\n');
  const go = lines(20, (i) => `go: downloading example.org/pkg-${i} v1.0.0`).join('\n');
  const logs = ['error: first', 'warning: second', 'note: third', 'error: fourth'].join('\n');
  for (const s of [pnpm, go, logs]) assert.equal(looksStructured(s), false, s.slice(0, 30));
});

test('runner options: npm exec --yes, pnpm dlx --, poetry run --', () => {
  for (const [cmd, want] of [
    ['npm exec --yes eslint .', 'eslint'], ['npm exec -- eslint .', 'eslint'], ['pnpm dlx -- prettier --check .', 'prettier'],
    ['pnpm dlx prettier --check .', 'prettier'], ['poetry run -- pytest -q', 'pytest'], ['poetry run pytest -q', 'pytest'],
    ['uv run -- pytest', 'pytest'], ['npx --yes eslint .', 'eslint'], ['npm install', 'npm'], ['poetry install', 'poetry'],
  ]) assert.equal(prog(cmd), want, cmd);
});

test('pipes and chains force generic dispatch (no family reason)', () => {
  const text = [...lines(200, (i) => `npm notice package-${i} installed`), 'added 200 packages in 2s'].join('\n');
  for (const cmd of ['npm install | tee log.txt', 'npm install && echo done', 'cd app; npm install']) {
    const r = runWide(cmd, text);
    assert.ok(!String(r.reason).startsWith('family:'), `${cmd}: ${r.reason}`);
  }
});

test('failing exit: compression keeps failure lines and exit notice', () => {
  const text = [
    ...lines(200, (i) => `npm notice package-${i} installed`),
    'npm error code ELIFECYCLE', 'npm error Failed at the build script', 'Process exited with code 1',
  ].join('\n');
  const r = runWide('npm install', text, 1);
  for (const row of ['npm error code ELIFECYCLE', 'npm error Failed at the build script', 'Process exited with code 1']) {
    assert.ok(r.text.includes(row), row);
  }
});

const uniqLines = (n, p = 'line') => Array.from({ length: n }, (_, i) => `${p} ${i} ${'x'.repeat(i % 7)} value-${i * 31}`).join('\n');

for (const command of ['grep npm build.log', 'echo npm install']) {
  test(`kind: '${command}' is not build; 200 unique non-diagnostic lines stay raw`, () => {
    const text = uniqLines(200);
    const r = run(command, text, 0);
    assert.equal(r.text, text);
    assert.equal(r.changed, false);
  });
}

test('filterRule dropping Process exited cannot remove a nonzero exit notice', () => {
  const noise = Array.from({ length: 80 }, (_, i) => `acme-noise ${i} padding padding padding`).join('\n');
  const text = `${noise}\nnpm error code ELIFECYCLE\nProcess exited with code 2`;
  const options = parseOptions({ minOutputChars: 200, filterRules: [{ program: 'npm', dropPrefixes: ['acme-noise', 'Process exited'] }] });
  const r = run('npm run build', text, 2, options);
  assert.match(r.text, /Process exited with code 2/);
  assert.match(r.text, /ELIFECYCLE/);
});

test('git patch flags are protected for log and stash show', () => {
  for (const command of [
    'git log -c', 'git log -m', 'git log --word-diff', 'git log --word-diff=color', 'git log --color-words',
    'git log --patch-with-raw', 'git stash show --word-diff', 'git stash show --color-words',
    'git stash show --patch-with-raw', 'git stash show -c', 'git stash show -p',
  ]) {
    assert.equal(isProtectedCommand(command), true, command);
    const text = uniqLines(150, 'diff');
    assert.equal(run(command, text, 0).text, text, command);
  }
  assert.equal(isProtectedCommand('git log --oneline'), false);
});

test('git log over the old 60-row cap keeps every unique commit row', () => {
  const commits = Array.from({ length: 100 }, (_, i) => `${(i + 1).toString(16).padStart(7, '0')} commit subject number ${i}`);
  const text = [...commits, 'Receiving objects: 50% (5/10)', 'Resolving deltas: 100% (3/3)'].join('\n');
  const r = run('git log --oneline', text, 0, parseOptions({ minOutputChars: 200, maxOutputLines: 500, maxOutputChars: 20000 }));
  for (const c of commits) assert.ok(r.text.includes(c), c);
});
