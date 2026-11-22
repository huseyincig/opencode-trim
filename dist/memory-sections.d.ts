export interface SectionRange {
    start: number;
    end: number;
}
export declare const SECTION_NAMES: readonly string[];
/** Canonical section name for a user spelling (case/space/hyphen/underscore tolerant), else null. */
export declare function normalizeSection(value: unknown): string | null;
/**
 * Parse `## Heading` sections. Returns Map<canonicalName, {start, end}> offsets into `text`
 * (body only, heading line excluded). First occurrence of a known section wins; unknown `##`
 * headings end the current section but never discard others. Headings inside fenced code are ignored.
 */
export declare function parseSections(text: unknown): Map<string, SectionRange>;
/** Text of one section (empty string when absent). */
export declare function sectionText(text: unknown, section: unknown): string;
/** Bounded snippet from `section`, around the first query token present, else from the section start. */
export declare function sectionSnippet(text: unknown, section: unknown, query: unknown, maxChars: unknown): string;
