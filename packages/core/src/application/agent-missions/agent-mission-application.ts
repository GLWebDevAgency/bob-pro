import {
  AgentMission,
  type AgentMissionError,
  type AgentMissionTransition,
  type QuoteCreationMissionPayloadV1,
  type QuoteMissionDraftReferenceV1,
} from '../../domain/agent/agent-mission';
import { normalizeCustomerName } from '../../domain/customer/customer';
import {
  type AgentMissionActor,
  AgentMissionEvent,
  AGENT_MISSION_EVENT_RETENTION_MS,
  type AgentMissionEventSnapshot,
} from '../../domain/agent/agent-mission-event';
import { sha256Hex } from '../../shared-kernel/sha256';
import { type Instant } from '../../shared-kernel/time';
import { type Result, err, ok } from '../../shared-kernel/result';
import { hasAsciiControlCharacter } from '../../shared-kernel/control-characters';
import { type IdGeneratorPort } from '../ports/services';
import {
  type AgentMissionFingerprint,
  type AgentMissionFingerprintPort,
} from '../ports/agent-mission-fingerprint';
import {
  type AgentMissionEventLookup,
  type AgentMissionLookup,
  type AgentMissionOwner,
} from '../ports/agent-mission-repository';
import {
  type AgentMissionCapabilityRejectionReason,
  type AgentMissionForegroundUnavailableReason,
  type AgentMissionTransaction,
} from '../ports/agent-mission-unit-of-work';
import {
  type AppError,
  appConflict,
  appForbidden,
  appNotFound,
  appUnavailable,
} from '../result';
import { type CustomerCandidateReference } from '../ports/customer-candidate-search';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSTGRES_INT_MAX = 2_147_483_647;

export type AgentMissionUserCommandOrigin =
  | {
      readonly actor: 'user_tap';
      readonly correlation: null | {
        readonly realtimeSessionId: string;
        readonly contextRevision: number;
        readonly contextDigest: string;
      };
    }
  | {
      readonly actor: 'user_voice';
      readonly correlation: {
        readonly realtimeSessionId: string;
        readonly turnId: string;
        readonly contextRevision: number;
        readonly contextDigest: string;
      };
    };

export interface AgentMissionViewV1 {
  readonly id: string;
  readonly kind: 'quote_creation';
  readonly status: 'active' | 'cancelled' | 'expired';
  readonly actionable: boolean;
  readonly phase: AgentMission['phase'];
  readonly revision: number;
  readonly payloadVersion: 1;
  readonly payload: QuoteCreationMissionPayloadV1;
  readonly currentBinding: AgentMission['currentBinding'];
  readonly idleExpiresAt: Instant;
  readonly hardExpiresAt: Instant;
  readonly terminalAt: Instant | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

/**
 * Un reçu idempotent ne redevient jamais une autorité de premier plan.
 *
 * Après vérification du journal et du fingerprint, chaque use case appelle ce garde avant de
 * restituer une mission historique. Un autre kind actif gagne toujours : le replay est alors
 * refusé sans transition, sans effet métier et sans navigation dérivée de l'ancienne réponse.
 */
export async function guardAgentMissionReplayForeground(input: {
  readonly transaction: AgentMissionTransaction;
  readonly owner: AgentMissionOwner;
  readonly replayedMissionId: string;
}): Promise<Result<void, AppError>> {
  const foreground = await input.transaction.missions.findForegroundForUpdate(input.owner);
  if (foreground === null) return ok(undefined);
  const foregroundMissionId = foreground.status === 'known'
    ? foreground.mission.id
    : foreground.missionId;
  return foregroundMissionId === input.replayedMissionId
    ? ok(undefined)
    : err(appConflict('agent_mission_foreground', 'active_mission_exists'));
}

/** Un binaire devis ne parse jamais une mission ajoutée par un binaire plus récent. */
export function resolveQuoteAgentMissionLookup(
  lookup: AgentMissionLookup | null,
): Result<AgentMission | null, AppError> {
  if (lookup === null) return ok(null);
  return lookup.status === 'known'
    ? ok(lookup.mission)
    : err(appConflict('agent_mission_kind', 'unsupported_kind'));
}

/** Même discrimination pour le journal : un commandId futur n'est jamais considéré comme neuf. */
export function resolveQuoteAgentMissionEventLookup(
  lookup: AgentMissionEventLookup | null,
): Result<AgentMissionEvent | null, AppError> {
  if (lookup === null) return ok(null);
  return lookup.status === 'known'
    ? ok(lookup.event)
    : err(appConflict('agent_mission_kind', 'unsupported_kind'));
}

/**
 * Résout une commande devis neuve sans jamais demander au repository de parser le payload d'un
 * autre kind. Le foreground global est l'autorité : un kind inconnu ou une autre mission active
 * refuse la commande ; la mission devis courante est réutilisée déjà typée. La lecture par ID ne
 * subsiste que pour rendre le résultat historique d'une mission devis terminale.
 */
export async function resolveQuoteAgentMissionForUpdate(input: {
  readonly transaction: AgentMissionTransaction;
  readonly owner: AgentMissionOwner;
  readonly missionId: string;
}): Promise<Result<AgentMission | null, AppError>> {
  const foreground = await input.transaction.missions.findForegroundForUpdate(input.owner);
  if (foreground === null) {
    const lookup = await input.transaction.missions.findByIdForUpdate({
      ...input.owner,
      missionId: input.missionId,
    });
    return resolveQuoteAgentMissionLookup(lookup);
  }
  if (
    foreground.status === 'unsupported_kind'
    || foreground.mission.id !== input.missionId
  ) {
    return err(appConflict('agent_mission_foreground', 'active_mission_exists'));
  }
  return ok(foreground.mission);
}

export function isCanonicalAgentMissionUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isCanonicalAgentMissionOwner(owner: AgentMissionOwner): boolean {
  return (
    owner.companyId.length >= 1
    && owner.companyId.length <= 200
    && owner.companyId === owner.companyId.trim()
    && !hasAsciiControlCharacter(owner.companyId)
    && owner.ownerUserId.length >= 1
    && owner.ownerUserId.length <= 200
    && owner.ownerUserId === owner.ownerUserId.trim()
    && !hasAsciiControlCharacter(owner.ownerUserId)
  );
}

export function canonicalAgentMissionCommand(input: AgentMissionOwner & {
  readonly operation: 'start_quote_creation' | 'cancel_quote_creation' | 'expire_quote_creation';
  readonly commandId: string;
  readonly missionId?: string;
  readonly expectedRevision?: number;
  readonly reason?: 'user_cancelled' | 'manual_handoff';
}): string {
  return JSON.stringify([
    'bob.agent-mission.command.v1',
    input.operation,
    input.companyId,
    input.ownerUserId,
    input.commandId,
    input.missionId ?? null,
    input.expectedRevision ?? null,
    input.reason ?? null,
  ]);
}

export function isCanonicalAgentMissionUserCommandOrigin(
  value: unknown,
): value is AgentMissionUserCommandOrigin {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const origin = value as Record<string, unknown>;
  if (
    !Object.hasOwn(origin, 'actor')
    || !Object.hasOwn(origin, 'correlation')
    || Object.keys(origin).some((key) => key !== 'actor' && key !== 'correlation')
  ) return false;
  const actor = origin['actor'];
  const correlation = origin['correlation'];
  if (actor === 'user_tap' && correlation === null) return true;
  if (
    (actor !== 'user_tap' && actor !== 'user_voice')
    || typeof correlation !== 'object'
    || correlation === null
    || Array.isArray(correlation)
  ) return false;
  const candidate = correlation as Record<string, unknown>;
  const expectedKeys = actor === 'user_voice'
    ? ['realtimeSessionId', 'turnId', 'contextRevision', 'contextDigest']
    : ['realtimeSessionId', 'contextRevision', 'contextDigest'];
  if (
    Object.keys(candidate).length !== expectedKeys.length
    || !expectedKeys.every((key) => Object.hasOwn(candidate, key))
    || !isCanonicalAgentMissionUuid(candidate['realtimeSessionId'])
    || (
      actor === 'user_voice'
      && !isCanonicalAgentMissionUuid(candidate['turnId'])
    )
    || !Number.isSafeInteger(candidate['contextRevision'])
    || Object.is(candidate['contextRevision'], -0)
    || (candidate['contextRevision'] as number) < 1
    || (candidate['contextRevision'] as number) > POSTGRES_INT_MAX
    || typeof candidate['contextDigest'] !== 'string'
    || !SHA256.test(candidate['contextDigest'])
  ) return false;
  return true;
}

/**
 * Préserve volontairement le fingerprint M1-A du démarrage tactile sans référence. Toute
 * sémantique M1-C utilise une nouvelle enveloppe qui lie la provenance et la référence transitoire.
 */
export function canonicalAgentMissionStartCommand(input: AgentMissionOwner & {
  readonly commandId: string;
  readonly origin: AgentMissionUserCommandOrigin;
  readonly customerReference: string | null;
}): string {
  if (input.origin.actor === 'user_tap'
    && input.origin.correlation === null
    && input.customerReference === null) {
    return canonicalAgentMissionCommand({
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
      operation: 'start_quote_creation',
      commandId: input.commandId,
    });
  }
  const correlation = input.origin.correlation;
  const turnId = input.origin.actor === 'user_voice'
    ? input.origin.correlation.turnId
    : null;
  return JSON.stringify([
    'bob.agent-mission.command.start-quote.v2',
    input.companyId,
    input.ownerUserId,
    input.commandId,
    input.origin.actor,
    correlation?.realtimeSessionId ?? null,
    turnId,
    correlation?.contextRevision ?? null,
    correlation?.contextDigest ?? null,
    input.customerReference,
  ]);
}

export function canonicalAgentMissionScreenAckCommand(input: AgentMissionOwner & {
  readonly commandId: string;
  readonly missionId: string;
  readonly expectedMissionRevision: number;
  readonly realtimeSessionId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly draftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
}): string {
  return JSON.stringify([
    'bob.agent-mission.command.v1',
    'acknowledge_quote_screen',
    input.companyId,
    input.ownerUserId,
    input.commandId,
    input.missionId,
    input.expectedMissionRevision,
    input.realtimeSessionId,
    input.contextRevision,
    input.contextDigest,
    input.draftSessionId,
    input.expectedDraftSlotRevision,
    input.expectedDraftContentRevision,
  ]);
}

export function canonicalAgentMissionAdvanceCustomerCommand(input: AgentMissionOwner & {
  readonly commandId: string;
  readonly missionId: string;
  readonly acknowledgementCommandId: string;
  readonly acknowledgementMissionRevision: number;
  readonly realtimeSessionId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
}): string {
  return JSON.stringify([
    'bob.agent-mission.command.v1',
    'consume_staged_customer_resolution',
    input.companyId,
    input.ownerUserId,
    input.commandId,
    input.missionId,
    input.acknowledgementCommandId,
    input.acknowledgementMissionRevision,
    input.realtimeSessionId,
    input.contextRevision,
    input.contextDigest,
  ]);
}

export function canonicalAgentMissionCustomerDecisionCommand(input: AgentMissionOwner & {
  readonly missionId: string;
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly origin: AgentMissionUserCommandOrigin;
  readonly decision:
    | {
        readonly action: 'choose_presented_option';
        readonly decisionId: string;
        readonly choiceSetRevision: number;
        readonly choiceId: string;
      }
    | {
      readonly action: 'select_screen_customer';
      readonly customerId: string;
    }
    | {
      readonly action: 'resolve_customer_reference';
      readonly customerReference: string;
    };
}): string {
  const correlation = input.origin.correlation;
  const turnId = input.origin.actor === 'user_voice'
    ? input.origin.correlation.turnId
    : null;
  const decision = input.decision.action === 'choose_presented_option'
    ? [
        input.decision.action,
        input.decision.decisionId,
        input.decision.choiceSetRevision,
        input.decision.choiceId,
      ]
    : input.decision.action === 'select_screen_customer'
      ? [
          input.decision.action,
          input.decision.customerId,
        ]
      : [
          input.decision.action,
          input.decision.customerReference,
        ];
  return JSON.stringify([
    'bob.agent-mission.command.customer-decision.v1',
    input.companyId,
    input.ownerUserId,
    input.missionId,
    input.commandId,
    input.expectedMissionRevision,
    input.expectedDraftSessionId,
    input.expectedDraftSlotRevision,
    input.expectedDraftContentRevision,
    input.origin.actor,
    correlation?.realtimeSessionId ?? null,
    turnId,
    correlation?.contextRevision ?? null,
    correlation?.contextDigest ?? null,
    decision,
  ]);
}

export function isCanonicalCustomerCandidateReference(
  value: unknown,
): value is CustomerCandidateReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2
    || !Object.hasOwn(candidate, 'customerId')
    || !Object.hasOwn(candidate, 'canonicalName')
  ) return false;
  return (
    typeof candidate['customerId'] === 'string'
    && candidate['customerId'].length >= 1
    && candidate['customerId'].length <= 200
    && candidate['customerId'] === candidate['customerId'].trim()
    && !hasAsciiControlCharacter(candidate['customerId'])
    && typeof candidate['canonicalName'] === 'string'
    && normalizeCustomerName(candidate['canonicalName'])
      === candidate['canonicalName']
  );
}

export type AgentMissionSystemCommandInput =
  | {
      readonly operation: 'expire_quote_creation';
      readonly companyId: string;
      readonly ownerUserId: string;
      readonly missionId: string;
      readonly missionRevision: number;
      readonly effectiveReason: 'idle_ttl' | 'hard_ttl';
      readonly effectiveExpiresAt: Instant;
    }
  | {
      readonly operation: 'consume_staged_customer_resolution';
      readonly companyId: string;
      readonly ownerUserId: string;
      readonly missionId: string;
      readonly acknowledgementMissionRevision: number;
    };

export function deriveAgentMissionSystemCommandId(
  input: AgentMissionSystemCommandInput,
): string {
  const canonical = input.operation === 'expire_quote_creation'
    ? [
        'bob.agent-mission.system-command.uuid-v8.v1',
        input.operation,
        input.companyId,
        input.ownerUserId,
        input.missionId,
        input.missionRevision,
        input.effectiveReason,
        input.effectiveExpiresAt,
      ]
    : [
        'bob.agent-mission.system-command.uuid-v8.v1',
        input.operation,
        input.companyId,
        input.ownerUserId,
        input.missionId,
        input.acknowledgementMissionRevision,
      ];
  const hex = sha256Hex(JSON.stringify(canonical));
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

export function draftReferenceForMission(mission: AgentMission): QuoteMissionDraftReferenceV1 {
  const payload = mission.payload;
  if (payload.draft !== null) return payload.draft;
  const decision = payload.decision;
  if (decision?.kind === 'existing_draft' || decision?.kind === 'confirm_draft_discard') {
    return {
      sessionId: decision.expectedDraftSessionId,
      slotRevision: decision.expectedDraftSlotRevision,
      contentRevision: decision.expectedDraftContentRevision,
    };
  }
  throw new Error('AGENT_MISSION_DRAFT_REFERENCE_MISSING');
}

export function toAgentMissionView(
  mission: AgentMission,
  databaseNow: Instant,
): Result<AgentMissionViewV1, AppError> {
  const expired = mission.isExpiredAt(databaseNow);
  if (!expired.ok) return err(agentMissionDomainError(expired.error));
  const snapshot = mission.toSnapshot();
  const effectiveExpired = snapshot.status === 'active' && expired.value;
  return ok({
    id: snapshot.id,
    kind: snapshot.kind,
    status: effectiveExpired ? 'expired' : snapshot.status,
    actionable: snapshot.status === 'active' && !effectiveExpired,
    phase: snapshot.phase,
    revision: snapshot.revision,
    payloadVersion: snapshot.payloadVersion,
    payload: snapshot.payload,
    currentBinding: snapshot.currentBinding,
    idleExpiresAt: snapshot.idleExpiresAt,
    hardExpiresAt: snapshot.hardExpiresAt,
    terminalAt: snapshot.terminalAt,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  });
}

export function agentMissionDomainError(
  error: AgentMissionError,
): AppError {
  if (error.code === 'agent_mission_revision_conflict') {
    return appConflict('agent_mission', 'stale_revision');
  }
  if (error.code === 'agent_mission_decision_conflict') {
    return appConflict('agent_mission', error.reason);
  }
  if (error.code === 'agent_mission_terminal') {
    return appConflict('agent_mission', `terminal_${error.status}`);
  }
  if (error.code === 'agent_mission_expired') {
    return appConflict('agent_mission', 'expired');
  }
  return {
    kind: 'validation',
    issues: [{
      field: 'agentMission',
      message: error.code,
    }],
  };
}

export function requireAgentMissionFingerprint(
  fingerprints: AgentMissionFingerprintPort,
  canonicalRequest: string,
  keyVersion?: number,
): Result<AgentMissionFingerprint, AppError> {
  const fingerprint = fingerprints.sign(canonicalRequest, keyVersion);
  return fingerprint === null
    ? err(appUnavailable('agent_mission_fingerprint_keyring'))
    : ok(fingerprint);
}

export function verifyAgentMissionFingerprint(
  fingerprints: AgentMissionFingerprintPort,
  canonicalRequest: string,
  snapshot: Pick<AgentMissionEventSnapshot, 'fingerprintKeyVersion' | 'requestFingerprintHmac'>,
): Result<boolean, AppError> {
  const matches = fingerprints.matches(canonicalRequest, {
    keyVersion: snapshot.fingerprintKeyVersion,
    hmac: snapshot.requestFingerprintHmac,
  });
  return matches === null
    ? err(appUnavailable('agent_mission_fingerprint_keyring'))
    : ok(matches);
}

export function recordAgentMissionEvent(input: {
  readonly owner: AgentMissionOwner;
  readonly transition: AgentMissionTransition;
  readonly actor: AgentMissionActor;
  readonly commandId: string;
  readonly fingerprint: AgentMissionFingerprint;
  readonly ids: IdGeneratorPort;
  readonly draftBefore: QuoteMissionDraftReferenceV1 | null;
  readonly draftAfter: QuoteMissionDraftReferenceV1;
  readonly correlation?: {
    readonly realtimeSessionId: string;
    readonly turnId: string | null;
    readonly contextRevision: number;
    readonly contextDigest: string;
  };
}): Result<AgentMissionEvent, AppError> {
  const transition = input.transition;
  const occurredAt = transition.event.occurredAt;
  const retentionExpiresAt = new Date(
    Date.parse(occurredAt) + AGENT_MISSION_EVENT_RETENTION_MS,
  ).toISOString();
  const event = AgentMissionEvent.record({
    id: input.ids.newId(),
    companyId: input.owner.companyId,
    ownerUserId: input.owner.ownerUserId,
    missionId: transition.mission.id,
    sequence: transition.event.missionRevisionAfter,
    eventType: transition.event.eventType,
    eventVersion: 1,
    actor: input.actor,
    commandId: input.commandId,
    requestFingerprintHmac: input.fingerprint.hmac,
    fingerprintKeyVersion: input.fingerprint.keyVersion,
    fingerprintCanonicalizationVersion: 1,
    missionRevisionBefore: transition.event.missionRevisionBefore,
    missionRevisionAfter: transition.event.missionRevisionAfter,
    draftSlotRevisionBefore: input.draftBefore?.slotRevision ?? null,
    draftSlotRevisionAfter: input.draftAfter.slotRevision,
    draftContentRevisionBefore: input.draftBefore?.contentRevision ?? null,
    draftContentRevisionAfter: input.draftAfter.contentRevision,
    realtimeSessionId: input.correlation?.realtimeSessionId ?? null,
    turnId: input.correlation?.turnId ?? null,
    contextRevision: input.correlation?.contextRevision ?? null,
    contextDigest: input.correlation?.contextDigest ?? null,
    data: transition.event.data,
    occurredAt,
    retentionExpiresAt,
  });
  return event.ok ? ok(event.value) : err({
    kind: 'dependency',
    port: 'agent_mission_event',
    cause: `${event.error.field}:${event.error.reason}`,
  });
}

export function missingAgentMission(missionId: string): AppError {
  return appNotFound('agent_mission', missionId);
}

export function unavailableAgentMissionCompany(
  reason: 'missing' | 'closed',
): AppError {
  return reason === 'closed'
    ? appForbidden('company_closed')
    : appNotFound('company', 'current');
}

export function unavailableAgentMissionForeground(
  _reason: AgentMissionForegroundUnavailableReason,
): AppError {
  // La cause SQL exacte reste bornée dans la métrique hôte. Le client reçoit un même service
  // temporairement indisponible et peut retenter sans jamais voir Prisma ni un SQLSTATE.
  return appUnavailable('agent_mission_foreground', 1);
}

export function rejectedAgentMissionCapability(
  _reason: AgentMissionCapabilityRejectionReason,
): AppError {
  // La raison précise alimente uniquement une métrique bornée côté hôte. La réponse publique ne
  // distingue jamais absence, expiration, ambiguïté ou hash discordant.
  return appForbidden('agent_mission_capability_invalid');
}

export async function expireAgentMissionInTransaction(input: {
  readonly transaction: AgentMissionTransaction;
  readonly owner: AgentMissionOwner;
  readonly mission: AgentMission;
  readonly occurredAt: Instant;
  readonly fingerprints: AgentMissionFingerprintPort;
  readonly ids: IdGeneratorPort;
}): Promise<Result<AgentMission, AppError>> {
  const snapshot = input.mission.toSnapshot();
  const hardIsEffectiveDeadline = (
    Date.parse(snapshot.hardExpiresAt) <= Date.parse(snapshot.idleExpiresAt)
  );
  const effectiveExpiresAt = hardIsEffectiveDeadline
    ? snapshot.hardExpiresAt
    : snapshot.idleExpiresAt;
  const effectiveReason = hardIsEffectiveDeadline ? 'hard_ttl' : 'idle_ttl';
  const commandId = deriveAgentMissionSystemCommandId({
    operation: 'expire_quote_creation',
    ...input.owner,
    missionId: input.mission.id,
    missionRevision: input.mission.revision,
    effectiveReason,
    effectiveExpiresAt,
  });
  const canonical = canonicalAgentMissionCommand({
    ...input.owner,
    operation: 'expire_quote_creation',
    commandId,
    missionId: input.mission.id,
    expectedRevision: input.mission.revision,
  });
  const fingerprint = requireAgentMissionFingerprint(input.fingerprints, canonical);
  if (!fingerprint.ok) return fingerprint;
  const reference = draftReferenceForMission(input.mission);
  const expired = input.mission.expire({
    expectedRevision: input.mission.revision,
    occurredAt: input.occurredAt,
  });
  if (!expired.ok) return err(agentMissionDomainError(expired.error));
  if (
    expired.value.event.data.kind !== 'mission_expired'
    || expired.value.event.data.reason !== effectiveReason
  ) {
    return err({
      kind: 'dependency',
      port: 'agent_mission',
      cause: 'effective_expiry_reason_drift',
    });
  }
  const updated = await input.transaction.missions.updateCas({
    mission: expired.value.mission,
    expectedRevision: input.mission.revision,
  });
  if (updated !== 'updated') return err(appConflict('agent_mission', 'stale_revision'));
  if (input.mission.payload.draft !== null) {
    const released = await input.transaction.quoteDrafts.release({
      ...input.owner,
      missionId: input.mission.id,
    });
    if (!released) {
      return err({
        kind: 'dependency',
        port: 'agent_mission_quote_draft',
        cause: 'owned_slot_release_failed',
      });
    }
  }
  const event = recordAgentMissionEvent({
    owner: input.owner,
    transition: expired.value,
    actor: 'system',
    commandId,
    fingerprint: fingerprint.value,
    ids: input.ids,
    draftBefore: reference,
    draftAfter: reference,
  });
  if (!event.ok) return event;
  await input.transaction.events.append(event.value);
  return ok(expired.value.mission);
}
