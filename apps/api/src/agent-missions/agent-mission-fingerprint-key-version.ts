import { createHash } from 'node:crypto';

const POSTGRES_INT_MAX = 2_147_483_647;
const MAX_AGENT_MISSION_FINGERPRINT_KEY_VERSIONS = 32;
const SHA256 = /^[a-f0-9]{64}$/u;
const AGENT_MISSION_FINGERPRINT_KEY_DOMAIN = Buffer.from(
  'bob.agent-mission.fingerprint-hmac-key.v1\0',
  'utf8',
);

export const AGENT_MISSION_FINGERPRINT_KEY_SPACE =
  'bob-agent-mission-fingerprint-hmac-v1';

export interface AgentMissionFingerprintKeyBinding {
  readonly keyVersion: number;
  readonly keyFingerprint: string;
}

export interface AgentMissionFingerprintKeyVersionAuthority {
  /**
   * Refuse le démarrage si un binding configuré diffère du registre append-only ou si un event
   * durable référence une version absente. Seule une autorité DB globale bornée l'implémente.
   */
  assertKeyBindings(): Promise<void>;
}

export function canonicalAgentMissionFingerprintKeyVersions(
  versions: readonly number[],
): readonly number[] | null {
  if (
    !Array.isArray(versions)
    || versions.length < 1
    || versions.length > MAX_AGENT_MISSION_FINGERPRINT_KEY_VERSIONS
    || versions.some((version) => (
      !Number.isSafeInteger(version)
      || version < 1
      || version > POSTGRES_INT_MAX
    ))
    || new Set(versions).size !== versions.length
  ) return null;
  return Object.freeze([...versions].sort((left, right) => left - right));
}

export function fingerprintAgentMissionHmacKey(secret: string): string {
  if (typeof secret !== 'string') {
    throw new Error('AgentMission fingerprint HMAC key material is invalid.');
  }
  const decoded = Buffer.from(secret, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== secret) {
    throw new Error('AgentMission fingerprint HMAC key material is invalid.');
  }
  return createHash('sha256')
    .update(AGENT_MISSION_FINGERPRINT_KEY_DOMAIN)
    .update(decoded)
    .digest('hex');
}

export function canonicalAgentMissionFingerprintKeyBindings(
  bindings: readonly AgentMissionFingerprintKeyBinding[],
): readonly AgentMissionFingerprintKeyBinding[] | null {
  if (!Array.isArray(bindings) || bindings.length < 1
      || bindings.length > MAX_AGENT_MISSION_FINGERPRINT_KEY_VERSIONS) {
    return null;
  }
  const versions = canonicalAgentMissionFingerprintKeyVersions(
    bindings.map(({ keyVersion }) => keyVersion),
  );
  if (versions === null
      || bindings.some(({ keyFingerprint }) => !SHA256.test(keyFingerprint))
      || new Set(bindings.map(({ keyFingerprint }) => keyFingerprint)).size !== bindings.length) {
    return null;
  }
  const byVersion = new Map(
    bindings.map((binding) => [binding.keyVersion, binding] as const),
  );
  return Object.freeze(versions.map((keyVersion) => Object.freeze({
    keyVersion,
    keyFingerprint: byVersion.get(keyVersion)!.keyFingerprint,
  })));
}
