import {
  normalizeCustomerName,
  AGENT_MISSION_PROTOCOL_M2A,
  AGENT_MISSION_PROTOCOL_V1,
  AGENT_MISSION_HARD_TTL_MS,
  AGENT_MISSION_RETENTION_MS,
  QUOTE_CREATION_MISSION_PHASES,
  AgentMission,
  isCanonicalAgentMissionDraftSessionId,
  isCanonicalAgentMissionUuid,
  type AcknowledgeQuoteScreenOutput,
  type AgentMissionProtocolVersion,
  type AgentMissionViewV1,
  type CancelQuoteAgentMissionOutput,
  type CustomerMissionChoiceView,
  type DecideQuoteAgentMissionOutput,
  type QuoteAgentMissionResumeView,
  type StartQuoteAgentMissionOutput,
} from '@bob/core';
import type {
  RealtimeAgentMissionCatalogueChoiceOutput,
  RealtimeAgentMissionLineContinuation,
  RealtimeAgentMissionStageQuoteLinesOutput,
} from './agent-mission-session';

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
function decodeAgentMissionView(
  value: unknown,
  protocolVersion: AgentMissionProtocolVersion,
): AgentMissionViewV1 | null {
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
    protocolVersion,
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

export function decodeAgentMissionViewV1(value: unknown): AgentMissionViewV1 | null {
  return decodeAgentMissionView(value, AGENT_MISSION_PROTOCOL_V1);
}

export function decodeAgentMissionViewV2(value: unknown): AgentMissionViewV1 | null {
  return decodeAgentMissionView(value, AGENT_MISSION_PROTOCOL_M2A);
}

function decodeAgentMissionCurrentForProtocol(
  value: unknown,
  protocolVersion: AgentMissionProtocolVersion,
): { readonly mission: AgentMissionViewV1 | null } | null {
  const response = record(value);
  if (!response || !exactKeys(response, ['mission'])) return null;
  if (response.mission === null) return Object.freeze({ mission: null });
  const mission = decodeAgentMissionView(response.mission, protocolVersion);
  return mission === null ? null : Object.freeze({ mission });
}

export function decodeAgentMissionCurrent(
  value: unknown,
): { readonly mission: AgentMissionViewV1 | null } | null {
  return decodeAgentMissionCurrentForProtocol(
    value,
    AGENT_MISSION_PROTOCOL_V1,
  );
}

export function decodeAgentMissionCurrentV2(
  value: unknown,
): { readonly mission: AgentMissionViewV1 | null } | null {
  return decodeAgentMissionCurrentForProtocol(
    value,
    AGENT_MISSION_PROTOCOL_M2A,
  );
}

const RESUME_MISSION_KEYS = [
  'id',
  'status',
  'phase',
  'revision',
  'actionable',
  'draft',
  'idleExpiresAt',
  'hardExpiresAt',
] as const;
const RESUME_DRAFT_REFERENCE_KEYS = [
  'sessionId',
  'slotRevision',
  'contentRevision',
] as const;
const RESUME_DRAFT_KEYS = [
  ...RESUME_DRAFT_REFERENCE_KEYS,
  'step',
] as const;
const QUOTE_DRAFT_STEPS = [
  'client',
  'lignes',
  'tvaMentions',
  'acompte',
  'signature',
] as const;
function positiveRevision(value: unknown, allowZero = false): value is number {
  return Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && (value as number) >= (allowZero ? 0 : 1)
    && (value as number) <= 2_147_483_647;
}

function resumeDraftReference(
  value: unknown,
  withStep: boolean,
): {
  readonly sessionId: string;
  readonly slotRevision: number;
  readonly contentRevision: number;
  readonly step?: (typeof QUOTE_DRAFT_STEPS)[number];
} | null {
  const draft = record(value);
  const keys = withStep ? RESUME_DRAFT_KEYS : RESUME_DRAFT_REFERENCE_KEYS;
  if (
    draft === null
    || !exactKeys(draft, keys)
    || !isCanonicalAgentMissionDraftSessionId(draft.sessionId)
    || !positiveRevision(draft.slotRevision)
    || !positiveRevision(draft.contentRevision, true)
    || (
      withStep
      && !QUOTE_DRAFT_STEPS.includes(
        draft.step as (typeof QUOTE_DRAFT_STEPS)[number],
      )
    )
  ) {
    return null;
  }
  return Object.freeze({
    sessionId: draft.sessionId,
    slotRevision: draft.slotRevision,
    contentRevision: draft.contentRevision,
    ...(withStep
      ? { step: draft.step as (typeof QUOTE_DRAFT_STEPS)[number] }
      : {}),
  });
}

export function decodeQuoteAgentMissionResume(
  value: unknown,
): QuoteAgentMissionResumeView | null {
  const response = record(value);
  if (response === null) return null;
  if (response.mission === null) {
    return exactKeys(response, ['mission'])
      ? Object.freeze({ mission: null })
      : null;
  }
  if (!exactKeys(response, ['mission', 'draft', 'customerChoices'])) return null;
  const mission = record(response.mission);
  const missionDraft = mission === null
    ? null
    : resumeDraftReference(mission.draft, false);
  const draft = resumeDraftReference(response.draft, true);
  if (
    mission === null
    || !exactKeys(mission, RESUME_MISSION_KEYS)
    || !isCanonicalAgentMissionUuid(mission.id)
    || (mission.status !== 'active' && mission.status !== 'expired')
    || mission.actionable !== (mission.status === 'active')
    || !QUOTE_CREATION_MISSION_PHASES.includes(
      mission.phase as (typeof QUOTE_CREATION_MISSION_PHASES)[number],
    )
    || !positiveRevision(mission.revision)
    || !canonicalInstant(mission.idleExpiresAt)
    || !canonicalInstant(mission.hardExpiresAt)
    || Date.parse(mission.idleExpiresAt) > Date.parse(mission.hardExpiresAt)
    || missionDraft === null
    || draft === null
    || missionDraft.sessionId !== draft.sessionId
    || missionDraft.slotRevision !== draft.slotRevision
    || missionDraft.contentRevision !== draft.contentRevision
    || !Array.isArray(response.customerChoices)
    || response.customerChoices.length > 5
    || (
      mission.phase === 'awaiting_customer_choice'
        ? response.customerChoices.length < 1
        : response.customerChoices.length !== 0
    )
  ) {
    return null;
  }
  const choices = response.customerChoices.map((value) => {
    const choice = record(value);
    if (choice === null || !isCanonicalAgentMissionUuid(choice.choiceId)) return null;
    if (choice.status === 'unavailable' && exactKeys(choice, ['status', 'choiceId'])) {
      return Object.freeze({
        status: 'unavailable' as const,
        choiceId: choice.choiceId,
      });
    }
    const normalizedLabel = choice === null
      ? null
      : normalizeCustomerName(choice.label);
    if (
      choice.status === 'available'
      && exactKeys(choice, ['status', 'choiceId', 'label'])
      && normalizedLabel !== null
    ) {
      return Object.freeze({
        status: 'available' as const,
        choiceId: choice.choiceId,
        label: normalizedLabel,
      });
    }
    return null;
  });
  if (
    choices.some((choice) => choice === null)
    || new Set(choices.map((choice) => choice?.choiceId)).size !== choices.length
  ) {
    return null;
  }
  return Object.freeze({
    mission: Object.freeze({
      id: mission.id,
      status: mission.status,
      phase: mission.phase as (typeof QUOTE_CREATION_MISSION_PHASES)[number],
      revision: mission.revision,
      actionable: mission.actionable,
      draft: missionDraft,
      idleExpiresAt: mission.idleExpiresAt,
      hardExpiresAt: mission.hardExpiresAt,
    }),
    draft: Object.freeze({
      sessionId: draft.sessionId,
      slotRevision: draft.slotRevision,
      contentRevision: draft.contentRevision,
      step: draft.step!,
    }),
    customerChoices: Object.freeze(
      choices as CustomerMissionChoiceView[],
    ),
  });
}

function decodeAgentMissionStartForProtocol(
  value: unknown,
  protocolVersion: AgentMissionProtocolVersion,
): StartQuoteAgentMissionOutput | null {
  const response = record(value);
  if (!response || !exactKeys(response, ['outcome', 'startOutcome', 'mission'])) return null;
  const mission = decodeAgentMissionView(response.mission, protocolVersion);
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

export function decodeAgentMissionStart(
  value: unknown,
): StartQuoteAgentMissionOutput | null {
  return decodeAgentMissionStartForProtocol(value, AGENT_MISSION_PROTOCOL_V1);
}

export function decodeAgentMissionStartV2(
  value: unknown,
): StartQuoteAgentMissionOutput | null {
  return decodeAgentMissionStartForProtocol(value, AGENT_MISSION_PROTOCOL_M2A);
}

function decodeAgentMissionCancelForProtocol(
  value: unknown,
  protocolVersion: AgentMissionProtocolVersion,
): CancelQuoteAgentMissionOutput | null {
  const response = record(value);
  if (!response || !exactKeys(response, ['outcome', 'mission'])) return null;
  const mission = decodeAgentMissionView(response.mission, protocolVersion);
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

export function decodeAgentMissionCancel(
  value: unknown,
): CancelQuoteAgentMissionOutput | null {
  return decodeAgentMissionCancelForProtocol(value, AGENT_MISSION_PROTOCOL_V1);
}

export function decodeAgentMissionCancelV2(
  value: unknown,
): CancelQuoteAgentMissionOutput | null {
  return decodeAgentMissionCancelForProtocol(value, AGENT_MISSION_PROTOCOL_M2A);
}

function decodeAgentMissionScreenAckForProtocol(
  value: unknown,
  protocolVersion: AgentMissionProtocolVersion,
): AcknowledgeQuoteScreenOutput | null {
  const response = record(value);
  if (!response || !exactKeys(response, ['outcome', 'receipt', 'mission'])) return null;
  const mission = decodeAgentMissionView(response.mission, protocolVersion);
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
          && (
            protocolVersion !== AGENT_MISSION_PROTOCOL_M2A
            || mission.phase !== 'awaiting_catalogue_choice'
          )
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

export function decodeAgentMissionScreenAck(
  value: unknown,
): AcknowledgeQuoteScreenOutput | null {
  return decodeAgentMissionScreenAckForProtocol(
    value,
    AGENT_MISSION_PROTOCOL_V1,
  );
}

export function decodeAgentMissionScreenAckV2(
  value: unknown,
): AcknowledgeQuoteScreenOutput | null {
  return decodeAgentMissionScreenAckForProtocol(
    value,
    AGENT_MISSION_PROTOCOL_M2A,
  );
}

function decodeAgentMissionDecisionForProtocol(
  value: unknown,
  expectedMissionId: string,
  protocolVersion: AgentMissionProtocolVersion,
): DecideQuoteAgentMissionOutput | null {
  const response = record(value);
  if (!response || !exactKeys(response, ['outcome', 'effect', 'mission'])) return null;
  const mission = decodeAgentMissionView(response.mission, protocolVersion);
  const outcome = response.outcome;
  const effect = record(response.effect);
  const decodedEffect = effect !== null
    && exactKeys(
      effect,
      effect.kind === 'selected' ? ['kind'] : ['kind', 'reason'],
    )
    && (
      effect.kind === 'selected'
      || (
        effect.kind === 'invalidated'
        && (
          effect.reason === 'candidate_unavailable'
          || effect.reason === 'draft_changed'
          || effect.reason === 'choice_set_stale'
        )
      )
    )
      ? effect
      : null;
  if (
    mission === null
    || mission.id !== expectedMissionId
    || decodedEffect === null
    || (
      outcome !== 'selected'
      && outcome !== 'invalidated'
      && outcome !== 'replayed'
    )
    || (
      outcome !== 'replayed'
      && outcome !== decodedEffect.kind
    )
    || (
      outcome === 'selected'
      && (
        mission.status !== 'active'
        || !mission.actionable
        || (
          mission.phase !== 'awaiting_lines'
          && (
            protocolVersion !== AGENT_MISSION_PROTOCOL_M2A
            || mission.phase !== 'awaiting_catalogue_choice'
          )
        )
      )
    )
    || (
      outcome === 'invalidated'
      && (
        mission.status !== 'active'
        || !mission.actionable
        || mission.phase !== 'awaiting_customer'
      )
    )
  ) {
    return null;
  }
  return Object.freeze(
    { outcome, effect: Object.freeze({ ...decodedEffect }), mission },
  ) as DecideQuoteAgentMissionOutput;
}

export function decodeAgentMissionDecision(
  value: unknown,
  expectedMissionId: string,
): DecideQuoteAgentMissionOutput | null {
  return decodeAgentMissionDecisionForProtocol(
    value,
    expectedMissionId,
    AGENT_MISSION_PROTOCOL_V1,
  );
}

export function decodeAgentMissionDecisionV2(
  value: unknown,
  expectedMissionId: string,
): DecideQuoteAgentMissionOutput | null {
  return decodeAgentMissionDecisionForProtocol(
    value,
    expectedMissionId,
    AGENT_MISSION_PROTOCOL_M2A,
  );
}

function decodeAgentMissionLineContinuation(
  value: unknown,
): RealtimeAgentMissionLineContinuation | null {
  const continuation = record(value);
  if (
    continuation === null
    || !exactKeys(continuation, [
      'outcome',
      'pendingLineId',
      'presentedChoiceCount',
    ])
    || (
      continuation.outcome !== 'catalogue_not_found'
      && continuation.outcome !== 'choices_presented'
      && continuation.outcome !== 'empty'
      && continuation.outcome !== 'deferred_to_m2a2'
      && continuation.outcome !== 'superseded'
      && continuation.outcome !== 'replayed'
    )
    || !Number.isSafeInteger(continuation.presentedChoiceCount)
    || (continuation.presentedChoiceCount as number) < 0
    || (continuation.presentedChoiceCount as number) > 6
  ) {
    return null;
  }
  const hasPendingLine = isCanonicalAgentMissionUuid(continuation.pendingLineId);
  if (
    (
      continuation.outcome === 'empty'
      || continuation.outcome === 'superseded'
    )
      ? continuation.pendingLineId !== null
        || continuation.presentedChoiceCount !== 0
      : !hasPendingLine
  ) {
    return null;
  }
  if (
    continuation.outcome === 'choices_presented'
      ? (continuation.presentedChoiceCount as number) < 2
      : continuation.outcome === 'replayed'
        ? (
            continuation.presentedChoiceCount !== 0
            && (continuation.presentedChoiceCount as number) < 2
          )
        : continuation.presentedChoiceCount !== 0
  ) {
    return null;
  }
  return Object.freeze({
    outcome: continuation.outcome,
    pendingLineId: continuation.pendingLineId as string | null,
    presentedChoiceCount: continuation.presentedChoiceCount as number,
  });
}

export function decodeAgentMissionStageQuoteLines(
  value: unknown,
  expectedMissionId: string,
): RealtimeAgentMissionStageQuoteLinesOutput | null {
  const response = record(value);
  if (
    response === null
    || !exactKeys(response, [
      'outcome',
      'mission',
      'stagedCount',
      'firstQueueOrdinal',
      'lastQueueOrdinal',
      'continuation',
    ])
  ) {
    return null;
  }
  const mission = decodeAgentMissionView(response.mission, AGENT_MISSION_PROTOCOL_M2A);
  const continuation = decodeAgentMissionLineContinuation(response.continuation);
  if (
    mission === null
    || mission.id !== expectedMissionId
    || continuation === null
    || (response.outcome !== 'staged' && response.outcome !== 'replayed')
    || !positiveRevision(response.stagedCount)
    || (response.stagedCount as number) > 20
    || !positiveRevision(response.firstQueueOrdinal)
    || !positiveRevision(response.lastQueueOrdinal)
    || (
      (response.lastQueueOrdinal as number)
      - (response.firstQueueOrdinal as number)
      + 1
      !== response.stagedCount
    )
  ) {
    return null;
  }
  return Object.freeze({
    outcome: response.outcome,
    mission,
    stagedCount: response.stagedCount,
    firstQueueOrdinal: response.firstQueueOrdinal,
    lastQueueOrdinal: response.lastQueueOrdinal,
    continuation,
  }) as RealtimeAgentMissionStageQuoteLinesOutput;
}

export function decodeAgentMissionCatalogueChoice(
  value: unknown,
  expectedMissionId: string,
): RealtimeAgentMissionCatalogueChoiceOutput | null {
  const response = record(value);
  if (
    response === null
    || !exactKeys(response, [
      'outcome',
      'resolution',
      'invalidationReason',
      'mission',
      'continuation',
    ])
  ) {
    return null;
  }
  const mission = decodeAgentMissionView(response.mission, AGENT_MISSION_PROTOCOL_M2A);
  const continuation = decodeAgentMissionLineContinuation(response.continuation);
  const selectedShape = (
    (response.resolution === 'free' || response.resolution === 'selected')
    && response.invalidationReason === null
  );
  const invalidatedShape = (
    response.resolution === null
    && (
      response.invalidationReason === 'candidate_unavailable'
      || response.invalidationReason === 'choice_set_stale'
    )
  );
  if (
    mission === null
    || mission.id !== expectedMissionId
    || continuation === null
    || (
      response.outcome !== 'selected'
      && response.outcome !== 'invalidated'
      && response.outcome !== 'replayed'
    )
    || (
      response.outcome === 'selected'
        ? !selectedShape
        : response.outcome === 'invalidated'
          ? !invalidatedShape
          : !selectedShape && !invalidatedShape
    )
  ) {
    return null;
  }
  return Object.freeze({
    outcome: response.outcome,
    resolution: response.resolution,
    invalidationReason: response.invalidationReason,
    mission,
    continuation,
  }) as RealtimeAgentMissionCatalogueChoiceOutput;
}
