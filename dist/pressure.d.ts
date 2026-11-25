export interface ModelLimitEntry {
    context?: number;
    input?: number;
    output?: number;
}
export interface ResolvedModelLimit {
    context: number | undefined;
    output: number | undefined;
    source: 'event-model' | 'model-catalog' | 'config' | 'unavailable';
    capped?: boolean;
    uncappedContext?: number;
}
export interface ContextBreakdown {
    systemChars: number;
    chatChars: number;
    toolChars: number;
}
export interface ToolBloatEntry {
    name: string;
    chars: number;
}
export interface ContextDiagnostics {
    toolSchemaChars: number;
    toolCount: number;
    topTools: ToolBloatEntry[];
}
export interface PressureEstimate {
    estimatedTokens: number;
    estimatedChars: number;
    modelContext: number | undefined;
    modelSource: ResolvedModelLimit['source'];
    usableTokens: number | undefined;
    ratio: number | undefined;
    estimated: boolean;
    mediaPresent: boolean;
    reportedTokens?: number;
    /** Token count the ratio is based on: real provider tokens when available, else the byte estimate. */
    effectiveTokens: number;
    breakdown?: ContextBreakdown;
    diagnostics?: ContextDiagnostics;
}
export declare function recordPrunedMsgChars(msg: unknown, deltaChars: number): void;
export declare function getPrunedMsgChars(msg: unknown): number;
export declare function resolveModelLimit(event: any, modelLimits?: Map<string, ModelLimitEntry>, options?: any): ResolvedModelLimit;
/** Bytes are treated conservatively for mostly UTF-8 text, without expensive tokenizer dependencies. */
export declare function estimateTokens(text: unknown): number;
/** Only estimates model-visible text; media tokens are not predictable from these hooks. */
/** Real provider token counts keyed by assistant message id (e.g. from session.step.ended), plus drops already reflected in them. */
export interface NativeTokenInfo {
    tokens: Map<string, number>;
    baselineChars?: number;
}
export declare function sumPrunedMsgChars(messages: unknown): number;
export declare function estimateRequest(event: any, modelLimits: Map<string, ModelLimitEntry>, options: any, native?: NativeTokenInfo): PressureEstimate;
/** Prewarm host-provided limits once. Not a provider generation request. */
export declare function discoverModelLimits(ctx: any): Promise<Map<string, ModelLimitEntry>>;
export declare function resetModelLookupAttempts(attempted: Set<string>): void;
export declare function ensureModelLimit(ctx: any, modelLimits: Map<string, ModelLimitEntry>, model: any, attempted: Set<string>): Promise<void>;
