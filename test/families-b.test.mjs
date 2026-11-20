import test from 'node:test';
import assert from 'node:assert/strict';
import * as kubectl from '../src/families/kubectl.js';
import * as terraform from '../src/families/terraform.js';
import * as gradle from '../src/families/gradle.js';
import * as make from '../src/families/make.js';
import * as pip from '../src/families/pip.js';
import * as uv from '../src/families/uv.js';
import * as curl from '../src/families/curl.js';
import * as wget from '../src/families/wget.js';

const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const join = (...parts) => parts.flat().join('\n');

const CASES = {
  kubectl: {
    mod: kubectl, program: 'kubectl',
    noisy: join('deployment.apps/web configured', rep(40, (i) => `Waiting for deployment "web" rollout to finish: ${i} of 40 updated replicas are available...`), 'deployment "web" successfully rolled out', 'No resources found in default namespace.'),
    keep: ['deployment.apps/web configured', 'No resources found in default namespace.', 'deployment "web" successfully rolled out'],
    critical: join('deployment.apps/web configured', 'service/web created'),
    errorNoisy: join(rep(10, () => 'Waiting for pod to be ready...'), 'Error from server (NotFound): pods "x" not found'),
    errorKeep: 'Error from server (NotFound): pods "x" not found',
  },
  terraform: {
    mod: terraform, program: 'terraform',
    noisy: join(rep(30, (i) => `aws_instance.a${i}: Refreshing state... [id=i-${i}]`), rep(5, (i) => `data.x.d${i}: Read complete after 0s [id=${i}]`), 'Terraform will perform the following actions:', '  + resource "aws_instance" "new" {', '  ~ ami = "a" -> "b"', '  - old = true', 'Plan: 1 to add, 1 to change, 1 to destroy.', 'Apply complete! Resources: 1 added, 1 changed, 1 destroyed.', 'Outputs:', 'ip = "1.2.3.4"'),
    keep: ['  + resource "aws_instance" "new" {', '  ~ ami = "a" -> "b"', '  - old = true', 'Plan: 1 to add, 1 to change, 1 to destroy.', 'Apply complete! Resources: 1 added, 1 changed, 1 destroyed.', 'ip = "1.2.3.4"'],
    critical: join('Terraform will perform the following actions:', '  + resource "x" "y" {}', 'Plan: 1 to add, 0 to change, 0 to destroy.'),
    errorNoisy: join(rep(8, (i) => `a${i}: Refreshing state...`), 'Error: Invalid provider configuration'),
    errorKeep: 'Error: Invalid provider configuration',
  },
  gradle: {
    mod: gradle, program: 'gradlew',
    noisy: join(rep(40, (i) => `> Task :mod${i}:compileJava UP-TO-DATE`), rep(5, (i) => `> Task :mod${i}:processResources NO-SOURCE`), '> Task :app:test FAILED', 'FooTest > bar FAILED', '    java.lang.AssertionError at FooTest.java:12', 'w: deprecated API used', 'BUILD FAILED in 3s'),
    keep: ['> Task :app:test FAILED', 'FooTest > bar FAILED', 'w: deprecated API used', 'BUILD FAILED in 3s'],
    critical: join('> Task :app:test', 'BUILD SUCCESSFUL in 2s'),
    errorNoisy: join(rep(6, (i) => `> Task :m${i}:jar UP-TO-DATE`), 'FAILURE: Build failed with an exception.'),
    errorKeep: 'FAILURE: Build failed with an exception.',
  },
  make: {
    mod: make, program: 'make',
    noisy: join(rep(20, (i) => `make[${i}]: Entering directory '/src/d${i}'`), rep(20, (i) => `make[${i}]: Leaving directory '/src/d${i}'`), rep(5, () => "make: Nothing to be done for 'all'."), 'gcc -c main.c -o main.o', 'main.c:3:1: error: expected ; before }', "make: *** [Makefile:5: main.o] Error 1"),
    keep: ['gcc -c main.c -o main.o', 'main.c:3:1: error: expected ; before }', 'make: *** [Makefile:5: main.o] Error 1'],
    critical: join('gcc -c main.c', 'gcc -o app main.o'),
    errorNoisy: join(rep(6, (i) => `make[1]: Entering directory '/d${i}'`), 'make: *** No rule to make target foo. Stop. error'),
    errorKeep: 'make: *** No rule to make target foo. Stop. error',
  },
  pip: {
    mod: pip, program: 'pip',
    noisy: join(rep(15, (i) => `Collecting pkg${i}==1.0`), rep(15, (i) => `  Downloading pkg${i}-1.0-py3-none-any.whl (10 kB)`), rep(10, (i) => `  Using cached pkg${i}-1.0.whl (5 kB)`), 'Installing collected packages: a, b', 'Successfully installed a-1 b-2'),
    keep: ['Successfully installed a-1 b-2'],
    critical: join('Successfully installed a-1'),
    errorNoisy: join(rep(8, (i) => `Collecting p${i}`), 'ERROR: Could not find a version that satisfies the requirement zzz'),
    errorKeep: 'ERROR: Could not find a version that satisfies the requirement zzz',
  },
  uv: {
    mod: uv, program: 'uv',
    noisy: join('Resolved 40 packages in 10ms', 'Prepared 40 packages in 1s', 'Audited 40 packages in 1ms', rep(10, (i) => `Downloading pkg${i} (1.0MiB)`), 'Installed 40 packages in 5ms', ' + a==1.0'),
    keep: ['Installed 40 packages in 5ms', ' + a==1.0'],
    critical: join('Installed 1 package in 5ms', ' + a==1.0'),
    errorNoisy: join(rep(8, (i) => `Downloading p${i} (1MiB)`), 'error: No solution found when resolving dependencies'),
    errorKeep: 'error: No solution found when resolving dependencies',
  },
  curl: {
    mod: curl, program: 'curl',
    noisy: join('  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current', '                                 Dload  Upload   Total   Spent    Left  Speed', rep(20, (i) => `  ${i}  1000k    ${i}  100k    0     0  1234k      0  0:00:01  0:00:01 --:--:-- 1234k`), rep(20, () => '{ [16384 bytes data]'), '< HTTP/2 200', '< content-type: text/plain', 'hello body'),
    keep: ['< HTTP/2 200', '< content-type: text/plain', 'hello body'],
    critical: join('HTTP/1.1 200 OK', 'content-type: text/plain', '', 'hello'),
    errorNoisy: join(rep(6, () => '} [5 bytes data]'), 'curl: (7) Failed to connect to localhost port 1 after 0 ms: error'),
    errorKeep: 'curl: (7) Failed to connect to localhost port 1 after 0 ms: error',
  },
  wget: {
    mod: wget, program: 'wget',
    noisy: join('--2024-01-01 00:00:00--  http://x/f.bin', 'Resolving x (x)... 1.2.3.4', 'Connecting to x (x)|1.2.3.4|:80... connected.', 'HTTP request sent, awaiting response... 200 OK', 'Length: 1000 (1K) [application/octet-stream]', 'Saving to: ‘f.bin’', rep(20, (i) => `     ${i}K .......... .......... .......... ${i}%  1.2M 0s`), "2024-01-01 00:00:01 (1.0 MB/s) - ‘f.bin’ saved [1000/1000]"),
    keep: ['--2024-01-01 00:00:00--  http://x/f.bin', "2024-01-01 00:00:01 (1.0 MB/s) - ‘f.bin’ saved [1000/1000]"],
    critical: join('--2024-01-01--  http://x/f', 'HTTP request sent, awaiting response... 404 Not Found'),
    errorNoisy: join(rep(6, () => 'Resolving x (x)... 1.2.3.4'), 'HTTP request sent, awaiting response... 404 Not Found', '2024-01-01 ERROR 404: Not Found.'),
    errorKeep: '2024-01-01 ERROR 404: Not Found.',
  },
};

for (const [name, c] of Object.entries(CASES)) {
  test(`${name}: module contract and matching`, () => {
    assert.equal(c.mod.id, name);
    assert.equal(c.mod.priority, 60);
    assert.equal(c.mod.match({ program: c.program }), true);
    assert.equal(c.mod.match({ program: 'definitely-not-it' }), false);
    assert.equal(c.mod.match({}), false);
  });
  test(`${name}: noisy fixture compresses, diagnostics preserved, marker present`, () => {
    const out = c.mod.compress(c.noisy, { program: c.program });
    assert.ok(out.length < c.noisy.length * 0.85, `${name} not reduced: ${out.length}/${c.noisy.length}`);
    assert.match(out, new RegExp(`^\\[\\d+ ${name} progress rows omitted\\]`));
    assert.ok(out.split('\n').length <= 160 && out.length <= 16000);
    for (const line of c.keep) assert.ok(out.includes(line), `${name} lost: ${line}`);
  });
  test(`${name}: errors among noise survive`, () => {
    const out = c.mod.compress(c.errorNoisy, { program: c.program, failed: true });
    assert.ok(out.includes(c.errorKeep));
  });
  test(`${name}: critical/no-noise output untouched`, () => {
    assert.equal(c.mod.compress(c.critical, {}), c.critical);
  });
  test(`${name}: garbage/empty input does not throw and is deterministic`, () => {
    for (const bad of ['', '\n\n', undefined, null, 42, {}, '\x1b[31m\x00\uffff']) {
      assert.doesNotThrow(() => c.mod.compress(bad, undefined));
    }
    assert.equal(c.mod.compress('', {}), '');
    assert.equal(c.mod.compress(c.noisy, {}), c.mod.compress(c.noisy, {}));
  });
}

test('pip keeps a few "already satisfied" rows and folds the rest', () => {
  const t = join(rep(20, (i) => `Requirement already satisfied: p${i} in /venv`), 'Successfully installed z-1');
  const out = pip.compress(t, {});
  assert.equal(out.split('\n').filter((l) => l.startsWith('Requirement already')).length, 3);
  assert.ok(out.includes('Successfully installed z-1'));
});
test('wget keeps "Saving to" when no saved confirmation exists', () => {
  const t = join('Resolving x', 'Connecting to x', 'Length: 10', 'Saving to: ‘f’');
  const out = wget.compress(t, {});
  assert.ok(out.includes('Saving to: ‘f’'));
});
for (const [name, c] of Object.entries(CASES)) {
  test(`${name}: ~1000 unique rows are preserved or output is raw`, () => {
    const rows = c.noisy.split('\n');
    const sent = rep(1000, (i) => `sentinel-${name}-${String(i).padStart(4, '0')} unique payload row`);
    const text = join(rows[0], sent, rows.slice(1));
    const out = c.mod.compress(text, { program: c.program });
    if (out === text) return;
    for (const s of sent) assert.ok(out.includes(s), `lost: ${s}`);
  });
}
test('oversized remainder returns original instead of losing lines', () => {
  const t = join(rep(5, (i) => `> Task :x${i} UP-TO-DATE`), rep(400, (i) => `error: boom ${i}`));
  assert.equal(gradle.compress(t, {}), t);
});
test('curl drops 4-digit progress-meter rows, keeps headers/body', () => {
  const t = join(
    '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current',
    '                                 Dload  Upload   Total   Spent    Left  Speed',
    '  0  1999    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0',
    ' 52  1999   52  1040    0     0   1999      0  0:00:01  0:00:01 --:--:--  1999',
    '100  1999  100  1999    0     0   1999      0  0:00:01  0:00:01 --:--:--  1999',
    '< HTTP/2 200', 'hello body 1999 bytes');
  const out = curl.compress(t, { program: 'curl' });
  assert.match(out, /^\[5 curl progress rows omitted\]/);
  assert.ok(!/0:00:01/.test(out));
  for (const l of ['< HTTP/2 200', 'hello body 1999 bytes']) assert.ok(out.includes(l));
});
test('wget drops 4-digit progress rows, keeps header and saved line', () => {
  const t = join(
    '--2024-01-01 00:00:00--  http://x/f.bin',
    'Length: 9999999 (9.5M)',
    ' 1999K .......... .......... .......... 20%  1.2M 0s',
    '10000K .......... .......... .......... 40%  1.2M 0s',
    '100000K .......... .......... .......... 99%  1.2M 0s',
    "2024-01-01 00:00:01 (1.0 MB/s) - ‘f.bin’ saved [9999999/9999999]");
  const out = wget.compress(t, { program: 'wget' });
  assert.match(out, /^\[4 wget progress rows omitted\]/);
  assert.ok(!/\.\.\.\.\.\.\.\.\.\./.test(out));
  assert.ok(out.includes('--2024-01-01 00:00:00--  http://x/f.bin'));
  assert.ok(out.includes('saved [9999999/9999999]'));
});
