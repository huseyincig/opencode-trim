export interface FamilyContext {
    command?: string;
    tokens?: string[];
    program?: string;
    failed?: boolean;
    exitCode?: number;
    externalFailureNotice?: boolean;
    head?: string;
    options?: {
        maxOutputLines?: number;
        maxOutputChars?: number;
        [key: string]: unknown;
    };
}
export interface FamilyLimits {
    maxLines: number;
    maxChars: number;
}
export { skipPrefixWords, splitSegments, shellWords, gitSubcommands } from "../git.ts";
export declare const FAILURE: RegExp;
export declare const WARNING: RegExp;
export declare const SUMMARY: RegExp;
export declare const STACK: RegExp;
export declare const ANCHOR: RegExp;
export declare function clean(text: unknown): string;
/** Configured output caps (conservative defaults for direct calls without ctx). */
export declare function familyLimits(ctx?: FamilyContext): FamilyLimits;
export declare function splitLines(text: unknown): string[];
export declare function render(rows: readonly string[]): string;
export declare function isImportant(line: string): boolean;
export declare function isFailure(line: string): boolean;
export declare function isNoiseMeter(line: string): boolean;
export declare function dropMatching(rows: readonly string[], predicate: (line: string) => boolean): {
    rows: string[];
    dropped: number;
};
export declare function foldMatching(rows: readonly string[], predicate: (line: string) => boolean, label: string): {
    text: string;
    dropped: number;
};
export declare function headTail(rows: readonly string[], max: number, label: string): string;
export declare function unique(rows: readonly string[]): string[];
export declare function collapseBlank(rows: readonly string[], max?: number): string[];
export declare function compactRows(rows: readonly string[], max: number): string;
export declare function summarizeCounts(text: string): string;
export declare function hasTestSummary(text: unknown): boolean;
export declare function truncateLine(line: string, max?: number): string;
