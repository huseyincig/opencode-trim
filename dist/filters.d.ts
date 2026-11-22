export interface FilterApplicationResult {
    text: any;
    dropped: number;
    program?: string;
}
export declare function programOf(command: unknown): string;
export declare function hasDiagnostic(line: string): boolean;
export declare function hasFailure(line: string): boolean;
export declare function hasImportantPath(line: string): boolean;
export declare function isProtectedCommand(command: unknown): boolean;
/** Drops only user-configured filterRules lines for `programs` (a program name or list). Diagnostics, summaries and anchors are always kept. */
export declare function applyCustomRules(programs: string | string[], text: unknown, options: any): FilterApplicationResult;
export declare function applyLineFilters(command: unknown, text: string, options: any): FilterApplicationResult;
export declare const BUILTIN_PROGRAMS: readonly string[];
