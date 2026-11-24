/** Prompt-cache-aware owner: keep a stable drop set until a natural bust or force band. */
import { evaluateCacheBreakEven, type CacheBreakEvenInput } from './prune.ts';
export { evaluateCacheBreakEven, type CacheBreakEvenInput };
export interface CacheGate {
    allowNewDrops: boolean;
    coldCache: boolean;
    warmCache: boolean;
    plannedDrops: Set<string>;
    finish: (ids: Iterable<string>, opts?: {
        deferred?: boolean;
    }) => void;
}
export interface CacheSessionEntry {
    identity: string;
    plannedDrops: Set<string>;
    sizeMark?: number;
    startBandAdmitted?: boolean;
    lastRequestAt?: number;
    lastCacheRead?: number;
}
export declare function requestIdentity(event: any): string;
/**
 * plannedDrops is bounded. Past MAX_PLANNED the OLDEST ids are evicted one at a
 * time (no halving), so only results older than the newest MAX_PLANNED drops can
 * be resurrected. This limitation is deliberate and tested.
 */
export declare const MAX_PLANNED: number;
export declare class ContextCache {
    sessions: Map<string, CacheSessionEntry>;
    observedCacheReads: Map<string, number>;
    constructor();
    /** Record latest provider cache.read tokens from session.step.ended for warm/cold detection. */
    observeCacheRead(sessionID: unknown, cacheRead: unknown): void;
    begin(event: any, opts: any, pressure: any, kind?: string, now?: number): CacheGate;
    resetSession(sessionID: unknown): void;
    clear(): void;
}
