/** Command-aware, declarative, bounded line filters. No shell command execution. */
import {isProtectedGit} from './git.ts';
import {isImportantLine,isExitNotice} from './diagnostics.ts';

export interface FilterApplicationResult {
  text: any;
  dropped: number;
  program?: string;
}

const DIAGNOSTIC=/\b(?:fail(?:ed|ure)?|error|exception|fatal|panic|traceback|assertion|denied|unauthorized|warning|warn|deprecated|security|permission|vulnerab|critical|high severity|CVE-\d{4})\b|\bTS\d{4}\b|\bE\d{3,}\b|✗|❌/i;
const SUMMARY=/(?:^\s*(?:Test Files|Test Suites:|Tests|Ran|BUILD\s+(?:SUCCESSFUL|FAILED)|Found\s+\d+\s+errors?|Checked\s+\d+\s+files?|Code style|Successfully installed|Installed\s+\d+\s+packages?|=+\s*\d+\s+(?:passed|failed)|exit\s*(?:code|status)|finished|completed|success|done)\b|\b\d+\s+(?:passed|failed|skipped|warnings?|errors?)\b)/im;
const PATH=/\b(?:[\w.-]{1,120}[/\\]){1,16}[\w.-]{1,120}(?::\d+(?::\d+)?)?/;
const STACK=/\bat\s+\S[^\n]{0,300}?:\d+(?::\d+)?\b|^\s*File\s+"[^"\n]{1,300}",\s+line\s+\d+|^\s*Caused by:/i;
const BUILTINS: Record<string, RegExp[]> = {
  npm:[/^\s*(?:npm (?:notice|sill|verb)\b|\[={3,}>+\]\s*\d+%)/i],
  pnpm:[/^\s*(?:Progress:|Packages:\s+[+\-]|Downloading\s+\d)/i],
  bun:[/^\s*(?:Resolved:\s+\d+|Downloaded:\s+\d+|\[\d+\/\d+\]\s+installing)/i],
  cargo:[/^\s*Compiling\s+[\w-]+\s+v\d+[^\n]*$/i, /^\s*Downloading\s+[\w-]+\s+v\d+/i],
  docker:[/^\s*(?:\d+(?:\.\d+)?%|Pulling fs layer|Waiting|Downloading|Extracting)\s*$/i],
  kubectl:[/^\s*\.+\s*$/],
  pip:[/^\s*(?:Downloading|Installing collected packages|Collecting)\s+[\w_.-]+/i],
  uv:[/^\s*(?:Resolved|Prepared|Audited)\s+\d+\s+packages?\b/i],
  gradle:[/^\s*> Task\s+:[\w:-]+\s+UP-TO-DATE\s*$/i],
  make:[/^\s*make\[\d+\]: (?:Entering|Leaving) directory\b/i],
  terraform:[/^\s*Refreshing state\.\.\.\s*$/i],
  curl:[/^\s*%\s+Total\s+%\s+Received\s+%\s+Xferd\b/i],
  wget:[/^\s*\d+%\s+\[=+>?.*\]\s*\d+/],
  xcodebuild:[/^\s*CompileAssetCatalogVariant\s+.*\bnormal\b/],
  helm:[/^\s*Pulled:\s+[^\s]+\s*$/],
  ansible:[/^\s*skipping:\s+\[[^\]]+\]\s*$/i],
  aws:[/^\s*upload:\s+.*\s+to\s+.*\s+\(.*\)$/i],
  psql:[/^\s*NOTICE:\s+relation\s+.*\s+already exists, skipping\s*$/i],
  deno:[/^\s*Download\s+https?:\/\/\S+\s*$/],
  gh:[/^\s*✓\s+Downloaded\s+.*\s*$/],
  prettier:[/^\s*Checking formatting\.\.\.\s*$/i],
  playwright:[/^\s*Running\s+\d+\s+tests?\s+using\s+\d+\s+workers?\s*$/i],
  next:[/^\s*○\s+Compiling.*$/],
  go:[/^\s*go:\s+downloading\s+[^\n]+$/],
  pytest:[/^\s*\.{20,}(?:\s+\[\s*\d+%\])?\s*$/],
};
const PROTECTED_INPUT=/(?:^|\s)(?:git\s+(?:diff|show|blame|apply|patch)|openssl\b|gpg\b|base64\b|ssh-keygen\b|cat\s+[^|;]+(?:\.pem|\.key|\.env)\b|\b(?:head|tail|more|less|grep|rg|cat|sed|awk|nl|bat)\b[^|;&\n]*(?:\.env(?:\.\w+)?|\.pem|\.key|\.npmrc|\.netrc|id_(?:rsa|ed25519|ecdsa|dsa)(?:_sk)?|secrets\.json)(?![\w.-]))/i;
const DECLARATIVE=Object.freeze(['program','dropPrefixes','dropExact']);
export function programOf(command: unknown): string {
  if(typeof command!=='string') return '';
  // Inspect known executable tokens, never evaluate shell syntax or mutate command text.
  const tokens=command.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g)?.slice(0,24)??[];
  for(let i=0;i<tokens.length;i++) {
    const token=(tokens[i].replace(/^['"]|['"]$/g,'').replace(/\\/g,'/').split('/').at(-1)??'').replace(/\.(?:exe|cmd)$/i,'').toLowerCase();
    if(token==='python'||token==='python3') {
      if(tokens[i+1]==='-m'&&tokens[i+2]==='pytest') return 'pytest';
    }
    if(token==='npx'||token==='bunx'||token==='exec'||token==='run') continue;
    if(['npm','pnpm','bun','cargo','docker','kubectl','pip','uv','gradle','make','terraform','curl','wget','pytest','vitest','jest','tsc','eslint','biome','go','git','ruff','next','prettier','playwright','xcodebuild','helm','ansible','aws','psql','deno','gh'].includes(token)) return token;
  }
  return '';
}
export function hasDiagnostic(line: string): boolean {return DIAGNOSTIC.test(line)||SUMMARY.test(line)||STACK.test(line)||isImportantLine(line);}
export function hasFailure(line: string): boolean {return DIAGNOSTIC.test(line) && /\b(?:fail(?:ed|ure)?|error|exception|fatal|panic|traceback|assertion|denied|unauthorized|vulnerab|CVE-\d{4})\b|\bTS\d{4}\b/i.test(line);}
export function hasImportantPath(line: string): boolean {return PATH.test(line)||STACK.test(line);}
export function isProtectedCommand(command: unknown): boolean {return typeof command==='string'&&(PROTECTED_INPUT.test(command)||isProtectedGit(command));}
/** Drops only user-configured filterRules lines for `programs` (a program name or list). Diagnostics, summaries and anchors are always kept. */
export function applyCustomRules(programs: string | string[], text: unknown, options: any): FilterApplicationResult {
  const names=new Set([programs].flat().filter(Boolean));
  const rules=(options.filterRules??[]).filter((x: any)=>names.has(x.program));
  if(!rules.length||typeof text!=='string') return {text,dropped:0};
  const keep=[];let dropped=0;
  for(const line of text.split('\n')) {
    const t=line.trim();
    if(!t||isExitNotice(line)||hasDiagnostic(line)||hasImportantPath(line)) {keep.push(line);continue;}
    if(rules.some((r: any)=>r.dropExact.includes(t)||r.dropPrefixes.some((x: string)=>t.startsWith(x)))) dropped++;
    else keep.push(line);
  }
  if(!dropped||!keep.some(x=>x.trim())) return {text,dropped:0};
  return {text:`[${dropped} low-value lines omitted]\n${keep.join('\n')}`,dropped};
}
export function applyLineFilters(command: unknown, text: string, options: any): FilterApplicationResult {
  const program=programOf(command);
  const patterns=BUILTINS[program]??[];
  const rules=(options.filterRules??[]).filter((x: any)=>x.program===program);
  if(!patterns.length&&!rules.length) return {text,dropped:0,program};
  const lines=text.split('\n');
  let dropped=0;
  const keep=[];
  for(const line of lines) {
    const t=line.trim();
    // Always preserve diagnostics, result summaries and file-path anchors.
    if(isExitNotice(line)||hasDiagnostic(line)||hasImportantPath(line)||!t) {keep.push(line);continue;}
    const builtin=patterns.some((re: RegExp)=>re.test(line));
    const custom=rules.some((r: any)=>r.dropExact.includes(t)||r.dropPrefixes.some((x: string)=>t.startsWith(x)));
    if(builtin||custom) dropped++;
    else keep.push(line);
  }
  if(!dropped||!keep.some(x=>x.trim())) return {text,dropped:0,program};
  // Show that content was withheld. Exact line counts are retained.
  return {text:`[${dropped} low-value lines omitted]\n${keep.join('\n')}`,dropped,program};
}
export const BUILTIN_PROGRAMS=Object.freeze(Object.keys(BUILTINS));
