export declare function createTrimStats({ options, now, emit, setTimeout: setT, clearTimeout: clearT, maxSessions, emitIntervalMs, }?: {
    options?: any;
    now?: () => number;
    emit?: (sessionID: string, revision: number) => any;
    setTimeout?: any;
    clearTimeout?: any;
    maxSessions?: number;
    emitIntervalMs?: number;
}): Record<string, any>;
