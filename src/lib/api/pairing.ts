import Constants from 'expo-constants';
import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

import {
  buildPairRequest,
  type ConfirmMode,
  type DeviceIdentity,
  openPairResponse,
  type PairingOffer,
  type PairRequestPayload,
  type SealedBox,
} from '../crypto/protocol';
import { fromB64u, toB64u } from '../encoding';
import type { PairedHost } from '../storage/keyStore';
import { bridgeErrorCode, ENDPOINTS } from './endpoints';
import { postJson, TransportError } from './http';
import { ClockSkewError } from './secureChannel';

/** SPEC P3: give up after 2 minutes (or when the QR offer expires, if sooner). */
const PAIRING_TIMEOUT_MS = 2 * 60 * 1000;
/** The host holds a `wait: true` request for up to 20 s; the HTTP timeout must be at least 25 s (contract §4.2). */
const LONG_POLL_HTTP_TIMEOUT_MS = 30 * 1000;
/**
 * Floor between long-poll requests that came back early while still pending. A correctly
 * long-polling host never triggers it; it keeps a non-holding host under A8's 10/min limit.
 */
const MIN_REPOLL_MS = 6 * 1000;

export class PairingRejectedError extends Error {
  constructor(message = 'Pairing was declined on the PC.') {
    super(message);
    this.name = 'PairingRejectedError';
  }
}

export class PairingTimeoutError extends Error {
  constructor(message = 'Pairing timed out. Try again.') {
    super(message);
    this.name = 'PairingTimeoutError';
  }
}

/** A2: the code was used by another device (`aborted` to us, or `409 pairing_locked`), so the offer is burned. */
export class PairingLockedError extends Error {
  constructor() {
    super('This code was used by another device. Generate a new one on your PC.');
    this.name = 'PairingLockedError';
  }
}

export interface PairingResult {
  host: PairedHost;
  /** Issued by the PC for bridge-enforced confirmation (§5). Absent when `confirmMode` is `none`. */
  confirmKey?: Uint8Array;
  confirmMode: ConfirmMode;
}

/**
 * Which confirm-key protection this phone can offer (contract §5.2). Android's
 * `requireAuthentication` needs Class 3 biometrics, so weak biometrics count as passcode.
 */
export async function detectConfirmMode(): Promise<ConfirmMode> {
  if (Platform.OS === 'web') return 'none';
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG) return 'biometric';
    if (level === LocalAuthentication.SecurityLevel.BIOMETRIC_WEAK || level === LocalAuthentication.SecurityLevel.SECRET) {
      return 'device_passcode';
    }
    return 'none';
  } catch {
    return 'none';
  }
}

/** The 6-digit code depends only on the keys and the pairing secret, so it can be shown immediately. */
export function pairingCode(identity: DeviceIdentity, offer: PairingOffer): string {
  return buildPairRequest(identity, offer, requestPayload(undefined, 'none', false)).sas;
}

/**
 * Long-polls the pairing request (contract §4.2) while the user compares codes and
 * approves on the PC: the first request returns `pending` at once, then each request
 * waits on the host until the offer changes or 20 s pass, and is re-sealed with a
 * fresh `ts`. Resolves once approved.
 */
export async function pairWithHost(
  identity: DeviceIdentity,
  offer: PairingOffer,
  { signal, deviceName, confirmMode }: { signal?: AbortSignal; deviceName?: string; confirmMode: ConfirmMode },
): Promise<PairingResult> {
  let urls = offer.urls;
  const deadline = Math.min(offer.expiresAt, Date.now() + PAIRING_TIMEOUT_MS);
  let wait = false;
  let lastSentAt = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (wait && Date.now() - lastSentAt < MIN_REPOLL_MS) await delay(MIN_REPOLL_MS - (Date.now() - lastSentAt), signal);

    const payload = requestPayload(deviceName, confirmMode, wait);
    const { body, pairingKey } = buildPairRequest(identity, offer, payload);
    lastSentAt = Date.now();
    const res = await postJson(urls, ENDPOINTS.pair, body, { signal, timeoutMs: LONG_POLL_HTTP_TIMEOUT_MS });
    urls = [res.baseUrl, ...offer.urls.filter((u) => u !== res.baseUrl)];

    if (res.status !== 200) {
      const code = bridgeErrorCode(res.json);
      if (code === 'pairing_expired') throw new PairingTimeoutError('This code expired. Generate a new one on your PC.');
      if (code === 'pairing_locked') throw new PairingLockedError();
      if (code === 'clock_skew') {
        const hostTime = (res.json as { hostTime?: unknown }).hostTime;
        throw new ClockSkewError(typeof hostTime === 'number' ? hostTime : undefined);
      }
      if (code === 'rate_limited') throw new TransportError('Too many pairing attempts. Wait a minute and try again.');
      // Contract rev 4.3 §4.4a: the code no longer matches the PC's keys, or the PC's identity changed.
      if (code === 'auth_failed') throw new PairingTimeoutError("This code doesn't match your PC any more. Generate a new one on your PC.");
      if (code === 'unknown_host') throw new PairingTimeoutError("Your PC's identity changed since this code was made. Generate a new one on your PC.");
      if (code === 'forbidden_peer') throw new TransportError('Your PC only accepts phones on its local network or your VPN.');
      throw new TransportError(`Pairing failed (${res.status}${code ? `: ${code}` : ''})`);
    }

    const reply = openPairResponse(pairingKey, offer.hostId, identity.deviceId, res.json as SealedBox, payload.ts);
    if (reply.status === 'approved') {
      return {
        host: {
          hostId: offer.hostId,
          hostName: reply.hostName || offer.hostName,
          hostPublicKey: toB64u(offer.hostPublicKey),
          urls,
          pairedAt: Date.now(),
          confirmMode,
        },
        confirmKey: reply.confirmKey ? fromB64u(reply.confirmKey) : undefined,
        confirmMode,
      };
    }
    if (reply.status === 'rejected') throw new PairingRejectedError();
    if (reply.status === 'aborted') throw new PairingLockedError();
    wait = true;
  }
  throw new PairingTimeoutError();
}

/** OS-provided default for the P1b name field. */
export function defaultDeviceName(): string {
  return Constants.deviceName ?? (Platform.OS === 'ios' ? 'iPhone' : 'Android phone');
}

function requestPayload(deviceName: string | undefined, confirmMode: ConfirmMode, wait: boolean): PairRequestPayload {
  return {
    deviceName: (deviceName?.trim() || defaultDeviceName()).slice(0, 40),
    platform: Platform.OS,
    appVersion: Constants.expoConfig?.version ?? '0.0.0',
    ts: Date.now(),
    confirmMode,
    wait,
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}
