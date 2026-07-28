import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, type Provider } from '@nestjs/common';
import type {
  AgentMissionFingerprint,
  AgentMissionFingerprintPort,
} from '@bob/core';
import {
  loadEnv,
  resolveAgentMissionHmacKeyRing,
  type Env,
  type ResolvedAgentMissionHmacKeyRing,
} from '../config/env';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import { assertAgentMissionFingerprintReadiness } from './agent-mission-fingerprint-readiness';

export const AGENT_MISSION_FINGERPRINTS = Symbol('AGENT_MISSION_FINGERPRINTS');

/** Garde fail-closed utilisée uniquement lorsque le master AgentMission est désactivé. */
@Injectable()
export class UnavailableAgentMissionFingerprints implements AgentMissionFingerprintPort {
  sign(): AgentMissionFingerprint | null {
    return null;
  }

  matches(): boolean | null {
    return null;
  }
}

export class HmacAgentMissionFingerprints implements AgentMissionFingerprintPort {
  constructor(private readonly keyRing: ResolvedAgentMissionHmacKeyRing) {}

  sign(
    canonicalRequest: string,
    keyVersion = this.keyRing.currentVersion,
  ): AgentMissionFingerprint | null {
    const secret = this.keyRing.secret(keyVersion);
    if (secret === null) return null;
    return Object.freeze({
      keyVersion,
      hmac: createHmac('sha256', Buffer.from(secret, 'base64url'))
        .update(canonicalRequest, 'utf8')
        .digest('hex'),
    });
  }

  matches(
    canonicalRequest: string,
    fingerprint: AgentMissionFingerprint,
  ): boolean | null {
    const expected = this.sign(canonicalRequest, fingerprint.keyVersion);
    if (expected === null || !/^[0-9a-f]{64}$/u.test(fingerprint.hmac)) return null;
    return timingSafeEqual(
      Buffer.from(expected.hmac, 'hex'),
      Buffer.from(fingerprint.hmac, 'hex'),
    );
  }
}

export async function buildAgentMissionFingerprints(
  persistence: Pick<Persistence, 'createAgentMissionFingerprintKeyVersionAuthority'>,
  env: Env = loadEnv(),
): Promise<AgentMissionFingerprintPort> {
  if (env.BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED !== 'true') {
    return new UnavailableAgentMissionFingerprints();
  }
  const keyRing = resolveAgentMissionHmacKeyRing(env);
  if (keyRing === null) {
    throw new Error('AgentMission fingerprint HMAC keyring is unavailable.');
  }
  await assertAgentMissionFingerprintReadiness(persistence, keyRing);
  return new HmacAgentMissionFingerprints(keyRing);
}

export const agentMissionFingerprintProvider: Provider = {
  provide: AGENT_MISSION_FINGERPRINTS,
  inject: [PERSISTENCE],
  useFactory: buildAgentMissionFingerprints,
};
