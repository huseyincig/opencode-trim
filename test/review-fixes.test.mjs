import test from 'node:test';
import assert from 'node:assert/strict';
import {compressOutput,looksStructured} from '../src/compress.js';
import {compressPassingTests} from '../src/runners.js';
import {parseOptions} from '../src/config.js';
import {isDiagnosticLine,hasFailureText} from '../src/diagnostics.js';
import {isProtectedCommand} from '../src/filters.js';
import {PROTECTED_GIT,isProtectedGitCall} from '../src/git.js';
const options=parseOptions({minOutputChars:200,maxOutputLines:20,maxOutputChars:2500,minSavingsRatio:0.01});
const rows=Array.from({length:100},(_,i)=>` ✓ src/test_${i}.test.ts (1 test)`);
const report=[...rows,'Test Files 100 passed (100)','Tests 100 passed'].join('\n');

test('cat of a results file with passing rows is unchanged; real test command compresses',()=>{
  const cat=compressPassingTests('cat test_results.txt',report);
  assert.equal(cat.text,report);assert.equal(cat.dropped,0);
  const real=compressPassingTests('vitest run',report);
  assert.ok(real.dropped>0);
  assert.equal(compressPassingTests('vitest run',rows.join('\n')).dropped,0);
});
test('patch-printing git plumbing is protected',()=>{
  for(const sub of ['diff-index','diff-files','cherry-pick']){
    assert.ok(PROTECTED_GIT.has(sub));
    assert.ok(isProtectedGitCall({sub,args:[]}));
    assert.ok(isProtectedCommand(`git ${sub} HEAD`));
  }
  const patch=['diff --git a/f b/f','--- a/f','+++ b/f',...Array.from({length:80},(_,i)=>`+line ${i} `+'x'.repeat(40))].join('\n');
  const r=compressOutput({command:'git diff-index -p HEAD',text:patch,exitCode:0,options});
  assert.equal(r.changed,false);assert.equal(r.text,patch);
});
test('multiplication sign is not a failure but failure rows are',()=>{
  assert.equal(isDiagnosticLine('resolution 1920×1080'),false);
  assert.equal(isDiagnosticLine('2 × 2 = 4'),false);
  assert.equal(hasFailureText('size 1920×1080\n2 × 2'),false);
  assert.equal(isDiagnosticLine(' × test fails'),true);
  assert.equal(isDiagnosticLine('  ✗ broken'),true);
  assert.equal(isDiagnosticLine('1) ✗ broken'),true);
  const out=compressPassingTests('vitest run',[...rows,' × keeps 1920×1080','Tests 1 failed | 100 passed'].join('\n'));
  assert.ok(out.text.includes(' × keeps'));
});
test('structured detection: [-v] is text, [-1] is JSON; control chars guard',()=>{
  assert.equal(looksStructured('[-v] usage line\nmore'),false);
  assert.equal(looksStructured('[-1, 2]'),true);
  assert.equal(looksStructured('[-1]'),true);
  const text=('plain line\n'.repeat(100))+'\x1c';
  assert.equal(compressOutput({command:'echo',text,exitCode:0,options}).changed,false);
  assert.equal(compressOutput({command:'echo',text:text.replace('\x1c','\x7f'),exitCode:0,options}).reason,'structured');
});
test('secret files are protected from compression for viewing commands',()=>{
  for(const c of ['head .env','tail -n 5 .env.local','more id_rsa','less a.pem','grep K .npmrc','rg token .netrc','cat secrets.json','sed -n 1p x.key','awk 1 .env','nl .env','bat server.key'])
    assert.equal(isProtectedCommand(c),true,c);
  for(const c of ['head README.md','grep foo src/app.js','cat keyboard.txt'])
    assert.equal(isProtectedCommand(c),false,c);
});
