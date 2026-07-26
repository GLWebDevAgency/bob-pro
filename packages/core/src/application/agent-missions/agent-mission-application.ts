import {
  AgentMission,
  type AgentMissionError,
  type AgentMissionTransition,
  type QuoteCreationMissionPayloadV1,
  type QuoteMissionDraftReferenceV1,
} from '../../domain/agent/agent-mission';
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
import { type AgentMissionOwner } from '../ports/agent-mission-repository';
import { type AgentMissionTransaction } from '../ports/agent-mission-unit-of-work';
import {
  type AppError,
  appConflict,
  appForbidden,
  appNotFound,
  appUnavailable,
} from '../result';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

export function deriveAgentMissionSystemCommandId(input: {
  readonly operation: 'expire_quote_creation';
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly missionId: string;
  readonly missionRevision: number;
  readonly effectiveReason: 'idle_ttl' | 'hard_ttl';
  readonly effectiveExpiresAt: Instant;
}): string {
  const hex = sha256Hex(JSON.stringify([
    'bob.agent-mission.system-command.uuid-v8.v1',
    input.operation,
    input.companyId,
    input.ownerUserId,
    input.missionId,
    input.missionRevision,
    input.effectiveReason,
    input.effectiveExpiresAt,
  ]));
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
    realtimeSessionId: null,
    turnId: null,
    contextRevision: null,
    contextDigest: null,
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
