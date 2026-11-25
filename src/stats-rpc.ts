// Plain JSON-schema RPC definition shared by the server plugin and the TUI. No @opencode import:
// the host's `Rpc.define` accepts this exact shape, and the TUI calls `client.rpc(TRIM_STATS_RPC)`.
// Deliberately not frozen: host validators may annotate schema objects.
export const SNAPSHOT_VERSION: number = 1;
export const TRIM_STATS_RPC_ID: string = 'opencode-trim-stats';

export const TRIM_STATS_RPC = {
  id: TRIM_STATS_RPC_ID,
  methods: {
    snapshot: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string', minLength: 1, maxLength: 512 } },
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: { type: 'object' },
    },
    flush: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string', minLength: 1, maxLength: 512 } },
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          queued: { type: 'boolean' },
          sessionID: { type: 'string' },
        },
        required: ['queued', 'sessionID'],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: 'object',
        properties: { sessionID: { type: 'string' }, revision: { type: 'number' } },
        required: ['sessionID', 'revision'],
        additionalProperties: false,
      },
    },
  },
};

export default TRIM_STATS_RPC;
