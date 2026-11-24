export interface CompressionResult {
    text: any;
    changed: boolean;
    reason?: string;
}
export interface CompressionCacheStats {
    hits: number;
    misses: number;
    entries: number;
    chars: number;
}
export declare function stripAnsi(input: string): string;
export declare function tokenizeCommand(command: unknown): string[];
/** Finds the first real program token, skipping launchers; package-manager subcommands resolve to the manager. */
export declare function resolveProgram(tokens: readonly string[]): string;
export declare function deduplicateConsecutive(input: string): string;
/** Elide inline base64 data URIs and long raw base64/hex dumps in tool outputs without touching diagnostics. */
export declare function scrubBlobs(text: string): string;
/** Collapse consecutive debug/trace/verbose log lines while keeping info/warn/error and diagnostics untouched. */
export declare function filterDebugLogs(text: string): string;
/** Collapse runs of >= 3 byte-identical recursive stack frames to 1 frame plus a count marker. */
export declare function collapseStackTraces(text: string): string;
/** Lossless markdown table cell padding removal outside fenced code blocks. */
export declare function collapseTablePadding(text: string): string;
/** Collapse runaway single-character repetition loops and consecutive multi-line block loops. */
export declare function collapseRepetitionLoops(text: string): string;
export declare function clearCompressionCache(): void;
export declare function compressionCacheStats(): CompressionCacheStats;
export declare function looksStructured(text: string): boolean;
export declare function compressOutput({ command, text, exitCode, options, externalFailureNotice }: {
    command?: string;
    text: any;
    exitCode?: number;
    options: any;
    externalFailureNotice?: boolean;
}): CompressionResult;
/** Restrict non-shell tool filtering to lossless duplicate folding; do not
 * truncate distinct code/search results or structured tool payloads. */
export declare function dedupToolOutput(text: any, options: any): CompressionResult;
/**
 * Losslessly compact repeated project root prefixes and group consecutive
 * file/directory entries in grep/glob/find/ls outputs without dropping matches.
 */
export declare function compactListPaths(text: any, directory?: string, options?: any): CompressionResult;
