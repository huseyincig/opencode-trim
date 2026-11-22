import test from 'node:test';
import assert from 'node:assert/strict';
import { compressOutput, stripAnsi, deduplicateConsecutive } from '../src/compress.ts';
import { parseOptions } from '../src/config.ts';
const opts=parseOptions({minOutputChars:200,maxOutputLines:25,maxOutputChars:2500,minSavingsRatio:0.05});
const run=(command,text,exitCode)=>compressOutput({command,text,exitCode,options:opts});
test('ANSI removal',()=>assert.equal(stripAnsi('\x1b[31mred\x1b[0m\r'), 'red\n'));
test('consecutive dedup (3 kept, 4 folded)',()=>{
  assert.equal(deduplicateConsecutive('a\na\na'),'a\na\na');
  assert.equal(deduplicateConsecutive('a\na\na\na'),'a\n[3 identical lines omitted]');
});
test('short outputs untouched',()=>assert.equal(run('npm test','pass').changed,false));
test('long success logs compress, summary retained',()=>{
  const out=['Running suite',...Array.from({length:300},(_,i)=>`progress ${i}`),'Tests: 300 passed, 0 failed'].join('\n');
  const result=run('npm test',out,0);
  assert.equal(result.changed,true);assert.match(result.text,/300 passed/);assert.match(result.text,/lines omitted/);assert.ok(result.text.length<out.length);
});
test('failure details kept or original untouched',()=>{
  const out=['Begin',...Array.from({length:180},(_,i)=>`noise ${i}`),'FAIL module-a','AssertionError: expected 3',' at src/mod.test.ts:47:3',...Array.from({length:180},(_,i)=>`noise2 ${i}`),'Tests: 1 failed'].join('\n');
  const result=run('vitest',out,1);
  assert.match(result.text,/FAIL module-a/);assert.match(result.text,/AssertionError/);assert.match(result.text,/mod.test.ts:47/);assert.match(result.text,/1 failed/);
});
test('JSON output never compressed',()=>{
  const data=JSON.stringify({items:Array.from({length:100},(_,i)=>({i,value:'abc'}))});
  assert.deepEqual(run('curl',data),{text:data,changed:false,reason:'structured'});
});
test('XML output never compressed',()=>{
  const data='<?xml version="1.0"?>'+('<item>x</item>'.repeat(150));
  assert.equal(run('curl',data).changed,false);
});
test('nul bytes never compressed',()=>{
  const data=('log\n'.repeat(200))+'\u0000';assert.equal(run('bash',data).changed,false);
});
test('repetitive shell output reduces',()=>{
  const data='ok\n'.repeat(300)+'Completed';const result=run('echo',data);
  assert.equal(result.changed,true);assert.match(result.text,/identical lines omitted/);
});
test('no recognizable rows protects output',()=>{
  const data=Array.from({length:100},(_,i)=>`chunk-${i}`).join('\n');
  const result=run('unknown',data);
  assert.ok(result.text.includes('chunk-0'));assert.ok(result.text.includes('chunk-99'));
});
test('trailing summary never stripped',()=>{
  const data=[...Array.from({length:300},(_,i)=>`line ${i}`),'5 passed'].join('\n');
  assert.ok(run('pytest',data).text.includes('5 passed'));
});
test('unicode boundaries kept when trimming',()=>{
 const data=('🍃彡 '.repeat(400))+'\nAll completed';const result=run('unknown',data);
 assert.equal(result.text.includes('\ufffd'),false);
});
test('invalid options fail loudly',()=>{
  assert.throws(()=>parseOptions({maxOutputLines:-1}));
  assert.throws(()=>parseOptions({pruneEligibleTools:['shell;rm']}));
  assert.throws(()=>parseOptions({typo:true}));
});
test('large output scan limit leaves text untouched',()=>{
 const text='x'.repeat(2_000_100);
 const got=run('npm test',text);
 assert.equal(got.changed,false); assert.equal(got.reason,'scan-limit');
});
