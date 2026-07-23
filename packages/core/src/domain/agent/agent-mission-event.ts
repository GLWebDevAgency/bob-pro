import { type Result, err, ok } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';

export const AGENT_MISSION_EVENT_TYPES = [
  'mission_started',
  'draft_resume_selected',
  'draft_discard_requested',
  'draft_discard_cancelled',
  'draft_discard_confirmed',
  'screen_acknowledged',
  'customer_not_found',
  'customer_choice_presented',
  'customer_selected',
  'decision_invalidated',
  'mission_cancelled',
  'mission_expired',
] as const;

export type AgentMissionEventType = (typeof AGENT_MISSION_EVENT_TYPES)[number];
export type AgentMissionActor = 'user_voice' | 'user_tap' | 'system';
export const AGENT_MISSION_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const AGENT_MISSION_EVENT_INT4_MAX = 2_147_483_647;

export type AgentMissionEventDataV1 =
  | {
      readonly kind: 'mission_started';
      readonly startOutcome: 'no_slot' | 'empty_slot_adopted' | 'draft_conflict';
    }
  | { readonly kind: 'draft_resume_selected' }
  | { readonly kind: 'draft_discard_requested' }
  | { readonly kind: 'draft_discard_cancelled' }
  | { readonly kind: 'draft_discard_confirmed' }
  | {
      readonly kind: 'screen_acknowledged';
      readonly nextPhase: 'awaiting_customer' | 'awaiting_customer_choice' | 'awaiting_lines';
    }
  | {
      readonly kind: 'customer_not_found';
      readonly result: 'none' | 'too_many';
    }
  | {
      readonly kind: 'customer_choice_presented';
      readonly candidateCount: number;
      readonly choiceSetHash: string;
    }
  | {
      readonly kind: 'customer_selected';
      readonly customerId: string;
      readonly source: 'exact_match' | 'presented_choice' | 'screen_selection';
      readonly choiceId: string | null;
      readonly choiceSetHash: string | null;
    }
  | {
      readonly kind: 'decision_invalidated';
      readonly reason: 'candidate_unavailable' | 'draft_changed' | 'choice_set_stale';
    }
  | {
      readonly kind: 'mission_cancelled';
      readonly reason: 'user_cancelled' | 'manual_handoff';
    }
  | {
      readonly kind: 'mission_expired';
      readonly reason: 'idle_ttl' | 'hard_ttl';
    };

/**
 * Preuve pure produite avec la transition d'agrégat. L'application ajoute ensuite les preuves
 * d'admission/idempotence pour construire l'événement durable, dans la même transaction CAS.
 */
export interface AgentMissionTransitionEvent {
  readonly eventType: AgentMissionEventType;
  readonly missionRevisionBefore: number;
  readonly missionRevisionAfter: number;
  readonly data: AgentMissionEventDataV1;
  readonly occurredAt: Instant;
}

export interface AgentMissionEventSnapshot {
  readonly id: string;
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly missionId: string;
  readonly sequence: number;
  readonly eventType: AgentMissionEventType;
  readonly eventVersion: 1;
  readonly actor: AgentMissionActor;
  readonly commandId: string;
  readonly requestFingerprintHmac: string;
  readonly fingerprintKeyVersion: number;
  readonly fingerprintCanonicalizationVersion: 1;
  readonly missionRevisionBefore: number;
  readonly missionRevisionAfter: number;
  readonly draftSlotRevisionBefore: number | null;
  readonly draftSlotRevisionAfter: number | null;
  readonly draftContentRevisionBefore: number | null;
  readonly draftContentRevisionAfter: number | null;
  readonly realtimeSessionId: string | null;
  readonly turnId: string | null;
  readonly contextRevision: number | null;
  readonly contextDigest: string | null;
  readonly data: AgentMissionEventDataV1;
  readonly occurredAt: Instant;
  readonly retentionExpiresAt: Instant;
}

export type AgentMissionEventValidationError = {
  readonly code: 'invalid_agent_mission_event';
  readonly field: string;
  readonly reason:
    | 'invalid_shape'
    | 'invalid_identifier'
    | 'invalid_uuid'
    | 'invalid_digest'
    | 'invalid_revision'
    | 'invalid_instant'
    | 'invalid_value'
    | 'inconsistent_event';
};

export type AgentMissionEventResult<T> = Result<T, AgentMissionEventValidationError>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_IDENTIFIER_LENGTH = 200;

function invalid(
  field: string,
  reason: AgentMissionEventValidationError['reason'],
): AgentMissionEventResult<never> {
  return err({ code: 'invalid_agent_mission_event', field, reason });
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isOneOf<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || (codePoint >= 127 && codePoint <= 159));
  });
}

function isCanonicalIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && value === value.trim()
    && !hasControlCharacter(value)
  );
}

function isSafeRevision(value: unknown, allowZero: boolean): value is number {
  return (
    Number.isSafeInteger(value)
    && (value as number) >= (allowZero ? 0 : 1)
    && (value as number) <= AGENT_MISSION_EVENT_INT4_MAX
  );
}

function instantEpoch(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) return null;
  return epoch;
}

function cloneEventData(data: AgentMissionEventDataV1): AgentMissionEventDataV1 {
  return Object.freeze({ ...data });
}

function validateData(
  eventType: AgentMissionEventType,
  value: unknown,
): AgentMissionEventResult<AgentMissionEventDataV1> {
  if (!isPlainRecord(value) || value['kind'] !== eventType) {
    return invalid('data.kind', 'inconsistent_event');
  }

  let data: AgentMissionEventDataV1;
  if (eventType === 'mission_started') {
    if (!exactKeys(value, ['kind', 'startOutcome']) || !isOneOf(['no_slot', 'empty_slot_adopted', 'draft_conflict'] as const, value['startOutcome'])) {
      return invalid('data', 'invalid_shape');
    }
    data = { kind: eventType, startOutcome: value['startOutcome'] as 'no_slot' | 'empty_slot_adopted' | 'draft_conflict' };
  } else if (
    eventType === 'draft_resume_selected'
    || eventType === 'draft_discard_requested'
    || eventType === 'draft_discard_cancelled'
    || eventType === 'draft_discard_confirmed'
  ) {
    if (!exactKeys(value, ['kind'])) return invalid('data', 'invalid_shape');
    data = { kind: eventType };
  } else if (eventType === 'screen_acknowledged') {
    if (
      !exactKeys(value, ['kind', 'nextPhase'])
      || !isOneOf(['awaiting_customer', 'awaiting_customer_choice', 'awaiting_lines'] as const, value['nextPhase'])
    ) {
      return invalid('data', 'invalid_shape');
    }
    data = {
      kind: eventType,
      nextPhase: value['nextPhase'] as 'awaiting_customer' | 'awaiting_customer_choice' | 'awaiting_lines',
    };
  } else if (eventType === 'customer_not_found') {
    if (!exactKeys(value, ['kind', 'result']) || !isOneOf(['none', 'too_many'] as const, value['result'])) {
      return invalid('data', 'invalid_shape');
    }
    data = { kind: eventType, result: value['result'] as 'none' | 'too_many' };
  } else if (eventType === 'customer_choice_presented') {
    if (!exactKeys(value, ['kind', 'candidateCount', 'choiceSetHash'])) return invalid('data', 'invalid_shape');
    if (typeof value['choiceSetHash'] !== 'string') {
      return invalid('data.choiceSetHash', 'invalid_digest');
    }
    data = {
      kind: eventType,
      candidateCount: value['candidateCount'] as number,
      choiceSetHash: value['choiceSetHash'],
    };
  } else if (eventType === 'customer_selected') {
    if (!exactKeys(value, ['kind', 'customerId', 'source', 'choiceId', 'choiceSetHash'])) {
      return invalid('data', 'invalid_shape');
    }
    if (!isOneOf(['exact_match', 'presented_choice', 'screen_selection'] as const, value['source'])) {
      return invalid('data.source', 'invalid_value');
    }
    if (value['choiceSetHash'] !== null && typeof value['choiceSetHash'] !== 'string') {
      return invalid('data.choiceSetHash', 'invalid_digest');
    }
    data = {
      kind: eventType,
      customerId: value['customerId'] as string,
      source: value['source'] as 'exact_match' | 'presented_choice' | 'screen_selection',
      choiceId: value['choiceId'] as string | null,
      choiceSetHash: value['choiceSetHash'],
    };
  } else if (eventType === 'decision_invalidated') {
    if (
      !exactKeys(value, ['kind', 'reason'])
      || !isOneOf(['candidate_unavailable', 'draft_changed', 'choice_set_stale'] as const, value['reason'])
    ) {
      return invalid('data', 'invalid_shape');
    }
    data = {
      kind: eventType,
      reason: value['reason'] as 'candidate_unavailable' | 'draft_changed' | 'choice_set_stale',
    };
  } else if (eventType === 'mission_cancelled') {
    if (!exactKeys(value, ['kind', 'reason']) || !isOneOf(['user_cancelled', 'manual_handoff'] as const, value['reason'])) {
      return invalid('data', 'invalid_shape');
    }
    data = { kind: eventType, reason: value['reason'] as 'user_cancelled' | 'manual_handoff' };
  } else {
    if (!exactKeys(value, ['kind', 'reason']) || !isOneOf(['idle_ttl', 'hard_ttl'] as const, value['reason'])) {
      return invalid('data', 'invalid_shape');
    }
    data = { kind: 'mission_expired', reason: value['reason'] as 'idle_ttl' | 'hard_ttl' };
  }

  if (data.kind !== eventType) return invalid('data.kind', 'inconsistent_event');

  if (data.kind === 'customer_choice_presented') {
    if (!Number.isSafeInteger(data.candidateCount) || data.candidateCount < 1 || data.candidateCount > 5) {
      return invalid('data.candidateCount', 'invalid_value');
    }
    if (!SHA256.test(data.choiceSetHash)) return invalid('data.choiceSetHash', 'invalid_digest');
  }

  if (data.kind === 'customer_selected') {
    if (!isCanonicalIdentifier(data.customerId)) return invalid('data.customerId', 'invalid_identifier');
    if (data.source === 'presented_choice') {
      if (!isCanonicalUuid(data.choiceId)) return invalid('data.choiceId', 'invalid_uuid');
      if (data.choiceSetHash === null || !SHA256.test(data.choiceSetHash)) {
        return invalid('data.choiceSetHash', 'invalid_digest');
      }
    } else if (data.choiceId !== null || data.choiceSetHash !== null) {
      return invalid('data', 'inconsistent_event');
    }
  }

  return ok(cloneEventData(data));
}

type EventCorrelationRule = 'user' | 'screen_ack' | 'system';
type EventDraftRule = 'mission_start' | 'no_op' | 'replace_in_place' | 'advance_customer';

interface AgentMissionEventRule {
  readonly actors: readonly AgentMissionActor[];
  readonly correlation: EventCorrelationRule;
  readonly draft: EventDraftRule;
}

/** Matrice M1 exhaustive dérivée des effets atomiques de la spec §7-10. */
const AGENT_MISSION_EVENT_RULES = {
  mission_started: { actors: ['user_voice', 'user_tap'], correlation: 'user', draft: 'mission_start' },
  draft_resume_selected: { actors: ['user_voice', 'user_tap'], correlation: 'user', draft: 'no_op' },
  draft_discard_requested: { actors: ['user_voice', 'user_tap'], correlation: 'user', draft: 'no_op' },
  draft_discard_cancelled: { actors: ['user_voice', 'user_tap'], correlation: 'user', draft: 'no_op' },
  draft_discard_confirmed: { actors: ['user_voice', 'user_tap'], correlation: 'user', draft: 'replace_in_place' },
  screen_acknowledged: { actors: ['system'], correlation: 'screen_ack', draft: 'no_op' },
  customer_not_found: { actors: ['user_voice', 'user_tap'], correlation: 'user', draft: 'no_op' },
  customer_choice_presented: { actors: ['user_voice', 'user_tap'], correlation: 'user', draft: 'no_op' },
  customer_selected: { actors: ['user_voice', 'user_tap'], correlation: 'user', draft: 'advance_customer' },
  decision_invalidated: { actors: ['user_voice', 'user_tap'], correlation: 'user', draft: 'no_op' },
  mission_cancelled: { actors: ['user_voice', 'user_tap'], correlation: 'user', draft: 'no_op' },
  mission_expired: { actors: ['system'], correlation: 'system', draft: 'no_op' },
} as const satisfies Readonly<Record<AgentMissionEventType, AgentMissionEventRule>>;

function validateCorrelation(input: {
  readonly eventType: AgentMissionEventType;
  readonly actor: AgentMissionActor;
  readonly realtimeSessionId: string | null;
  readonly turnId: string | null;
  readonly contextRevision: number | null;
  readonly contextDigest: string | null;
  readonly data: AgentMissionEventDataV1;
}): AgentMissionEventResult<void> {
  const rule = AGENT_MISSION_EVENT_RULES[input.eventType];
  if (!(rule.actors as readonly AgentMissionActor[]).includes(input.actor)) {
    return invalid('actor', 'inconsistent_event');
  }

  const hasSession = input.realtimeSessionId !== null;
  const hasTurn = input.turnId !== null;
  const hasContext = input.contextRevision !== null && input.contextDigest !== null;
  if (rule.correlation === 'system') {
    if (hasSession || hasTurn || hasContext) return invalid('correlation', 'inconsistent_event');
  } else if (rule.correlation === 'screen_ack') {
    if (!hasSession || hasTurn || !hasContext) return invalid('correlation', 'inconsistent_event');
  } else if (input.actor === 'user_voice') {
    if (!hasSession || !hasTurn || !hasContext) return invalid('correlation', 'inconsistent_event');
  } else {
    const isStandaloneTap = !hasSession && !hasTurn && !hasContext;
    const isSessionTap = hasSession && !hasTurn && hasContext;
    if (!isStandaloneTap && !isSessionTap) return invalid('correlation', 'inconsistent_event');
  }

  if (input.data.kind === 'customer_selected') {
    if (input.data.source === 'screen_selection' && input.actor !== 'user_tap') {
      return invalid('actor', 'inconsistent_event');
    }
  }
  return ok(undefined);
}

function validateDraftEffect(input: {
  readonly eventType: AgentMissionEventType;
  readonly data: AgentMissionEventDataV1;
  readonly slotBefore: number | null;
  readonly slotAfter: number | null;
  readonly contentBefore: number | null;
  readonly contentAfter: number | null;
}): AgentMissionEventResult<void> {
  const beforeComplete = input.slotBefore !== null && input.contentBefore !== null;
  const afterComplete = input.slotAfter !== null && input.contentAfter !== null;
  if ((input.slotBefore === null) !== (input.contentBefore === null)) {
    return invalid('draftRevisionBefore', 'inconsistent_event');
  }
  if ((input.slotAfter === null) !== (input.contentAfter === null)) {
    return invalid('draftRevisionAfter', 'inconsistent_event');
  }

  const rule = AGENT_MISSION_EVENT_RULES[input.eventType].draft;
  if (rule === 'mission_start') {
    if (input.data.kind !== 'mission_started') return invalid('data.kind', 'inconsistent_event');
    if (input.data.startOutcome === 'no_slot') {
      return !beforeComplete && afterComplete && input.slotAfter === 1 && input.contentAfter === 0
        ? ok(undefined)
        : invalid('draftRevisions', 'inconsistent_event');
    }
    return beforeComplete
      && afterComplete
      && input.slotBefore === input.slotAfter
      && input.contentBefore === input.contentAfter
      ? ok(undefined)
      : invalid('draftRevisions', 'inconsistent_event');
  }

  if (!beforeComplete || !afterComplete) return invalid('draftRevisions', 'inconsistent_event');
  if (rule === 'no_op') {
    return input.slotBefore === input.slotAfter && input.contentBefore === input.contentAfter
      ? ok(undefined)
      : invalid('draftRevisions', 'inconsistent_event');
  }
  if (input.slotBefore === AGENT_MISSION_EVENT_INT4_MAX) {
    return invalid('draftSlotRevisionBefore', 'invalid_revision');
  }
  if (rule === 'replace_in_place') {
    return input.slotAfter === input.slotBefore + 1 && input.contentAfter === 0
      ? ok(undefined)
      : invalid('draftRevisions', 'inconsistent_event');
  }
  if (input.contentBefore === AGENT_MISSION_EVENT_INT4_MAX) {
    return invalid('draftContentRevisionBefore', 'invalid_revision');
  }
  return input.slotAfter === input.slotBefore + 1 && input.contentAfter === input.contentBefore + 1
    ? ok(undefined)
    : invalid('draftRevisions', 'inconsistent_event');
}

/**
 * Événement append-only M1. Le constructeur valide l'enveloppe complète avant qu'un adapter ne
 * puisse la persister. Il n'accepte aucun champ de texte libre : transcript, noms et prompts ne
 * font structurellement pas partie du type.
 */
export class AgentMissionEvent {
  private constructor(private readonly snapshot: AgentMissionEventSnapshot) {
    Object.freeze(this);
  }

  static record(value: unknown): AgentMissionEventResult<AgentMissionEvent> {
    if (!isPlainRecord(value) || !exactKeys(value, [
      'id',
      'companyId',
      'ownerUserId',
      'missionId',
      'sequence',
      'eventType',
      'eventVersion',
      'actor',
      'commandId',
      'requestFingerprintHmac',
      'fingerprintKeyVersion',
      'fingerprintCanonicalizationVersion',
      'missionRevisionBefore',
      'missionRevisionAfter',
      'draftSlotRevisionBefore',
      'draftSlotRevisionAfter',
      'draftContentRevisionBefore',
      'draftContentRevisionAfter',
      'realtimeSessionId',
      'turnId',
      'contextRevision',
      'contextDigest',
      'data',
      'occurredAt',
      'retentionExpiresAt',
    ])) {
      return invalid('$', 'invalid_shape');
    }
    if (!isCanonicalUuid(value['id'])) return invalid('id', 'invalid_uuid');
    if (!isCanonicalIdentifier(value['companyId'])) return invalid('companyId', 'invalid_identifier');
    if (!isCanonicalIdentifier(value['ownerUserId'])) return invalid('ownerUserId', 'invalid_identifier');
    if (!isCanonicalUuid(value['missionId'])) return invalid('missionId', 'invalid_uuid');
    if (!isCanonicalUuid(value['commandId'])) return invalid('commandId', 'invalid_uuid');
    if (!AGENT_MISSION_EVENT_TYPES.includes(value['eventType'] as AgentMissionEventType)) {
      return invalid('eventType', 'invalid_value');
    }
    const eventType = value['eventType'] as AgentMissionEventType;
    if (value['eventVersion'] !== 1) return invalid('eventVersion', 'invalid_value');
    if (!isOneOf(['user_voice', 'user_tap', 'system'] as const, value['actor'])) {
      return invalid('actor', 'invalid_value');
    }
    const actor = value['actor'];
    if (typeof value['requestFingerprintHmac'] !== 'string' || !SHA256.test(value['requestFingerprintHmac'])) {
      return invalid('requestFingerprintHmac', 'invalid_digest');
    }
    if (
      !Number.isSafeInteger(value['fingerprintKeyVersion'])
      || (value['fingerprintKeyVersion'] as number) < 1
      || (value['fingerprintKeyVersion'] as number) > AGENT_MISSION_EVENT_INT4_MAX
    ) {
      return invalid('fingerprintKeyVersion', 'invalid_value');
    }
    if (value['fingerprintCanonicalizationVersion'] !== 1) {
      return invalid('fingerprintCanonicalizationVersion', 'invalid_value');
    }
    if (!isSafeRevision(value['missionRevisionAfter'], false)) {
      return invalid('missionRevisionAfter', 'invalid_revision');
    }
    if (value['sequence'] !== value['missionRevisionAfter']) {
      return invalid('sequence', 'inconsistent_event');
    }
    if (eventType === 'mission_started') {
      if (value['missionRevisionBefore'] !== 0 || value['missionRevisionAfter'] !== 1) {
        return invalid('missionRevisionBefore', 'inconsistent_event');
      }
    } else if (
      !isSafeRevision(value['missionRevisionBefore'], false)
      || value['missionRevisionAfter'] !== value['missionRevisionBefore'] + 1
    ) {
      return invalid('missionRevisionAfter', 'inconsistent_event');
    }

    const revisions: ReadonlyArray<readonly [string, number | null]> = [
      ['draftSlotRevisionBefore', value['draftSlotRevisionBefore'] as number | null],
      ['draftSlotRevisionAfter', value['draftSlotRevisionAfter'] as number | null],
      ['draftContentRevisionBefore', value['draftContentRevisionBefore'] as number | null],
      ['draftContentRevisionAfter', value['draftContentRevisionAfter'] as number | null],
    ];
    for (const [field, value] of revisions) {
      if (value !== null && !isSafeRevision(value, field.includes('Content'))) {
        return invalid(field, 'invalid_revision');
      }
    }

    if (value['realtimeSessionId'] !== null && !isCanonicalUuid(value['realtimeSessionId'])) {
      return invalid('realtimeSessionId', 'invalid_uuid');
    }
    if (value['turnId'] !== null && !isCanonicalUuid(value['turnId'])) return invalid('turnId', 'invalid_uuid');
    if ((value['contextRevision'] === null) !== (value['contextDigest'] === null)) {
      return invalid('context', 'inconsistent_event');
    }
    if (value['contextRevision'] !== null && !isSafeRevision(value['contextRevision'], false)) {
      return invalid('contextRevision', 'invalid_revision');
    }
    if (value['contextDigest'] !== null && (typeof value['contextDigest'] !== 'string' || !SHA256.test(value['contextDigest']))) {
      return invalid('contextDigest', 'invalid_digest');
    }

    const occurredAt = instantEpoch(value['occurredAt']);
    const retentionExpiresAt = instantEpoch(value['retentionExpiresAt']);
    if (occurredAt === null) return invalid('occurredAt', 'invalid_instant');
    if (retentionExpiresAt === null || retentionExpiresAt !== occurredAt + AGENT_MISSION_EVENT_RETENTION_MS) {
      return invalid('retentionExpiresAt', 'invalid_instant');
    }

    const data = validateData(eventType, value['data']);
    if (!data.ok) return data;
    const correlation = validateCorrelation({
      eventType,
      actor,
      realtimeSessionId: value['realtimeSessionId'] as string | null,
      turnId: value['turnId'] as string | null,
      contextRevision: value['contextRevision'] as number | null,
      contextDigest: value['contextDigest'] as string | null,
      data: data.value,
    });
    if (!correlation.ok) return correlation;
    const draftEffect = validateDraftEffect({
      eventType,
      data: data.value,
      slotBefore: value['draftSlotRevisionBefore'] as number | null,
      slotAfter: value['draftSlotRevisionAfter'] as number | null,
      contentBefore: value['draftContentRevisionBefore'] as number | null,
      contentAfter: value['draftContentRevisionAfter'] as number | null,
    });
    if (!draftEffect.ok) return draftEffect;

    const snapshot: AgentMissionEventSnapshot = {
      id: value['id'],
      companyId: value['companyId'],
      ownerUserId: value['ownerUserId'],
      missionId: value['missionId'],
      sequence: value['sequence'] as number,
      eventType,
      eventVersion: 1,
      actor,
      commandId: value['commandId'],
      requestFingerprintHmac: value['requestFingerprintHmac'],
      fingerprintKeyVersion: value['fingerprintKeyVersion'] as number,
      fingerprintCanonicalizationVersion: 1,
      missionRevisionBefore: value['missionRevisionBefore'] as number,
      missionRevisionAfter: value['missionRevisionAfter'] as number,
      draftSlotRevisionBefore: value['draftSlotRevisionBefore'] as number | null,
      draftSlotRevisionAfter: value['draftSlotRevisionAfter'] as number | null,
      draftContentRevisionBefore: value['draftContentRevisionBefore'] as number | null,
      draftContentRevisionAfter: value['draftContentRevisionAfter'] as number | null,
      realtimeSessionId: value['realtimeSessionId'] as string | null,
      turnId: value['turnId'] as string | null,
      contextRevision: value['contextRevision'] as number | null,
      contextDigest: value['contextDigest'] as string | null,
      data: data.value,
      occurredAt: value['occurredAt'] as Instant,
      retentionExpiresAt: value['retentionExpiresAt'] as Instant,
    };
    return ok(new AgentMissionEvent(Object.freeze(snapshot)));
  }

  toSnapshot(): AgentMissionEventSnapshot {
    return Object.freeze({ ...this.snapshot, data: cloneEventData(this.snapshot.data) });
  }
}
