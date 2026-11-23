export declare const STORAGE_KEY = "opencode-trim.tui";
export declare const FRESH_RUNNING_MS = 15000;
export declare const FRESH_IDLE_MS = 300000;
export declare function safeText(value: unknown, max?: number): string | null;
export declare function normalizeEventSessionID(event: any): string | null;
export declare function normalizeSnapshot(raw: any): any;
export declare function deriveCachePolicy(snapshot: any): string | null;
export declare function isStale(snapshot: any, now: unknown, running?: boolean): boolean;
export declare function nativeContextTokens(messages: unknown): number | null;
export declare function compactionHistory(messages: unknown): {
    total: number;
    failed: number;
    lastAt: number | null;
    lastReason: string | null;
} | null;
export declare const TRIM_VERSION = "0.9.2";
export declare const SECTION_TITLES: Record<string, string>;
export declare function buildRows(raw: any, now?: number, options?: any): any[];
export declare function buildSections(raw: any, now?: number, options?: any): any[];
export declare function buildHeader(raw: any, { expanded, stale, nativeTokens, nativeLimitTokens }?: {
    expanded?: boolean;
    stale?: boolean;
    nativeTokens?: number | null;
    nativeLimitTokens?: number | null;
}): {
    title: string;
    summary: string;
    marker: string;
};
export declare function collapsedSummary(raw: any, { stale, nativeTokens, nativeLimitTokens }?: {
    stale?: boolean;
    nativeTokens?: number | null;
    nativeLimitTokens?: number | null;
}): string;
export declare function buildCollapsedRows(raw: any, options?: any): any[];
export declare function headerText(stale?: boolean): string;
