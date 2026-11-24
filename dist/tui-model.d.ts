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
export declare const TRIM_VERSION = "0.9.3";
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
export type TrimViewMode = "collapsed" | "default" | "expanded";
export type HealthState = "healthy" | "caution" | "critical" | "idle";
export interface SidebarBreakdown {
    systemChars: number;
    chatChars: number;
    toolChars: number;
}
export interface BarSegments {
    sys: number;
    chat: number;
    tools: number;
    toolsWarn: number;
    empty: number;
}
export interface SidebarDetailRow {
    key: string;
    label: string;
    parts: string[];
    value: string;
    tone: string;
}
export declare function normalizeViewMode(stored: any): TrimViewMode;
export declare function nextViewMode(mode: TrimViewMode): TrimViewMode;
export declare function messageBreakdown(messages: unknown): SidebarBreakdown | null;
export declare function compactionBreakdown(messages: unknown): {
    total: number;
    auto: number;
    manual: number;
    failed: number;
    lastAt: number | null;
    lastReason: string | null;
} | null;
export declare function computeBarSegments(barRatio: number | null, breakdown: SidebarBreakdown | null, width?: number, health?: HealthState): BarSegments;
export declare function buildSidebarModel(raw: any, now?: number, options?: any): {
    hasData: boolean;
    context: {
        known: boolean;
        percent: number | null;
        percentText: string;
        usedText: string;
        limitText: string;
        pairText: string;
        barRatio: number | null;
        effectiveRatio: any;
        over: number;
        overText: string | null;
        capTokens: any;
        capRatio: number | null;
        capText: string | null;
    };
    health: {
        state: HealthState;
        label: HealthState;
        tone: string;
    };
    sessionAge: string | null;
    statusRight: {
        parts: string[];
        text: string;
        tone: string;
    };
    details: SidebarDetailRow[];
    segments: (width: number) => BarSegments;
};
