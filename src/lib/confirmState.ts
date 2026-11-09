import { Platform } from 'react-native';

import type { ApprovalOption, HostInfo } from './api/types';
import type { PairedHost } from './storage/keyStore';

/**
 * How sensitive actions confirm on one PC (SPEC §15 terms, §15.5 table):
 * - off: the PC has `requireConfirm` off for this phone; actions send without a prompt;
 * - biometric / device_passcode: this phone's confirm key, unlocked per action;
 * - none: no screen lock, so no key was issued (and the PC requires one);
 * - needs_reconfirm: the key is unreadable or was rejected, or the pairing predates keys.
 * While /v1/host is loading, the PC's default (required) is assumed.
 */
export type ConfirmState = 'off' | 'biometric' | 'device_passcode' | 'none' | 'needs_reconfirm';

export function confirmStateFor(host: Pick<PairedHost, 'confirmMode' | 'keyInvalid'> | undefined, info: Pick<HostInfo, 'device'> | undefined): ConfirmState {
  if (info?.device?.requireConfirm === false) return 'off';
  if (!host) return 'needs_reconfirm';
  if (host.keyInvalid) return 'needs_reconfirm';
  if (host.confirmMode === 'biometric' || host.confirmMode === 'device_passcode') return host.confirmMode;
  if (host.confirmMode === 'none') return 'none';
  return 'needs_reconfirm';
}

/** Sensitive buttons work (possibly after a prompt). Otherwise they're disabled (SPEC §15.1.5). */
export const canConfirm = (state: ConfirmState) => state === 'off' || state === 'biometric' || state === 'device_passcode';

/**
 * What the phone can unlock with, from expo-local-authentication's supported types: one face
 * sensor, one fingerprint sensor, or several (e.g. Samsung fingerprint + face). null = unknown.
 */
export type BiometricKind = 'face' | 'fingerprint' | 'multiple';

/**
 * The phone's own name for its biometric (device run, 2026-11-08): Face ID / Touch ID on iOS;
 * Face unlock / Fingerprint on Android; "Biometrics" when there are several or it's unknown.
 */
export function biometricName(kind: BiometricKind | null, os: string = Platform.OS): string {
  if (kind === 'face') return os === 'ios' ? 'Face ID' : 'Face unlock';
  if (kind === 'fingerprint') return os === 'ios' ? 'Touch ID' : 'Fingerprint';
  return 'Biometrics';
}

/** Copy that names biometrics in general: "Face ID or Touch ID" / "fingerprint or face unlock". */
export function biometricsInGeneral(os: string = Platform.OS): string {
  return os === 'ios' ? 'Face ID or Touch ID' : 'fingerprint or face unlock';
}

/** The app-lock option label: "Face ID / Touch ID" on iOS, "Fingerprint / face unlock" elsewhere. */
export function biometricLockLabel(os: string = Platform.OS): string {
  return os === 'ios' ? 'Face ID / Touch ID' : 'Fingerprint / face unlock';
}

/** The Confirmations value text (SPEC §15.5). */
export function confirmValueText(state: ConfirmState, kind: BiometricKind | null): string {
  switch (state) {
    case 'biometric':
      return biometricName(kind);
    case 'device_passcode':
      return 'Passcode (app-enforced)';
    case 'off':
      return 'Off on this PC';
    case 'none':
      return 'Not available — no screen lock';
    case 'needs_reconfirm':
      return 'Needs re-confirming';
  }
}

/** States that warn (stNeedsYouText, and a dot for needs_reconfirm). */
export const isConfirmWarning = (state: ConfirmState) => state === 'off' || state === 'none' || state === 'needs_reconfirm';

/** Names in OS prompts are truncated to 40 characters (SPEC §15.1.1). */
export const promptName = (name: string) => (name.length > 40 ? `${name.slice(0, 39)}…` : name);

/** OS prompt copy for an approval option (SPEC §15.1.1, §15.4). */
export function allowPrompt(option: Pick<ApprovalOption, 'kind' | 'alwaysScope'> | null, tool: string, agentName: string): string {
  // The relabelled Claude "always" does the same as once, so it says so.
  const always = option?.kind === 'allow_always' && option.alwaysScope !== 'same_as_once';
  return `${always ? 'Always allow' : 'Allow'} ${promptName(tool)} for ${promptName(agentName)}`;
}
