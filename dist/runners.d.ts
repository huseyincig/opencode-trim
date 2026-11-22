export interface RunnerCompressionResult {
    text: any;
    dropped: number;
}
export declare function compressPassingTests(command: unknown, text: unknown): RunnerCompressionResult;
