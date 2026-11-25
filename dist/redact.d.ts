export declare const REDACTED = "[REDACTED]";
/** Linear-time removal of `key: [REDACTED]` (key looked up backwards, bounded) for the emptiness check. */
export declare function stripRedactedAssignments(text: string): string;
export declare function redactSecrets(text: unknown): string;
