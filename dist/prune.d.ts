export interface CacheBreakEvenInput {
    savedChars: number;
    remainingChars: number;
    isColdCache: boolean;
    isCritical: boolean;
    minSavingsChars?: number;
    expectedTurns?: number;
    writeOverheadRatio?: number;
}
/**
 * Economic break-even check for warm prompt-cache invalidation.
 * Cold caches and critical pressure always pass; warm caches require savedChars to beat
 * both a floor (minSavingsChars) and the amortized rewrite penalty across expectedTurns.
 */
export declare function evaluateCacheBreakEven(input: CacheBreakEvenInput): {
    allow: boolean;
    reason: string;
};
export interface ReduceDirective {
    scope: 'older_tools' | 'target';
    target?: string;
    tool?: string;
    keepRecent?: number;
    applyNow?: boolean;
}
export interface PruneResult {
    pruned: number;
    removedChars: number;
    reason: 'pruned' | 'cache-deferred' | 'below-pressure' | 'no-safe-target' | 'disabled';
    plannedIds: string[];
    eligibleChars?: number;
    estimatedContextRatio?: number;
    consumedDirectives?: boolean;
    warmCacheDeferred?: boolean;
}
export interface PruneVaultAdapter {
    store: (refId: string, entry: any, sessionID?: string) => boolean;
    has: (refId: string) => boolean;
}
export declare const PRUNED = "[opencode-trim: old tool output omitted from model context]";
export declare const PRUNED_ERROR_INPUT = "[opencode-trim: oversized input of failed tool call omitted; error output preserved]";
export declare const PRUNED_REASONING = "[opencode-trim: historical reasoning trace omitted]";
export declare function recoverableNotice(refId: string, tool?: string, tokens?: number, lines?: number, opts?: {
    truncated?: boolean;
}): string;
export declare function liveDiskNotice(tool?: string, target?: string, tokens?: number, lines?: number): string;
export declare function expiredNotice(refId: string, tool?: string): string;
export declare function buildPreviewNotice(original: string, notice: string, previewLines?: number): string;
export declare function scorePruningCandidate(savedChars: number, suffixChars: number): number;
/** Hard per-message / per-request content-part budgets. Over budget fails closed (no pruning). */
export declare const MAX_PARTS_PER_MESSAGE = 500;
export declare const MAX_PARTS_TOTAL = 50000;
/** Read an own plain data property; never invoke accessors or inherited getters. */
declare function data(o: any, k: string): any;
export { data as ownData };
declare function isArr(x: unknown): x is any[];
export { isArr as isPlainArray };
/**
 * Deterministic message key for OpenCode V2 Prompt.Message objects that may omit `msg.id`.
 * Never hashes mutable tool outputs, so the key stays invariant before and after pruning.
 */
export declare function stableMessageKey(msg: any): string;
/** True for tools that inspect live files/code on disk (should be re-read live, never vaulted as stale snapshots). */
export declare function isLiveDiskTool(name: unknown): boolean;
/** Shell commands whose output may carry instructions, secrets or patches: never pruned. */
export declare function protectedShell(cmd: unknown): boolean;
/** Default number of lines a read returns when no limit/endLine is given. */
export declare const READ_DEFAULT_LINES = 2000;
/** True when any metadata holder on part/result/state/message is mesh-protected (with provenance check when ledger exists). */
export declare function isTrimMeshProtected(part: any, msg: any, sessionID?: string): boolean;
/** Called with an outgoing-only draft. plannedDrops contains stable per-session result keys. */
export declare function pruneContext(event: any, options: any, settings?: any): PruneResult;
