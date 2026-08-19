import { createHash } from 'node:crypto';
import {
  CUSTOMER_CONTACT_MISSION_KIND_V1,
  EvaluateReleaseFlag,
  QUOTE_CREATION_MISSION_KIND_V1,
  type MissionKindId,
  type ReleaseFlagEnvironment,
} from '@bob/core';
import { resolveAgentMissionHmacKeyRing, type Env } from '../../config/env';
import type { Persistence } from '../../persistence/persistence';
import {
  isRealtimeCompanyId,
  REALTIME_AGENT_MISSION_CUSTOMER_CONTACT_V1_RELEASE_FLAG_KEY,
  REALTIME_AGENT_MISSION_QUOTE_M2A_RELEASE_FLAG_KEY,
  REALTIME_AGENT_MISSION_QUOTE_RELEASE_FLAG_KEY,
  type RealtimeAgentMissionQuoteReleaseFlagKey,
  type RealtimeAgentMissionAdmissionBinding,
  type RealtimeAgentMissionKindBinding,
  type RealtimeProviderId,
} from './realtime-admission';
import {
  AGENT_MISSION_PROTOCOL_M2A_VERSION,
  AGENT_MISSION_PROTOCOL_VERSION,
  issueRealtimeAgentMissionCapability,
  type AgentMissionProtocolVersion,
  type RealtimeAgentMissionNegotiationRequest,
} from './realtime-agent-mission-negotiation';

const PRINCIPAL_BINDING_DOMAIN = 'bob.agent-mission.principal-lock.v1\u0000';
const MAX_PRINCIPAL_USER_ID_BYTES = 512;
export type RealtimeAgentMissionAdmissionPreparation =
  | {
      readonly capability: null;
      readonly binding: null;
      /** Aucun kind admis sans lease : la voix reste sur le chemin global. */
      readonly admittedKinds: readonly RealtimeAgentMissionKindBinding[];
    }
  | {
      readonly capability: string;
      readonly binding: RealtimeAgentMissionAdmissionBinding;
      /** Kinds RÉELLEMENT ouverts pour cette session — un par flag évalué (U1-d). */
      readonly admittedKinds: readonly RealtimeAgentMissionKindBinding[];
    };

export interface RealtimeAgentMissionAdmissionGate {
  available(input: {
    readonly protocolVersion: AgentMissionProtocolVersion;
    readonly companyId: string;
    readonly userId: string;
    readonly providerId: RealtimeProviderId;
    readonly transport: 'webrtc' | 'mistral-pcm';
    readonly speechDelivery: 'openai-native-webrtc-v1' | 'audited-signed-url-v1';
  }): Promise<boolean>;
  prepare(input: {
    readonly negotiation: RealtimeAgentMissionNegotiationRequest;
    readonly companyId: string;
    readonly userId: string;
    readonly providerId: RealtimeProviderId;
    readonly transport: 'webrtc' | 'mistral-pcm';
    readonly speechDelivery: 'openai-native-webrtc-v1' | 'audited-signed-url-v1';
  }): Promise<RealtimeAgentMissionAdmissionPreparation>;
}

const NO_AGENT_MISSION = Object.freeze({
  capability: null,
  binding: null,
  admittedKinds: Object.freeze([]),
}) satisfies RealtimeAgentMissionAdmissionPreparation;

/** Liste des kinds admis, dérivée des flags — jamais une liste écrite dans un appelant. */
export function admittedRealtimeMissionKindIds(
  preparation: RealtimeAgentMissionAdmissionPreparation,
): readonly MissionKindId[] {
  return Object.freeze(preparation.admittedKinds.map((kind) => kind.missionKindId));
}

function validPrincipalUserId(userId: string): boolean {
  return (
    userId.length > 0 &&
    Buffer.byteLength(userId, 'utf8') <= MAX_PRINCIPAL_USER_ID_BYTES &&
    !userId.includes('\u0000')
  );
}

/**
 * Lock stable indépendant des keyrings HMAC. Ce hash n'est ni un identifiant métier, ni une
 * donnée de log ; il sert uniquement à protéger l'absence d'une lease pendant l'admission.
 */
export function agentMissionPrincipalBindingHash(companyId: string, userId: string): string {
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

function runtimeAllowsAgentMission(input: {
  providerId: RealtimeProviderId;
  transport: 'webrtc' | 'mistral-pcm';
  speechDelivery: 'openai-native-webrtc-v1' | 'audited-signed-url-v1';
}): boolean {
  return (
    input.providerId === 'openai' &&
    input.transport === 'webrtc' &&
    (input.speechDelivery === 'audited-signed-url-v1' ||
      input.speechDelivery === 'openai-native-webrtc-v1')
  );
}

export class DisabledRealtimeAgentMissionAdmissionGate implements RealtimeAgentMissionAdmissionGate {
  async available(): Promise<boolean> {
    return false;
  }

  async prepare(
    _input: Parameters<RealtimeAgentMissionAdmissionGate['prepare']>[0],
  ): Promise<RealtimeAgentMissionAdmissionPreparation> {
    return NO_AGENT_MISSION;
  }
}

export class DurableRealtimeAgentMissionAdmissionGate implements RealtimeAgentMissionAdmissionGate {
  private readonly evaluateFlag: EvaluateReleaseFlag;

  constructor(
    private readonly persistence: Pick<Persistence, 'cabinet' | 'runWithIdentity'>,
    private readonly releaseEnvironment: ReleaseFlagEnvironment,
    private readonly capabilityEntropy?: () => Uint8Array,
    private readonly allowedProtocolVersions: readonly AgentMissionProtocolVersion[] = [
      AGENT_MISSION_PROTOCOL_VERSION,
    ],
  ) {
    this.evaluateFlag = new EvaluateReleaseFlag(persistence.cabinet.flags);
  }

  async available(
    input: Parameters<RealtimeAgentMissionAdmissionGate['available']>[0],
  ): Promise<boolean> {
    return (await this.evaluateRuntimeDecision(input)) !== null;
  }

  async prepare(
    input: Parameters<RealtimeAgentMissionAdmissionGate['prepare']>[0],
  ): Promise<RealtimeAgentMissionAdmissionPreparation> {
    const protocolVersion =
      input.negotiation.requested === 'v1' || input.negotiation.requested === 'v2'
        ? input.negotiation.protocolVersion
        : null;
    if (protocolVersion === null) return NO_AGENT_MISSION;
    const runtimeDecision = await this.evaluateRuntimeDecision({
      protocolVersion,
      companyId: input.companyId,
      userId: input.userId,
      providerId: input.providerId,
      transport: input.transport,
      speechDelivery: input.speechDelivery,
    });
    if (runtimeDecision === null) return NO_AGENT_MISSION;
    const { flagVersion, principalBindingHash, releaseFlagKey } = runtimeDecision;
    // Kind par kind (U1-d) : le devis est admis par le flag qui scelle déjà la lease ; la fiche
    // client ajoute SON flag, évalué séparément et OFF par défaut. Un kind non admis n'existe
    // pas pour le tour — ni outil, ni lentille, ni exécution.
    const customerContactFlagVersion = await this.evaluateKindFlagVersion(
      input.userId,
      REALTIME_AGENT_MISSION_CUSTOMER_CONTACT_V1_RELEASE_FLAG_KEY,
    );
    const admittedKinds: readonly RealtimeAgentMissionKindBinding[] = Object.freeze([
      Object.freeze({
        missionKindId: QUOTE_CREATION_MISSION_KIND_V1,
        releaseFlagKey,
        releaseEnvironment: this.releaseEnvironment,
        releaseFlagVersion: flagVersion,
      }),
      ...(customerContactFlagVersion === null
        ? []
        : [
            Object.freeze({
              missionKindId: CUSTOMER_CONTACT_MISSION_KIND_V1,
              releaseFlagKey: REALTIME_AGENT_MISSION_CUSTOMER_CONTACT_V1_RELEASE_FLAG_KEY,
              releaseEnvironment: this.releaseEnvironment,
              releaseFlagVersion: customerContactFlagVersion,
            } as const),
          ]),
    ]);

    const issued =
      this.capabilityEntropy === undefined
        ? issueRealtimeAgentMissionCapability(protocolVersion)
        : issueRealtimeAgentMissionCapability(protocolVersion, this.capabilityEntropy);
    const binding: RealtimeAgentMissionAdmissionBinding =
      protocolVersion === AGENT_MISSION_PROTOCOL_VERSION
        ? Object.freeze({
            protocolVersion: AGENT_MISSION_PROTOCOL_VERSION,
            capabilityHash: issued.capabilityHash,
            releaseFlagKey: REALTIME_AGENT_MISSION_QUOTE_RELEASE_FLAG_KEY,
            releaseEnvironment: this.releaseEnvironment,
            releaseFlagVersion: flagVersion,
            principalBindingHash,
          })
        : Object.freeze({
            protocolVersion: AGENT_MISSION_PROTOCOL_M2A_VERSION,
            capabilityHash: issued.capabilityHash,
            releaseFlagKey: REALTIME_AGENT_MISSION_QUOTE_M2A_RELEASE_FLAG_KEY,
            releaseEnvironment: this.releaseEnvironment,
            releaseFlagVersion: flagVersion,
            principalBindingHash,
          });
    return Object.freeze({
      capability: issued.capability,
      binding,
      admittedKinds,
    });
  }

  /**
   * Version du flag d'un kind, ou `null` s'il est OFF/indisponible. Fail-closed : une panne de
   * lecture ferme le kind, elle n'ouvre jamais un vertical par défaut.
   */
  private async evaluateKindFlagVersion(
    userId: string,
    key: typeof REALTIME_AGENT_MISSION_CUSTOMER_CONTACT_V1_RELEASE_FLAG_KEY,
  ): Promise<number | null> {
    let decision: Awaited<ReturnType<EvaluateReleaseFlag['execute']>>;
    try {
      decision = await this.persistence.runWithIdentity(userId, () =>
        this.evaluateFlag.execute({
          environment: this.releaseEnvironment,
          key,
          userId,
        }),
      );
    } catch {
      return null;
    }
    if (!decision.ok || !decision.value.enabled) return null;
    const flagVersion = decision.value.flagVersion;
    return Number.isSafeInteger(flagVersion) &&
      (flagVersion ?? 0) >= 1 &&
      (flagVersion ?? 0) <= 2_147_483_647
      ? (flagVersion as number)
      : null;
  }

  private async evaluateRuntimeDecision(input: {
    readonly protocolVersion: AgentMissionProtocolVersion;
    readonly companyId: string;
    readonly userId: string;
    readonly providerId: RealtimeProviderId;
    readonly transport: 'webrtc' | 'mistral-pcm';
    readonly speechDelivery: 'openai-native-webrtc-v1' | 'audited-signed-url-v1';
  }): Promise<{
    readonly releaseFlagKey: RealtimeAgentMissionQuoteReleaseFlagKey;
    readonly flagVersion: number;
    readonly principalBindingHash: string;
  } | null> {
    if (
      !this.allowedProtocolVersions.includes(input.protocolVersion) ||
      !runtimeAllowsAgentMission(input)
    )
      return null;
    let principalBindingHash: string;
    try {
      principalBindingHash = agentMissionPrincipalBindingHash(input.companyId, input.userId);
    } catch {
      return null;
    }
    const releaseFlagKey: RealtimeAgentMissionQuoteReleaseFlagKey =
      input.protocolVersion === AGENT_MISSION_PROTOCOL_VERSION
        ? REALTIME_AGENT_MISSION_QUOTE_RELEASE_FLAG_KEY
        : REALTIME_AGENT_MISSION_QUOTE_M2A_RELEASE_FLAG_KEY;
    let decision: Awaited<ReturnType<EvaluateReleaseFlag['execute']>>;
    try {
      decision = await this.persistence.runWithIdentity(input.userId, () =>
        this.evaluateFlag.execute({
          environment: this.releaseEnvironment,
          key: releaseFlagKey,
          userId: input.userId,
        }),
      );
    } catch {
      return null;
    }
    if (!decision.ok || !decision.value.enabled) return null;
    const flagVersion = decision.value.flagVersion;
    if (
      !Number.isSafeInteger(flagVersion) ||
      (flagVersion ?? 0) < 1 ||
      (flagVersion ?? 0) > 2_147_483_647
    ) {
      throw new Error('AgentMission release flag returned an invalid enabled decision.');
    }
    return Object.freeze({
      releaseFlagKey,
      flagVersion: flagVersion as number,
      principalBindingHash,
    });
  }
}

/**
 * Composition boot-time. Le keyring est entièrement vérifié puis volontairement non retenu dans
 * le gate : M1-B ne doit pas élargir la durée de vie des secrets de fingerprint.
 *
 * U1-d — borne assumée : l'activation du gate reste portée par le flag de release DEVIS, car la
 * lease est scellée en base par SA clé de flag (`revalidate_agent_mission_release_flag_v1`,
 * writer N-1 de `reserve`, hors périmètre de ce lot). Le vertical fiche client s'ADDITIONNE
 * donc à une session déjà admise : son flag `bob.agent_missions.customer_contact.v1` décide
 * seulement de l'admission du kind. Ouvrir la fiche client SANS devis exigera d'élargir le
 * writer `reserve` et l'env (`BOB_AGENT_MISSIONS_CUSTOMER_CONTACT_V1_ENABLED`) — vague B.
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
    undefined,
    env.BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED === 'true'
      ? [AGENT_MISSION_PROTOCOL_VERSION, AGENT_MISSION_PROTOCOL_M2A_VERSION]
      : [AGENT_MISSION_PROTOCOL_VERSION],
  );
}
