export interface FilterRule {
    readonly program: string;
    readonly dropPrefixes: readonly string[];
    readonly dropExact: readonly string[];
}
export interface TrimMemoryOptions {
    readonly enabled: boolean;
    readonly agentAllowlist: readonly string[];
    readonly agentDenylist: readonly string[];
    readonly retentionDays: number;
    recentWork?: boolean;
    dbPath?: string;
}
export interface TrimTuiOptions {
    readonly enabled: boolean;
}
export interface TrimOptions {
    readonly enabled: boolean;
    readonly shell: boolean;
    readonly toolFiltering: boolean;
    readonly pruning: boolean;
    readonly compactionInputPruning: boolean;
    readonly autoCompact: boolean;
    readonly reduceTool: boolean;
    readonly minOutputChars: number;
    readonly minSavingsRatio: number;
    readonly maxOutputLines: number;
    readonly maxOutputChars: number;
    readonly maxInputScanChars: number;
    readonly protectRecentMessages: number;
    readonly protectRecentTokens: number;
    readonly keepRecentToolResults: number;
    readonly pruneAfterToolChars: number;
    readonly pruneMinResultChars: number;
    readonly pruneEligibleTools: readonly string[];
    readonly pressureStartRatio: number;
    readonly pressureForceRatio: number;
    readonly pressureCriticalRatio: number;
    readonly outputReserveTokens: number;
    readonly contextWindow: number;
    readonly contextWindowCap: number;
    readonly contextWindowRatioCap?: number;
    readonly maxTokens?: number | string;
    readonly pruneAt?: number | string;
    readonly supersessionMinChars: number;
    readonly purgeErrorInputs: boolean;
    readonly pruneHistoricalReasoning: boolean;
    readonly pruneUnrelatedDiagnostics: boolean;
    readonly supersedeWrites: boolean;
    readonly pruneOldToolInputs: boolean;
    readonly pruneAgedDiffs: boolean;
    readonly pruneResolvedErrors: boolean;
    readonly adaptivePruning: boolean;
    readonly virtualizeOutputChars: number;
    readonly prunePreviewLines: number;
    readonly dedupeWindow: number;
    readonly cacheTtlMs: number;
    readonly cacheMinSavingsChars: number;
    readonly filterRules: readonly FilterRule[];
    readonly memory: TrimMemoryOptions;
    readonly tui: TrimTuiOptions;
    [key: string]: any;
}
/** Strict, bounded configuration. The plugin does not create config files. */
export declare const DEFAULTS: Readonly<{
    enabled: true;
    shell: true;
    toolFiltering: true;
    pruning: true;
    compactionInputPruning: false;
    autoCompact: true;
    reduceTool: false;
    minOutputChars: 1600;
    minSavingsRatio: 0.15;
    maxOutputLines: 160;
    maxOutputChars: 16000;
    maxInputScanChars: 2000000;
    protectRecentMessages: 10;
    protectRecentTokens: 4096;
    keepRecentToolResults: 8;
    pruneAfterToolChars: 75000;
    pruneMinResultChars: 800;
    pruneEligibleTools: readonly string[];
    pressureStartRatio: 0.65;
    pressureForceRatio: 0.85;
    pressureCriticalRatio: 0.94;
    outputReserveTokens: 8192;
    contextWindow: 0;
    contextWindowCap: 250000;
    supersessionMinChars: 5000;
    purgeErrorInputs: true;
    pruneHistoricalReasoning: true;
    pruneUnrelatedDiagnostics: true;
    supersedeWrites: true;
    pruneOldToolInputs: false;
    pruneAgedDiffs: true;
    pruneResolvedErrors: true;
    adaptivePruning: true;
    virtualizeOutputChars: 32000;
    prunePreviewLines: 2;
    dedupeWindow: 8;
    cacheTtlMs: 300000;
    cacheMinSavingsChars: 6000;
    filterRules: readonly never[];
    memory: Readonly<{
        enabled: false;
        agentAllowlist: readonly never[];
        agentDenylist: readonly never[];
        retentionDays: 60;
    }>;
    tui: Readonly<{
        enabled: false;
    }>;
}>;
export declare function parseOptions(options?: Record<string, any>): TrimOptions;
