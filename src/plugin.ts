import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, normalize as normalizePath, posix as posixPath, relative as relativePath, resolve as resolvePath, win32 as win32Path } from 'node:path';
import { parseOptions } from './config.ts';
import { isExitNotice } from './diagnostics.ts';
import { compressOutput, dedupToolOutput } from './compress.ts';
import { pruneContext } from './prune.ts';
import { setupMemory, memoryDbBytes } from './memory.ts';
import { createTrimStats } from './stats.ts';
import { TRIM_STATS_RPC } from './stats-rpc.ts';
import { ContextCache } from './cache.ts';
import { discoverModelLimits, ensureModelLimit, estimateRequest } from './pressure.ts';
import { registerMeshPeer, wasMeshBounded, forgetMeshSession, MESH_METADATA_KEY } from './bridge.ts';

export interface ActiveFileEntry {
  path: string;
  action: string;
  count: number;
  lastSeen: number;
}
export interface OpenErrorEntry {
  category: string;
  command: string;
  summary: string;
  status: 'open' | 'resolved';
  count: number;
  lastSeen: number;
}
export interface WorkingStateSnapshot {
  activeFiles: ActiveFileEntry[];
  openErrors: OpenErrorEntry[];
}
export interface PrunedDiagnosticsResult {
  metadata: any;
  removedFiles: number;
  changed: boolean;
}

const SHELL_TOOLS=new Set(['shell','bash']);
const LIST_TOOLS=new Set(['grep','glob','ls','list','find']);
const EDIT_TOOLS=new Set(['edit','write','apply_patch']);
const EXIT_NOTICE=/(?:exit\s*code|timed out|interrupted|killed|failed)/i;
const COMPACTION_EVENTS=Object.freeze(['session.compaction.started','session.compaction.ended','session.compaction.failed']);

/** Tighten output line/char caps when session context pressure reaches force/critical bands. */
export function effectiveToolOptions<T extends Record<string, any>>(options: T, pressureRatio?: number): T {
  if (!options || typeof pressureRatio !== 'number' || !Number.isFinite(pressureRatio)) return options;
  let scale = 1;
  if (pressureRatio >= options.pressureCriticalRatio) scale = 0.5;
  else if (pressureRatio >= options.pressureForceRatio) scale = 0.7;
  if (scale >= 1) return options;
  const maxOutputLines = Math.max(20, Math.round(options.maxOutputLines * scale));
  const maxOutputChars = Math.max(2000, options.minOutputChars, Math.round(options.maxOutputChars * scale));
  return { ...options, maxOutputLines, maxOutputChars };
}

/** Shorten absolute project directory prefix in built-in read tool header without touching file content. */
export function compactReadEnvelope(text: string, directory?: string): string {
  if (typeof text !== 'string' || typeof directory !== 'string' || !directory) return text;
  const m = text.match(/^Read file ([^\n]+?)(, lines \d+-\d+)?\n/);
  if (!m) return text;
  const absPath = normalizePath(m[1]);
  const rel = relativePath(directory, absPath).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return text;
  return `Read file ${rel}${m[2] ?? ''}\n${text.slice(m[0].length)}`;
}

const MAX_RING_SESSIONS = 64;
export class ToolDedupeRing {
  windowSize: number;
  minChars: number;
  rings: Map<string, any[]>;
  seq: Map<string, number>;
  constructor(windowSize: number = 4, minChars: number = 800) {
    this.windowSize = Math.max(0, Math.trunc(windowSize));
    this.minChars = Math.max(200, Math.trunc(minChars));
    this.rings = new Map();
    this.seq = new Map();
  }
  check(sessionID: string, tool: string, command: string, text: string): string | null {
    if (!sessionID || this.windowSize <= 0 || tool === 'read' || typeof text !== 'string' || text.length < this.minChars) return null;
    let ring = this.rings.get(sessionID);
    if (ring) {
      this.rings.delete(sessionID);
      this.rings.set(sessionID, ring);
    } else {
      ring = [];
      if (this.rings.size >= MAX_RING_SESSIONS) this.rings.delete(this.rings.keys().next().value as string);
      this.rings.set(sessionID, ring);
    }
    const callSeq = (this.seq.get(sessionID) ?? 0) + 1;
    this.seq.set(sessionID, callSeq);
    const hash = createHash('sha256').update(`${tool}\0${command ?? ''}\0${text}`).digest('hex').slice(0, 24);
    const match = ring.find((e) => e.tool === tool && e.hash === hash && !e.stubbed);
    if (match) {
      const callsBack = Math.max(1, callSeq - match.seq);
      ring.push({ seq: callSeq, tool, hash, chars: text.length, stubbed: true });
      if (ring.length > this.windowSize) ring.splice(0, ring.length - this.windowSize);
      return `[opencode-trim: ${text.length} chars withheld — byte-identical ${tool} output from ${callsBack} call${callsBack === 1 ? '' : 's'} ago still in context (verified by content hash)]`;
    }
    ring.push({ seq: callSeq, tool, hash, chars: text.length, stubbed: false });
    if (ring.length > this.windowSize) ring.splice(0, ring.length - this.windowSize);
    return null;
  }
  reset(sessionID?: string): void {
    if (!sessionID) return;
    this.rings.delete(sessionID);
    this.seq.delete(sessionID);
  }
  clear(): void {
    this.rings.clear();
    this.seq.clear();
  }
}

function normDiagPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  if (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)) {
    return `win:${win32Path.normalize(value).replace(/\\/g, '/').replace(/^[A-Z]:/, (d) => d.toLowerCase())}`;
  }
  if (value.startsWith('/')) return `posix:${posixPath.normalize(value)}`;
  return null;
}

function resolveDiagFile(value: unknown, directory?: string): string | null {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  const base = normDiagPath(directory);
  if (base?.startsWith('posix:')) {
    if (value.includes('\\')) return null;
    return normDiagPath(posixPath.isAbsolute(value) ? value : posixPath.join(directory as string, value));
  }
  if (base?.startsWith('win:') && /^[\\/]/.test(value) && !/^\\\\[^\\]+\\[^\\]+/.test(value)) return null;
  const direct = normDiagPath(value);
  if (direct) return direct;
  if (/^[a-z]:/i.test(value) || !base) return null;
  if (base.startsWith('win:')) return normDiagPath(win32Path.resolve(directory as string, value));
  if (value.includes('\\')) return null;
  return normDiagPath(posixPath.resolve(directory as string, value));
}

function editedTargetSet(tool: string, input: any, metadata: any, directory?: string): Set<string> | null {
  if (tool === 'edit' || tool === 'write') {
    const raw = obj(input) ? (input.filePath ?? input.path ?? input.file_path) : null;
    const f = resolveDiagFile(raw, directory);
    return f ? new Set([f]) : null;
  }
  if (tool === 'apply_patch') {
    if (obj(metadata) && Array.isArray(metadata.files) && metadata.files.length) {
      const set = new Set<string>();
      for (const entry of metadata.files) {
        if (!obj(entry) || !['add', 'update', 'delete', 'move'].includes(entry.type)) return null;
        if (entry.type !== 'move' && entry.movePath !== undefined) return null;
        const orig = resolveDiagFile(entry.filePath, directory);
        if (!orig) return null;
        set.add(orig);
        if (entry.type === 'move') {
          const dest = resolveDiagFile(entry.movePath, directory);
          if (!dest) return null;
          set.add(dest);
        }
      }
      return set.size ? set : null;
    }
    const raw = obj(input) ? (input.filePath ?? input.path ?? input.file_path) : null;
    const f = resolveDiagFile(raw, directory);
    return f ? new Set([f]) : null;
  }
  return null;
}

function safeJsonLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Keep LSP diagnostics only for files touched by edit/write/apply_patch; preserve non-file keys and metadata. */
export function pruneEditDiagnostics(tool: string, input: any, metadata: any, directory?: string): PrunedDiagnosticsResult {
  const unchanged = { metadata, removedFiles: 0, changed: false };
  if (!EDIT_TOOLS.has(tool) || !obj(metadata) || !obj(metadata.diagnostics)) return unchanged;
  const targets = editedTargetSet(tool, input, metadata, directory);
  if (!targets) return unchanged;
  const kept = [];
  let removedFiles = 0;
  for (const [key, val] of Object.entries(metadata.diagnostics)) {
    const norm = resolveDiagFile(key, directory);
    if (norm && !targets.has(norm)) removedFiles++;
    else kept.push([key, val]);
  }
  if (!removedFiles) return unchanged;
  return {
    metadata: { ...metadata, diagnostics: Object.fromEntries(kept) },
    removedFiles,
    changed: true,
  };
}

function classifyShellCategory(command: unknown): string {
  const cmd = String(command ?? '').trim().toLowerCase();
  if (/\b(?:test|vitest|jest|pytest|mocha|ava|cargo\s+test|go\s+test)\b/.test(cmd)) return 'test';
  if (/\b(?:tsc|typecheck|pyright|mypy|vue-tsc)\b/.test(cmd)) return 'typecheck';
  if (/\b(?:eslint|biome|lint|ruff|clippy|flake8)\b/.test(cmd)) return 'lint';
  if (/\b(?:build|compile|webpack|vite\s+build|cargo\s+build|go\s+build)\b/.test(cmd)) return 'build';
  return 'shell';
}

export class SessionWorkingState {
  maxSessions: number;
  maxFiles: number;
  maxErrors: number;
  sessions: Map<string, { files: Map<string, ActiveFileEntry>; errors: Map<string, OpenErrorEntry> }>;
  constructor(maxSessions: number = 64, maxFiles: number = 32, maxErrors: number = 16) {
    this.maxSessions = maxSessions;
    this.maxFiles = maxFiles;
    this.maxErrors = maxErrors;
    this.sessions = new Map();
  }
  #ensure(sessionID: string) {
    let s = this.sessions.get(sessionID);
    if (s) {
      this.sessions.delete(sessionID);
      this.sessions.set(sessionID, s);
      return s;
    }
    if (this.sessions.size >= this.maxSessions) {
      this.sessions.delete(this.sessions.keys().next().value as string);
    }
    s = { files: new Map(), errors: new Map() };
    this.sessions.set(sessionID, s);
    return s;
  }
  recordTool(sessionID: string, event: any, exitCode?: number, directory?: string): void {
    if (typeof sessionID !== 'string' || !sessionID || !obj(event)) return;
    const tool = typeof event.tool === 'string' ? event.tool : '';
    const state = this.#ensure(sessionID);
    const now = Date.now();
    if (['read', 'grep', 'edit', 'write', 'apply_patch'].includes(tool)) {
      const raw = obj(event.input) ? (event.input.filePath ?? event.input.path ?? event.input.file_path) : null;
      if (typeof raw === 'string' && raw && !raw.includes('\0')) {
        let rel = raw;
        if (typeof directory === 'string' && directory && isAbsolute(raw)) {
          const r = relativePath(directory, normalizePath(raw)).replace(/\\/g, '/');
          if (r && !r.startsWith('..') && !isAbsolute(r)) rel = r;
        }
        const prev = state.files.get(rel);
        state.files.delete(rel);
        if (state.files.size >= this.maxFiles) state.files.delete(state.files.keys().next().value as string);
        state.files.set(rel, {
          path: rel,
          action: tool,
          count: (prev?.count ?? 0) + 1,
          lastSeen: now,
        });
      }
    }
    if (SHELL_TOOLS.has(tool)) {
      const cmd = typeof event.input?.command === 'string' ? event.input.command.trim() : '';
      const category = classifyShellCategory(cmd);
      if (typeof exitCode === 'number' && exitCode !== 0) {
        const rawOut = typeof event.result?.content === 'string' ? event.result.content : '';
        const summary = rawOut.split('\n').find((l: string) => l.trim())?.slice(0, 160) ?? `exit ${exitCode}`;
        const prev = state.errors.get(category);
        state.errors.delete(category);
        if (state.errors.size >= this.maxErrors) state.errors.delete(state.errors.keys().next().value as string);
        state.errors.set(category, {
          category,
          command: cmd.slice(0, 160),
          summary,
          status: 'open',
          count: (prev?.count ?? 0) + 1,
          lastSeen: now,
        });
      } else if (exitCode === 0) {
        const prev = state.errors.get(category);
        if (prev && prev.status === 'open') {
          state.errors.set(category, { ...prev, status: 'resolved', lastSeen: now });
        }
      }
    }
  }
  snapshot(sessionID: string): WorkingStateSnapshot {
    const s = this.sessions.get(sessionID);
    if (!s) return { activeFiles: [], openErrors: [] };
    return {
      activeFiles: [...s.files.values()],
      openErrors: [...s.errors.values()],
    };
  }
  reset(sessionID?: string): void {
    if (!sessionID) return;
    this.sessions.delete(sessionID);
  }
  clear() {
    this.sessions.clear();
  }
}
function obj(value: unknown): value is Record<string, any> {return value!==null&&typeof value==='object'&&!Array.isArray(value);}
// Tool hook events are not guaranteed to carry a session id on every host revision; stats skip what they cannot attribute.
function toolSessionOf(event: any): string | undefined {
  for(const v of [event?.sessionID,event?.sessionId,event?.session?.id,event?.context?.sessionID]) if(typeof v==='string'&&v)return v;
  return undefined;
}
function exitCode(event: any): number | undefined {
  // V2 shell puts the real code in result.output.exitCode; metadata may carry
  // only tool status. Any nonzero candidate wins; sources are ordered so the
  // structured output beats metadata, independent of object key order.
  let zero;
  for(const v of [event?.result?.output,event?.result,event?.result?.metadata,event?.input]) {
    if(!obj(v))continue;
    for(const key of ['exitCode','exit_code','exit']){
      const n=v[key];
      if(!Number.isSafeInteger(n))continue;
      if(n!==0)return n;
      zero=0;
    }
  }
  return zero;
}
// A string result has no separate notice part, so the compacted text itself
// must still carry any exit/timeout notice the original had.
function keepsNotice(original: string, next: string): boolean {
  if(isExitNotice(original)&&!isExitNotice(next))return false;
  if(/\btimed out\b/i.test(original)&&!/\btimed out\b/i.test(next))return false;
  return true;
}
function assignResult(event: any, next: Record<string, any>): boolean {
  try{event.result={...event.result,...next};return true;}catch{return false;}
}
function isEventMeshBounded(event: any): boolean {
  for(const h of [event?.result,event,event?.result?.output]){
    if(wasMeshBounded(h))return true;
    if(obj(h?.metadata)&&wasMeshBounded({metadata:h.metadata}))return true;
  }
  return false;
}
/**
 * Compress every text content part independently. Shell results carry the
 * command output in the first part and an exit/timeout notice in a later one;
 * the notice is left intact. When the structured output mirrors the first
 * part, it is updated too so stored and model-visible text stay consistent.
 */
export function processToolEvent(event: any, options: any, sink?: (info: any) => void, runtime?: any): boolean {
  if(event?.status!=='completed')return false;
  const shell=SHELL_TOOLS.has(event?.tool);
  const isRead=event?.tool==='read';
  const isEdit=EDIT_TOOLS.has(event?.tool);
  const dir=runtime?.directory;
  const sid=runtime?.sessionID??toolSessionOf(event);
  const code=exitCode(event);
  if(runtime?.workingState&&sid){
    try{runtime.workingState.recordTool(sid,event,code,dir);}catch{/* observer only */}
  }
  if(isEdit){
    if(runtime?.dedupeRing&&sid)runtime.dedupeRing.reset(sid);
    if(options.pruneUnrelatedDiagnostics===false||!obj(event.result))return false;
    const res=event.result;
    const pruned=pruneEditDiagnostics(event.tool,event.input,res.metadata,dir);
    if(!pruned.changed)return false;
    const beforeLen=safeJsonLen(res.metadata?.diagnostics??{});
    const afterLen=safeJsonLen(pruned.metadata?.diagnostics??{});
    const savedDiag=Math.max(0,beforeLen-afterLen);
    const patch: Record<string, any> = {
      metadata:pruned.metadata,
    };
    const applied=assignResult(event,patch);
    if(typeof sink==='function'){
      try{sink({kind:'filtering',changed:applied,savedChars:applied?savedDiag:0});}catch{/* observer only */}
    }
    return applied;
  }
  if(isRead){
    if(!options.toolFiltering||typeof dir!=='string'||!dir)return false;
  } else if(shell ? !options.shell : !options.toolFiltering || !LIST_TOOLS.has(event?.tool)) return false;
  const result=event.result;
  if(!obj(result))return false;
  // Mixed text/media results are protected as a unit: replacing one text part
  // while a sibling image/file part remains could desynchronize the payload.
  const rawContent=result.content;
  if(Array.isArray(rawContent)&&rawContent.some((part)=>!obj(part)||part.type!=='text'))return false;
  const command=typeof event.input?.command==='string'?event.input.command:'';
  if(shell && !command) return false;
  // Observer only (stats): never alters the result or the return value.
  const report=(didChange: boolean, savedChars: number): void => {
    if(typeof sink!=='function')return;
    try{sink({kind:shell?'shell':'filtering',changed:didChange,savedChars});}catch{/* observer only */}
  };
  if(!isRead&&isEventMeshBounded(event)){report(false,0);return false;}
  const content=result.content;
  const ring=runtime?.dedupeRing;
  let firstOriginal=null,firstNext=null,changed=false,saved=0;
  let nextContent=content;
  const transformPart=(text: string, noticePresent: boolean): { text: string; changed: boolean } => {
    if(isRead){
      const compacted=compactReadEnvelope(text,dir);
      return {text:compacted,changed:compacted!==text};
    }
    if(ring&&sid&&event?.codemode!==true&&(!shell||code===undefined||code===0)){
      const dedupeKey=shell?command:safeJsonLen(event.input)?JSON.stringify(event.input):'';
      const stub=ring.check(sid,event.tool,dedupeKey,text);
      if(stub&&stub.length<text.length)return {text:stub,changed:true};
    }
    return shell ? compressOutput({command,text,exitCode:code,options,externalFailureNotice:noticePresent}) : dedupToolOutput(text,options);
  };
  if(typeof content==='string'){
    // No separate notice part exists: the failure postconditions must apply.
    const next=transformPart(content,false);
    if(next.changed&&(!shell||keepsNotice(content,next.text))){firstOriginal=content;firstNext=next.text;nextContent=next.text;changed=true;saved+=Math.max(0,content.length-next.text.length);}
  } else if(Array.isArray(content)){
    nextContent=content.slice();
    let noticePresent=false;
    for(let i=0;i<content.length;i++){
      const part=content[i];
      if(obj(part)&&part.type==='text'&&typeof part.text==='string'&&i>0&&EXIT_NOTICE.test(part.text))noticePresent=true;
    }
    for(let i=0;i<content.length;i++){
      const part=content[i];
      if(!obj(part)||part.type!=='text'||typeof part.text!=='string')continue;
      const next=transformPart(part.text,noticePresent);
      if(!next.changed)continue;
      if(i===0){firstOriginal=part.text;firstNext=next.text;}
      nextContent[i]={...part,text:next.text};
      changed=true;saved+=Math.max(0,part.text.length-next.text.length);
    }
  }
  if(!changed){report(false,0);return false;}
  const output=result.output;
  const baseMeta=obj(result.metadata)?result.metadata:{};
  const patch: Record<string, any> = {
    content:nextContent,
    ...(isRead
      ? (obj(result.metadata)?{metadata:baseMeta}:{})
      : {
          metadata:{
            ...baseMeta,
            [MESH_METADATA_KEY]:{
              ...(obj(baseMeta[MESH_METADATA_KEY])?baseMeta[MESH_METADATA_KEY]:{v:2,owner:'opencode-trim',kind:'tool-output'}),
              boundedBy:'opencode-trim',
            },
          },
        }),
  };
  if(firstOriginal!==null&&obj(output)&&typeof output.output==='string'&&output.output===firstOriginal){
    patch.output={...output,output:firstNext};
  }
  const applied=assignResult(event,patch);
  report(applied,applied?saved:0);
  return applied;
}
function valid(reg: any): { dispose: () => any } {if(!reg||typeof reg.dispose!=='function')throw new Error('opencode-trim: V2 registration missing dispose()');return reg;}
/**
 * This plugin never calls a model, writes a database, spawns a process,
 * creates a tool, adds a prompt, or edits the user's OpenCode configuration.
 */
export async function setupTrim(ctx: any): Promise<() => Promise<void>> {
  const opts=parseOptions(ctx?.options??{});
  if(!opts.enabled)return async()=>{};
  if(typeof ctx?.session?.hook!=='function'||typeof ctx?.tool?.hook!=='function')
    throw new Error('opencode-trim requires OpenCode V2 session/tool hook APIs');
  // Optional TUI stats: created only when tui.enabled. Everything below that touches `stats` is observer-only.
  let rpcReg: any = null;
  let stats: any = null;
  if(opts.tui.enabled){
    try{
      stats=createTrimStats({options:opts,emit:(sessionID: string, revision: number)=>rpcReg?.events?.emit?.('changed',{sessionID,revision})});
    }catch{stats=null;}
  }
  const modelLimits=(opts.pruning||stats)?await discoverModelLimits(ctx):new Map();
  const modelLookups=new Set<string>();
  const cache=new ContextCache();
  const dedupeRing=new ToolDedupeRing(opts.dedupeWindow,opts.minOutputChars);
  const workingState=new SessionWorkingState();
  const sessionPressure=new Map<string, number>();
  const autoCompactState=new Map<string, { inFlight: boolean; triggeredAt: number; turnsSince: number; lastMsgCount: number }>();
  let activeVault: any = null;
  const registrations: Array<{ dispose: () => any }> = [];
  const sessionOf=(event: any): string | undefined => {const s=event?.sessionID;return typeof s==='string'&&s?s:undefined;};
  const observe=(fn: (s: any) => void): void => {if(!stats)return;try{fn(stats);}catch{/* never affect the engine */}};
  const canonDir=(v: unknown): string | undefined => {
    try{
      if(typeof v!=='string'||!v||!isAbsolute(v)||v.includes('\0'))return undefined;
      try{return realpathSync(v);}catch{return resolvePath(v);}
    }catch{return undefined;}
  };
  const localDir=canonDir(ctx?.location?.directory);
  // Events from another or conflicting location must not touch this location's context, tools, vault, cache, or stats.
  const foreignEvent=(e: any): boolean => {
    if(!localDir)return false;
    try{
      for(const holder of [e,e?.data,e?.properties,e?.context,e?.session]){
        const loc=holder?.location;
        if(loc===undefined||loc===null)continue;
        if(!obj(loc))return true;
        const raw=loc.directory;
        if(raw===undefined||raw===null)continue;
        const dir=canonDir(raw);
        if(dir===undefined||dir!==localDir)return true;
      }
      return false;
    }catch{return true;}
  };
  const contextStats=(event: any, pressure: any)=>observe((s: any)=>s.recordContext({
    sessionID:sessionOf(event),estimatedTokens:pressure.reportedTokens!==undefined?Math.max(pressure.estimatedTokens,pressure.reportedTokens):pressure.estimatedTokens,estimatedChars:pressure.estimatedChars,
    usableTokens:pressure.usableTokens,limitTokens:pressure.modelContext,ratio:pressure.ratio,
    source:pressure.modelSource,media:pressure.mediaPresent}));
  const runPruning=async(event: any, kind: string): Promise<void> => {
    if(!opts.pruning||foreignEvent(event))return;
    try{
      await ensureModelLimit(ctx,modelLimits,event?.model,modelLookups);
      const pressure=estimateRequest(event,modelLimits,opts);
      const sid=sessionOf(event);
      if(sid&&typeof pressure.ratio==='number'){
        sessionPressure.delete(sid);
        if(sessionPressure.size>=128)sessionPressure.delete(sessionPressure.keys().next().value as string);
        sessionPressure.set(sid,pressure.ratio);
      }
      const gate=cache.begin(event,opts,pressure,kind);
      const result=pruneContext(event,opts,{pressure,...gate,...(activeVault?{vault:activeVault}:{})});
      gate.finish(result.plannedIds);
      const postPressure=(kind==='context'&&result.pruned>0)?estimateRequest(event,modelLimits,opts):pressure;
      if(sid&&typeof postPressure.ratio==='number'){
        sessionPressure.delete(sid);
        if(sessionPressure.size>=128)sessionPressure.delete(sessionPressure.keys().next().value as string);
        sessionPressure.set(sid,postPressure.ratio);
      }
      if(
        opts.autoCompact!==false &&
        kind==='context' &&
        event?.kind!=='compaction' &&
        event?.kind!=='title' &&
        event?.kind!=='generate' &&
        sid &&
        typeof ctx?.session?.compact==='function'
      ){
        const msgCount=Array.isArray(event?.messages)?event.messages.length:0;
        const prev=autoCompactState.get(sid);
        if(prev){
          prev.turnsSince+=1;
          if(msgCount<prev.lastMsgCount||(typeof postPressure.ratio==='number'&&Number.isFinite(postPressure.ratio)&&postPressure.ratio<1.0)){
            prev.inFlight=false;
            prev.lastMsgCount=msgCount;
          }
        }
        if(
          typeof postPressure.ratio==='number' &&
          Number.isFinite(postPressure.ratio) &&
          postPressure.ratio>=1.0 &&
          msgCount>opts.protectRecentMessages
        ){
          const now=Date.now();
          const canTrigger=!prev || (
            (!prev.inFlight || now-prev.triggeredAt>120_000) &&
            prev.turnsSince>=3
          );
          if(canTrigger){
            autoCompactState.delete(sid);
            if(autoCompactState.size>=128)autoCompactState.delete(autoCompactState.keys().next().value as string);
            autoCompactState.set(sid,{inFlight:true,triggeredAt:now,turnsSince:0,lastMsgCount:msgCount});
            Promise.resolve().then(()=>ctx.session.compact({sessionID:sid,delivery:'queue'})).catch(()=>{
              const cur=autoCompactState.get(sid);
              if(cur)cur.inFlight=false;
            });
          }
        }
      }
      observe((s: any)=>{
        // A native compaction request is not the live model context; only its prune counters apply.
        if(kind==='context')contextStats(event,postPressure);
        s.recordPrune({sessionID:sessionOf(event),pruned:result.pruned,removedChars:result.removedChars,
          reason:result.reason,allowNewDrops:gate.allowNewDrops});
      });
    }catch{/* No optimization is safer than breaking a model request. */}
  };
  const statsOnlyContext=async(event: any): Promise<void> => {
    try{
      if(foreignEvent(event))return;
      await ensureModelLimit(ctx,modelLimits,event?.model,modelLookups);
      contextStats(event,estimateRequest(event,modelLimits,opts));
    }catch{/* stats are best effort */}
  };
  const resetSessionState=(sid: unknown)=>{
    if(typeof sid!=='string'||!sid)return;
    cache.resetSession(sid);
    dedupeRing.reset(sid);
    workingState.reset(sid);
    sessionPressure.delete(sid);
    autoCompactState.delete(sid);
  };
  registrations.push({
    dispose:registerMeshPeer({
      id:'opencode-trim',
      directory:localDir,
      capabilities:['context.prune'],
      onSessionForget:resetSessionState,
    }),
  });
  let subscriptionAbort: AbortController | null = null;
  const dispose=async()=>{
    try{subscriptionAbort?.abort();}catch{/* ignore */}
    try{stats?.dispose();}catch{/* ignore */}
    if(rpcReg){const reg=rpcReg;rpcReg=null;await Promise.resolve().then(()=>reg.dispose()).catch(()=>{});}
  };
  try{
    if(opts.shell||opts.toolFiltering){
      registrations.push(valid(await ctx.tool.hook('execute.after',(event: any)=>{
        try{
          if(foreignEvent(event))return;
          const sessionID=toolSessionOf(event);
          const effOpts=sessionID?effectiveToolOptions(opts,sessionPressure.get(sessionID)):opts;
          const rt={directory:localDir,dedupeRing,workingState,sessionID};
          if(!stats)processToolEvent(event,effOpts,undefined,rt);
          else{
            processToolEvent(event,effOpts,(info: any)=>stats.recordTool({sessionID,...info}),rt);
          }
        }catch{/* Preserve host result. */}
      })));
    }
    if(opts.pruning){
      registrations.push(valid(await ctx.session.hook('context',(event: any)=>runPruning(event,'context'))));
      if(opts.compactionInputPruning){
        // This ONLY prunes a native compaction request's old tool results.
        // It neither asks for a summary nor sets event.result.
        registrations.push(valid(await ctx.session.hook('compaction',(event: any)=>runPruning(event,'compaction'))));
      }
    }else if(stats){
      registrations.push(valid(await ctx.session.hook('context',statsOnlyContext)));
    }
  }catch(error){
    await Promise.allSettled(registrations.reverse().map(reg=>reg.dispose()));
    await dispose();
    cache.clear();throw error;
  }
  if(stats){
    // No host `compaction.auto` exists: count observed compaction events by their reason instead.
    try{
      if(typeof ctx?.rpc?.register==='function'){
        rpcReg=await ctx.rpc.register(TRIM_STATS_RPC,{snapshot:async(input: any)=>stats.snapshot(input?.sessionID)});
        if(!rpcReg||typeof rpcReg.dispose!=='function')rpcReg=null;
      }
    }catch{rpcReg=null;}
    try{
      if(typeof ctx?.event?.subscribe==='function'){
        subscriptionAbort=new AbortController();
        const signal=subscriptionAbort.signal;
        const subscription=await ctx.event.subscribe({signal,types:[...COMPACTION_EVENTS]});
        (async()=>{
          try{
            for await(const e of subscription){
              if(signal.aborted)break;
              if(foreignEvent(e))continue;
              const p=obj(e?.data)?e.data:obj(e?.properties)?e.properties:(obj(e)?e:{});
              const sid=p.sessionID??p.sessionId??e?.sessionID;
              if(e?.type==='session.deleted'){
                if(typeof sid==='string'&&sid){
                  forgetMeshSession(sid);
                  cache.resetSession(sid);
                  dedupeRing.reset(sid);
                  workingState.reset(sid);
                  sessionPressure.delete(sid);
                  autoCompactState.delete(sid);
                }
                continue;
              }
              if(e?.type==='session.compaction.failed'&&typeof sid==='string'&&sid){
                const cur=autoCompactState.get(sid);
                if(cur)cur.inFlight=false;
              }
              if(e?.type==='session.compaction.ended'&&typeof sid==='string'&&sid){
                cache.resetSession(sid);
                dedupeRing.reset(sid);
                workingState.reset(sid);
                sessionPressure.delete(sid);
                const cur=autoCompactState.get(sid);
                if(cur)cur.inFlight=false;
              }
              observe((s)=>{
                const type=COMPACTION_EVENTS.includes(e?.type)?e.type.slice('session.compaction.'.length):null;
                if(type)s.recordCompactionEvent({sessionID:sid,type,reason:p.reason});
              });
            }
          }catch{/* stream ended or aborted */}
        })();
      }
    }catch{subscriptionAbort=null;}
  }
  let memoryStop: (() => Promise<void>) | null = null;
  if(opts.memory.enabled){
    // Memory is optional; a failure must not disable Trim itself.
    try{
      memoryStop=await setupMemory(ctx,opts,{
        onReady:({project,store,dbPath,vault}: any)=>{
          activeVault=vault??null;
          if(stats){
            stats.setMemoryProvider(()=>({...store.stats(project),dbBytes:memoryDbBytes(dbPath)}));
            stats.setMemoryState({active:true});
          }
        },
        onSearch:({sessionID,results}: any)=>stats?.recordMemorySearch({sessionID,results:Array.isArray(results)?results.length:0}),
        onClose:()=>{
          activeVault=null;
          if(stats){stats.setMemoryProvider(null);stats.setMemoryState({active:false});}
        },
        onCompactionEnded:(sid: string)=>{
          cache.resetSession(sid);
          dedupeRing.reset(sid);
          workingState.reset(sid);
          sessionPressure.delete(sid);
          const cur=autoCompactState.get(sid);
          if(cur)cur.inFlight=false;
        },
        onCompactionFailed:(sid: string)=>{
          const cur=autoCompactState.get(sid);
          if(cur)cur.inFlight=false;
        },
      });
    }catch{memoryStop=null;activeVault=null;observe((s: any)=>{s.setMemoryProvider(null);s.setMemoryState({active:false,error:'setup-failed'});});}
  }
  let disposed=false;
  return async()=>{
    if(disposed)return;
    disposed=true;cache.clear();dedupeRing.clear();workingState.clear();sessionPressure.clear();autoCompactState.clear();activeVault=null;
    if(memoryStop)await Promise.resolve().then(memoryStop).catch(()=>{});
    await Promise.allSettled(registrations.reverse().map(reg=>reg.dispose()));
    await dispose();
  };
}
