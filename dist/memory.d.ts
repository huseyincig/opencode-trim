export declare const TOOL_NAME = "trim_history_search";
export declare const EXPAND_TOOL_NAME = "trim_expand";
export declare function defaultDbPath(): string;
/** Main DB + active journal/WAL size in bytes; null for :memory: or any stat failure. */
export declare function memoryDbBytes(dbPath: unknown): number | null;
/**
 * Compaction-summary memory. Only called when memory.enabled; owns its DB,
 * event subscription, one tool and one hook, and returns an idempotent cleanup.
 */
export declare function setupMemory(ctx: any, opts: any, hooks?: any): Promise<() => Promise<void>>;
