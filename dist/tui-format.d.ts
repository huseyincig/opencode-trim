export interface SplitBarResult {
    filled: string;
    empty: string;
    text: string;
}
export declare function fmtCount(value: unknown): string;
export declare function fmtChars(value: unknown): string;
export declare function fmtPercent(ratio: unknown): string;
export declare function fmtAge(ms: unknown): string;
export declare function splitBar(ratio: unknown, width?: number): SplitBarResult;
export declare function isAscii(text: unknown): boolean;
