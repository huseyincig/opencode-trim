export interface CacheGate {
    allowNewDrops: boolean;
    plannedDrops: Set<string>;
    finish: (ids: Iterable<string>) => void;
}
export interface CacheSessionEntry {
    identity: string;
    plannedDrops: Set<string>;
    sizeMark?: number;
    startBandAdmitted?: boolean;
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
    constructor();
    begin(event: any, opts: any, pressure: any, kind?: string): CacheGate;
    resetSession(sessionID: unknown): void;
    clear(): void;
}
