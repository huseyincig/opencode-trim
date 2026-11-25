/** Prompt-cache-aware owner: keep a stable drop set until a natural bust or force band. */
import { evaluateCacheBreakEven, type CacheBreakEvenInput } from './prune.ts';
export { evaluateCacheBreakEven, type CacheBreakEvenInput };
export interface CacheGate {
    allowNewDrops: boolean;
    coldCache: boolean;
    warmCache: boolean;
    forceFlush?: boolean;
    adaptiveTier?: 0 | 1 | 2;
    plannedDrops: Set<string>;
    hydratedDrops?: Set<string>;
    finish: (ids: Iterable<string>, opts?: {
        deferred?: boolean;
    }) => void;
}
export interface CacheSessionEntry {
    identity: string;
    plannedDrops: Set<string>;
    hydratedDrops?: Set<string>;
    sizeMark?: number;
    startBandAdmitted?: boolean;
    adaptiveTier?: 0 | 1 | 2;
    lastRequestAt?: number;
    lastCacheRead?: number;
}
export declare function requestIdentity(event: any): string;
/**
 * plannedDrops is bounded. Past MAX_PLANNED the OLDEST ids are evicted one at a
 * time (no halving), so only results older than the newest MAX_PLANNED drops can
 * be resurrected. This limitation is deliberate and tested.
 */
export interface CachePersistence {
    load?: (sessionID: string) => Iterable<string>;
    save?: (sessionID: string, ids: Iterable<string>) => void;
    clear?: (sessionID: string) => void;
}
export declare const MAX_PLANNED: number;
export declare class ContextCache {
    #private;
    sessions: Map<string, CacheSessionEntry>;
    observedCacheReads: Map<string, number>;
    flushRequests: Set<string>;
    constructor();
    setPersistence(adapter: CachePersistence | null): void;
    requestFlush(sessionID: unknown): boolean;
    /** Record latest provider cache.read tokens from session.step.ended for warm/cold detection. */
    observeCacheRead(sessionID: unknown, cacheRead: unknown): void;
    begin(event: any, opts: any, pressure: any, kind?: string, now?: number): CacheGate;
    resetSession(sessionID: unknown): void;
    clear(): void;
}
