import {
  AGENT_MISSION_HARD_TTL_MS,
  AGENT_MISSION_RETENTION_MS,
  AgentMission,
  type AcknowledgeQuoteScreenOutput,
  type AgentMissionViewV1,
  type CancelQuoteAgentMissionOutput,
  type StartQuoteAgentMissionOutput,
} from '@bob/core';

const VIEW_KEYS = [
  'id',
  'kind',
  'status',
  'actionable',
  'phase',
  'revision',
  'payloadVersion',
  'payload',
  'currentBinding',
  'idleExpiresAt',
  'hardExpiresAt',
  'terminalAt',
  'createdAt',
  'updatedAt',
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function futureInstant(value: string, milliseconds: number): string | null {
  const epoch = Date.parse(value) + milliseconds;
  if (!Number.isFinite(epoch)) return null;
  try {
    return new Date(epoch).toISOString();
  } catch {
    return null;
  }
}

/**
 * Réutilise l'agrégat comme validateur profond de payload, décision, binding et cohérence
 * temporelle. Les identités codec ne quittent jamais cette fonction et ne deviennent donc
 * jamais des données produit.
 */
export function decodeAgentMissionViewV1(value: unknown): AgentMissionViewV1 | null {
  const view = record(value);
  if (!view || !exactKeys(view, VIEW_KEYS)) return null;
  if (
    typeof view.actionable !== 'boolean'
    || !canonicalInstant(view.createdAt)
    || !canonicalInstant(view.updatedAt)
    || !canonicalInstant(view.idleExpiresAt)
    || !canonicalInstant(view.hardExpiresAt)
    || (view.terminalAt !== null && !canonicalInstant(view.terminalAt))
    || (
      view.status !== 'active'
      && view.status !== 'cancelled'
      && view.status !== 'expired'
    )
    || view.actionable !== (view.status === 'active')
    || (view.status === 'active' && view.terminalAt !== null)
    || (view.status === 'cancelled' && view.terminalAt === null)
  ) {
    return null;
  }

  // Une vue `expired` peut être une projection paresseuse d'une mission encore stockée `active`.
  const persistedStatus =
    view.status === 'expired' && view.terminalAt === null ? 'active' : view.status;
  const retentionBase =
    persistedStatus === 'active' ? view.hardExpiresAt : view.terminalAt;
  if (retentionBase === null) return null;
  const retentionExpiresAt = futureInstant(retentionBase, AGENT_MISSION_RETENTION_MS);
  if (retentionExpiresAt === null) return null;

  const restored = AgentMission.rehydrate({
    id: view.id,
    companyId: 'agent-mission-codec-company',
    ownerUserId: 'agent-mission-codec-user',
    kind: view.kind,
    status: persistedStatus,
    phase: view.phase,
    revision: view.revision,
    payloadVersion: view.payloadVersion,
    payload: view.payload,
    currentBinding: view.currentBinding,
    idleExpiresAt: view.idleExpiresAt,
    hardExpiresAt: view.hardExpiresAt,
    terminalAt: view.terminalAt,
    retentionExpiresAt,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  });
  if (!restored.ok) return null;

  const snapshot = restored.value.toSnapshot();
  if (
    Date.parse(snapshot.hardExpiresAt) - Date.parse(snapshot.createdAt)
      !== AGENT_MISSION_HARD_TTL_MS
  ) {
    return null;
  }
  return Object.freeze({
    id: snapshot.id,
    kind: snapshot.kind,
    status: view.status,
    actionable: view.actionable,
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

export function decodeAgentMissionCurrent(
  value: unknown,
): { readonly mission: AgentMissionViewV1 | null } | null {
  const response = record(value);
  if (!response || !exactKeys(response, ['mission'])) return null;
  if (response.mission === null) return Object.freeze({ mission: null });
  const mission = decodeAgentMissionViewV1(response.mission);
  return mission === null ? null : Object.freeze({ mission });
}

export function decodeAgentMissionStart(
  value: unknown,
): StartQuoteAgentMissionOutput | null {
  const response = record(value);
  if (!response || !exactKeys(response, ['outcome', 'startOutcome', 'mission'])) return null;
  const mission = decodeAgentMissionViewV1(response.mission);
  const outcome = response.outcome;
  const startOutcome = response.startOutcome;
  if (
    mission === null
    || (outcome !== 'created' && outcome !== 'joined_active' && outcome !== 'replayed')
    || (
      startOutcome !== null
      && startOutcome !== 'no_slot'
      && startOutcome !== 'empty_slot_adopted'
      && startOutcome !== 'draft_conflict'
    )
    || (outcome === 'created' && startOutcome === null)
    || (outcome === 'joined_active' && startOutcome !== null)
    || (
      outcome === 'joined_active'
      && (mission.status !== 'active' || !mission.actionable)
    )
    || (
      outcome === 'created'
      && (
        mission.status !== 'active'
        || !mission.actionable
        || (
          startOutcome === 'draft_conflict'
            ? mission.phase !== 'awaiting_draft_decision'
            : mission.phase !== 'awaiting_quote_screen'
        )
      )
    )
  ) {
    return null;
  }
  return Object.freeze({ outcome, startOutcome, mission }) as StartQuoteAgentMissionOutput;
}

export function decodeAgentMissionCancel(
  value: unknown,
): CancelQuoteAgentMissionOutput | null {
  const response = record(value);
  if (!response || !exactKeys(response, ['outcome', 'mission'])) return null;
  const mission = decodeAgentMissionViewV1(response.mission);
  if (
    mission === null
    || (response.outcome !== 'cancelled' && response.outcome !== 'replayed')
    || mission.status !== 'cancelled'
    || mission.actionable
  ) {
    return null;
  }
  return Object.freeze({
    outcome: response.outcome,
    mission,
  }) as CancelQuoteAgentMissionOutput;
}

export function decodeAgentMissionScreenAck(
  value: unknown,
): AcknowledgeQuoteScreenOutput | null {
  const response = record(value);
  if (!response || !exactKeys(response, ['outcome', 'receipt', 'mission'])) return null;
  const mission = decodeAgentMissionViewV1(response.mission);
  const receipt = record(response.receipt);
  if (
    mission === null
    || receipt === null
    || !exactKeys(receipt, [
      'ackCommandId',
      'missionId',
      'missionRevisionAfter',
      'realtimeSessionId',
      'contextRevision',
      'contextDigest',
      'occurredAt',
    ])
    || typeof receipt.ackCommandId !== 'string'
    || !UUID_V4.test(receipt.ackCommandId)
    || typeof receipt.missionId !== 'string'
    || !UUID.test(receipt.missionId)
    || receipt.missionId !== mission.id
    || !Number.isSafeInteger(receipt.missionRevisionAfter)
    || (receipt.missionRevisionAfter as number) < 1
    || (receipt.missionRevisionAfter as number) > mission.revision
    || typeof receipt.realtimeSessionId !== 'string'
    || !UUID.test(receipt.realtimeSessionId)
    || !Number.isSafeInteger(receipt.contextRevision)
    || (receipt.contextRevision as number) < 1
    || typeof receipt.contextDigest !== 'string'
    || !SHA256.test(receipt.contextDigest)
    || !canonicalInstant(receipt.occurredAt)
    || (response.outcome !== 'acknowledged' && response.outcome !== 'replayed')
    || (
      response.outcome === 'acknowledged'
      && (
        mission.status !== 'active'
        || !mission.actionable
        || mission.currentBinding === null
        || (
          mission.phase !== 'awaiting_customer'
          && mission.phase !== 'awaiting_customer_choice'
          && mission.phase !== 'awaiting_lines'
        )
      )
    )
  ) {
    return null;
  }
  return Object.freeze({
    outcome: response.outcome,
    receipt: Object.freeze({
      ackCommandId: receipt.ackCommandId,
      missionId: receipt.missionId,
      missionRevisionAfter: receipt.missionRevisionAfter,
      realtimeSessionId: receipt.realtimeSessionId,
      contextRevision: receipt.contextRevision,
      contextDigest: receipt.contextDigest,
      occurredAt: receipt.occurredAt,
    }),
    mission,
  }) as AcknowledgeQuoteScreenOutput;
}
