import { isAbsolute } from 'node:path';
/** Strict, bounded configuration. The plugin does not create config files. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  shell: true,
  toolFiltering: true,
  pruning: true,
  compactionInputPruning: false,
  minOutputChars: 1600,
  minSavingsRatio: 0.15,
  maxOutputLines: 160,
  maxOutputChars: 16000,
  maxInputScanChars: 2_000_000,
  protectRecentMessages: 14,
  protectRecentTokens: 4096,
  keepRecentToolResults: 12,
  pruneAfterToolChars: 100000,
  pruneMinResultChars: 800,
  pruneEligibleTools: ["shell", "bash", "read", "grep", "glob", "ls", "list", "search", "find"],
  pressureStartRatio: 0.65,
  pressureForceRatio: 0.85,
  pressureCriticalRatio: 0.94,
  outputReserveTokens: 8192,
  contextWindow: 0,
  supersessionMinChars: 5000,
  filterRules: [],
  memory: Object.freeze({ enabled: false, agentAllowlist: Object.freeze([]), agentDenylist: Object.freeze([]), retentionDays: 90 }),
  tui: Object.freeze({ enabled: false }),
});
const TUI_KEYS = ['enabled'];
function validateTui(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('opencode-trim: tui must be an object');
  const unknown = Object.keys(input).filter(k => !TUI_KEYS.includes(k));
  if (unknown.length) throw new Error(`opencode-trim: unknown tui options: ${unknown.join(', ')}`);
  const t = { ...DEFAULTS.tui, ...input };
  if (typeof t.enabled !== 'boolean') throw new TypeError('opencode-trim: tui.enabled must be boolean');
  return Object.freeze({ enabled: t.enabled });
}
const MEMORY_KEYS = ['enabled', 'agentAllowlist', 'agentDenylist', 'retentionDays', 'dbPath'];
function validateMemory(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('opencode-trim: memory must be an object');
  const unknown = Object.keys(input).filter(k => !MEMORY_KEYS.includes(k));
  if (unknown.length) throw new Error(`opencode-trim: unknown memory options: ${unknown.join(', ')}`);
  const m = { ...DEFAULTS.memory, ...input };
  if (typeof m.enabled !== 'boolean') throw new TypeError('opencode-trim: memory.enabled must be boolean');
  if (!Number.isSafeInteger(m.retentionDays) || m.retentionDays < 1 || m.retentionDays > 3650)
    throw new TypeError('opencode-trim: memory.retentionDays outside 1..3650');
  for (const k of ['agentAllowlist', 'agentDenylist']) {
    if (!Array.isArray(m[k]) || m[k].length > 20 ||
      !m[k].every(x => typeof x === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,63}$/i.test(x)))
      throw new TypeError(`opencode-trim: memory.${k} must contain at most 20 simple agent names`);
  }
  if (m.dbPath !== undefined && (typeof m.dbPath !== 'string' || !m.dbPath || m.dbPath.length > 1024 || /\x00/.test(m.dbPath)))
    throw new TypeError('opencode-trim: memory.dbPath must be a non-empty string');
  if (m.dbPath !== undefined && m.dbPath !== ':memory:' && !isAbsolute(m.dbPath))
    throw new TypeError('opencode-trim: memory.dbPath must be an absolute path or ":memory:"');
  const out = { enabled: m.enabled, agentAllowlist: Object.freeze([...new Set(m.agentAllowlist)]), agentDenylist: Object.freeze([...new Set(m.agentDenylist)]), retentionDays: m.retentionDays };
  if (m.dbPath !== undefined) out.dbPath = m.dbPath;
  return Object.freeze(out);
}
const ranges = {
  minOutputChars: [200, 200000], maxOutputLines: [20, 2000],
  maxOutputChars: [2000, 1000000], maxInputScanChars: [10000, 5000000],
  protectRecentMessages: [4, 100], protectRecentTokens: [1024, 64000], keepRecentToolResults: [1, 100],
  pruneAfterToolChars: [10000, 2000000], pruneMinResultChars: [100, 200000],
  outputReserveTokens: [1024, 100000], contextWindow: [0, 10000000], supersessionMinChars: [100, 200000],
};
const simpleTool = /^[a-z][a-z0-9_-]{0,63}$/i;
const simpleProgram = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
function validateRules(rules) {
  if (!Array.isArray(rules) || rules.length > 24) throw new TypeError('opencode-trim: filterRules must contain at most 24 entries');
  return rules.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r) ||
      Object.keys(r).some(k => !['program', 'dropPrefixes', 'dropExact'].includes(k)) ||
      typeof r.program !== 'string' || !simpleProgram.test(r.program)) {
      throw new TypeError(`opencode-trim: invalid filterRules[${i}]`);
    }
    for (const field of ['dropPrefixes', 'dropExact']) {
      const list = r[field] ?? [];
      if (!Array.isArray(list) || list.length > 20 || !list.every(x =>
        typeof x === 'string' && x.length > 1 && x.length <= 120 && !/[\r\n\x00-\x1f]/.test(x))) {
        throw new TypeError(`opencode-trim: invalid filterRules[${i}].${field}`);
      }
    }
    return Object.freeze({program:r.program.toLowerCase(),
      dropPrefixes:Object.freeze([...(r.dropPrefixes ?? [])]),
      dropExact:Object.freeze([...(r.dropExact ?? [])])});
  });
}
export function parseOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('opencode-trim options must be an object');
  const unknown=Object.keys(options).filter(key=>!Object.hasOwn(DEFAULTS,key));
  if (unknown.length) throw new Error(`opencode-trim: unknown options: ${unknown.join(', ')}`);
  const result={...DEFAULTS,...options};
  for(const key of ['enabled','shell','toolFiltering','pruning','compactionInputPruning']) {
    if(typeof result[key] !== 'boolean') throw new TypeError(`opencode-trim: ${key} must be boolean`);
  }
  for(const [field,[min,max]] of Object.entries(ranges)) {
    if(!Number.isSafeInteger(result[field])||result[field]<min||result[field]>max) {
      throw new TypeError(`opencode-trim: ${field} outside ${min}..${max}`);
    }
  }
  if (result.maxInputScanChars < result.maxOutputChars) throw new Error('opencode-trim: maxInputScanChars must be >= maxOutputChars');
  if (result.minOutputChars > result.maxInputScanChars) throw new Error('opencode-trim: minOutputChars must be <= maxInputScanChars');
  if (result.minOutputChars > result.maxOutputChars) throw new Error('opencode-trim: minOutputChars must be <= maxOutputChars');
  for (const [field,min,max] of [
    ['minSavingsRatio',0,0.9],['pressureStartRatio',0.2,0.9],
    ['pressureForceRatio',0.5,0.98],['pressureCriticalRatio',0.7,0.999],
  ]) {
    if(typeof result[field]!=='number' || !Number.isFinite(result[field]) || result[field]<min || result[field]>max)
      throw new TypeError(`opencode-trim: invalid ${field}`);
  }
  if(!(result.pressureStartRatio < result.pressureForceRatio && result.pressureForceRatio < result.pressureCriticalRatio))
    throw new Error('opencode-trim: pressure ratios must be strictly increasing');
  if(!Array.isArray(result.pruneEligibleTools)||result.pruneEligibleTools.length>40||
    !result.pruneEligibleTools.every(x=>typeof x==='string' && simpleTool.test(x)))
    throw new TypeError('opencode-trim: pruneEligibleTools must contain simple tool names');
  return Object.freeze({...result,
    memory:validateMemory(result.memory),
    tui:validateTui(result.tui),
    pruneEligibleTools:Object.freeze([...new Set(result.pruneEligibleTools.map(x=>x.toLowerCase()))]),
    filterRules:Object.freeze(validateRules(result.filterRules))});
}
