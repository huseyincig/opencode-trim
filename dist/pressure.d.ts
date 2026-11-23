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
}
export declare function recordPrunedMsgChars(msg: unknown, deltaChars: number): void;
export declare function getPrunedMsgChars(msg: unknown): number;
export declare function resolveModelLimit(event: any, modelLimits?: Map<string, ModelLimitEntry>, options?: any): ResolvedModelLimit;
/** Bytes are treated conservatively for mostly UTF-8 text, without expensive tokenizer dependencies. */
export declare function estimateTokens(text: unknown): number;
/** Only estimates model-visible text; media tokens are not predictable from these hooks. */
export declare function estimateRequest(event: any, modelLimits: Map<string, ModelLimitEntry>, options: any): PressureEstimate;
/** Prewarm host-provided limits once. Not a provider generation request. */
export declare function discoverModelLimits(ctx: any): Promise<Map<string, ModelLimitEntry>>;
export declare function ensureModelLimit(ctx: any, modelLimits: Map<string, ModelLimitEntry>, model: any, attempted: Set<string>): Promise<void>;
