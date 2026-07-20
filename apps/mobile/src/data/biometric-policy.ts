export type BiometricGateDecision = 'open' | 'offer' | 'locked';

/** Prevents one authenticated identity from reusing the previous identity's open decision. */
export function isBiometricDecisionCurrent(input: {
  readonly authEnabled: boolean;
  readonly userId: string | null;
  readonly resolvedUserId: string | null;
}): boolean {
  if (!input.authEnabled || input.userId === null) return true;
  return input.resolvedUserId === input.userId;
}

/**
 * Pure security policy for a persisted session.
 * Once biometric protection was enabled, missing hardware is not permission to bypass it:
 * the gate remains locked and offers password re-authentication.
 */
export function decideBiometricGate(input: {
  readonly freshPasswordLogin: boolean;
  readonly optIn: boolean | null;
  readonly supportAvailable: boolean;
}): BiometricGateDecision {
  if (input.freshPasswordLogin) {
    return input.optIn === null && input.supportAvailable ? 'offer' : 'open';
  }
  return input.optIn === true ? 'locked' : 'open';
}

export function shouldRelockBiometricSession(input: {
  readonly protectionEnabled: boolean;
  readonly backgroundedAtMs: number | null;
  readonly resumedAtMs: number;
  readonly thresholdMs: number;
}): boolean {
  if (!input.protectionEnabled || input.backgroundedAtMs === null) return false;
  if (!Number.isFinite(input.thresholdMs) || input.thresholdMs < 0) return true;
  return input.resumedAtMs - input.backgroundedAtMs >= input.thresholdMs;
}
