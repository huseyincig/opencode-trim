export interface GitCallInfo {
    sub: string;
    args: string[];
}
export interface GitInspectionResult {
    calls: GitCallInfo[];
    overflow: boolean;
}
/**
 * Dependency-free, quote/escape-aware shell command inspection used to find git
 * invocations and decide whether their output must never be compressed.
 * Pure text analysis; commands are never evaluated.
 *
 * Fail-closed: a command larger than MAX_COMMAND_CHARS, with more than
 * MAX_SEGMENTS shell segments or MAX_WORDS words in one segment, cannot be
 * analysed completely, so any command mentioning git is treated as protected.
 */
export declare const MAX_COMMAND_CHARS = 8192;
export declare const MAX_SEGMENTS = 32;
export declare const MAX_WORDS = 48;
/** Subcommands whose output is (or may be) a patch/blame/history that must stay verbatim. */
export declare const PROTECTED_GIT: Set<string>;
/**
 * Returns the index of the first word after leading env assignments and
 * prefix wrappers (sudo/env/nice/time/...), consuming option values such as
 * `sudo -u root` or `time -f x`. `--opt=value` is a single word.
 */
export declare function skipPrefixWords(words: readonly unknown[], start?: number): number;
/**
 * Quote/escape-aware split on unquoted ; | & and newlines (redirections such
 * as 2>&1 and &> are not separators). Quoted or backslash-escaped separators
 * stay inside their segment. An unterminated quote fails closed to the naive
 * split so a real separator cannot hide. Input beyond MAX_COMMAND_CHARS is ignored;
 * use inspect() to learn about truncation.
 */
export declare function splitSegments(command: unknown): string[];
/** Splits one segment into unquoted shell words (quotes removed, backslash escapes resolved). */
export declare function shellWords(segment: string): string[];
/**
 * Analyses every shell segment. Returns { calls: [{sub, args}], overflow }.
 * `overflow` is true when a limit was exceeded and the analysis is incomplete.
 */
export declare function inspectGit(command: unknown): GitInspectionResult;
/** Returns the git subcommand of every shell segment that invokes git. */
export declare function gitSubcommands(command: unknown): string[];
/** True when this single git call prints patch/diff content (or may). */
export declare function isProtectedGitCall(call: GitCallInfo): boolean;
/** True when compressing this command's output could damage patch/blame/diff content. Fails closed on overflow. */
export declare function isProtectedGit(command: unknown): boolean;
/**
 * True when the command has more than one top-level shell segment (pipe,
 * `&&`, `||`, `;`, `&` or newline outside quotes). Fails closed (true) if the
 * command is too large to analyse completely.
 */
export declare function hasTopLevelChain(command: unknown): boolean;
