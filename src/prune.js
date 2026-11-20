/**
 * Model-wire-only, non-LLM tool-result pruning with protected-tail and
 * supersession reclaim. Never reads/writes the host database or replaces
 * user, system, assistant prose, tools or inputs.
 */
import { types } from 'node:util';
import { isProtectedCommand } from './filters.js';
import { splitSegments, shellWords, skipPrefixWords } from './families/util.js';
import { MAX_LINE, STACK as DIAG_STACK, SUMMARY as DIAG_SUMMARY, ANCHOR as DIAG_ANCHOR, CODE as DIAG_CODE, hasFailureText, parseExitCode } from './diagnostics.js';
import { isMeshProtectedPart, verifyMeshMetadata, MESH_SYMBOL, MESH_METADATA_KEY } from './bridge.js';
export const PRUNED='[opencode-trim: old tool output omitted from model context]';
/** Hard per-message / per-request content-part budgets. Over budget fails closed (no pruning). */
export const MAX_PARTS_PER_MESSAGE=500;
export const MAX_PARTS_TOTAL=50000;
const PROTECTED_NAME=/(?:question|ask|task|delegate|work|board|todo|permission|auth|security|guardian|recovery|session|codebase|memory|mcp|approve|credential|secret|payment|deploy)/i;
const WRITE_NAME=/(?:write|edit|patch|delete|remove|apply|create|commit|push|upload|post|send|update|exec)/i;
// Line-shaped diagnostics: a line must *look like* a log/failure/summary line.
// An incidental token (`throw new Error(..)`, `catch (error)`) in source does not count.
const DIAG_LEVEL=/^\s{0,20}(?:\[?\d{4}-\d\d-\d\d[T ][^\]\s]{1,30}\]?\s+)?[\[<(]?\s{0,3}(?:ERROR|FATAL|CRITICAL|PANIC|SEVERE|WARN(?:ING)?|FAIL(?:ED|URE)?)\b/;
const DIAG_START=/^\s{0,20}(?:npm (?:ERR|error)!|error(?:\[E\d+\])?:|fatal:|panic:|Traceback \(most recent call last\)|Uncaught\b|Unhandled\s?(?:Promise)?\s?[Rr]ejection|[A-Z][A-Za-z]{0,40}(?:Error|Exception)(?::|\s\[)|AssertionError|Segmentation fault|thread '[^'\n]{0,100}' panicked|E[A-Z]{3,12}:|[✗✘✖❌✕]|×(?=\s))/;
const DIAG_BARE=/^\s{0,20}(?:Error|FATAL|Fatal|FATAL ERROR)\s{0,3}:/;
const DIAG_TSLEVEL=/^\s{0,20}[\[(]?\d{4}-\d\d-\d\d[T ][^\]\s]{1,30}[\])]?\s{1,3}[\[<(]?\s{0,3}(?:error|fatal|critical)\s{0,3}[:\]>)]/i;
const DIAG_JSON=/^\s{0,20}\{[^\n]{0,1900}?"(?:level|severity)"\s{0,3}:\s{0,3}"(?:error|fatal|critical)"/i;
const DIAG_TS=/\b(?:error|warning)\s+TS\d{4,5}\b/;
const DIAG_ANCHORED=/:\s{0,3}(?:error|warning|fatal)\b|\b(?:error|warning)\s{1,3}[A-Z]{1,4}\d{2,5}\b/i;
const DIAG_DENIED=/:\s{0,3}(?:permission|access) denied\s{0,5}$/i;
const DIAG_SEC=/^\s{0,20}(?:#{1,6}\s{0,3})?(?:\d{1,6}\s{1,3})?(?:high|critical)\s{1,3}(?:severity|vulnerabilit)|\bCVE-\d{4}-\d{4,7}\b|\bGHSA(?:-[a-z0-9]{4}){3}\b/i;
const DIAG_FAILED_SUMMARY=/\b[1-9]\d{0,6}\s{1,3}(?:failed|failing|errors?)\b|\bFAILED\b|\bfailed:\s{0,3}[1-9]/i;
function diagnosticLine(raw){
  const l=raw.length>MAX_LINE?raw.slice(0,MAX_LINE):raw;
  if(DIAG_LEVEL.test(l)||DIAG_START.test(l)||DIAG_TS.test(l)||DIAG_STACK.test(l)||DIAG_DENIED.test(l)||DIAG_SEC.test(l)||DIAG_BARE.test(l)||DIAG_TSLEVEL.test(l)||DIAG_JSON.test(l))return true;
  if(DIAG_ANCHOR.test(l)&&(DIAG_ANCHORED.test(l)||DIAG_CODE.test(l)))return true;
  return DIAG_SUMMARY.test(l)&&DIAG_FAILED_SUMMARY.test(l);
}
const MAX_SCAN_LINES=20000;
function eachLine(text,fn){
  let start=0,n=0;
  while(start<=text.length&&n++<MAX_SCAN_LINES){
    let end=text.indexOf('\n',start);if(end<0)end=text.length;
    if(fn(text.slice(start,Math.min(end,start+MAX_LINE))))return true;
    start=end+1;
  }
  return false;
}
/** True when any line is an actual failure/log/summary diagnostic (not a mere source token). */
// Conservative prefilter: a superset of every keyword any diagnostic pattern needs.
// Text without any of these cannot match diagnosticLine, so the line scan is skipped.
const DIAG_KEYWORD=/error|fail|fatal|panic|exception|traceback|timeout|timed out|killed|interrupted|cancel+ed|terminated|denied|security|vulnerab|severe|critical|CVE-|GHSA|warn|deprecated|uncaught|unhandled|assert|segmentation|found \d|ERR!|\bE[A-Z]{3,12}:|\b(?:TS|[EFW])\d{3}|(?:^|\s)[✗✘✖✕❌]|^\s*×(?=\s)|^\s*at |File "|Caused by/im;
function diagnosticText(text){return DIAG_KEYWORD.test(text)&&eachLine(text,diagnosticLine);}
// A short status notice such as "Command timed out after 120s" / "[killed]".
const STATUS_NOTICE=/^\s{0,20}[\[(<]?\s{0,3}(?:(?:command|process|execution|tool|shell|run|task|operation|request|job)\b[^\n]{0,80}?)?\b(?:timed out|killed|interrupted|cancelled|canceled|terminated|timeout(?=\s{1,3}(?:after|exceeded|reached|expired)\b|\s{0,3}[\])]))\b(?!\s{0,3}[:=(,;])/i;
const STATUS_KEYWORD=/timed out|killed|interrupted|cancell?ed|terminated|timeout/i;
function statusNotice(text){return STATUS_KEYWORD.test(text)&&eachLine(text,l=>l.length<240&&STATUS_NOTICE.test(l));}
/** Own-data reader that never invokes accessors or traps. */
const INSTRUCTION_PATH = /(?:^|[/\\])(?:AGENTS|PROTOCOL|CLAUDE|GEMINI|SECURITY|POLICY|INSTRUCTIONS|CONTRIBUTING|README|SKILL)\.md$|(?:^|[/\\])(?:opencode|plugin|secrets)\.jsonc?$|(?:^|[/\\])(?:\.npmrc|\.netrc|id_(?:rsa|ed25519|ecdsa|dsa)(?:_sk)?)$|(?:^|[/\\])\.env(?:\.[^/\\]+)?$/i;
const SAFE_SHELL=/^\s*(?:(?:ls|pwd|echo|grep|rg|find|head|tail|wc|tree|stat|git\s+(?:status|log|branch|diff\s+--stat)|npm\s+(?:test|run\s+(?:test|lint|check|typecheck|build))|pnpm\s+(?:test|run\s+(?:test|lint|check|typecheck|build))|bun\s+(?:test|run\s+(?:test|lint|check|typecheck|build))|cargo\s+(?:test|check|build|clippy)|pytest|vitest|jest|tsc|eslint|biome)\b)/i;
const EXIT_LINE=/exit\s*code:?\s*(\d+)/gi;
const EXIT_NOTICE=/\b(?:process|command)\s+exited\s+with\s+(?:exit\s+)?code:?\s*(\d+)/gi;
function failedNotice(text){
  if(typeof text!=='string')return false;
  for(const m of text.matchAll(EXIT_NOTICE))if(Number(m[1])!==0)return true;
  for(const m of text.matchAll(EXIT_LINE))if(Number(m[1])!==0)return true;
  return false;
}
/** Read an own plain data property; never invoke accessors or inherited getters. */
function data(o,k){
  if(o===null||typeof o!=='object'||types.isProxy(o))return undefined;
  const d=Object.getOwnPropertyDescriptor(o,k);
  return d&&'value' in d?d.value:undefined;
}
export {data as ownData};
function isArr(x){return Array.isArray(x)&&!types.isProxy(x);}
export {isArr as isPlainArray};
/** Own-data array element. */
function at(arr,i){return data(arr,String(i));}
/** True when an object has an accessor, a Proxy, or too many keys: such objects are never trusted. */
function trapped(o){
  if(o===null||typeof o!=='object')return false;
  if(types.isProxy(o))return true;
  const keys=Reflect.ownKeys(o);
  if(keys.length>256)return true;
  for(const k of keys){const d=Object.getOwnPropertyDescriptor(o,k);if(d&&!('value' in d))return true;}
  return false;
}
function writable(o,k){
  if(o===null||typeof o!=='object'||types.isProxy(o))return false;
  const d=Object.getOwnPropertyDescriptor(o,k);
  return !!d&&'value' in d&&d.writable===true;
}
const MEDIA_FIELDS=['attachments','files','file','image','images','media'];
function hasMedia(o){
  return obj(o)&&MEDIA_FIELDS.some(k=>{
    const v=data(o,k);
    // An empty array carries no media.
    return v!=null&&!(Array.isArray(v)&&v.length===0);
  });
}
function obj(x) { return x!==null && typeof x==='object' && !Array.isArray(x) && !types.isProxy(x); }
function safeString(x) {return typeof x==='string'?x:'';}
function fingerprint(s) {let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return (h>>>0).toString(16);}
function structured(text) {
  const s=text.trimStart();
  if(/^(?:<\?xml|<!doctype|<html|<svg|-----BEGIN )/i.test(s)||text.includes('\x00')) return true;
  if((s.startsWith('{')||s.startsWith('['))) {
    // Very large JSON is machine-readable by shape; do not pay a full parse to
    // discover that, and never line-mangle it.
    if(text.length>1_000_000) return true;
    try {JSON.parse(s);return true;}catch{/*plain text*/}
  }
  return false;
}
/** Own-data text fragments of every result shape: plain string, value string, text items, state.output. */
function resultTexts(part){
  const out=[];
  const res=data(part,'result');
  if(typeof res==='string')out.push(res);
  else if(obj(res)){
    const v=data(res,'value');
    if(typeof v==='string')out.push(v);
    for(const list of [v,data(res,'content')]){
      if(!isArr(list))continue;
      const n=Math.min(list.length,200);
      for(let i=0;i<n;i++){
        const item=at(list,i);const t=obj(item)?data(item,'text'):undefined;
        if(typeof t==='string')out.push(t);
      }
    }
  }
  const o=data(data(part,'state'),'output');
  if(typeof o==='string')out.push(o);
  return out;
}
function textFailed(t){
  if(failedNotice(t))return true;
  const code=parseExitCode(t);
  if(code!==null&&code!==0)return true;
  // A short result is a status line, not content: any failure word protects it.
  if(t.length<240&&hasFailureText(t))return true;
  return statusNotice(t);
}
function failure(part) {
  if(!obj(part)) return true;
  if(trapped(part))return true;
  if(data(part,'isError')===true || data(part,'error') != null) return true;
  const value=data(part,'result'),state=data(part,'state');
  if(trapped(value)||trapped(state))return true;
  if(obj(value) && (data(value,'isError')===true||data(value,'error') != null||data(value,'type')==='error')) return true;
  for(const t of resultTexts(part))if(textFailed(t))return true;
  if(obj(state) && (data(state,'status')==='error'||data(state,'error') != null)) return true;
  for(const v of [value,state,part]) {
    if(!obj(v))continue;
    const c=data(v,'exitCode')??data(v,'exit_code')??data(v,'exit');
    if(typeof c==='number'&&c!==0)return true;
    const meta=data(v,'metadata');
    if(obj(meta)) {
      if(trapped(meta))return true;
      const mc=data(meta,'exitCode')??data(meta,'exit_code')??data(meta,'exit');
      if(typeof mc==='number'&&mc!==0)return true;
    }
  }
  return false;
}
function accessor(part){
  const ptype=data(part,'type');
  if(ptype==='tool-result'){
    if(hasMedia(part))return null;
    const result=data(part,'result');
    // Only a plain text result is safely replaceable. Multi-part/content
    // results may carry files or notices and are left untouched. Only own
    // writable data properties are replaced: a setter is never invoked.
    if(typeof result==='string'){
      if(!writable(part,'result'))return null;
      return {get:()=>data(part,'result'),set:v=>{part.result=v;}};
    }
    if(!obj(result)||hasMedia(result))return null;
    const type=data(result,'type');
    if(type!==undefined&&type!=='text'&&type!=='content')return null;
    if(type===undefined&&'type' in result)return null;
    const value=data(result,'value');
    const contentArr=value===undefined?data(result,'content'):undefined;
    const arrField=isArr(value)?'value':(isArr(contentArr)?'content':null);
    const list=arrField==='value'?value:contentArr;
    if(type==='content'&&arrField&&isArr(list)){
      // Real V2 shape: exactly one plain text part, no media, no accessors.
      if(trapped(list)||list.length!==1)return null;
      const item=at(list,0);
      if(!obj(item)||trapped(item)||hasMedia(item)||data(item,'type')!=='text')return null;
      if(typeof data(item,'text')!=='string'||!writable(item,'text'))return null;
      return {get:()=>{
        if(data(part,'result')!==result||data(result,arrField)!==list||list.length!==1||at(list,0)!==item)return undefined;
        return data(item,'text');
      },set:v=>{item.text=v;}};
    }
    // Real context read shape {type:'content',value:'<string>'} (and {type:'text'}):
    // own writable string value only; the type is preserved on rewrite.
    if(typeof value!=='string'||!writable(result,'value'))return null;
    return {get:()=>data(part,'result')===result?data(result,'value'):undefined,
      set:v=>{result.value=v;}};
  }
  if(ptype==='tool'){
    const state=data(part,'state');
    if(obj(state)&&!hasMedia(state)){
      const out=data(state,'output');
      if(typeof out==='string'&&writable(state,'output'))
        return {get:()=>data(part,'state')===state?data(state,'output'):undefined,
          set:v=>{state.output=v;}};
    }
  }
  return null;
}
function getInput(part){
  const i=data(part,'input');if(obj(i))return i;
  const si=data(data(part,'state'),'input');return obj(si)?si:{};
}
/** Token estimate for a model message without JSON.stringify (host messages can be cyclic). */
function messageTokens(msg){
  return messageTokensImpl(msg);
}
/** Bounded size walk: never stringifies a huge/cyclic input (cap 200k chars, 2000 nodes). */
function boundedChars(value,cap=200_000){
  let chars=0,nodes=0;
  const stack=[[value,0]];
  while(stack.length&&chars<cap&&nodes<2000){
    const [v,depth]=stack.pop();nodes++;
    if(typeof v==='string')chars+=Math.min(v.length,cap);
    else if(typeof v==='number'||typeof v==='boolean')chars+=8;
    else if(v!==null&&typeof v==='object'&&!types.isProxy(v)&&depth<6){
      let seen=0;
      for(const k in v){
        if(!Object.prototype.hasOwnProperty.call(v,k))continue;
        if(++seen>200)break;
        chars+=k.length+4;
        const d=Object.getOwnPropertyDescriptor(v,k);
        if(d&&'value' in d)stack.push([d.value,depth+1]);
      }
    }
  }
  return Math.min(chars,cap);
}
const TOKEN_SCAN_BYTES=1_000_000;
function messageTokensImpl(msg){
  let tokens=8;
  // Strings are byte-scanned only within a shared budget; beyond it the O(1)
  // length is used (UTF-8 is at most 3 bytes per UTF-16 unit, so length/3*3
  // never underestimates bytes/3).
  let budget=TOKEN_SCAN_BYTES;
  const cost=s=>{
    let n;
    if(s.length<=budget){n=Buffer.byteLength(s,'utf8');budget-=s.length;}
    else{n=s.length*3;budget=0;}
    return Math.ceil(n/3)+4;
  };
  const raw=data(msg,'content');
  if(typeof raw==='string')tokens+=cost(raw);
  const parts=isArr(raw)?raw:[];
  const n=Math.min(parts.length,MAX_PARTS_PER_MESSAGE);
  for(let i=0;i<n;i++){
    const part=at(parts,i);
    if(!obj(part))continue;
    const ptext=data(part,'text');
    if(typeof ptext==='string')tokens+=cost(ptext);
    const res=data(part,'result'),rv=data(res,'value'),rc=data(res,'content');
    if(typeof res==='string')tokens+=cost(res);
    else if(typeof rv==='string')tokens+=cost(rv);
    else {
      for(const list of [rv,rc]){
        if(!isArr(list))continue;
        const m=Math.min(list.length,200);
        for(let j=0;j<m;j++){const item=at(list,j);const t=obj(item)?data(item,'text'):undefined;
          if(typeof t==='string')tokens+=cost(t);}
      }
    }
    const pt=data(part,'type');
    if(pt==='media'||pt==='image'||pt==='file')tokens+=4000;
    const so=data(data(part,'state'),'output');
    if(pt==='tool'&&typeof so==='string')tokens+=cost(so);
    const pin=data(part,'input');
    if(pin!==undefined)tokens+=Math.ceil(boundedChars(pin)/3)+4;
  }
  return tokens;
}
function eligibleTool(name, opts){
  return name && opts.pruneEligibleTools.includes(name) && !PROTECTED_NAME.test(name) && !WRITE_NAME.test(name);
}
const GIT_VALUE=new Set(['-C','-c','--git-dir','--work-tree','--namespace','--exec-path','--super-prefix','--config-env','--attr-source']);
const PATCH_FLAG=/^(?:--(?:patch|patch-with-stat|patch-with-raw|cc|remerge-diff|diff-merges|word-diff|color-words|full-diff|unified|textconv|ext-diff)(?:=|$)|-(?:[A-Za-z0-9]*[pucm]|L|U\d*)(?:\W|\w|$))/;
const STATUS_VERBOSE=/^(?:--verbose$|-[A-Za-z]*v)/;
const FILE_READERS=/\b(?:cat|head|tail|grep|egrep|fgrep|rg|less|more|sed|awk|nl|bat|tac|type|strings|xxd|od)\b/i;
const GIT_PATCH_SUBS=new Set(['log','reflog','whatchanged','stash','show-branch']);
function gitBase(w){return String(w).replace(/\\/g,'/').split('/').at(-1).replace(/\.(?:exe|cmd)$/i,'').toLowerCase();}
/** Git invocations that print patch/diff content, beyond the plain diff/show/blame set. */
function gitPatchCommand(cmd){
  for(const seg of splitSegments(cmd).slice(0,32)){
    const w=shellWords(seg).slice(0,64);
    let i=skipPrefixWords(w);
    if(i>=w.length||gitBase(w[i])!=='git')continue;
    i++;
    while(i<w.length&&w[i].startsWith('-'))i+=GIT_VALUE.has(w[i])?2:1;
    const sub=(w[i]??'').toLowerCase(),args=w.slice(i+1);
    if(sub==='request-pull'||sub==='diff-index'||sub==='diff-files'||sub==='cherry-pick'||sub==='format-patch')return true;
    if(sub==='status'&&args.some(a=>STATUS_VERBOSE.test(a)))return true;
    if(GIT_PATCH_SUBS.has(sub)&&args.some(a=>PATCH_FLAG.test(a)))return true;
  }
  return false;
}
/** Shell commands whose output may carry instructions, secrets or patches: never pruned. */
export function protectedShell(cmd){
  if(typeof cmd!=='string')return true;
  if(isProtectedCommand(cmd)||gitPatchCommand(cmd))return true;
  // head/tail/grep/rg/cat... of an instruction/secret file, not only the read tool.
  if(FILE_READERS.test(cmd)&&cmd.split(/[\s"'`=<>:;|&()]+/).some(t=>t&&INSTRUCTION_PATH.test(t)))return true;
  return false;
}
function readOnlyCommand(name,input){
  if(!['shell','bash'].includes(name)) return true;
  const cmd=safeString(data(input,'command'));
  if(!cmd || protectedShell(cmd))return false;
  // Semicolon, redirect, pipe and $() mean the command may have side effects.
  if(/[;|><`&\r\n]|\$\(|\$\{|\$[A-Za-z_]|\x00/.test(cmd))return false;
  if(!SAFE_SHELL.test(cmd))return false;
  return !mutatingArgs(argv(cmd.trim()));
}
function argv(cmd){
  return (cmd.match(/"[^"]*"|'[^']*'|\S+/g)??[]).map(t=>t.replace(/^(["'])(.*)\1$/,'$2'));
}
const GIT_BRANCH_READ=new Set(['-a','-r','-v','-vv','--all','--remotes','--verbose','--list','--show-current','--no-color','--color','--no-column']);
const FIND_MUTATING=new Set(['-delete','-exec','-execdir','-ok','-okdir','-fprint','-fprint0','-fprintf','-fls']);
const MUTATING={
  find:t=>FIND_MUTATING.has(t),
  eslint:t=>t==='--fix'||t==='--fix-type'||t==='--init',
  biome:t=>['init','migrate','--write','--apply','--apply-unsafe','--fix','--unsafe'].includes(t),
  prettier:t=>t==='--write'||t==='-w',
  tree:t=>/^-[^-]*o/.test(t),
  tsc:t=>t==='--init',
  rg:t=>t==='--pre'||t==='--hostname-bin',
  jest:t=>t==='-u'||t==='--updateSnapshot'||t==='--update-snapshot'||t==='--init'||/^--clear-?cache$/i.test(t),
  vitest:t=>t==='-u'||t==='--update'||t==='--update-snapshot'||t==='--update-snapshots',
  pytest:t=>t==='--snapshot-update'||t==='--force-regen'||t==='--cache-clear'||t==='--basetemp',
};
/** Argv-aware rejection of mutating flags/subcommands in otherwise allowlisted programs. */
function mutatingArgs(tokens){
  const prog=(tokens[0]??'').toLowerCase();
  const rest=tokens.slice(1).map(t=>t.split('=')[0]);
  if(prog==='cargo')return rest.some(t=>t==='--fix'||t==='--allow-dirty');
  if(prog==='git'){
    if(rest[0]==='branch')return rest.slice(1).some(t=>!GIT_BRANCH_READ.has(t));
    return rest.some(t=>t==='--output'||t==='--ext-diff'||t==='--textconv');
  }
  const check=MUTATING[prog];
  if(check&&rest.some(check))return true;
  if(/^(?:npm|pnpm|bun|yarn)$/.test(prog)){
    if(rest.some(t=>/^(?:-u|--update\w*|--update-snapshots?|--fix\w*|--write|--init|--clear-?cache|--cache-clear|--basetemp)$/i.test(t)))return true;
    const at=rest[0]==='run'||rest[0]==='run-script'?1:0;
    return /(?:fix|update|write|init|migrate|clean|reset)/i.test(rest[at]??'');
  }
  return false;
}
function pathOf(input){
  return safeString(data(input,'path')??data(input,'filePath')??data(input,'file_path')??data(input,'directory')??'.')||'.';
}
/** Default number of lines a read returns when no limit/endLine is given. */
export const READ_DEFAULT_LINES=2000;
function readRange(input){
  const num=v=>typeof v==='number'&&Number.isFinite(v)?v:undefined;
  const start=num(data(input,'offset')??data(input,'startLine')??data(input,'start_line'))??0;
  const limit=num(data(input,'limit')??data(input,'lineCount')??data(input,'count'));
  const endLine=num(data(input,'endLine')??data(input,'end_line'));
  // Fail closed on a nonsensical range: no coverage claim.
  if(start<0||(limit!==undefined&&limit<=0))return null;
  const end=limit!==undefined?start+limit:endLine!==undefined?endLine:start+READ_DEFAULT_LINES;
  return {start,end};
}
const KEY_SKIP=new Set(['description','timeout','id','workdir','cwd']);
const READ_SKIP=new Set([...KEY_SKIP,'offset','limit','startLine','start_line','lineCount','count','endLine','end_line']);
const KEY_MAX=512;
/** Small own-data walk with hard budgets; false when the value is not small and plain. */
function smallJson(v,budget){
  let nodes=0;
  const walk=(x,d)=>{
    if(--budget.n<0||++nodes>64||d>4)return false;
    if(typeof x==='string'){budget.n-=x.length;return budget.n>=0;}
    if(x===null||typeof x==='number'||typeof x==='boolean')return true;
    if(typeof x!=='object')return false;
    if(Array.isArray(x)){
      if(x.length>32)return false;
      for(let i=0;i<x.length;i++)if(!walk(x[i],d+1))return false;
      return true;
    }
    let seen=0;
    for(const k in x){
      if(!Object.prototype.hasOwnProperty.call(x,k))continue;
      if(++seen>32)return false;
      const dsc=Object.getOwnPropertyDescriptor(x,k);
      if(!dsc||!('value' in dsc)||!walk(dsc.value,d+1))return false;
      budget.n-=k.length;
    }
    return budget.n>=0&&typeof x.toJSON!=='function';
  };
  return walk(v,0);
}
/**
 * Every other input field is an effective query option and participates in the
 * key. Returns unambiguous [name,type,text] triples (never joined by a
 * delimiter), or null when the input is not small and plain.
 */
function effective(input,skip){
  const out=[];let size=0;
  const keys=Object.keys(input);
  if(keys.length>64)return null;
  for(const k of keys.sort()){
    if(k.length>KEY_MAX)return null;
    if(skip.has(k))continue;
    const d=Object.getOwnPropertyDescriptor(input,k);
    if(!d||!('value' in d))return null;
    const v=d.value;
    if(v===undefined||v===null)continue;
    let triple;
    if(typeof v==='object'){
      if(!smallJson(v,{n:KEY_MAX}))return null;
      let j;try{j=JSON.stringify(v);}catch{return null;}
      if(typeof j!=='string')return null;
      triple=[k,'j',j];
    }else if(typeof v==='string'){
      if(v.length>KEY_MAX)return null;
      triple=[k,'s',v];
    }else if(typeof v==='number'||typeof v==='boolean'){
      triple=[k,typeof v==='number'?'n':'b',String(v)];
    }else return null;
    size+=triple[0].length+triple[2].length+2;
    if(size>KEY_MAX)return null;
    out.push(triple);
  }
  return out;
}
/** Key is JSON of a structured tuple, so no field value can collide with another field's delimiter. */
function supersessionKey(name,input){
  const wd=safeString(data(input,'workdir')),cw=safeString(data(input,'cwd'));
  if(wd.length>KEY_MAX||cw.length>KEY_MAX)return '';
  const scope=[wd,cw];
  let parts=null;
  if(name==='read'||name==='ls'||name==='list'){
    // Only a read has range coverage; other tools' limit/offset/count is query identity.
    const extra=effective(input,new Set([...(name==='read'?READ_SKIP:KEY_SKIP),'path','filePath','file_path','directory']));
    const p=pathOf(input);
    if(extra===null||p.length>KEY_MAX)return '';
    parts=[name,scope,p,extra];
  } else if(['grep','glob','search','find'].includes(name)) {
    const opts=effective(input,KEY_SKIP);
    if(opts===null)return '';
    parts=[name,scope,opts];
  } else if(name==='shell'||name==='bash'){
    const cmd=safeString(data(input,'command')).trim().replace(/\s+/g,' ');
    if(cmd.length>KEY_MAX||!SAFE_SHELL.test(cmd))return '';
    const opts=effective(input,new Set([...KEY_SKIP,'command']));
    if(opts===null)return '';
    parts=[name,scope,opts,cmd];
  }
  if(!parts)return '';
  const key=JSON.stringify(parts);
  return key.length<=KEY_MAX*4?key:'';
}
/** True only when later has enough evidence to make earlier redundant. */
function supersedes(later, earlier){
  if(!later?.supKey||later.supKey!==earlier?.supKey)return false;
  if(later.name!=='read')return true;
  const a=earlier.range,b=later.range;
  if(!a||!b)return false;
  return b.start<=a.start && b.end>=a.end;
}
/** True when any metadata holder on part/result/state/message is mesh-protected (with provenance check when ledger exists). */
export function isTrimMeshProtected(part, msg, sessionID){
  const sid=typeof sessionID==='string'&&sessionID?sessionID:'';
  const ledger=sid?globalThis[MESH_SYMBOL]?.provenanceBySession?.get?.(sid):undefined;
  const hasLedger=ledger instanceof Map && ledger.size>0;
  const holders=[part,data(part,'result'),data(part,'state'),data(part,'payload'),msg,data(msg,'payload'),data(msg,'state')];
  for(const h of holders){
    if(!obj(h)||trapped(h))continue;
    const metas=[data(h,'metadata'),h];
    for(const m of metas){
      if(!obj(m)||trapped(m))continue;
      if(!isMeshProtectedPart({metadata:m}))continue;
      const env=obj(data(m,MESH_METADATA_KEY))?data(m,MESH_METADATA_KEY):undefined;
      const tok=typeof data(env,'token')==='string'?data(env,'token'):(typeof data(m,'opencode-guardian-provenance')==='string'?data(m,'opencode-guardian-provenance'):'');
      if(hasLedger&&tok&&!verifyMeshMetadata(sid,{metadata:m}))continue;
      return true;
    }
  }
  return false;
}
/** Pair by call id in source order, never join an unrelated earlier assistant call. */
function candidates(event,opts){
  const messages=event?.messages;
  if(!Array.isArray(messages)||messages.length>10000)return [];
  const pending=new Map();const out=[];let totalParts=0;
  for(let mi=0;mi<messages.length;mi++) {
    const msg=at(messages,mi);
    if(!obj(msg)||trapped(msg))continue;
    const content=data(msg,'content');
    if(!isArr(content))continue;
    // Hard content-part budget: an over-budget message is never touched, and an
    // over-budget request stops collecting (fail closed).
    if(content.length>MAX_PARTS_PER_MESSAGE)continue;
    totalParts+=content.length;
    if(totalParts>MAX_PARTS_TOTAL)break;
    const rawId=data(msg,'id');
    const msgId=typeof rawId==='string'?rawId:'';
    const role=data(msg,'role');
    for(let pi=0;pi<content.length;pi++){
      const part=at(content,pi);if(!obj(part))continue;
      const type=data(part,'type');
      const pid=data(part,'id');
      if(type==='tool-call'&&typeof pid==='string') {
        const queue=pending.get(pid)??[];
        queue.push({name:safeString(data(part,'name')).toLowerCase(),input:getInput(part),mi});
        pending.set(pid,queue);
        continue;
      }
      if(type!=='tool-result'&&type!=='tool')continue;
      const callId=pid??data(part,'callID');
      const queue=typeof callId==='string'?pending.get(callId):undefined;
      const call=queue?.shift();
      // A split native tool-result without its own matching invocation is not
      // safe to transform: another tool may have reused the call ID.
      if(type==='tool-result' && !call)continue;
      if(isTrimMeshProtected(part,msg,event?.sessionID))continue;
      const name=(safeString(data(part,'name')??data(part,'tool')??call?.name)).toLowerCase();
      if(role==='user'||!eligibleTool(name,opts)||failure(part))continue;
      if(type==='tool'&&data(data(part,'state'),'status')!=='completed')continue;
      const input=call?.input??getInput(part);
      if(trapped(input))continue;
      if(name === 'read' && INSTRUCTION_PATH.test(pathOf(input)))continue;
      if(!readOnlyCommand(name,input))continue;
      const a=accessor(part);if(!a)continue;
      const text=a.get();
      if(typeof text!=='string'||!text||text===PRUNED||text.length<opts.pruneMinResultChars||structured(text)||diagnosticText(text))continue;
      // Stable across appends and history compaction: never include a row index.
      const id=`${name}:${safeString(callId)||'?'}:${fingerprint(text)}:${msgId}`;
      out.push({id,mi,pi,name,input,accessor:a,length:text.length,
        supKey:supersessionKey(name,input),
        range:name==='read'?readRange(input):undefined,
        original:text});
    }
  }
  return out;
}
/** Called with an outgoing-only draft. plannedDrops contains stable per-session result keys. */
export function pruneContext(event,options,settings={}) {
  if(!options.pruning||!Array.isArray(event?.messages))
    return {pruned:0,removedChars:0,reason:'disabled',plannedIds:[]};
  const entries=candidates(event,options);
  const keep=new Set(entries.slice(-options.keepRecentToolResults).map(x=>x.id));
  const tail=Math.max(0,event.messages.length-options.protectRecentMessages);
  // Guard a recent *token-sized* tail as well as a message-count tail. Actual
  // provider tokenization is unavailable here; byte/3 is a conservative
  // request-budget approximation. Keep at least the final message.
  const usableTokens=settings.pressure?.usableTokens;
  const derived=Number.isFinite(usableTokens)&&usableTokens>0
    ? Math.min(48000,Math.ceil(usableTokens*0.06)) : 0;
  const cap=Number.isFinite(usableTokens)&&usableTokens>0
    ? Math.max(1024,Math.floor(usableTokens*0.25)) : Infinity;
  const protectedTokens=Math.min(cap,Math.max(options.protectRecentTokens??4096,derived));
  let tokenTail=event.messages.length-1, accumulated=0;
  for(let i=event.messages.length-1;i>=0;i--){
    accumulated+=messageTokens(at(event.messages,i));tokenTail=i;
    if(accumulated>=protectedTokens)break;
  }
  const protectedEntry=e=>e.mi>=tail||e.mi>=tokenTail||keep.has(e.id);
  const total=entries.reduce((sum,e)=>sum+e.length,0);
  const plannedDrops=settings.plannedDrops instanceof Set?settings.plannedDrops:new Set();
  const newDrops=settings.allowNewDrops!==false;
  const pressure=settings.pressure?.ratio;
  const normalizedRatio=typeof pressure==='number' && Number.isFinite(pressure)?pressure:0;
  const force=normalizedRatio>=options.pressureForceRatio;
  const critical=normalizedRatio>=options.pressureCriticalRatio;
  const dueToSize=total>options.pruneAfterToolChars*1.25;
  const dueToPressure=normalizedRatio>=options.pressureStartRatio && !settings.pressure?.mediaPresent;
  // Supersession needs coverage evidence, not merely a similar path or command.
  const groups=new Map();
  for(const e of entries){if(!e.supKey)continue;const arr=groups.get(e.supKey)??[];arr.push(e);groups.set(e.supKey,arr);}
  const superseded=[];
  for(const arr of groups.values()){
    for(let i=0;i<arr.length-1;i++){
      const earlier=arr[i];
      if(protectedEntry(earlier))continue;
      for(let j=i+1;j<arr.length;j++){
        if(supersedes(arr[j],earlier)){superseded.push(earlier);break;}
      }
    }
  }
  const supersessionMass=superseded.reduce((n,e)=>n+e.length,0);
  const dueToSupersession=supersessionMass>=options.supersessionMinChars;
  const canReclaim=newDrops&&(dueToSize||dueToPressure||dueToSupersession);
  const target=critical?Math.floor(options.pruneAfterToolChars*0.4):force?Math.floor(options.pruneAfterToolChars*0.6):
    Math.floor(options.pruneAfterToolChars*0.8);
  const supersededSet=new Set(superseded.map(e=>e.id));
  const ordered=[...superseded,...entries.filter(e=>!supersededSet.has(e.id))];
  // Translate estimated excess token mass into an approximate byte-reclaim
  // target. Never claim exact provider usage or touch protected content.
  const pressureGoal=critical?Math.max(0.35,options.pressureStartRatio-0.15):
    force?Math.max(0.4,options.pressureStartRatio-0.10):
    Math.max(0.45,options.pressureStartRatio-0.05);
  const needChars=dueToPressure && Number.isFinite(usableTokens) && usableTokens>0
    ? Math.max(0,Math.ceil((normalizedRatio-pressureGoal)*usableTokens*3)) : 0;
  const operations=[];let remaining=total;let reduction=0;
  const applied=new Set();
  for(const e of ordered){
    if(protectedEntry(e)||e.length<=PRUNED.length||applied.has(e.id))continue;
    const already=plannedDrops.has(e.id);
    const obsolete=supersededSet.has(e.id);
    const pressureTarget=dueToSize||dueToPressure;
    const selected=already || (canReclaim && ((obsolete && dueToSupersession)|| (pressureTarget&&(remaining>target||reduction<needChars))));
    if(!selected)continue;
    operations.push(e);applied.add(e.id);remaining-=e.length-PRUNED.length;reduction+=e.length-PRUNED.length;
  }
  let removedChars=0;const committed=[];
  try {
    for(const e of operations) {
      if(e.accessor.get()!==e.original)continue;
      e.accessor.set(PRUNED);committed.push(e);removedChars+=e.length-PRUNED.length;
    }
  } catch (cause) {
    // A later plugin may have frozen a message; never leave a partial rewrite.
    for(const e of committed.reverse()) {try{e.accessor.set(e.original);}catch{/* immutable after commit */}}
    throw cause;
  }
  const reason=committed.length?'pruned':!newDrops?'cache-deferred':
    !(dueToSize||dueToPressure||dueToSupersession)?'below-pressure':'no-safe-target';
  return {pruned:committed.length,removedChars,reason,plannedIds:committed.map(e=>e.id),
    eligibleChars:total,estimatedContextRatio:settings.pressure?.ratio};
}
