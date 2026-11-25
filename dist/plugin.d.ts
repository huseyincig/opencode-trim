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
/** Tighten output line/char caps when session context pressure reaches force/critical bands. */
export declare function effectiveToolOptions<T extends Record<string, any>>(options: T, pressureRatio?: number): T;
/** Shorten absolute project directory prefix in built-in read tool header without touching file content. */
export declare function compactReadEnvelope(text: string, directory?: string): string;
export declare class ToolDedupeRing {
    windowSize: number;
    minChars: number;
    rings: Map<string, any[]>;
    seq: Map<string, number>;
    constructor(windowSize?: number, minChars?: number);
    lookup(sessionID: string, tool: string, command: string, text: string): string | null;
    record(sessionID: string, tool: string, command: string, text: string, stubbed?: boolean): void;
    check(sessionID: string, tool: string, command: string, text: string): string | null;
    reset(sessionID?: string): void;
    clear(): void;
}
/** Keep LSP diagnostics only for files touched by edit/write/apply_patch; preserve non-file keys and metadata. */
export declare function pruneEditDiagnostics(tool: string, input: any, metadata: any, directory?: string): PrunedDiagnosticsResult;
export declare class SessionWorkingState {
    #private;
    maxSessions: number;
    maxFiles: number;
    maxErrors: number;
    sessions: Map<string, {
        files: Map<string, ActiveFileEntry>;
        errors: Map<string, OpenErrorEntry>;
    }>;
    constructor(maxSessions?: number, maxFiles?: number, maxErrors?: number);
    recordTool(sessionID: string, event: any, exitCode?: number, directory?: string): void;
    snapshot(sessionID: string): WorkingStateSnapshot;
    reset(sessionID?: string): void;
    clear(): void;
}
/**
 * Compress every text content part independently. Shell results carry the
 * command output in the first part and an exit/timeout notice in a later one;
 * the notice is left intact. When the structured output mirrors the first
 * part, it is updated too so stored and model-visible text stay consistent.
 */
export declare function processToolEvent(event: any, options: any, sink?: (info: any) => void, runtime?: any): boolean;
/**
 * This plugin never calls a model, writes a database, spawns a process,
 * creates a tool, adds a prompt, or edits the user's OpenCode configuration.
 */
export declare function setupTrim(ctx: any): Promise<() => Promise<void>>;
