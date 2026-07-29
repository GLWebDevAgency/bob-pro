import { createHash } from 'node:crypto';
import {
  EvaluateReleaseFlag,
  type ReleaseFlagEnvironment,
} from '@bob/core';
import {
  resolveAgentMissionHmacKeyRing,
  type Env,
} from '../../config/env';
import type { Persistence } from '../../persistence/persistence';
import {
  isRealtimeCompanyId,
  REALTIME_AGENT_MISSION_QUOTE_RELEASE_FLAG_KEY,
  type RealtimeAgentMissionAdmissionBinding,
  type RealtimeProviderId,
} from './realtime-admission';
import {
  issueRealtimeAgentMissionCapability,
  type RealtimeAgentMissionNegotiationRequest,
} from './realtime-agent-mission-negotiation';

const PRINCIPAL_BINDING_DOMAIN = 'bob.agent-mission.principal-lock.v1\u0000';
const MAX_PRINCIPAL_USER_ID_BYTES = 512;
export type RealtimeAgentMissionAdmissionPreparation =
  | {
      readonly capability: null;
      readonly binding: null;
    }
  | {
      readonly capability: string;
      readonly binding: RealtimeAgentMissionAdmissionBinding;
    };

export interface RealtimeAgentMissionAdmissionGate {
  prepare(input: {
    readonly negotiation: RealtimeAgentMissionNegotiationRequest;
    readonly companyId: string;
    readonly userId: string;
    readonly providerId: RealtimeProviderId;
    readonly transport: 'webrtc' | 'mistral-pcm';
    readonly speechDelivery:
      | 'openai-native-webrtc-v1'
      | 'audited-signed-url-v1';
  }): Promise<RealtimeAgentMissionAdmissionPreparation>;
}

const NO_AGENT_MISSION = Object.freeze({
  capability: null,
  binding: null,
}) satisfies RealtimeAgentMissionAdmissionPreparation;

function validPrincipalUserId(userId: string): boolean {
  return userId.length > 0
    && Buffer.byteLength(userId, 'utf8') <= MAX_PRINCIPAL_USER_ID_BYTES
    && !userId.includes('\u0000');
}

/**
 * Lock stable indépendant des keyrings HMAC. Ce hash n'est ni un identifiant métier, ni une
 * donnée de log ; il sert uniquement à protéger l'absence d'une lease pendant l'admission.
 */
export function agentMissionPrincipalBindingHash(
  companyId: string,
  userId: string,
): string {
  if (!isRealtimeCompanyId(companyId) || !validPrincipalUserId(userId)) {
    throw new Error('AgentMission principal binding input is invalid.');
  }
  return createHash('sha256')
    .update(PRINCIPAL_BINDING_DOMAIN, 'utf8')
    .update(companyId, 'utf8')
    .update('\u0000', 'utf8')
    .update(userId, 'utf8')
    .digest('hex');
}

function runtimeAllowsV1(input: {
  providerId: RealtimeProviderId;
  transport: 'webrtc' | 'mistral-pcm';
  speechDelivery: 'openai-native-webrtc-v1' | 'audited-signed-url-v1';
}): boolean {
  return input.providerId === 'openai'
    && input.transport === 'webrtc'
    // Le natif V1 ne dispose pas encore d'un basculement audité par tour. Or tout fait tenanté,
    // choix et contrôle M1-C exige une parole exacte avant l'effet UI. Refuser ici évite une
    // capability mensongère qui ne casserait qu'après la première commande métier.
    && input.speechDelivery === 'audited-signed-url-v1';
}

export class DisabledRealtimeAgentMissionAdmissionGate
implements RealtimeAgentMissionAdmissionGate {
  async prepare(
    _input: Parameters<RealtimeAgentMissionAdmissionGate['prepare']>[0],
  ): Promise<RealtimeAgentMissionAdmissionPreparation> {
    return NO_AGENT_MISSION;
  }
}

export class DurableRealtimeAgentMissionAdmissionGate
implements RealtimeAgentMissionAdmissionGate {
  private readonly evaluateFlag: EvaluateReleaseFlag;

  constructor(
    private readonly persistence: Pick<Persistence, 'cabinet' | 'runWithIdentity'>,
    private readonly releaseEnvironment: ReleaseFlagEnvironment,
    private readonly capabilityEntropy?: () => Uint8Array,
  ) {
    this.evaluateFlag = new EvaluateReleaseFlag(persistence.cabinet.flags);
  }

  async prepare(
    input: Parameters<RealtimeAgentMissionAdmissionGate['prepare']>[0],
  ): Promise<RealtimeAgentMissionAdmissionPreparation> {
    if (
      input.negotiation.requested !== 'v1'
      || !runtimeAllowsV1(input)
    ) return NO_AGENT_MISSION;

    const principalBindingHash = agentMissionPrincipalBindingHash(
      input.companyId,
      input.userId,
    );
    let decision: Awaited<ReturnType<EvaluateReleaseFlag['execute']>>;
    try {
      decision = await this.persistence.runWithIdentity(
        input.userId,
        () => this.evaluateFlag.execute({
          environment: this.releaseEnvironment,
          key: REALTIME_AGENT_MISSION_QUOTE_RELEASE_FLAG_KEY,
          userId: input.userId,
        }),
      );
    } catch {
      return NO_AGENT_MISSION;
    }
    if (!decision.ok || !decision.value.enabled) return NO_AGENT_MISSION;
    if (
      !Number.isSafeInteger(decision.value.flagVersion)
      || (decision.value.flagVersion ?? 0) < 1
      || (decision.value.flagVersion ?? 0) > 2_147_483_647
    ) {
      throw new Error('AgentMission release flag returned an invalid enabled decision.');
    }

    const issued = this.capabilityEntropy === undefined
      ? issueRealtimeAgentMissionCapability()
      : issueRealtimeAgentMissionCapability(this.capabilityEntropy);
    return Object.freeze({
      capability: issued.capability,
      binding: Object.freeze({
        protocolVersion: 1,
        capabilityHash: issued.capabilityHash,
        releaseFlagKey: REALTIME_AGENT_MISSION_QUOTE_RELEASE_FLAG_KEY,
        releaseEnvironment: this.releaseEnvironment,
        releaseFlagVersion: decision.value.flagVersion as number,
        principalBindingHash,
      }),
    });
  }
}

/**
 * Composition boot-time. Le keyring est entièrement vérifié puis volontairement non retenu dans
 * le gate : M1-B ne doit pas élargir la durée de vie des secrets de fingerprint.
 */
export function buildRealtimeAgentMissionAdmissionGate(
  persistence: Pick<Persistence, 'cabinet' | 'runWithIdentity'>,
  env: Env,
): RealtimeAgentMissionAdmissionGate {
  if (env.BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED !== 'true') {
    return new DisabledRealtimeAgentMissionAdmissionGate();
  }
  const keyRing = resolveAgentMissionHmacKeyRing(env);
  if (keyRing === null) {
    throw new Error('AgentMission admission keyring is unavailable.');
  }
  for (const version of keyRing.versions) {
    if (keyRing.secret(version) === null) {
      throw new Error(`AgentMission admission keyring version ${version} is unavailable.`);
    }
  }
  return new DurableRealtimeAgentMissionAdmissionGate(
    persistence,
    env.CABINET_RELEASE_ENV,
  );
}
