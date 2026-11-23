export interface VaultLookupResult {
    found: boolean;
    id: string;
    mode?: 'item' | 'list';
    tool?: string | null;
    target?: string | null;
    totalLines?: number;
    matchedLines?: number;
    truncated?: boolean;
    totalVaultRows?: number;
    refs?: VaultRefSummary[];
    text: string;
}
export interface VaultRefSummary {
    id: string;
    session_id: string | null;
    tool: string | null;
    target: string | null;
    tokens: number;
    totalLines: number;
    created_at: number;
    date: string;
}
export interface VaultListResult extends VaultLookupResult {
    mode: 'list';
    totalVaultRows: number;
    refs: VaultRefSummary[];
}
export declare const MAX_TEXT_CHARS = 1000000;
export declare function redactSecrets(text: unknown): string;
/** Split a user query into quoted FTS5 phrase tokens; never passes raw operators. */
export declare function buildMatchQuery(query: unknown): string;
export declare const SCAN_BATCH = 100;
export declare const SCAN_MAX_ROWS = 1000;
export declare const SCAN_MAX_CHARS = 8000000;
export declare function openMemoryStore({ dbPath, retentionDays, maxResults, maxSnippetChars, maxVaultRows, project, }?: {
    dbPath?: string;
    retentionDays?: number;
    maxResults?: number;
    maxSnippetChars?: number;
    maxVaultRows?: number;
    project?: string;
}): {
    archive(record: any): {
        inserted: boolean;
    };
    updateContextAfter(project: unknown, eventId: unknown, tokens: unknown): {
        updated: boolean;
    };
    search({ project, query, section, sessionID, days, limit, maxSnippetChars: snip, fullSection, now }?: {
        project?: string;
        query?: string;
        section?: string | null;
        sessionID?: string | null;
        days?: number | null;
        limit?: number;
        maxSnippetChars?: number;
        fullSection?: boolean;
        now?: number;
    }): Record<string, any>[];
    /** Archived summaries for one project that are still inside retention; never reads other projects. */
    stats(statsProject: unknown, now?: number): {
        summaries: number;
        lastSummaryAt: number | null;
    };
    prune(pruneProject: unknown, now?: number): {
        deleted: number;
    };
    saveVault(record: any): {
        saved: boolean;
        ref_id: any;
        line_count: number;
    };
    hasVault(vaultProject: unknown, refId: unknown, now?: number): boolean;
    listVault({ project: vaultProject, tool, target, limit, now }?: {
        project?: string;
        tool?: string | null;
        target?: string | null;
        limit?: number;
        now?: number;
    }): VaultListResult;
    getVault({ project: vaultProject, ref_id: refId, startLine, endLine, grep, regex, caseSensitive, maxChars, now }?: {
        project?: string;
        ref_id?: string;
        startLine?: number;
        endLine?: number;
        grep?: string;
        regex?: boolean;
        caseSensitive?: boolean;
        maxChars?: number;
        now?: number;
    }): VaultLookupResult;
    close(): void;
};
