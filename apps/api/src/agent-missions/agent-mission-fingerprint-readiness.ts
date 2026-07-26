import {
  type ResolvedAgentMissionHmacKeyRing,
} from '../config/env';
import type { Persistence } from '../persistence/persistence';
import {
  fingerprintAgentMissionHmacKey,
} from './agent-mission-fingerprint-key-version';

export async function assertAgentMissionFingerprintReadiness(
  persistence: Pick<Persistence, 'createAgentMissionFingerprintKeyVersionAuthority'>,
  keyRing: ResolvedAgentMissionHmacKeyRing,
): Promise<void> {
  const bindings = keyRing.versions.map((keyVersion) => {
    const secret = keyRing.secret(keyVersion);
    if (secret === null) {
      throw new Error(
        `AgentMission fingerprint HMAC key version ${keyVersion} is unavailable.`,
      );
    }
    return Object.freeze({
      keyVersion,
      keyFingerprint: fingerprintAgentMissionHmacKey(secret),
    });
  });
  const authority = persistence.createAgentMissionFingerprintKeyVersionAuthority(
    bindings,
    keyRing.currentVersion,
  );
  if (authority === null) {
    throw new Error('AgentMission fingerprint key-version authority is unavailable.');
  }
  await authority.assertKeyBindings();
}
