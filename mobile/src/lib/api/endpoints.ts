/** Bridge endpoints for the mobile secure channel (proposed; see docs/pairing-encryption-proposal.md). */
export const ENDPOINTS = {
  pair: '/api/mobile/v1/pair',
  session: '/api/mobile/v1/session',
  rpc: '/api/mobile/v1/rpc',
} as const;

/** Plaintext error codes the bridge returns outside the encrypted envelope. */
export type BridgeErrorCode =
  | 'unknown_session'
  | 'session_expired'
  | 'device_revoked'
  | 'unknown_host'
  | 'auth_failed'
  | 'pairing_expired'
  | 'pairing_locked'
  | 'clock_skew'
  | 'rate_limited'
  | 'malformed'
  | 'unsupported_version'
  /** rpc: the envelope's seq was already used (e.g. a stale retry); re-seal and send again. */
  | 'replayed'
  /** The PC only accepts private-network peers (contract rev 4.3 §4.4a). */
  | 'forbidden_peer';

export function bridgeErrorCode(json: unknown): BridgeErrorCode | undefined {
  if (json && typeof json === 'object' && 'error' in json && typeof json.error === 'string') {
    return json.error as BridgeErrorCode;
  }
  return undefined;
}
