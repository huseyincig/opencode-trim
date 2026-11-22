export interface PruneResult {
    pruned: number;
    removedChars: number;
    reason: 'pruned' | 'cache-deferred' | 'below-pressure' | 'no-safe-target' | 'disabled';
    plannedIds: string[];
    eligibleChars?: number;
    estimatedContextRatio?: number;
}
export interface PruneVaultAdapter {
    store: (refId: string, entry: any) => boolean;
    has: (refId: string) => boolean;
}
export declare const PRUNED = "[opencode-trim: old tool output omitted from model context]";
export declare const PRUNED_ERROR_INPUT = "[opencode-trim: oversized input of failed tool call omitted; error output preserved]";
export declare const PRUNED_REASONING = "[opencode-trim: historical reasoning trace omitted]";
export declare function recoverableNotice(refId: string, tool?: string, tokens?: number, lines?: number): string;
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
/** Shell commands whose output may carry instructions, secrets or patches: never pruned. */
export declare function protectedShell(cmd: unknown): boolean;
/** Default number of lines a read returns when no limit/endLine is given. */
export declare const READ_DEFAULT_LINES = 2000;
/** True when any metadata holder on part/result/state/message is mesh-protected (with provenance check when ledger exists). */
export declare function isTrimMeshProtected(part: any, msg: any, sessionID?: string): boolean;
/** Called with an outgoing-only draft. plannedDrops contains stable per-session result keys. */
export declare function pruneContext(event: any, options: any, settings?: any): PruneResult;
