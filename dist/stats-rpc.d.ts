export declare const SNAPSHOT_VERSION: number;
export declare const TRIM_STATS_RPC_ID: string;
export declare const TRIM_STATS_RPC: {
    id: string;
    methods: {
        snapshot: {
            input: {
                type: string;
                properties: {
                    sessionID: {
                        type: string;
                        minLength: number;
                        maxLength: number;
                    };
                };
                required: string[];
                additionalProperties: boolean;
            };
            output: {
                type: string;
            };
        };
        flush: {
            input: {
                type: string;
                properties: {
                    sessionID: {
                        type: string;
                        minLength: number;
                        maxLength: number;
                    };
                };
                required: string[];
                additionalProperties: boolean;
            };
            output: {
                type: string;
                properties: {
                    queued: {
                        type: string;
                    };
                    sessionID: {
                        type: string;
                    };
                };
                required: string[];
                additionalProperties: boolean;
            };
        };
    };
    events: {
        changed: {
            schema: {
                type: string;
                properties: {
                    sessionID: {
                        type: string;
                    };
                    revision: {
                        type: string;
                    };
                };
                required: string[];
                additionalProperties: boolean;
            };
        };
    };
};
export default TRIM_STATS_RPC;
