import { type Result, err, ok } from '../../shared-kernel/result';
import { jsonUtf8ByteLength } from '../../shared-kernel/json-size';
import { sha256Hex } from '../../shared-kernel/sha256';
import { type Instant } from '../../shared-kernel/time';
import {
  AGENT_MISSION_EVENT_RETENTION_MS,
  AGENT_MISSION_START_OUTCOMES,
  type AgentMissionEventDataV1,
  type AgentMissionStartConflictOutcome,
  type AgentMissionStartDirectDraftOutcome,
  type AgentMissionTransitionEvent,
} from './agent-mission-event';

export const AGENT_MISSION_KIND = 'quote_creation' as const;
export type AgentMissionKind = typeof AGENT_MISSION_KIND;

/**
 * États réellement persistables en M1. `completed` reste un état cible de la roadmap M2, mais
 * M1 s'arrête volontairement à `awaiting_lines` et ne doit donc jamais créer une ligne que son
 * propre core serait incapable de réhydrater.
 */
export const AGENT_MISSION_STATUSES = ['active', 'cancelled', 'expired'] as const;
export type AgentMissionStatus = (typeof AGENT_MISSION_STATUSES)[number];

export const QUOTE_CREATION_MISSION_PHASES = [
  'awaiting_draft_decision',
  'awaiting_draft_discard_confirmation',
  'awaiting_quote_screen',
  'awaiting_customer',
  'awaiting_customer_choice',
  'awaiting_lines',
] as const;

export type QuoteCreationMissionPhase = (typeof QUOTE_CREATION_MISSION_PHASES)[number];

export const AGENT_MISSION_PAYLOAD_SCHEMA = 'bob.agent-mission.quote-creation' as const;
export const AGENT_MISSION_PAYLOAD_VERSION = 1 as const;
export const AGENT_MISSION_IDLE_TTL_MS = 24 * 60 * 60 * 1_000;
export const AGENT_MISSION_HARD_TTL_MS = 7 * AGENT_MISSION_IDLE_TTL_MS;
export const AGENT_MISSION_RETENTION_MS = AGENT_MISSION_EVENT_RETENTION_MS;
export const AGENT_MISSION_MAX_CUSTOMER_CHOICES = 5;
export const AGENT_MISSION_INT4_MAX = 2_147_483_647;
export const AGENT_MISSION_MAX_PAYLOAD_BYTES = 64 * 1024;
export const QUOTE_MISSION_LEGACY_PAYLOAD_KEYS = [
  'schema',
  'version',
  'draft',
  'decision',
] as const;
export const QUOTE_MISSION_PAYLOAD_KEYS = [
  ...QUOTE_MISSION_LEGACY_PAYLOAD_KEYS,
  'stagedCustomerResolution',
] as const;
export const QUOTE_MISSION_DRAFT_REFERENCE_KEYS = [
  'sessionId',
  'slotRevision',
  'contentRevision',
] as const;
export const QUOTE_MISSION_DECISION_KINDS = [
  'existing_draft',
  'confirm_draft_discard',
  'customer',
] as const;
export const QUOTE_MISSION_DRAFT_DECISION_KEYS = [
  'kind',
  'decisionId',
  'choiceSetRevision',
  'expectedDraftSessionId',
  'expectedDraftSlotRevision',
  'expectedDraftContentRevision',
  'choices',
  'choiceSetHash',
] as const;
export const QUOTE_MISSION_CUSTOMER_DECISION_KEYS = [
  'kind',
  'decisionId',
  'choiceSetRevision',
  'candidates',
  'choiceSetHash',
] as const;
export const QUOTE_MISSION_ACTION_CHOICE_KEYS = ['choiceId', 'action'] as const;
export const QUOTE_MISSION_CUSTOMER_CANDIDATE_KEYS = ['choiceId', 'customerId'] as const;
export const QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KINDS = [
  'none',
  'too_many',
  'exact',
  'choices',
] as const;
export const QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KIND_ONLY_KEYS = ['kind'] as const;
export const QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_EXACT_KEYS = [
  'kind',
  'customerId',
] as const;
export const QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_CHOICES_KEYS = [
  'kind',
  'decisionId',
  'candidates',
] as const;
export const QUOTE_MISSION_EXISTING_DRAFT_ACTIONS = [
  'resume_existing',
  'request_discard',
] as const;
export const QUOTE_MISSION_CONFIRM_DISCARD_ACTIONS = [
  'confirm_discard',
  'keep_existing',
] as const;
export const AGENT_MISSION_CONTEXT_BINDING_KEYS = [
  'realtimeSessionId',
  'contextRevision',
  'contextDigest',
  'screenName',
  'screenInstanceId',
  'acknowledgedAt',
] as const;
export const AGENT_MISSION_CONTEXT_SCREEN_NAMES = ['/devis/new'] as const;

export interface QuoteMissionDraftReferenceV1 {
  readonly sessionId: string;
  readonly slotRevision: number;
  readonly contentRevision: number;
}

export interface ExistingDraftDecisionV1 {
  readonly kind: 'existing_draft';
  readonly decisionId: string;
  readonly choiceSetRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly choices: readonly [
    { readonly choiceId: string; readonly action: 'resume_existing' },
    { readonly choiceId: string; readonly action: 'request_discard' },
  ];
  readonly choiceSetHash: string;
}

export interface ConfirmDraftDiscardDecisionV1 {
  readonly kind: 'confirm_draft_discard';
  readonly decisionId: string;
  readonly choiceSetRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly choices: readonly [
    { readonly choiceId: string; readonly action: 'confirm_discard' },
    { readonly choiceId: string; readonly action: 'keep_existing' },
  ];
  readonly choiceSetHash: string;
}

export interface CustomerDecisionV1 {
  readonly kind: 'customer';
  readonly decisionId: string;
  readonly choiceSetRevision: number;
  readonly candidates: readonly {
    readonly choiceId: string;
    readonly customerId: string;
  }[];
  readonly choiceSetHash: string;
}

export type QuoteMissionStagedCustomerResolutionV1 =
  | { readonly kind: 'none' }
  | { readonly kind: 'too_many' }
  | { readonly kind: 'exact'; readonly customerId: string }
  | {
      readonly kind: 'choices';
      readonly decisionId: string;
      readonly candidates: readonly {
        readonly choiceId: string;
        readonly customerId: string;
      }[];
    };

export type QuoteMissionDecisionV1 =
  | ExistingDraftDecisionV1
  | ConfirmDraftDiscardDecisionV1
  | CustomerDecisionV1;

export interface QuoteCreationMissionPayloadV1 {
  readonly schema: typeof AGENT_MISSION_PAYLOAD_SCHEMA;
  readonly version: typeof AGENT_MISSION_PAYLOAD_VERSION;
  readonly draft: QuoteMissionDraftReferenceV1 | null;
  readonly decision: QuoteMissionDecisionV1 | null;
  /**
   * Toujours présent après normalisation core. Le parseur accepte son absence sur les lignes N-1
   * et les convertit en `null`.
   */
  readonly stagedCustomerResolution: QuoteMissionStagedCustomerResolutionV1 | null;
}

export interface AgentMissionContextBinding {
  readonly realtimeSessionId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly screenName: '/devis/new';
  readonly screenInstanceId: string;
  readonly acknowledgedAt: Instant;
}

export interface AgentMissionSnapshot {
  readonly id: string;
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly kind: AgentMissionKind;
  readonly status: AgentMissionStatus;
  readonly phase: QuoteCreationMissionPhase;
  readonly revision: number;
  readonly payloadVersion: 1;
  readonly payload: QuoteCreationMissionPayloadV1;
  readonly currentBinding: AgentMissionContextBinding | null;
  readonly idleExpiresAt: Instant;
  readonly hardExpiresAt: Instant;
  readonly terminalAt: Instant | null;
  readonly retentionExpiresAt: Instant;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export type AgentMissionError =
  | {
      readonly code: 'invalid_agent_mission';
      readonly field: string;
      readonly reason:
        | 'invalid_shape'
        | 'invalid_identifier'
        | 'invalid_uuid'
        | 'invalid_digest'
        | 'invalid_revision'
        | 'invalid_instant'
        | 'invalid_value'
        | 'payload_too_large'
        | 'inconsistent_state';
    }
  | {
      readonly code: 'agent_mission_terminal';
      readonly status: Exclude<AgentMissionStatus, 'active'>;
    }
  | {
      readonly code: 'agent_mission_revision_conflict';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    }
  | {
      readonly code: 'agent_mission_revision_overflow';
      readonly field: 'missionRevision' | 'draftSlotRevision' | 'draftContentRevision';
    }
  | {
      readonly code: 'agent_mission_invalid_transition';
      readonly phase: QuoteCreationMissionPhase;
      readonly action: AgentMissionAction;
    }
  | {
      readonly code: 'agent_mission_decision_conflict';
      readonly reason:
        | 'decision_id'
        | 'choice_set_revision'
        | 'choice_id'
        | 'draft_reference'
        | 'customer_reference';
    }
  | { readonly code: 'agent_mission_expired' }
  | { readonly code: 'agent_mission_clock_regression' };

export type AgentMissionResult<T> = Result<T, AgentMissionError>;

export type AgentMissionAction =
  | 'join_active'
  | 'resume_existing_draft'
  | 'request_draft_discard'
  | 'keep_existing_draft'
  | 'confirm_draft_discard'
  | 'stage_customer_resolution'
  | 'consume_staged_customer_resolution'
  | 'acknowledge_quote_screen'
  | 'customer_not_found'
  | 'present_customer_choices'
  | 'invalidate_customer_decision'
  | 'select_customer'
  | 'cancel'
  | 'expire';

export interface AgentMissionTransition {
  readonly mission: AgentMission;
  readonly event: AgentMissionTransitionEvent;
}

type ExistingDraftChoiceIds = {
  readonly decisionId: string;
  readonly resumeChoiceId: string;
  readonly requestDiscardChoiceId: string;
};

type ConfirmDraftDiscardChoiceIds = {
  readonly decisionId: string;
  readonly confirmChoiceId: string;
  readonly keepChoiceId: string;
};

export type StartQuoteAgentMissionInput = {
  readonly id: string;
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly createdAt: Instant;
  readonly stagedCustomerResolution: QuoteMissionStagedCustomerResolutionV1 | null;
} & (
  | {
      readonly startOutcome: AgentMissionStartDirectDraftOutcome;
      readonly draft: QuoteMissionDraftReferenceV1;
    }
  | {
      readonly startOutcome: AgentMissionStartConflictOutcome;
      readonly existingDraft: QuoteMissionDraftReferenceV1;
      readonly decision: ExistingDraftChoiceIds;
    }
);

type ChoiceSetItem =
  | { readonly choiceId: string; readonly action: string }
  | { readonly choiceId: string; readonly customerId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_SCREEN_INSTANCE_LENGTH = 160;
const ACTIVE_PHASES_REQUIRING_BINDING = new Set<QuoteCreationMissionPhase>([
  'awaiting_customer',
  'awaiting_customer_choice',
  'awaiting_lines',
]);
const ACKNOWLEDGEABLE_PHASES = new Set<QuoteCreationMissionPhase>([
  'awaiting_quote_screen',
  'awaiting_customer',
  'awaiting_customer_choice',
  'awaiting_lines',
]);
const CUSTOMER_RESOLUTION_STAGEABLE_PHASES = new Set<QuoteCreationMissionPhase>([
  'awaiting_draft_decision',
  'awaiting_draft_discard_confirmation',
  'awaiting_quote_screen',
]);

function invalid(
  field: string,
  reason: Extract<AgentMissionError, { code: 'invalid_agent_mission' }>['reason'],
): AgentMissionResult<never> {
  return err({ code: 'invalid_agent_mission', field, reason });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function requireExactInput(value: unknown, keys: readonly string[]): AgentMissionResult<void> {
  return isPlainRecord(value) && exactKeys(value, keys)
    ? ok(undefined)
    : invalid('$', 'invalid_shape');
}

function isOneOf<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point < 32 || (point >= 127 && point <= 159));
  });
}

function isCanonicalIdentifier(value: unknown, maxLength = MAX_IDENTIFIER_LENGTH): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !hasControlCharacter(value)
  );
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isRevision(value: unknown, allowZero: boolean): value is number {
  return (
    Number.isSafeInteger(value)
    && (value as number) >= (allowZero ? 0 : 1)
    && (value as number) <= AGENT_MISSION_INT4_MAX
  );
}

function instantEpoch(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) return null;
  return epoch;
}

function instantFromEpoch(epoch: number): Instant {
  return new Date(epoch).toISOString();
}

function futureInstant(epoch: number, durationMs: number): AgentMissionResult<Instant> {
  const target = epoch + durationMs;
  if (!Number.isSafeInteger(target)) return invalid('timestamps', 'invalid_instant');
  try {
    return ok(instantFromEpoch(target));
  } catch {
    return invalid('timestamps', 'invalid_instant');
  }
}

function cloneDraft(draft: QuoteMissionDraftReferenceV1): QuoteMissionDraftReferenceV1 {
  return Object.freeze({ ...draft });
}

function cloneDecision(decision: QuoteMissionDecisionV1): QuoteMissionDecisionV1 {
  if (decision.kind === 'customer') {
    return Object.freeze({
      ...decision,
      candidates: Object.freeze(decision.candidates.map((candidate) => Object.freeze({ ...candidate }))),
    });
  }
  if (decision.kind === 'existing_draft') {
    const choices: ExistingDraftDecisionV1['choices'] = Object.freeze([
      Object.freeze({ ...decision.choices[0] }),
      Object.freeze({ ...decision.choices[1] }),
    ]);
    return Object.freeze({
      ...decision,
      choices,
    });
  }
  const choices: ConfirmDraftDiscardDecisionV1['choices'] = Object.freeze([
    Object.freeze({ ...decision.choices[0] }),
    Object.freeze({ ...decision.choices[1] }),
  ]);
  return Object.freeze({
    ...decision,
    choices,
  });
}

function cloneStagedCustomerResolution(
  resolution: QuoteMissionStagedCustomerResolutionV1,
): QuoteMissionStagedCustomerResolutionV1 {
  if (resolution.kind !== 'choices') return Object.freeze({ ...resolution });
  return Object.freeze({
    ...resolution,
    candidates: Object.freeze(
      resolution.candidates.map((candidate) => Object.freeze({ ...candidate })),
    ),
  });
}

function clonePayload(payload: QuoteCreationMissionPayloadV1): QuoteCreationMissionPayloadV1 {
  return Object.freeze({
    ...payload,
    draft: payload.draft === null ? null : cloneDraft(payload.draft),
    decision: payload.decision === null ? null : cloneDecision(payload.decision),
    stagedCustomerResolution: payload.stagedCustomerResolution === null
      ? null
      : cloneStagedCustomerResolution(payload.stagedCustomerResolution),
  });
}

function cloneBinding(binding: AgentMissionContextBinding): AgentMissionContextBinding {
  return Object.freeze({ ...binding });
}

function cloneSnapshot(snapshot: AgentMissionSnapshot): AgentMissionSnapshot {
  return Object.freeze({
    ...snapshot,
    payload: clonePayload(snapshot.payload),
    currentBinding: snapshot.currentBinding === null ? null : cloneBinding(snapshot.currentBinding),
  });
}

function sameDraft(left: QuoteMissionDraftReferenceV1, right: QuoteMissionDraftReferenceV1): boolean {
  return (
    left.sessionId === right.sessionId
    && left.slotRevision === right.slotRevision
    && left.contentRevision === right.contentRevision
  );
}

function parseDraft(value: unknown, field: string): AgentMissionResult<QuoteMissionDraftReferenceV1> {
  if (
    !isPlainRecord(value)
    || !exactKeys(value, QUOTE_MISSION_DRAFT_REFERENCE_KEYS)
  ) {
    return invalid(field, 'invalid_shape');
  }
  if (!isCanonicalIdentifier(value['sessionId'])) return invalid(`${field}.sessionId`, 'invalid_identifier');
  if (!isRevision(value['slotRevision'], false)) return invalid(`${field}.slotRevision`, 'invalid_revision');
  if (!isRevision(value['contentRevision'], true)) return invalid(`${field}.contentRevision`, 'invalid_revision');
  return ok(cloneDraft({
    sessionId: value['sessionId'],
    slotRevision: value['slotRevision'],
    contentRevision: value['contentRevision'],
  }));
}

function parseStagedCustomerResolution(
  value: unknown,
): AgentMissionResult<QuoteMissionStagedCustomerResolutionV1> {
  if (
    !isPlainRecord(value)
    || !isOneOf(QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KINDS, value['kind'])
  ) {
    return invalid('payload.stagedCustomerResolution', 'invalid_shape');
  }

  if (value['kind'] === 'none' || value['kind'] === 'too_many') {
    if (!exactKeys(value, QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KIND_ONLY_KEYS)) {
      return invalid('payload.stagedCustomerResolution', 'invalid_shape');
    }
    return ok(cloneStagedCustomerResolution({ kind: value['kind'] }));
  }

  if (value['kind'] === 'exact') {
    if (!exactKeys(value, QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_EXACT_KEYS)) {
      return invalid('payload.stagedCustomerResolution', 'invalid_shape');
    }
    if (!isCanonicalIdentifier(value['customerId'])) {
      return invalid('payload.stagedCustomerResolution.customerId', 'invalid_identifier');
    }
    return ok(cloneStagedCustomerResolution({
      kind: 'exact',
      customerId: value['customerId'],
    }));
  }

  if (!exactKeys(value, QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_CHOICES_KEYS)) {
    return invalid('payload.stagedCustomerResolution', 'invalid_shape');
  }
  if (!isCanonicalUuid(value['decisionId'])) {
    return invalid('payload.stagedCustomerResolution.decisionId', 'invalid_uuid');
  }
  if (
    !Array.isArray(value['candidates'])
    || value['candidates'].length < 1
    || value['candidates'].length > AGENT_MISSION_MAX_CUSTOMER_CHOICES
  ) {
    return invalid('payload.stagedCustomerResolution.candidates', 'invalid_value');
  }

  const candidates: Array<{ readonly choiceId: string; readonly customerId: string }> = [];
  const choiceIds = new Set<string>();
  const customerIds = new Set<string>();
  for (let index = 0; index < value['candidates'].length; index += 1) {
    const candidate = value['candidates'][index];
    if (!isPlainRecord(candidate) || !exactKeys(candidate, QUOTE_MISSION_CUSTOMER_CANDIDATE_KEYS)) {
      return invalid(`payload.stagedCustomerResolution.candidates[${index}]`, 'invalid_shape');
    }
    if (!isCanonicalUuid(candidate['choiceId'])) {
      return invalid(
        `payload.stagedCustomerResolution.candidates[${index}].choiceId`,
        'invalid_uuid',
      );
    }
    if (!isCanonicalIdentifier(candidate['customerId'])) {
      return invalid(
        `payload.stagedCustomerResolution.candidates[${index}].customerId`,
        'invalid_identifier',
      );
    }
    if (choiceIds.has(candidate['choiceId']) || customerIds.has(candidate['customerId'])) {
      return invalid(`payload.stagedCustomerResolution.candidates[${index}]`, 'invalid_value');
    }
    choiceIds.add(candidate['choiceId']);
    customerIds.add(candidate['customerId']);
    candidates.push({
      choiceId: candidate['choiceId'],
      customerId: candidate['customerId'],
    });
  }

  return ok(cloneStagedCustomerResolution({
    kind: 'choices',
    decisionId: value['decisionId'],
    candidates,
  }));
}

/** Canonicalisation V1 explicitement ordonnée, partagée par voix et toucher. */
export function computeQuoteMissionChoiceSetHash(input: {
  readonly missionId: string;
  readonly choiceSetRevision: number;
  readonly decisionId: string;
  readonly choices: readonly ChoiceSetItem[];
  readonly draftFence?: QuoteMissionDraftReferenceV1;
}): AgentMissionResult<string> {
  if (!isPlainRecord(input) || !exactKeys(
    input,
    input['draftFence'] === undefined
      ? ['missionId', 'choiceSetRevision', 'decisionId', 'choices']
      : ['missionId', 'choiceSetRevision', 'decisionId', 'choices', 'draftFence'],
  )) {
    return invalid('$', 'invalid_shape');
  }
  if (!isCanonicalUuid(input.missionId)) return invalid('missionId', 'invalid_uuid');
  if (!isRevision(input.choiceSetRevision, false)) return invalid('choiceSetRevision', 'invalid_revision');
  if (!isCanonicalUuid(input.decisionId)) return invalid('decisionId', 'invalid_uuid');
  if (!Array.isArray(input.choices) || input.choices.length === 0 || input.choices.length > AGENT_MISSION_MAX_CUSTOMER_CHOICES) {
    return invalid('choices', 'invalid_value');
  }

  const draftFence = input.draftFence === undefined ? null : parseDraft(input.draftFence, 'draftFence');
  if (draftFence !== null && !draftFence.ok) return draftFence;

  const seen = new Set<string>();
  const canonicalChoices: Array<readonly [string, 'action' | 'customerId', string]> = [];
  for (let index = 0; index < input.choices.length; index += 1) {
    const choice = input.choices[index]!;
    if (!isPlainRecord(choice)) return invalid(`choices[${index}]`, 'invalid_shape');
    const hasAction = Object.hasOwn(choice, 'action');
    const hasCustomerId = Object.hasOwn(choice, 'customerId');
    if (
      hasAction === hasCustomerId
      || !exactKeys(choice, hasAction ? ['choiceId', 'action'] : ['choiceId', 'customerId'])
    ) {
      return invalid(`choices[${index}]`, 'invalid_shape');
    }
    if (!isCanonicalUuid(choice['choiceId']) || seen.has(choice['choiceId'])) {
      return invalid(
        `choices[${index}].choiceId`,
        seen.has(choice['choiceId'] as string) ? 'invalid_value' : 'invalid_uuid',
      );
    }
    seen.add(choice['choiceId']);
    if (hasAction) {
      if (!isCanonicalIdentifier(choice['action'], 64)) return invalid(`choices[${index}].action`, 'invalid_value');
      canonicalChoices.push([choice['choiceId'], 'action', choice['action']]);
    } else {
      if (!isCanonicalIdentifier(choice['customerId'])) {
        return invalid(`choices[${index}].customerId`, 'invalid_identifier');
      }
      canonicalChoices.push([choice['choiceId'], 'customerId', choice['customerId']]);
    }
  }

  return ok(sha256Hex(JSON.stringify([
    'bob.agent-mission.choice-set.v1',
    input.missionId,
    input.choiceSetRevision,
    input.decisionId,
    draftFence === null
      ? null
      : [draftFence.value.sessionId, draftFence.value.slotRevision, draftFence.value.contentRevision],
    canonicalChoices,
  ])));
}

function createExistingDraftDecision(
  missionId: string,
  revision: number,
  draft: QuoteMissionDraftReferenceV1,
  input: ExistingDraftChoiceIds,
): AgentMissionResult<ExistingDraftDecisionV1> {
  if (!isPlainRecord(input) || !exactKeys(input, ['decisionId', 'resumeChoiceId', 'requestDiscardChoiceId'])) {
    return invalid('decision', 'invalid_shape');
  }
  const parsedDraft = parseDraft(draft, 'existingDraft');
  if (!parsedDraft.ok) return parsedDraft;
  const choices = [
    { choiceId: input.resumeChoiceId, action: 'resume_existing' as const },
    { choiceId: input.requestDiscardChoiceId, action: 'request_discard' as const },
  ] as const;
  const hash = computeQuoteMissionChoiceSetHash({
    missionId,
    choiceSetRevision: revision,
    decisionId: input.decisionId,
    choices,
    draftFence: parsedDraft.value,
  });
  if (!hash.ok) return hash;
  return ok(cloneDecision({
    kind: 'existing_draft',
    decisionId: input.decisionId,
    choiceSetRevision: revision,
    expectedDraftSessionId: parsedDraft.value.sessionId,
    expectedDraftSlotRevision: parsedDraft.value.slotRevision,
    expectedDraftContentRevision: parsedDraft.value.contentRevision,
    choices,
    choiceSetHash: hash.value,
  }) as ExistingDraftDecisionV1);
}

function createConfirmDraftDiscardDecision(
  missionId: string,
  revision: number,
  draft: QuoteMissionDraftReferenceV1,
  input: ConfirmDraftDiscardChoiceIds,
): AgentMissionResult<ConfirmDraftDiscardDecisionV1> {
  if (!isPlainRecord(input) || !exactKeys(input, ['decisionId', 'confirmChoiceId', 'keepChoiceId'])) {
    return invalid('decision', 'invalid_shape');
  }
  const choices = [
    { choiceId: input.confirmChoiceId, action: 'confirm_discard' as const },
    { choiceId: input.keepChoiceId, action: 'keep_existing' as const },
  ] as const;
  const hash = computeQuoteMissionChoiceSetHash({
    missionId,
    choiceSetRevision: revision,
    decisionId: input.decisionId,
    choices,
    draftFence: draft,
  });
  if (!hash.ok) return hash;
  return ok(cloneDecision({
    kind: 'confirm_draft_discard',
    decisionId: input.decisionId,
    choiceSetRevision: revision,
    expectedDraftSessionId: draft.sessionId,
    expectedDraftSlotRevision: draft.slotRevision,
    expectedDraftContentRevision: draft.contentRevision,
    choices,
    choiceSetHash: hash.value,
  }) as ConfirmDraftDiscardDecisionV1);
}

function parseDecision(
  value: unknown,
  missionId: string,
  revision: number,
): AgentMissionResult<QuoteMissionDecisionV1> {
  if (!isPlainRecord(value) || typeof value['kind'] !== 'string') {
    return invalid('payload.decision', 'invalid_shape');
  }
  if (!isCanonicalUuid(value['decisionId'])) return invalid('payload.decision.decisionId', 'invalid_uuid');
  if (!isRevision(value['choiceSetRevision'], false) || value['choiceSetRevision'] > revision) {
    return invalid('payload.decision.choiceSetRevision', 'invalid_revision');
  }
  const choiceSetRevision = value['choiceSetRevision'];
  if (typeof value['choiceSetHash'] !== 'string' || !SHA256.test(value['choiceSetHash'])) {
    return invalid('payload.decision.choiceSetHash', 'invalid_digest');
  }

  if (value['kind'] === 'existing_draft') {
    if (!exactKeys(value, QUOTE_MISSION_DRAFT_DECISION_KEYS)) {
      return invalid('payload.decision', 'invalid_shape');
    }
    const draft = parseDraft({
      sessionId: value['expectedDraftSessionId'],
      slotRevision: value['expectedDraftSlotRevision'],
      contentRevision: value['expectedDraftContentRevision'],
    }, 'payload.decision.expectedDraft');
    if (!draft.ok) return draft;
    if (!Array.isArray(value['choices']) || value['choices'].length !== 2) {
      return invalid('payload.decision.choices', 'invalid_shape');
    }
    const first = value['choices'][0];
    const second = value['choices'][1];
    if (
      !isPlainRecord(first)
      || !exactKeys(first, QUOTE_MISSION_ACTION_CHOICE_KEYS)
      || first['action'] !== QUOTE_MISSION_EXISTING_DRAFT_ACTIONS[0]
      || !isCanonicalUuid(first['choiceId'])
      || !isPlainRecord(second)
      || !exactKeys(second, QUOTE_MISSION_ACTION_CHOICE_KEYS)
      || second['action'] !== QUOTE_MISSION_EXISTING_DRAFT_ACTIONS[1]
      || !isCanonicalUuid(second['choiceId'])
    ) {
      return invalid('payload.decision.choices', 'invalid_value');
    }
    const expected = createExistingDraftDecision(missionId, choiceSetRevision, draft.value, {
      decisionId: value['decisionId'],
      resumeChoiceId: first['choiceId'],
      requestDiscardChoiceId: second['choiceId'],
    });
    if (!expected.ok) return expected;
    if (expected.value.choiceSetHash !== value['choiceSetHash']) {
      return invalid('payload.decision.choiceSetHash', 'inconsistent_state');
    }
    return expected;
  }

  if (value['kind'] === 'confirm_draft_discard') {
    if (!exactKeys(value, QUOTE_MISSION_DRAFT_DECISION_KEYS)) {
      return invalid('payload.decision', 'invalid_shape');
    }
    const draft = parseDraft({
      sessionId: value['expectedDraftSessionId'],
      slotRevision: value['expectedDraftSlotRevision'],
      contentRevision: value['expectedDraftContentRevision'],
    }, 'payload.decision.expectedDraft');
    if (!draft.ok) return draft;
    if (!Array.isArray(value['choices']) || value['choices'].length !== 2) {
      return invalid('payload.decision.choices', 'invalid_shape');
    }
    const first = value['choices'][0];
    const second = value['choices'][1];
    if (
      !isPlainRecord(first)
      || !exactKeys(first, QUOTE_MISSION_ACTION_CHOICE_KEYS)
      || first['action'] !== QUOTE_MISSION_CONFIRM_DISCARD_ACTIONS[0]
      || !isCanonicalUuid(first['choiceId'])
      || !isPlainRecord(second)
      || !exactKeys(second, QUOTE_MISSION_ACTION_CHOICE_KEYS)
      || second['action'] !== QUOTE_MISSION_CONFIRM_DISCARD_ACTIONS[1]
      || !isCanonicalUuid(second['choiceId'])
    ) {
      return invalid('payload.decision.choices', 'invalid_value');
    }
    const expected = createConfirmDraftDiscardDecision(missionId, choiceSetRevision, draft.value, {
      decisionId: value['decisionId'],
      confirmChoiceId: first['choiceId'],
      keepChoiceId: second['choiceId'],
    });
    if (!expected.ok) return expected;
    if (expected.value.choiceSetHash !== value['choiceSetHash']) {
      return invalid('payload.decision.choiceSetHash', 'inconsistent_state');
    }
    return expected;
  }

  if (value['kind'] === 'customer') {
    if (!exactKeys(value, QUOTE_MISSION_CUSTOMER_DECISION_KEYS)) {
      return invalid('payload.decision', 'invalid_shape');
    }
    if (
      !Array.isArray(value['candidates'])
      || value['candidates'].length < 1
      || value['candidates'].length > AGENT_MISSION_MAX_CUSTOMER_CHOICES
    ) {
      return invalid('payload.decision.candidates', 'invalid_value');
    }
    const candidates: Array<{ readonly choiceId: string; readonly customerId: string }> = [];
    const customerIds = new Set<string>();
    for (let index = 0; index < value['candidates'].length; index += 1) {
      const candidate = value['candidates'][index];
      if (!isPlainRecord(candidate) || !exactKeys(candidate, QUOTE_MISSION_CUSTOMER_CANDIDATE_KEYS)) {
        return invalid(`payload.decision.candidates[${index}]`, 'invalid_shape');
      }
      if (!isCanonicalUuid(candidate['choiceId'])) {
        return invalid(`payload.decision.candidates[${index}].choiceId`, 'invalid_uuid');
      }
      if (!isCanonicalIdentifier(candidate['customerId'])) {
        return invalid(`payload.decision.candidates[${index}].customerId`, 'invalid_identifier');
      }
      if (customerIds.has(candidate['customerId'])) {
        return invalid(`payload.decision.candidates[${index}].customerId`, 'invalid_value');
      }
      customerIds.add(candidate['customerId']);
      candidates.push({ choiceId: candidate['choiceId'], customerId: candidate['customerId'] });
    }
    const hash = computeQuoteMissionChoiceSetHash({
      missionId,
      choiceSetRevision,
      decisionId: value['decisionId'],
      choices: candidates,
    });
    if (!hash.ok) return hash;
    if (hash.value !== value['choiceSetHash']) {
      return invalid('payload.decision.choiceSetHash', 'inconsistent_state');
    }
    return ok(cloneDecision({
      kind: 'customer',
      decisionId: value['decisionId'],
      choiceSetRevision,
      candidates,
      choiceSetHash: hash.value,
    }));
  }

  return invalid('payload.decision.kind', 'invalid_value');
}

function parsePayload(
  value: unknown,
  missionId: string,
  revision: number,
): AgentMissionResult<QuoteCreationMissionPayloadV1> {
  const payloadBytes = jsonUtf8ByteLength(value);
  if (payloadBytes === null) return invalid('payload', 'invalid_shape');
  if (payloadBytes > AGENT_MISSION_MAX_PAYLOAD_BYTES) {
    return invalid('payload', 'payload_too_large');
  }
  if (
    !isPlainRecord(value)
    || (
      !exactKeys(value, QUOTE_MISSION_PAYLOAD_KEYS)
      && !exactKeys(value, QUOTE_MISSION_LEGACY_PAYLOAD_KEYS)
    )
  ) {
    return invalid('payload', 'invalid_shape');
  }
  if (value['schema'] !== AGENT_MISSION_PAYLOAD_SCHEMA) return invalid('payload.schema', 'invalid_value');
  if (value['version'] !== AGENT_MISSION_PAYLOAD_VERSION) return invalid('payload.version', 'invalid_value');
  const draft = value['draft'] === null ? ok(null) : parseDraft(value['draft'], 'payload.draft');
  if (!draft.ok) return draft;
  const decision = value['decision'] === null
    ? ok(null)
    : parseDecision(value['decision'], missionId, revision);
  if (!decision.ok) return decision;
  const stagedCustomerResolution = !Object.hasOwn(value, 'stagedCustomerResolution')
    || value['stagedCustomerResolution'] === null
    ? ok(null)
    : parseStagedCustomerResolution(value['stagedCustomerResolution']);
  if (!stagedCustomerResolution.ok) return stagedCustomerResolution;
  return ok(clonePayload({
    schema: AGENT_MISSION_PAYLOAD_SCHEMA,
    version: AGENT_MISSION_PAYLOAD_VERSION,
    draft: draft.value,
    decision: decision.value,
    stagedCustomerResolution: stagedCustomerResolution.value,
  }));
}

function parseBinding(value: unknown): AgentMissionResult<AgentMissionContextBinding> {
  if (!isPlainRecord(value) || !exactKeys(value, AGENT_MISSION_CONTEXT_BINDING_KEYS)) {
    return invalid('currentBinding', 'invalid_shape');
  }
  if (!isCanonicalUuid(value['realtimeSessionId'])) return invalid('currentBinding.realtimeSessionId', 'invalid_uuid');
  if (!isRevision(value['contextRevision'], false)) return invalid('currentBinding.contextRevision', 'invalid_revision');
  if (typeof value['contextDigest'] !== 'string' || !SHA256.test(value['contextDigest'])) {
    return invalid('currentBinding.contextDigest', 'invalid_digest');
  }
  if (value['screenName'] !== AGENT_MISSION_CONTEXT_SCREEN_NAMES[0]) {
    return invalid('currentBinding.screenName', 'invalid_value');
  }
  if (!isCanonicalIdentifier(value['screenInstanceId'], MAX_SCREEN_INSTANCE_LENGTH)) {
    return invalid('currentBinding.screenInstanceId', 'invalid_identifier');
  }
  if (instantEpoch(value['acknowledgedAt']) === null) {
    return invalid('currentBinding.acknowledgedAt', 'invalid_instant');
  }
  return ok(cloneBinding({
    realtimeSessionId: value['realtimeSessionId'],
    contextRevision: value['contextRevision'],
    contextDigest: value['contextDigest'],
    screenName: '/devis/new',
    screenInstanceId: value['screenInstanceId'],
    acknowledgedAt: value['acknowledgedAt'] as Instant,
  }));
}

function validateStateCoherence(snapshot: AgentMissionSnapshot): AgentMissionResult<void> {
  const { phase, payload, currentBinding } = snapshot;
  const expectedDecisionKind: Readonly<Partial<Record<QuoteCreationMissionPhase, QuoteMissionDecisionV1['kind']>>> = {
    awaiting_draft_decision: 'existing_draft',
    awaiting_draft_discard_confirmation: 'confirm_draft_discard',
    awaiting_customer_choice: 'customer',
  };
  const expected = expectedDecisionKind[phase];
  if (expected === undefined ? payload.decision !== null : payload.decision?.kind !== expected) {
    return invalid('payload.decision', 'inconsistent_state');
  }

  if (phase === 'awaiting_draft_decision' || phase === 'awaiting_draft_discard_confirmation') {
    if (payload.draft !== null || currentBinding !== null) return invalid('payload.draft', 'inconsistent_state');
  } else if (payload.draft === null) {
    return invalid('payload.draft', 'inconsistent_state');
  }

  if (ACTIVE_PHASES_REQUIRING_BINDING.has(phase) !== (currentBinding !== null)) {
    return invalid('currentBinding', 'inconsistent_state');
  }

  if (
    payload.stagedCustomerResolution !== null
    && (phase === 'awaiting_customer_choice' || phase === 'awaiting_lines')
  ) {
    return invalid('payload.stagedCustomerResolution', 'inconsistent_state');
  }

  return ok(undefined);
}

function parseSnapshot(value: unknown): AgentMissionResult<AgentMissionSnapshot> {
  if (!isPlainRecord(value) || !exactKeys(value, [
    'id',
    'companyId',
    'ownerUserId',
    'kind',
    'status',
    'phase',
    'revision',
    'payloadVersion',
    'payload',
    'currentBinding',
    'idleExpiresAt',
    'hardExpiresAt',
    'terminalAt',
    'retentionExpiresAt',
    'createdAt',
    'updatedAt',
  ])) {
    return invalid('$', 'invalid_shape');
  }
  if (!isCanonicalUuid(value['id'])) return invalid('id', 'invalid_uuid');
  if (!isCanonicalIdentifier(value['companyId'])) return invalid('companyId', 'invalid_identifier');
  if (!isCanonicalIdentifier(value['ownerUserId'])) return invalid('ownerUserId', 'invalid_identifier');
  if (value['kind'] !== AGENT_MISSION_KIND) return invalid('kind', 'invalid_value');
  if (!AGENT_MISSION_STATUSES.includes(value['status'] as AgentMissionStatus)) return invalid('status', 'invalid_value');
  if (!QUOTE_CREATION_MISSION_PHASES.includes(value['phase'] as QuoteCreationMissionPhase)) {
    return invalid('phase', 'invalid_value');
  }
  if (!isRevision(value['revision'], false)) return invalid('revision', 'invalid_revision');
  if (value['payloadVersion'] !== AGENT_MISSION_PAYLOAD_VERSION) return invalid('payloadVersion', 'invalid_value');

  const payload = parsePayload(value['payload'], value['id'], value['revision']);
  if (!payload.ok) return payload;
  const binding = value['currentBinding'] === null ? ok(null) : parseBinding(value['currentBinding']);
  if (!binding.ok) return binding;

  const createdAt = instantEpoch(value['createdAt']);
  const updatedAt = instantEpoch(value['updatedAt']);
  const idleExpiresAt = instantEpoch(value['idleExpiresAt']);
  const hardExpiresAt = instantEpoch(value['hardExpiresAt']);
  const retentionExpiresAt = instantEpoch(value['retentionExpiresAt']);
  const terminalAt = value['terminalAt'] === null ? null : instantEpoch(value['terminalAt']);
  if (createdAt === null) return invalid('createdAt', 'invalid_instant');
  if (updatedAt === null) return invalid('updatedAt', 'invalid_instant');
  if (idleExpiresAt === null) return invalid('idleExpiresAt', 'invalid_instant');
  if (hardExpiresAt === null) return invalid('hardExpiresAt', 'invalid_instant');
  if (retentionExpiresAt === null) return invalid('retentionExpiresAt', 'invalid_instant');
  if (value['terminalAt'] !== null && terminalAt === null) return invalid('terminalAt', 'invalid_instant');
  if (
    updatedAt < createdAt
    || hardExpiresAt !== createdAt + AGENT_MISSION_HARD_TTL_MS
    || idleExpiresAt <= createdAt
    || idleExpiresAt > hardExpiresAt
  ) {
    return invalid('timestamps', 'inconsistent_state');
  }

  const status = value['status'] as AgentMissionStatus;
  if (status === 'active') {
    if (
      terminalAt !== null
      || updatedAt >= idleExpiresAt
      || idleExpiresAt !== Math.min(updatedAt + AGENT_MISSION_IDLE_TTL_MS, hardExpiresAt)
      || updatedAt >= hardExpiresAt
    ) {
      return invalid('timestamps', 'inconsistent_state');
    }
    if (retentionExpiresAt !== hardExpiresAt + AGENT_MISSION_RETENTION_MS) {
      return invalid('retentionExpiresAt', 'inconsistent_state');
    }
  } else {
    if (terminalAt === null || updatedAt !== terminalAt || retentionExpiresAt !== terminalAt + AGENT_MISSION_RETENTION_MS) {
      return invalid('timestamps', 'inconsistent_state');
    }
    if (status === 'cancelled' && (terminalAt >= idleExpiresAt || terminalAt >= hardExpiresAt)) {
      return invalid('terminalAt', 'inconsistent_state');
    }
    if (status === 'expired' && terminalAt < Math.min(idleExpiresAt, hardExpiresAt)) {
      return invalid('terminalAt', 'inconsistent_state');
    }
  }

  const snapshot: AgentMissionSnapshot = {
    id: value['id'],
    companyId: value['companyId'],
    ownerUserId: value['ownerUserId'],
    kind: AGENT_MISSION_KIND,
    status,
    phase: value['phase'] as QuoteCreationMissionPhase,
    revision: value['revision'],
    payloadVersion: AGENT_MISSION_PAYLOAD_VERSION,
    payload: payload.value,
    currentBinding: binding.value,
    idleExpiresAt: value['idleExpiresAt'] as Instant,
    hardExpiresAt: value['hardExpiresAt'] as Instant,
    terminalAt: value['terminalAt'] as Instant | null,
    retentionExpiresAt: value['retentionExpiresAt'] as Instant,
    createdAt: value['createdAt'] as Instant,
    updatedAt: value['updatedAt'] as Instant,
  };
  if (binding.value !== null) {
    const acknowledgedAt = Date.parse(binding.value.acknowledgedAt);
    if (acknowledgedAt < createdAt || acknowledgedAt > updatedAt) {
      return invalid('currentBinding.acknowledgedAt', 'inconsistent_state');
    }
  }
  const coherent = validateStateCoherence(snapshot);
  return coherent.ok ? ok(cloneSnapshot(snapshot)) : coherent;
}

function transitionEvent(
  before: number,
  after: number,
  data: AgentMissionEventDataV1,
  occurredAt: Instant,
): AgentMissionTransitionEvent {
  return Object.freeze({
    eventType: data.kind,
    missionRevisionBefore: before,
    missionRevisionAfter: after,
    data: Object.freeze({ ...data }),
    occurredAt,
  });
}

export class AgentMission {
  private constructor(private readonly snapshot: AgentMissionSnapshot) {
    Object.freeze(this);
  }

  static start(input: StartQuoteAgentMissionInput): AgentMissionResult<AgentMissionTransition> {
    if (!isPlainRecord(input)) return invalid('$', 'invalid_shape');
    const startOutcome = input['startOutcome'];
    if (!isOneOf(AGENT_MISSION_START_OUTCOMES, startOutcome)) {
      return invalid('startOutcome', 'invalid_value');
    }
    const shape = requireExactInput(
      input,
      startOutcome === 'draft_conflict'
        ? [
            'id',
            'companyId',
            'ownerUserId',
            'createdAt',
            'stagedCustomerResolution',
            'startOutcome',
            'existingDraft',
            'decision',
          ]
        : [
            'id',
            'companyId',
            'ownerUserId',
            'createdAt',
            'stagedCustomerResolution',
            'startOutcome',
            'draft',
          ],
    );
    if (!shape.ok) return shape;
    if (!isCanonicalUuid(input.id)) return invalid('id', 'invalid_uuid');
    if (!isCanonicalIdentifier(input.companyId)) return invalid('companyId', 'invalid_identifier');
    if (!isCanonicalIdentifier(input.ownerUserId)) return invalid('ownerUserId', 'invalid_identifier');
    const createdEpoch = instantEpoch(input.createdAt);
    if (createdEpoch === null) return invalid('createdAt', 'invalid_instant');
    const idle = futureInstant(createdEpoch, AGENT_MISSION_IDLE_TTL_MS);
    const hard = futureInstant(createdEpoch, AGENT_MISSION_HARD_TTL_MS);
    if (!idle.ok) return idle;
    if (!hard.ok) return hard;
    const retention = futureInstant(createdEpoch, AGENT_MISSION_HARD_TTL_MS + AGENT_MISSION_RETENTION_MS);
    if (!retention.ok) return retention;
    const stagedCustomerResolution = input.stagedCustomerResolution === null
      ? ok(null)
      : parseStagedCustomerResolution(input.stagedCustomerResolution);
    if (!stagedCustomerResolution.ok) return stagedCustomerResolution;

    let phase: QuoteCreationMissionPhase;
    let draft: QuoteMissionDraftReferenceV1 | null;
    let decision: QuoteMissionDecisionV1 | null;
    if (input.startOutcome === 'draft_conflict') {
      const existingDraft = parseDraft(input.existingDraft, 'existingDraft');
      if (!existingDraft.ok) return existingDraft;
      const createdDecision = createExistingDraftDecision(input.id, 1, existingDraft.value, input.decision);
      if (!createdDecision.ok) return createdDecision;
      phase = 'awaiting_draft_decision';
      draft = null;
      decision = createdDecision.value;
    } else {
      const validatedDraft = parseDraft(input.draft, 'draft');
      if (!validatedDraft.ok) return validatedDraft;
      if (
        input.startOutcome === 'no_slot'
        && (validatedDraft.value.slotRevision !== 1 || validatedDraft.value.contentRevision !== 0)
      ) {
        return invalid('draft', 'inconsistent_state');
      }
      phase = 'awaiting_quote_screen';
      draft = validatedDraft.value;
      decision = null;
    }

    const parsed = parseSnapshot({
      id: input.id,
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
      kind: AGENT_MISSION_KIND,
      status: 'active',
      phase,
      revision: 1,
      payloadVersion: AGENT_MISSION_PAYLOAD_VERSION,
      payload: {
        schema: AGENT_MISSION_PAYLOAD_SCHEMA,
        version: AGENT_MISSION_PAYLOAD_VERSION,
        draft,
        decision,
        stagedCustomerResolution: stagedCustomerResolution.value,
      },
      currentBinding: null,
      idleExpiresAt: idle.value,
      hardExpiresAt: hard.value,
      terminalAt: null,
      retentionExpiresAt: retention.value,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    if (!parsed.ok) return parsed;
    return ok(Object.freeze({
      mission: new AgentMission(parsed.value),
      event: transitionEvent(0, 1, {
        kind: 'mission_started',
        startOutcome: input.startOutcome,
      }, input.createdAt),
    }));
  }

  static rehydrate(snapshot: unknown): AgentMissionResult<AgentMission> {
    const parsed = parseSnapshot(snapshot);
    return parsed.ok ? ok(new AgentMission(parsed.value)) : parsed;
  }

  get id(): string {
    return this.snapshot.id;
  }

  get status(): AgentMissionStatus {
    return this.snapshot.status;
  }

  get phase(): QuoteCreationMissionPhase {
    return this.snapshot.phase;
  }

  get revision(): number {
    return this.snapshot.revision;
  }

  get payload(): QuoteCreationMissionPayloadV1 {
    return clonePayload(this.snapshot.payload);
  }

  get currentBinding(): AgentMissionContextBinding | null {
    return this.snapshot.currentBinding === null ? null : cloneBinding(this.snapshot.currentBinding);
  }

  toSnapshot(): AgentMissionSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  isExpiredAt(at: Instant): AgentMissionResult<boolean> {
    const epoch = instantEpoch(at);
    if (epoch === null) return invalid('at', 'invalid_instant');
    if (this.snapshot.status !== 'active') return ok(this.snapshot.status === 'expired');
    return ok(epoch >= Date.parse(this.snapshot.idleExpiresAt) || epoch >= Date.parse(this.snapshot.hardExpiresAt));
  }

  resumeExistingDraft(input: {
    readonly expectedRevision: number;
    readonly decisionId: string;
    readonly choiceSetRevision: number;
    readonly choiceId: string;
    readonly observedDraft: QuoteMissionDraftReferenceV1;
    readonly draftHasCustomer: boolean;
    readonly occurredAt: Instant;
  }): AgentMissionResult<AgentMissionTransition> {
    const shape = requireExactInput(input, [
      'expectedRevision',
      'decisionId',
      'choiceSetRevision',
      'choiceId',
      'observedDraft',
      'draftHasCustomer',
      'occurredAt',
    ]);
    if (!shape.ok) return shape;
    const ready = this.authorize('resume_existing_draft', input.expectedRevision, input.occurredAt, 'awaiting_draft_decision');
    if (!ready.ok) return ready;
    const decision = this.snapshot.payload.decision;
    if (decision?.kind !== 'existing_draft') return this.invalidTransition('resume_existing_draft');
    const choice = this.authorizeChoice(decision, input);
    if (!choice.ok) return choice;
    if (choice.value !== 'resume_existing') return err({ code: 'agent_mission_decision_conflict', reason: 'choice_id' });
    const draft = parseDraft(input.observedDraft, 'observedDraft');
    if (!draft.ok) return draft;
    if (
      draft.value.sessionId !== decision.expectedDraftSessionId
      || draft.value.slotRevision !== decision.expectedDraftSlotRevision
      || draft.value.contentRevision !== decision.expectedDraftContentRevision
    ) {
      return err({ code: 'agent_mission_decision_conflict', reason: 'draft_reference' });
    }
    if (typeof input.draftHasCustomer !== 'boolean') {
      return invalid('draftHasCustomer', 'invalid_value');
    }
    return this.activeTransition({
      occurredAt: input.occurredAt,
      phase: 'awaiting_quote_screen',
      draft: draft.value,
      decision: null,
      stagedCustomerResolution: input.draftHasCustomer
        ? null
        : this.snapshot.payload.stagedCustomerResolution,
      currentBinding: null,
      data: { kind: 'draft_resume_selected' },
    });
  }

  requestDraftDiscard(input: {
    readonly expectedRevision: number;
    readonly decisionId: string;
    readonly choiceSetRevision: number;
    readonly choiceId: string;
    readonly observedDraft: QuoteMissionDraftReferenceV1;
    readonly nextDecision: ConfirmDraftDiscardChoiceIds;
    readonly occurredAt: Instant;
  }): AgentMissionResult<AgentMissionTransition> {
    const shape = requireExactInput(input, [
      'expectedRevision',
      'decisionId',
      'choiceSetRevision',
      'choiceId',
      'observedDraft',
      'nextDecision',
      'occurredAt',
    ]);
    if (!shape.ok) return shape;
    const ready = this.authorize('request_draft_discard', input.expectedRevision, input.occurredAt, 'awaiting_draft_decision');
    if (!ready.ok) return ready;
    const decision = this.snapshot.payload.decision;
    if (decision?.kind !== 'existing_draft') return this.invalidTransition('request_draft_discard');
    const choice = this.authorizeChoice(decision, input);
    if (!choice.ok) return choice;
    if (choice.value !== 'request_discard') return err({ code: 'agent_mission_decision_conflict', reason: 'choice_id' });
    const draft = parseDraft(input.observedDraft, 'observedDraft');
    if (!draft.ok) return draft;
    if (
      draft.value.sessionId !== decision.expectedDraftSessionId
      || draft.value.slotRevision !== decision.expectedDraftSlotRevision
      || draft.value.contentRevision !== decision.expectedDraftContentRevision
    ) {
      return err({ code: 'agent_mission_decision_conflict', reason: 'draft_reference' });
    }
    const nextRevision = this.nextMissionRevision();
    if (!nextRevision.ok) return nextRevision;
    const confirmation = createConfirmDraftDiscardDecision(this.id, nextRevision.value, draft.value, input.nextDecision);
    if (!confirmation.ok) return confirmation;
    return this.activeTransition({
      occurredAt: input.occurredAt,
      phase: 'awaiting_draft_discard_confirmation',
      draft: null,
      decision: confirmation.value,
      stagedCustomerResolution: this.snapshot.payload.stagedCustomerResolution,
      currentBinding: null,
      data: { kind: 'draft_discard_requested' },
    });
  }

  keepExistingDraft(input: {
    readonly expectedRevision: number;
    readonly decisionId: string;
    readonly choiceSetRevision: number;
    readonly choiceId: string;
    readonly nextDecision: ExistingDraftChoiceIds;
    readonly occurredAt: Instant;
  }): AgentMissionResult<AgentMissionTransition> {
    const shape = requireExactInput(input, [
      'expectedRevision', 'decisionId', 'choiceSetRevision', 'choiceId', 'nextDecision', 'occurredAt',
    ]);
    if (!shape.ok) return shape;
    const ready = this.authorize('keep_existing_draft', input.expectedRevision, input.occurredAt, 'awaiting_draft_discard_confirmation');
    if (!ready.ok) return ready;
    const decision = this.snapshot.payload.decision;
    if (decision?.kind !== 'confirm_draft_discard') return this.invalidTransition('keep_existing_draft');
    const choice = this.authorizeChoice(decision, input);
    if (!choice.ok) return choice;
    if (choice.value !== 'keep_existing') return err({ code: 'agent_mission_decision_conflict', reason: 'choice_id' });
    const nextRevision = this.nextMissionRevision();
    if (!nextRevision.ok) return nextRevision;
    const expectedDraft = parseDraft({
      sessionId: decision.expectedDraftSessionId,
      slotRevision: decision.expectedDraftSlotRevision,
      contentRevision: decision.expectedDraftContentRevision,
    }, 'expectedDraft');
    if (!expectedDraft.ok) return expectedDraft;
    const nextDecision = createExistingDraftDecision(this.id, nextRevision.value, expectedDraft.value, input.nextDecision);
    if (!nextDecision.ok) return nextDecision;
    return this.activeTransition({
      occurredAt: input.occurredAt,
      phase: 'awaiting_draft_decision',
      draft: null,
      decision: nextDecision.value,
      stagedCustomerResolution: this.snapshot.payload.stagedCustomerResolution,
      currentBinding: null,
      data: { kind: 'draft_discard_cancelled' },
    });
  }

  confirmDraftDiscard(input: {
    readonly expectedRevision: number;
    readonly decisionId: string;
    readonly choiceSetRevision: number;
    readonly choiceId: string;
    readonly expectedDraft: QuoteMissionDraftReferenceV1;
    readonly replacementDraft: QuoteMissionDraftReferenceV1;
    readonly occurredAt: Instant;
  }): AgentMissionResult<AgentMissionTransition> {
    const shape = requireExactInput(input, [
      'expectedRevision',
      'decisionId',
      'choiceSetRevision',
      'choiceId',
      'expectedDraft',
      'replacementDraft',
      'occurredAt',
    ]);
    if (!shape.ok) return shape;
    const ready = this.authorize('confirm_draft_discard', input.expectedRevision, input.occurredAt, 'awaiting_draft_discard_confirmation');
    if (!ready.ok) return ready;
    const decision = this.snapshot.payload.decision;
    if (decision?.kind !== 'confirm_draft_discard') return this.invalidTransition('confirm_draft_discard');
    const choice = this.authorizeChoice(decision, input);
    if (!choice.ok) return choice;
    if (choice.value !== 'confirm_discard') return err({ code: 'agent_mission_decision_conflict', reason: 'choice_id' });
    const expected = parseDraft(input.expectedDraft, 'expectedDraft');
    if (!expected.ok) return expected;
    if (
      expected.value.sessionId !== decision.expectedDraftSessionId
      || expected.value.slotRevision !== decision.expectedDraftSlotRevision
      || expected.value.contentRevision !== decision.expectedDraftContentRevision
    ) {
      return err({ code: 'agent_mission_decision_conflict', reason: 'draft_reference' });
    }
    const replacement = parseDraft(input.replacementDraft, 'replacementDraft');
    if (!replacement.ok) return replacement;
    if (expected.value.slotRevision === AGENT_MISSION_INT4_MAX) {
      return err({ code: 'agent_mission_revision_overflow', field: 'draftSlotRevision' });
    }
    if (
      replacement.value.slotRevision !== expected.value.slotRevision + 1
      || replacement.value.contentRevision !== 0
    ) {
      return err({ code: 'agent_mission_decision_conflict', reason: 'draft_reference' });
    }
    return this.activeTransition({
      occurredAt: input.occurredAt,
      phase: 'awaiting_quote_screen',
      draft: replacement.value,
      decision: null,
      stagedCustomerResolution: this.snapshot.payload.stagedCustomerResolution,
      currentBinding: null,
      data: { kind: 'draft_discard_confirmed' },
    });
  }

  stageCustomerResolution(input: {
    readonly expectedRevision: number;
    readonly resolution: QuoteMissionStagedCustomerResolutionV1;
    readonly occurredAt: Instant;
  }): AgentMissionResult<AgentMissionTransition> {
    const shape = requireExactInput(input, ['expectedRevision', 'resolution', 'occurredAt']);
    if (!shape.ok) return shape;
    const ready = this.authorize(
      'stage_customer_resolution',
      input.expectedRevision,
      input.occurredAt,
    );
    if (!ready.ok) return ready;
    if (!CUSTOMER_RESOLUTION_STAGEABLE_PHASES.has(this.snapshot.phase)) {
      return this.invalidTransition('stage_customer_resolution');
    }
    const resolution = parseStagedCustomerResolution(input.resolution);
    if (!resolution.ok) return resolution;
    const observedCandidateCount = resolution.value.kind === 'none'
      ? 0
      : resolution.value.kind === 'too_many'
        ? 6
        : resolution.value.kind === 'exact'
          ? 1
          : resolution.value.candidates.length;
    return this.activeTransition({
      occurredAt: input.occurredAt,
      phase: this.snapshot.phase,
      draft: this.snapshot.payload.draft,
      decision: this.snapshot.payload.decision,
      stagedCustomerResolution: resolution.value,
      currentBinding: this.snapshot.currentBinding,
      data: {
        kind: 'customer_resolution_staged',
        result: resolution.value.kind,
        observedCandidateCount,
      },
    });
  }

  consumeStagedCustomerResolution(input:
    | {
        readonly expectedRevision: number;
        readonly outcome: 'not_found';
        readonly occurredAt: Instant;
      }
    | {
        readonly expectedRevision: number;
        readonly outcome: 'present_choices';
        readonly candidates: readonly {
          readonly choiceId: string;
          readonly customerId: string;
        }[];
        readonly occurredAt: Instant;
      }
    | {
        readonly expectedRevision: number;
        readonly outcome: 'select_exact';
        readonly customerId: string;
        readonly updatedDraft: QuoteMissionDraftReferenceV1;
        readonly occurredAt: Instant;
      }
  ): AgentMissionResult<AgentMissionTransition> {
    if (!isPlainRecord(input)) return invalid('$', 'invalid_shape');
    const shape = requireExactInput(
      input,
      input['outcome'] === 'present_choices'
        ? ['expectedRevision', 'outcome', 'candidates', 'occurredAt']
        : input['outcome'] === 'select_exact'
          ? ['expectedRevision', 'outcome', 'customerId', 'updatedDraft', 'occurredAt']
          : ['expectedRevision', 'outcome', 'occurredAt'],
    );
    if (!shape.ok) return shape;
    const ready = this.authorize(
      'consume_staged_customer_resolution',
      input.expectedRevision,
      input.occurredAt,
      'awaiting_customer',
    );
    if (!ready.ok) return ready;
    const staged = this.snapshot.payload.stagedCustomerResolution;
    if (staged === null) {
      return this.invalidTransition('consume_staged_customer_resolution');
    }

    if (input.outcome === 'not_found') {
      return this.activeTransition({
        occurredAt: input.occurredAt,
        phase: 'awaiting_customer',
        draft: this.requireDraft(),
        decision: null,
        stagedCustomerResolution: null,
        currentBinding: this.snapshot.currentBinding,
        data: {
          kind: 'customer_not_found',
          result: staged.kind === 'too_many' ? 'too_many' : 'none',
        },
      });
    }

    if (input.outcome === 'select_exact') {
      if (staged.kind !== 'exact') {
        return this.invalidTransition('consume_staged_customer_resolution');
      }
      if (!isCanonicalIdentifier(input.customerId)) {
        return invalid('customerId', 'invalid_identifier');
      }
      if (input.customerId !== staged.customerId) {
        return err({
          code: 'agent_mission_decision_conflict',
          reason: 'customer_reference',
        });
      }
      return this.transitionToSelectedCustomer({
        source: 'exact_match',
        customerId: staged.customerId,
        updatedDraft: input.updatedDraft,
        choiceId: null,
        choiceSetHash: null,
        occurredAt: input.occurredAt,
      });
    }

    if (input.outcome !== 'present_choices') return invalid('outcome', 'invalid_value');
    if (
      staged.kind !== 'choices'
      || !Array.isArray(input.candidates)
      || input.candidates.length < 1
      || input.candidates.length > staged.candidates.length
    ) {
      return this.invalidTransition('consume_staged_customer_resolution');
    }

    let previousStagedIndex = -1;
    const candidates: Array<{ readonly choiceId: string; readonly customerId: string }> = [];
    for (let index = 0; index < input.candidates.length; index += 1) {
      const candidate = input.candidates[index];
      if (
        !isPlainRecord(candidate)
        || !exactKeys(candidate, QUOTE_MISSION_CUSTOMER_CANDIDATE_KEYS)
        || !isCanonicalUuid(candidate['choiceId'])
        || !isCanonicalIdentifier(candidate['customerId'])
      ) {
        return invalid(`candidates[${index}]`, 'invalid_shape');
      }
      const stagedIndex = staged.candidates.findIndex(
        (stagedCandidate) => (
          stagedCandidate.choiceId === candidate['choiceId']
          && stagedCandidate.customerId === candidate['customerId']
        ),
      );
      if (stagedIndex <= previousStagedIndex) {
        return err({
          code: 'agent_mission_decision_conflict',
          reason: 'customer_reference',
        });
      }
      previousStagedIndex = stagedIndex;
      candidates.push({
        choiceId: candidate['choiceId'],
        customerId: candidate['customerId'],
      });
    }

    const nextRevision = this.nextMissionRevision();
    if (!nextRevision.ok) return nextRevision;
    const hash = computeQuoteMissionChoiceSetHash({
      missionId: this.id,
      choiceSetRevision: nextRevision.value,
      decisionId: staged.decisionId,
      choices: candidates,
    });
    if (!hash.ok) return hash;
    return this.activeTransition({
      occurredAt: input.occurredAt,
      phase: 'awaiting_customer_choice',
      draft: this.requireDraft(),
      decision: cloneDecision({
        kind: 'customer',
        decisionId: staged.decisionId,
        choiceSetRevision: nextRevision.value,
        candidates,
        choiceSetHash: hash.value,
      }),
      stagedCustomerResolution: null,
      currentBinding: this.snapshot.currentBinding,
      data: {
        kind: 'customer_choice_presented',
        candidateCount: candidates.length,
        choiceSetHash: hash.value,
      },
    });
  }

  acknowledgeQuoteScreen(input: {
    readonly expectedRevision: number;
    readonly binding: AgentMissionContextBinding;
    readonly observedDraft: QuoteMissionDraftReferenceV1;
    readonly draftHasCustomer: boolean;
    readonly occurredAt: Instant;
  }): AgentMissionResult<AgentMissionTransition> {
    const shape = requireExactInput(input, [
      'expectedRevision', 'binding', 'observedDraft', 'draftHasCustomer', 'occurredAt',
    ]);
    if (!shape.ok) return shape;
    const ready = this.authorize('acknowledge_quote_screen', input.expectedRevision, input.occurredAt);
    if (!ready.ok) return ready;
    if (!ACKNOWLEDGEABLE_PHASES.has(this.snapshot.phase)) {
      return this.invalidTransition('acknowledge_quote_screen');
    }
    if (typeof input.draftHasCustomer !== 'boolean') return invalid('draftHasCustomer', 'invalid_value');
    const draft = parseDraft(input.observedDraft, 'observedDraft');
    if (!draft.ok) return draft;
    const ownedDraft = this.snapshot.payload.draft;
    if (ownedDraft === null || !sameDraft(ownedDraft, draft.value)) {
      return err({ code: 'agent_mission_decision_conflict', reason: 'draft_reference' });
    }
    const binding = parseBinding(input.binding);
    if (!binding.ok) return binding;
    if (binding.value.acknowledgedAt !== input.occurredAt) {
      return invalid('binding.acknowledgedAt', 'inconsistent_state');
    }
    let nextPhase: 'awaiting_customer' | 'awaiting_customer_choice' | 'awaiting_lines';
    if (this.snapshot.phase === 'awaiting_quote_screen') {
      nextPhase = input.draftHasCustomer ? 'awaiting_lines' : 'awaiting_customer';
    } else if (
      this.snapshot.phase === 'awaiting_customer'
      || this.snapshot.phase === 'awaiting_customer_choice'
      || this.snapshot.phase === 'awaiting_lines'
    ) {
      const expectsCustomer = this.snapshot.phase === 'awaiting_lines';
      if (input.draftHasCustomer !== expectsCustomer) {
        return err({ code: 'agent_mission_decision_conflict', reason: 'draft_reference' });
      }
      nextPhase = this.snapshot.phase;
    } else {
      return this.invalidTransition('acknowledge_quote_screen');
    }
    return this.activeTransition({
      occurredAt: input.occurredAt,
      phase: nextPhase,
      draft: draft.value,
      decision: nextPhase === 'awaiting_customer_choice' ? this.snapshot.payload.decision : null,
      stagedCustomerResolution: input.draftHasCustomer
        ? null
        : this.snapshot.payload.stagedCustomerResolution,
      currentBinding: binding.value,
      data: { kind: 'screen_acknowledged', nextPhase },
    });
  }

  recordCustomerNotFound(input: {
    readonly expectedRevision: number;
    readonly result: 'none' | 'too_many';
    readonly occurredAt: Instant;
  }): AgentMissionResult<AgentMissionTransition> {
    const shape = requireExactInput(input, ['expectedRevision', 'result', 'occurredAt']);
    if (!shape.ok) return shape;
    const ready = this.authorize('customer_not_found', input.expectedRevision, input.occurredAt, 'awaiting_customer');
    if (!ready.ok) return ready;
    if (!(['none', 'too_many'] as const).includes(input.result)) return invalid('result', 'invalid_value');
    if (this.snapshot.payload.stagedCustomerResolution !== null) {
      return this.invalidTransition('customer_not_found');
    }
    return this.activeTransition({
      occurredAt: input.occurredAt,
      phase: 'awaiting_customer',
      draft: this.requireDraft(),
      decision: null,
      stagedCustomerResolution: null,
      currentBinding: this.snapshot.currentBinding,
      data: { kind: 'customer_not_found', result: input.result },
    });
  }

  presentCustomerChoices(input: {
    readonly expectedRevision: number;
    readonly decisionId: string;
    readonly candidates: readonly {
      readonly choiceId: string;
      readonly customerId: string;
    }[];
    readonly occurredAt: Instant;
  }): AgentMissionResult<AgentMissionTransition> {
    const shape = requireExactInput(input, ['expectedRevision', 'decisionId', 'candidates', 'occurredAt']);
    if (!shape.ok) return shape;
    const ready = this.authorize('present_customer_choices', input.expectedRevision, input.occurredAt, 'awaiting_customer');
    if (!ready.ok) return ready;
    if (this.snapshot.payload.stagedCustomerResolution !== null) {
      return this.invalidTransition('present_customer_choices');
    }
    const nextRevision = this.nextMissionRevision();
    if (!nextRevision.ok) return nextRevision;
    const hash = computeQuoteMissionChoiceSetHash({
      missionId: this.id,
      choiceSetRevision: nextRevision.value,
      decisionId: input.decisionId,
      choices: input.candidates,
    });
    if (!hash.ok) return hash;
    const customerIds = new Set(input.candidates.map((candidate) => candidate.customerId));
    if (customerIds.size !== input.candidates.length) return invalid('candidates', 'invalid_value');
    const decision = cloneDecision({
      kind: 'customer',
      decisionId: input.decisionId,
      choiceSetRevision: nextRevision.value,
      candidates: input.candidates.map((candidate) => ({ ...candidate })),
      choiceSetHash: hash.value,
    });
    return this.activeTransition({
      occurredAt: input.occurredAt,
      phase: 'awaiting_customer_choice',
      draft: this.requireDraft(),
      decision,
      stagedCustomerResolution: null,
      currentBinding: this.snapshot.currentBinding,
      data: {
        kind: 'customer_choice_presented',
        candidateCount: input.candidates.length,
        choiceSetHash: hash.value,
      },
    });
  }

  invalidateCustomerDecision(input: {
    readonly expectedRevision: number;
    readonly reason: 'candidate_unavailable' | 'choice_set_stale';
    readonly occurredAt: Instant;
  }): AgentMissionResult<AgentMissionTransition> {
    const shape = requireExactInput(input, ['expectedRevision', 'reason', 'occurredAt']);
    if (!shape.ok) return shape;
    const ready = this.authorize('invalidate_customer_decision', input.expectedRevision, input.occurredAt, 'awaiting_customer_choice');
    if (!ready.ok) return ready;
    if (!(['candidate_unavailable', 'choice_set_stale'] as const).includes(input.reason)) {
      return invalid('reason', 'invalid_value');
    }
    return this.activeTransition({
      occurredAt: input.occurredAt,
      phase: 'awaiting_customer',
      draft: this.requireDraft(),
      decision: null,
      stagedCustomerResolution: null,
      currentBinding: this.snapshot.currentBinding,
      data: { kind: 'decision_invalidated', reason: input.reason },
    });
  }

  selectCustomer(input: {
    readonly expectedRevision: number;
    readonly source: 'exact_match' | 'screen_selection' | 'presented_choice';
    readonly customerId: string;
    readonly updatedDraft: QuoteMissionDraftReferenceV1;
    readonly decisionId?: string;
    readonly choiceSetRevision?: number;
    readonly choiceId?: string;
    readonly occurredAt: Instant;
  }): AgentMissionResult<AgentMissionTransition> {
    if (!isPlainRecord(input)) return invalid('$', 'invalid_shape');
    const source = input['source'];
    const shape = requireExactInput(
      input,
      source === 'presented_choice'
        ? [
            'expectedRevision',
            'source',
            'customerId',
            'updatedDraft',
            'decisionId',
            'choiceSetRevision',
            'choiceId',
            'occurredAt',
          ]
        : ['expectedRevision', 'source', 'customerId', 'updatedDraft', 'occurredAt'],
    );
    if (!shape.ok) return shape;
    if (!(['exact_match', 'screen_selection', 'presented_choice'] as const).includes(input.source)) {
      return invalid('source', 'invalid_value');
    }
    const requiredPhase = input.source === 'presented_choice' ? 'awaiting_customer_choice' : 'awaiting_customer';
    const ready = this.authorize('select_customer', input.expectedRevision, input.occurredAt, requiredPhase);
    if (!ready.ok) return ready;
    if (!isCanonicalIdentifier(input.customerId)) return invalid('customerId', 'invalid_identifier');
    if (
      input.source === 'exact_match'
      && this.snapshot.payload.stagedCustomerResolution !== null
    ) {
      return this.invalidTransition('select_customer');
    }

    let choiceId: string | null = null;
    let choiceSetHash: string | null = null;
    if (input.source === 'presented_choice') {
      const decision = this.snapshot.payload.decision;
      if (decision?.kind !== 'customer') return this.invalidTransition('select_customer');
      if (input.decisionId !== decision.decisionId) {
        return err({ code: 'agent_mission_decision_conflict', reason: 'decision_id' });
      }
      if (input.choiceSetRevision !== decision.choiceSetRevision) {
        return err({ code: 'agent_mission_decision_conflict', reason: 'choice_set_revision' });
      }
      const candidate = decision.candidates.find((item) => item.choiceId === input.choiceId);
      if (candidate === undefined) return err({ code: 'agent_mission_decision_conflict', reason: 'choice_id' });
      if (candidate.customerId !== input.customerId) {
        return err({ code: 'agent_mission_decision_conflict', reason: 'customer_reference' });
      }
      choiceId = candidate.choiceId;
      choiceSetHash = decision.choiceSetHash;
    } else if (
      input.decisionId !== undefined
      || input.choiceSetRevision !== undefined
      || input.choiceId !== undefined
    ) {
      return invalid('choice', 'inconsistent_state');
    }

    return this.transitionToSelectedCustomer({
      source: input.source,
      customerId: input.customerId,
      updatedDraft: input.updatedDraft,
      choiceId,
      choiceSetHash,
      occurredAt: input.occurredAt,
    });
  }

  joinActive(input: {
    readonly expectedRevision: number;
    readonly stagedCustomerResolution: QuoteMissionStagedCustomerResolutionV1 | null;
    readonly occurredAt: Instant;
  }): AgentMissionResult<AgentMissionTransition> {
    const shape = requireExactInput(
      input,
      ['expectedRevision', 'stagedCustomerResolution', 'occurredAt'],
    );
    if (!shape.ok) return shape;
    const ready = this.authorize('join_active', input.expectedRevision, input.occurredAt);
    if (!ready.ok) return ready;
    let stagedCustomerResolution = this.snapshot.payload.stagedCustomerResolution;
    if (input.stagedCustomerResolution !== null) {
      if (!CUSTOMER_RESOLUTION_STAGEABLE_PHASES.has(this.snapshot.phase)) {
        return this.invalidTransition('join_active');
      }
      const parsedResolution = parseStagedCustomerResolution(input.stagedCustomerResolution);
      if (!parsedResolution.ok) return parsedResolution;
      stagedCustomerResolution = parsedResolution.value;
    }
    return this.activeTransition({
      occurredAt: input.occurredAt,
      phase: this.snapshot.phase,
      draft: this.snapshot.payload.draft,
      decision: this.snapshot.payload.decision,
      stagedCustomerResolution,
      currentBinding: this.snapshot.currentBinding,
      data: { kind: 'mission_joined' },
    });
  }

  cancel(input: {
    readonly expectedRevision: number;
    readonly reason: 'user_cancelled' | 'manual_handoff';
    readonly occurredAt: Instant;
  }): AgentMissionResult<AgentMissionTransition> {
    const shape = requireExactInput(input, ['expectedRevision', 'reason', 'occurredAt']);
    if (!shape.ok) return shape;
    const ready = this.authorize('cancel', input.expectedRevision, input.occurredAt);
    if (!ready.ok) return ready;
    if (!(['user_cancelled', 'manual_handoff'] as const).includes(input.reason)) {
      return invalid('reason', 'invalid_value');
    }
    return this.terminalTransition('cancelled', input.occurredAt, {
      kind: 'mission_cancelled',
      reason: input.reason,
    });
  }

  expire(input: {
    readonly expectedRevision: number;
    readonly occurredAt: Instant;
  }): AgentMissionResult<AgentMissionTransition> {
    const shape = requireExactInput(input, ['expectedRevision', 'occurredAt']);
    if (!shape.ok) return shape;
    if (this.snapshot.status !== 'active') {
      return err({ code: 'agent_mission_terminal', status: this.snapshot.status });
    }
    if (!isRevision(input.expectedRevision, false)) return invalid('expectedRevision', 'invalid_revision');
    if (input.expectedRevision !== this.snapshot.revision) {
      return err({
        code: 'agent_mission_revision_conflict',
        expectedRevision: input.expectedRevision,
        actualRevision: this.snapshot.revision,
      });
    }
    const epoch = instantEpoch(input.occurredAt);
    if (epoch === null) return invalid('occurredAt', 'invalid_instant');
    if (epoch < Date.parse(this.snapshot.updatedAt)) return err({ code: 'agent_mission_clock_regression' });
    const hardExpiresAt = Date.parse(this.snapshot.hardExpiresAt);
    const idleExpiresAt = Date.parse(this.snapshot.idleExpiresAt);
    const hardIsEffectiveDeadline = hardExpiresAt <= idleExpiresAt;
    const effectiveExpiresAt = hardIsEffectiveDeadline ? hardExpiresAt : idleExpiresAt;
    if (epoch < effectiveExpiresAt) return this.invalidTransition('expire');
    return this.terminalTransition('expired', input.occurredAt, {
      kind: 'mission_expired',
      reason: hardIsEffectiveDeadline ? 'hard_ttl' : 'idle_ttl',
    });
  }

  private authorize(
    action: AgentMissionAction,
    expectedRevision: number,
    occurredAt: Instant,
    requiredPhase?: QuoteCreationMissionPhase,
  ): AgentMissionResult<void> {
    if (this.snapshot.status !== 'active') {
      return err({ code: 'agent_mission_terminal', status: this.snapshot.status });
    }
    if (!isRevision(expectedRevision, false)) return invalid('expectedRevision', 'invalid_revision');
    if (expectedRevision !== this.snapshot.revision) {
      return err({
        code: 'agent_mission_revision_conflict',
        expectedRevision,
        actualRevision: this.snapshot.revision,
      });
    }
    if (requiredPhase !== undefined && this.snapshot.phase !== requiredPhase) {
      return this.invalidTransition(action);
    }
    const epoch = instantEpoch(occurredAt);
    if (epoch === null) return invalid('occurredAt', 'invalid_instant');
    if (epoch < Date.parse(this.snapshot.updatedAt)) return err({ code: 'agent_mission_clock_regression' });
    if (epoch >= Date.parse(this.snapshot.idleExpiresAt) || epoch >= Date.parse(this.snapshot.hardExpiresAt)) {
      return err({ code: 'agent_mission_expired' });
    }
    return ok(undefined);
  }

  private authorizeChoice(
    decision: ExistingDraftDecisionV1 | ConfirmDraftDiscardDecisionV1,
    input: {
      readonly decisionId: string;
      readonly choiceSetRevision: number;
      readonly choiceId: string;
    },
  ): AgentMissionResult<string> {
    if (!isCanonicalUuid(input.decisionId)) return invalid('decisionId', 'invalid_uuid');
    if (!isRevision(input.choiceSetRevision, false)) return invalid('choiceSetRevision', 'invalid_revision');
    if (!isCanonicalUuid(input.choiceId)) return invalid('choiceId', 'invalid_uuid');
    if (input.decisionId !== decision.decisionId) {
      return err({ code: 'agent_mission_decision_conflict', reason: 'decision_id' });
    }
    if (input.choiceSetRevision !== decision.choiceSetRevision) {
      return err({ code: 'agent_mission_decision_conflict', reason: 'choice_set_revision' });
    }
    const choice = decision.choices.find((candidate) => candidate.choiceId === input.choiceId);
    return choice === undefined
      ? err({ code: 'agent_mission_decision_conflict', reason: 'choice_id' })
      : ok(choice.action);
  }

  private invalidTransition(action: AgentMissionAction): AgentMissionResult<never> {
    return err({ code: 'agent_mission_invalid_transition', phase: this.snapshot.phase, action });
  }

  private requireDraft(): QuoteMissionDraftReferenceV1 {
    const draft = this.snapshot.payload.draft;
    if (draft === null) throw new Error('AGENT_MISSION_INTERNAL_DRAFT_INVARIANT');
    return draft;
  }

  private nextMissionRevision(): AgentMissionResult<number> {
    return this.snapshot.revision === AGENT_MISSION_INT4_MAX
      ? err({ code: 'agent_mission_revision_overflow', field: 'missionRevision' })
      : ok(this.snapshot.revision + 1);
  }

  private transitionToSelectedCustomer(input: {
    readonly source: 'exact_match' | 'screen_selection' | 'presented_choice';
    readonly customerId: string;
    readonly updatedDraft: QuoteMissionDraftReferenceV1;
    readonly choiceId: string | null;
    readonly choiceSetHash: string | null;
    readonly occurredAt: Instant;
  }): AgentMissionResult<AgentMissionTransition> {
    const previousDraft = this.requireDraft();
    const updatedDraft = parseDraft(input.updatedDraft, 'updatedDraft');
    if (!updatedDraft.ok) return updatedDraft;
    if (previousDraft.slotRevision === AGENT_MISSION_INT4_MAX) {
      return err({ code: 'agent_mission_revision_overflow', field: 'draftSlotRevision' });
    }
    if (previousDraft.contentRevision === AGENT_MISSION_INT4_MAX) {
      return err({ code: 'agent_mission_revision_overflow', field: 'draftContentRevision' });
    }
    if (
      updatedDraft.value.sessionId !== previousDraft.sessionId
      || updatedDraft.value.slotRevision !== previousDraft.slotRevision + 1
      || updatedDraft.value.contentRevision !== previousDraft.contentRevision + 1
    ) {
      return err({ code: 'agent_mission_decision_conflict', reason: 'draft_reference' });
    }

    return this.activeTransition({
      occurredAt: input.occurredAt,
      phase: 'awaiting_lines',
      draft: updatedDraft.value,
      decision: null,
      stagedCustomerResolution: null,
      currentBinding: this.snapshot.currentBinding,
      data: {
        kind: 'customer_selected',
        customerId: input.customerId,
        source: input.source,
        choiceId: input.choiceId,
        choiceSetHash: input.choiceSetHash,
      },
    });
  }

  private activeTransition(input: {
    readonly occurredAt: Instant;
    readonly phase: QuoteCreationMissionPhase;
    readonly draft: QuoteMissionDraftReferenceV1 | null;
    readonly decision: QuoteMissionDecisionV1 | null;
    readonly stagedCustomerResolution: QuoteMissionStagedCustomerResolutionV1 | null;
    readonly currentBinding: AgentMissionContextBinding | null;
    readonly data: AgentMissionEventDataV1;
  }): AgentMissionResult<AgentMissionTransition> {
    const occurredEpoch = Date.parse(input.occurredAt);
    const hardEpoch = Date.parse(this.snapshot.hardExpiresAt);
    const idleExpiresAt = instantFromEpoch(Math.min(occurredEpoch + AGENT_MISSION_IDLE_TTL_MS, hardEpoch));
    const revision = this.nextMissionRevision();
    if (!revision.ok) return revision;
    const parsed = parseSnapshot({
      ...this.snapshot,
      phase: input.phase,
      revision: revision.value,
      payload: {
        schema: AGENT_MISSION_PAYLOAD_SCHEMA,
        version: AGENT_MISSION_PAYLOAD_VERSION,
        draft: input.draft,
        decision: input.decision,
        stagedCustomerResolution: input.stagedCustomerResolution,
      },
      currentBinding: input.currentBinding,
      idleExpiresAt,
      updatedAt: input.occurredAt,
    });
    if (!parsed.ok) return parsed;
    return ok(Object.freeze({
      mission: new AgentMission(parsed.value),
      event: transitionEvent(this.snapshot.revision, revision.value, input.data, input.occurredAt),
    }));
  }

  private terminalTransition(
    status: 'cancelled' | 'expired',
    occurredAt: Instant,
    data: AgentMissionEventDataV1,
  ): AgentMissionResult<AgentMissionTransition> {
    const retention = futureInstant(Date.parse(occurredAt), AGENT_MISSION_RETENTION_MS);
    if (!retention.ok) return retention;
    const revision = this.nextMissionRevision();
    if (!revision.ok) return revision;
    const parsed = parseSnapshot({
      ...this.snapshot,
      status,
      revision: revision.value,
      terminalAt: occurredAt,
      retentionExpiresAt: retention.value,
      updatedAt: occurredAt,
    });
    if (!parsed.ok) return parsed;
    return ok(Object.freeze({
      mission: new AgentMission(parsed.value),
      event: transitionEvent(this.snapshot.revision, revision.value, data, occurredAt),
    }));
  }
}
