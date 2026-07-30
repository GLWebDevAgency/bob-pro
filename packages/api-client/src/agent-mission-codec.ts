import {
  AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS,
  normalizeCustomerName,
  AGENT_MISSION_PROTOCOL_M2A,
  AGENT_MISSION_PROTOCOL_V1,
  AGENT_MISSION_HARD_TTL_MS,
  AGENT_MISSION_RETENTION_MS,
  AgentMission,
  computeQuoteMissionCatalogueChoiceSetHash,
  computeQuoteMissionLineConfirmationChoiceSetHash,
  isCatalogueCategory,
  isCanonicalAgentMissionDraftSessionId,
  isCanonicalAgentMissionUuid,
  isVatRate,
  parseCustomPrestation,
  parseQuoteDraftPayload,
  type AcknowledgeQuoteScreenOutput,
  type AgentMissionProtocolVersion,
  type AgentMissionViewV1,
  type CancelQuoteAgentMissionOutput,
  type CustomerMissionChoiceView,
  type DecideQuoteAgentMissionOutput,
  type LineConfirmationDecisionV1,
  type QuoteAgentMissionCatalogueChoicePresentationV1,
  type QuoteAgentMissionCatalogueDecisionPresentationV1,
  type QuoteAgentMissionPresentationDecisionV1,
  type QuoteAgentMissionPresentationV1,
  type QuoteAgentMissionResumeView,
  type QuoteAgentMissionResumeViewV2,
  type QuoteCreationMissionPhase,
  type QuoteDraftPayloadLine,
  type StartQuoteAgentMissionOutput,
} from '@bob/core';
import type {
  RealtimeAgentMissionAcknowledgeQuoteScreenOutputV2,
  RealtimeAgentMissionCatalogueChoiceOutput,
  RealtimeAgentMissionLineContinuation,
  RealtimeAgentMissionLineProposalDecisionOutput,
  RealtimeAgentMissionPatchQuoteLineOutput,
  RealtimeAgentMissionQuoteDecisionOutputV2,
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
const RESUME_V1_PHASES = [
  'awaiting_draft_decision',
  'awaiting_draft_discard_confirmation',
  'awaiting_quote_screen',
  'awaiting_customer',
  'awaiting_customer_choice',
  'awaiting_lines',
] as const satisfies readonly QuoteCreationMissionPhase[];
const RESUME_V2_PHASES = [
  ...RESUME_V1_PHASES,
  'awaiting_catalogue_choice',
  'awaiting_line_details',
  'awaiting_line_confirmation',
] as const satisfies readonly QuoteCreationMissionPhase[];

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

function decodeQuoteAgentMissionResumeForPhases(
  value: unknown,
  phases: readonly QuoteCreationMissionPhase[],
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
    || !phases.includes(mission.phase as QuoteCreationMissionPhase)
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
      phase: mission.phase as QuoteCreationMissionPhase,
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

export function decodeQuoteAgentMissionResume(
  value: unknown,
): QuoteAgentMissionResumeView | null {
  return decodeQuoteAgentMissionResumeForPhases(value, RESUME_V1_PHASES);
}

const PRESENTATION_KEYS = [
  'schema',
  'version',
  'requiredFact',
  'pendingLine',
  'decision',
  'catalogueChoices',
  'freeLineChoiceId',
  'proposalStatus',
  'proposal',
] as const;
const CATALOGUE_DECISION_KEYS = [
  'kind',
  'decisionId',
  'choiceSetRevision',
  'pendingLineId',
  'expectedDraft',
  'expectedWorkRevision',
  'choices',
  'freeLineChoiceId',
  'choiceSetHash',
] as const;
const CATALOGUE_DECISION_CHOICE_KEYS = [
  'choiceId',
  'catalogueItemId',
  'expectedCatalogueRevision',
] as const;
const LINE_CONFIRMATION_DECISION_KEYS = [
  'kind',
  'decisionId',
  'choiceSetRevision',
  'pendingLineId',
  'proposalId',
  'proposalRevision',
  'expectedDraft',
  'expectedWorkRevision',
  'expectedCatalogue',
  'expectedVatContextDigest',
  'diffHash',
  'choices',
  'choiceSetHash',
] as const;
const LINE_CONFIRMATION_CHOICE_KEYS = ['choiceId', 'action'] as const;
const CATALOGUE_CHOICE_PRESENTATION_KEYS = [
  'choiceId',
  'available',
  'label',
  'category',
  'unit',
  'unitPriceCents',
  'vatRate',
] as const;
const PROPOSAL_KEYS = ['proposalId', 'diffHash', 'line', 'catalogue'] as const;
const PROPOSAL_CATALOGUE_KEYS = ['itemId', 'revision', 'label'] as const;

function sameDraftReference(
  left: {
    readonly sessionId: string;
    readonly slotRevision: number;
    readonly contentRevision: number;
  },
  right: {
    readonly sessionId: string;
    readonly slotRevision: number;
    readonly contentRevision: number;
  },
): boolean {
  return left.sessionId === right.sessionId
    && left.slotRevision === right.slotRevision
    && left.contentRevision === right.contentRevision;
}

function decodeCatalogueDecisionPresentation(
  value: unknown,
  missionId: string,
  missionRevision: number,
): QuoteAgentMissionCatalogueDecisionPresentationV1 | null {
  const decision = record(value);
  if (
    decision === null
    || !exactKeys(decision, CATALOGUE_DECISION_KEYS)
    || decision.kind !== 'catalogue'
    || !isCanonicalAgentMissionUuid(decision.decisionId)
    || !positiveRevision(decision.choiceSetRevision)
    || (decision.choiceSetRevision as number) > missionRevision
    || !isCanonicalAgentMissionUuid(decision.pendingLineId)
    || !positiveRevision(decision.expectedWorkRevision)
    || !isCanonicalAgentMissionUuid(decision.freeLineChoiceId)
    || typeof decision.choiceSetHash !== 'string'
    || !SHA256.test(decision.choiceSetHash)
    || !Array.isArray(decision.choices)
    || decision.choices.length < 1
    || decision.choices.length > 5
  ) {
    return null;
  }
  const expectedDraft = resumeDraftReference(decision.expectedDraft, false);
  if (expectedDraft === null) return null;
  const choices: Array<{
    readonly choiceId: string;
    readonly catalogueItemId: string;
    readonly expectedCatalogueRevision: number;
  }> = [];
  for (const value of decision.choices) {
    const choice = record(value);
    if (
      choice === null
      || !exactKeys(choice, CATALOGUE_DECISION_CHOICE_KEYS)
      || !isCanonicalAgentMissionUuid(choice.choiceId)
      || typeof choice.catalogueItemId !== 'string'
      || !positiveRevision(choice.expectedCatalogueRevision)
    ) {
      return null;
    }
    choices.push(Object.freeze({
      choiceId: choice.choiceId,
      catalogueItemId: choice.catalogueItemId,
      expectedCatalogueRevision: choice.expectedCatalogueRevision,
    }));
  }
  const computed = computeQuoteMissionCatalogueChoiceSetHash({
    missionId,
    choiceSetRevision: decision.choiceSetRevision,
    decisionId: decision.decisionId,
    pendingLineId: decision.pendingLineId,
    expectedDraft,
    expectedWorkRevision: decision.expectedWorkRevision,
    candidates: choices,
    freeLineChoiceId: decision.freeLineChoiceId,
  });
  if (!computed.ok || computed.value !== decision.choiceSetHash) return null;
  return Object.freeze({
    kind: 'catalogue',
    decisionId: decision.decisionId,
    choiceSetRevision: decision.choiceSetRevision,
    pendingLineId: decision.pendingLineId,
    expectedDraft: Object.freeze({ ...expectedDraft }),
    expectedWorkRevision: decision.expectedWorkRevision,
    choices: Object.freeze(choices),
    freeLineChoiceId: decision.freeLineChoiceId,
    choiceSetHash: decision.choiceSetHash,
  });
}

function decodeLineConfirmationDecisionPresentation(
  value: unknown,
  missionId: string,
  missionRevision: number,
): LineConfirmationDecisionV1 | null {
  const decision = record(value);
  if (
    decision === null
    || !exactKeys(decision, LINE_CONFIRMATION_DECISION_KEYS)
    || decision.kind !== 'line_confirmation'
    || !isCanonicalAgentMissionUuid(decision.decisionId)
    || !positiveRevision(decision.choiceSetRevision)
    || (decision.choiceSetRevision as number) > missionRevision
    || !isCanonicalAgentMissionUuid(decision.pendingLineId)
    || !isCanonicalAgentMissionUuid(decision.proposalId)
    || decision.proposalRevision !== 1
    || !positiveRevision(decision.expectedWorkRevision)
    || typeof decision.expectedVatContextDigest !== 'string'
    || !SHA256.test(decision.expectedVatContextDigest)
    || typeof decision.diffHash !== 'string'
    || !SHA256.test(decision.diffHash)
    || typeof decision.choiceSetHash !== 'string'
    || !SHA256.test(decision.choiceSetHash)
    || !Array.isArray(decision.choices)
    || decision.choices.length !== 3
  ) {
    return null;
  }
  const expectedDraft = resumeDraftReference(decision.expectedDraft, false);
  if (expectedDraft === null) return null;
  const expectedCatalogueRecord = decision.expectedCatalogue === null
    ? null
    : record(decision.expectedCatalogue);
  if (
    decision.expectedCatalogue !== null
    && (
      expectedCatalogueRecord === null
      || !exactKeys(expectedCatalogueRecord, ['itemId', 'revision'])
      || typeof expectedCatalogueRecord.itemId !== 'string'
      || !positiveRevision(expectedCatalogueRecord.revision)
    )
  ) {
    return null;
  }
  const expectedActions = [
    'confirm_line',
    'edit_line',
    'cancel_line',
  ] as const;
  const decodedChoiceIds: string[] = [];
  for (let index = 0; index < expectedActions.length; index += 1) {
    const choice = record(decision.choices[index]);
    if (
      choice === null
      || !exactKeys(choice, LINE_CONFIRMATION_CHOICE_KEYS)
      || !isCanonicalAgentMissionUuid(choice.choiceId)
      || choice.action !== expectedActions[index]
    ) {
      return null;
    }
    decodedChoiceIds.push(choice.choiceId);
  }
  const choices = Object.freeze([
    Object.freeze({
      choiceId: decodedChoiceIds[0]!,
      action: 'confirm_line' as const,
    }),
    Object.freeze({
      choiceId: decodedChoiceIds[1]!,
      action: 'edit_line' as const,
    }),
    Object.freeze({
      choiceId: decodedChoiceIds[2]!,
      action: 'cancel_line' as const,
    }),
  ]) satisfies LineConfirmationDecisionV1['choices'];
  const expectedCatalogue = expectedCatalogueRecord === null
    ? null
    : Object.freeze({
        itemId: expectedCatalogueRecord.itemId as string,
        revision: expectedCatalogueRecord.revision as number,
      });
  const computed = computeQuoteMissionLineConfirmationChoiceSetHash({
    missionId,
    choiceSetRevision: decision.choiceSetRevision,
    decisionId: decision.decisionId,
    pendingLineId: decision.pendingLineId,
    proposalId: decision.proposalId,
    proposalRevision: 1,
    expectedDraft,
    expectedWorkRevision: decision.expectedWorkRevision,
    expectedCatalogue,
    expectedVatContextDigest: decision.expectedVatContextDigest,
    diffHash: decision.diffHash,
    choices,
  });
  if (!computed.ok || computed.value !== decision.choiceSetHash) return null;
  return Object.freeze({
    kind: 'line_confirmation',
    decisionId: decision.decisionId,
    choiceSetRevision: decision.choiceSetRevision,
    pendingLineId: decision.pendingLineId,
    proposalId: decision.proposalId,
    proposalRevision: 1,
    expectedDraft: Object.freeze({ ...expectedDraft }),
    expectedWorkRevision: decision.expectedWorkRevision,
    expectedCatalogue,
    expectedVatContextDigest: decision.expectedVatContextDigest,
    diffHash: decision.diffHash,
    choices,
    choiceSetHash: decision.choiceSetHash,
  });
}

function decodePresentationDecision(
  value: unknown,
  missionId: string,
  missionRevision: number,
): QuoteAgentMissionPresentationDecisionV1 | undefined {
  if (value === null) return null;
  const decision = record(value);
  if (decision?.kind === 'catalogue') {
    return decodeCatalogueDecisionPresentation(
      decision,
      missionId,
      missionRevision,
    ) ?? undefined;
  }
  if (decision?.kind === 'line_confirmation') {
    return decodeLineConfirmationDecisionPresentation(
      decision,
      missionId,
      missionRevision,
    ) ?? undefined;
  }
  return undefined;
}

function decodeCatalogueChoicesPresentation(
  value: unknown,
  decision: QuoteAgentMissionPresentationDecisionV1,
): readonly QuoteAgentMissionCatalogueChoicePresentationV1[] | null {
  if (!Array.isArray(value)) return null;
  if (decision?.kind !== 'catalogue') {
    return value.length === 0 ? Object.freeze([]) : null;
  }
  if (value.length !== decision.choices.length) return null;
  const decoded: QuoteAgentMissionCatalogueChoicePresentationV1[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const choice = record(value[index]);
    const fence = decision.choices[index];
    if (
      choice === null
      || fence === undefined
      || !exactKeys(choice, CATALOGUE_CHOICE_PRESENTATION_KEYS)
      || choice.choiceId !== fence.choiceId
      || typeof choice.available !== 'boolean'
    ) {
      return null;
    }
    if (!choice.available) {
      if (
        choice.label !== null
        || choice.category !== null
        || choice.unit !== null
        || choice.unitPriceCents !== null
        || choice.vatRate !== null
      ) {
        return null;
      }
      decoded.push(Object.freeze({
        choiceId: fence.choiceId,
        available: false,
        label: null,
        category: null,
        unit: null,
        unitPriceCents: null,
        vatRate: null,
      }));
      continue;
    }
    if (
      typeof choice.label !== 'string'
      || !isCatalogueCategory(choice.category)
      || (choice.unit !== null && typeof choice.unit !== 'string')
      || !Number.isSafeInteger(choice.unitPriceCents)
      || (choice.unitPriceCents as number) < 1
      || typeof choice.vatRate !== 'number'
      || !isVatRate(choice.vatRate)
    ) {
      return null;
    }
    const canonical = parseCustomPrestation({
      id: fence.catalogueItemId,
      label: choice.label,
      category: choice.category,
      unit: choice.unit,
      unitPriceHT: choice.unitPriceCents,
      vatRate: choice.vatRate,
    });
    if (
      canonical === null
      || canonical.label !== choice.label
      || canonical.unit !== choice.unit
      || canonical.unitPriceHT !== choice.unitPriceCents
    ) {
      return null;
    }
    decoded.push(Object.freeze({
      choiceId: fence.choiceId,
      available: true,
      label: canonical.label,
      category: canonical.category,
      unit: canonical.unit,
      unitPriceCents: canonical.unitPriceHT,
      vatRate: canonical.vatRate,
    }));
  }
  return Object.freeze(decoded);
}

function decodeProposalLine(value: unknown): QuoteDraftPayloadLine | null {
  const candidate = record(value);
  const parsed = parseQuoteDraftPayload({
    schema: 'bob.quote-draft',
    version: 1,
    draft: {
      sessionId: 'api-client-presentation',
      contentRevision: 0,
      stagingRevision: 0,
      step: 'client',
      customer: null,
      lines: [value],
      lineMetadata: [{
        id: 'api-client-presentation-line',
        interaction: 'voice',
      }],
      lineForm: {
        label: '',
        quantity: '',
        unitPrice: '',
        category: 'labor',
      },
      vatDecision: { rate: candidate?.vatRate },
      depositPct: 0,
      signMode: null,
    },
  });
  return parsed.ok ? parsed.value.draft.lines[0] ?? null : null;
}

function canonicalPresentationLabel(value: unknown, itemId: string): string | null {
  if (typeof value !== 'string') return null;
  const parsed = parseCustomPrestation({
    id: itemId,
    label: value,
    category: 'labor',
    unit: null,
    unitPriceHT: 1,
    vatRate: 0,
  });
  return parsed?.label === value ? parsed.label : null;
}

function decodeQuoteAgentMissionPresentation(
  value: unknown,
  mission: NonNullable<QuoteAgentMissionResumeView['mission']>,
): QuoteAgentMissionPresentationV1 | null {
  const presentation = record(value);
  if (
    presentation === null
    || !exactKeys(presentation, PRESENTATION_KEYS)
    || presentation.schema !== 'bob.agent-mission.quote-presentation'
    || presentation.version !== 1
    || (
      presentation.requiredFact !== null
      && !AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS.includes(
        presentation.requiredFact as
          (typeof AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS)[number],
      )
    )
  ) {
    return null;
  }

  const pendingLineRecord = presentation.pendingLine === null
    ? null
    : record(presentation.pendingLine);
  if (
    presentation.pendingLine !== null
    && (
      pendingLineRecord === null
      || !exactKeys(pendingLineRecord, ['pendingLineId', 'expectedWorkRevision'])
      || !isCanonicalAgentMissionUuid(pendingLineRecord.pendingLineId)
      || !positiveRevision(pendingLineRecord.expectedWorkRevision)
    )
  ) {
    return null;
  }
  const pendingLine = pendingLineRecord === null
    ? null
    : Object.freeze({
        pendingLineId: pendingLineRecord.pendingLineId as string,
        expectedWorkRevision: pendingLineRecord.expectedWorkRevision as number,
      });

  const decision = decodePresentationDecision(
    presentation.decision,
    mission.id,
    mission.revision,
  );
  if (decision === undefined) return null;
  if (
    decision !== null
    && !sameDraftReference(decision.expectedDraft, mission.draft)
  ) {
    return null;
  }
  const catalogueChoices = decodeCatalogueChoicesPresentation(
    presentation.catalogueChoices,
    decision,
  );
  if (catalogueChoices === null) return null;

  const proposalStatus = record(presentation.proposalStatus);
  if (
    proposalStatus === null
    || (
      proposalStatus.kind === 'absent'
        ? !exactKeys(proposalStatus, ['kind'])
        : (
            proposalStatus.kind !== 'available'
            && proposalStatus.kind !== 'stale'
          )
          || (
            proposalStatus.kind === 'available'
              ? !exactKeys(proposalStatus, ['kind'])
              : !exactKeys(proposalStatus, ['kind', 'reason'])
                || (
                  proposalStatus.reason !== 'catalogue_changed'
                  && proposalStatus.reason !== 'vat_context_changed'
                )
          )
    )
  ) {
    return null;
  }

  const proposalRecord = presentation.proposal === null
    ? null
    : record(presentation.proposal);
  let proposal: QuoteAgentMissionPresentationV1['proposal'] = null;
  if (proposalRecord !== null) {
    if (
      !exactKeys(proposalRecord, PROPOSAL_KEYS)
      || decision?.kind !== 'line_confirmation'
      || proposalRecord.proposalId !== decision.proposalId
      || proposalRecord.diffHash !== decision.diffHash
    ) {
      return null;
    }
    const line = decodeProposalLine(proposalRecord.line);
    if (line === null) return null;
    const catalogueRecord = proposalRecord.catalogue === null
      ? null
      : record(proposalRecord.catalogue);
    if (
      decision.expectedCatalogue === null
        ? catalogueRecord !== null
        : (
            catalogueRecord === null
            || !exactKeys(catalogueRecord, PROPOSAL_CATALOGUE_KEYS)
            || catalogueRecord.itemId !== decision.expectedCatalogue.itemId
            || catalogueRecord.revision !== decision.expectedCatalogue.revision
            || canonicalPresentationLabel(
              catalogueRecord.label,
              decision.expectedCatalogue.itemId,
            ) === null
          )
    ) {
      return null;
    }
    proposal = Object.freeze({
      proposalId: decision.proposalId,
      diffHash: decision.diffHash,
      line: Object.freeze({ ...line }),
      catalogue: catalogueRecord === null
        ? null
        : Object.freeze({
            itemId: catalogueRecord.itemId as string,
            revision: catalogueRecord.revision as number,
            label: catalogueRecord.label as string,
          }),
    });
  } else if (presentation.proposal !== null) {
    return null;
  }

  const phase = mission.phase;
  const phaseShapeValid = phase === 'awaiting_catalogue_choice'
    ? (
        decision?.kind === 'catalogue'
        && pendingLine?.pendingLineId === decision.pendingLineId
        && pendingLine.expectedWorkRevision === decision.expectedWorkRevision
        && presentation.freeLineChoiceId === decision.freeLineChoiceId
        && presentation.requiredFact === null
      )
    : phase === 'awaiting_line_details'
      ? (
          decision === null
          && pendingLine !== null
          && presentation.freeLineChoiceId === null
        )
      : phase === 'awaiting_line_confirmation'
        ? (
            decision?.kind === 'line_confirmation'
            && pendingLine?.pendingLineId === decision.pendingLineId
            && pendingLine.expectedWorkRevision === decision.expectedWorkRevision
            && presentation.freeLineChoiceId === null
          )
        : phase === 'awaiting_lines'
          ? (
              decision === null
              && presentation.requiredFact === null
              && presentation.freeLineChoiceId === null
            )
          : (
              decision === null
              && pendingLine === null
              && presentation.requiredFact === null
              && presentation.freeLineChoiceId === null
            );
  if (!phaseShapeValid) return null;

  if (
    phase === 'awaiting_line_details'
      ? (
          presentation.requiredFact !== null
          && !AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS.includes(
            presentation.requiredFact as
              (typeof AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS)[number],
          )
        )
      : presentation.requiredFact !== null
  ) {
    return null;
  }
  if (
    decision?.kind === 'line_confirmation'
      ? (
          proposalStatus.kind === 'absent'
          || (
            proposalStatus.kind === 'available'
              ? proposal === null
              : proposal !== null
          )
        )
      : proposalStatus.kind !== 'absent' || proposal !== null
  ) {
    return null;
  }

  const decodedProposalStatus: QuoteAgentMissionPresentationV1['proposalStatus'] =
    proposalStatus.kind === 'stale'
      ? Object.freeze({
          kind: 'stale',
          reason: proposalStatus.reason as
            'catalogue_changed' | 'vat_context_changed',
        })
      : proposalStatus.kind === 'available'
        ? Object.freeze({ kind: 'available' })
        : Object.freeze({ kind: 'absent' });

  return Object.freeze({
    schema: 'bob.agent-mission.quote-presentation',
    version: 1,
    requiredFact: presentation.requiredFact as
      QuoteAgentMissionPresentationV1['requiredFact'],
    pendingLine,
    decision,
    catalogueChoices,
    freeLineChoiceId: presentation.freeLineChoiceId as string | null,
    proposalStatus: decodedProposalStatus,
    proposal,
  });
}

function decodeCommandPresentation(
  value: unknown,
  mission: AgentMissionViewV1,
): QuoteAgentMissionPresentationV1 | null {
  const draft = mission.payload.draft;
  if (
    draft === null
    || (mission.status !== 'active' && mission.status !== 'expired')
    || mission.actionable !== (mission.status === 'active')
  ) {
    return null;
  }
  return decodeQuoteAgentMissionPresentation(value, {
    id: mission.id,
    status: mission.status,
    phase: mission.phase,
    revision: mission.revision,
    actionable: mission.actionable,
    draft,
    idleExpiresAt: mission.idleExpiresAt,
    hardExpiresAt: mission.hardExpiresAt,
  });
}

export function decodeQuoteAgentMissionResumeV2(
  value: unknown,
): QuoteAgentMissionResumeViewV2 | null {
  const response = record(value);
  if (response === null) return null;
  if (response.mission === null) {
    return exactKeys(response, ['mission', 'presentation'])
      && response.presentation === null
      ? Object.freeze({ mission: null, presentation: null })
      : null;
  }
  if (
    !exactKeys(response, ['mission', 'draft', 'customerChoices', 'presentation'])
  ) {
    return null;
  }
  const resume = decodeQuoteAgentMissionResumeForPhases({
    mission: response.mission,
    draft: response.draft,
    customerChoices: response.customerChoices,
  }, RESUME_V2_PHASES);
  if (resume?.mission === null || resume === null) return null;
  const presentation = decodeQuoteAgentMissionPresentation(
    response.presentation,
    resume.mission,
  );
  if (presentation === null) return null;
  return Object.freeze({
    mission: resume.mission,
    draft: resume.draft,
    customerChoices: resume.customerChoices,
    presentation,
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
            || (
              mission.phase !== 'awaiting_catalogue_choice'
              && mission.phase !== 'awaiting_line_details'
              && mission.phase !== 'awaiting_line_confirmation'
            )
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
): RealtimeAgentMissionAcknowledgeQuoteScreenOutputV2 | null {
  const response = record(value);
  if (
    response === null
    || !exactKeys(response, ['outcome', 'receipt', 'mission', 'presentation'])
  ) {
    return null;
  }
  const acknowledged = decodeAgentMissionScreenAckForProtocol({
    outcome: response.outcome,
    receipt: response.receipt,
    mission: response.mission,
  }, AGENT_MISSION_PROTOCOL_M2A);
  const presentation = acknowledged === null
    ? null
    : decodeCommandPresentation(response.presentation, acknowledged.mission);
  return acknowledged === null || presentation === null
    ? null
    : Object.freeze({
        ...acknowledged,
        presentation,
      });
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
            || (
              mission.phase !== 'awaiting_catalogue_choice'
              && mission.phase !== 'awaiting_line_details'
              && mission.phase !== 'awaiting_line_confirmation'
            )
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
): RealtimeAgentMissionQuoteDecisionOutputV2 | null {
  const response = record(value);
  if (
    response === null
    || !exactKeys(response, ['outcome', 'effect', 'mission', 'presentation'])
  ) {
    return null;
  }
  const decided = decodeAgentMissionDecisionForProtocol({
    outcome: response.outcome,
    effect: response.effect,
    mission: response.mission,
  }, expectedMissionId, AGENT_MISSION_PROTOCOL_M2A);
  const presentation = decided === null
    ? null
    : decodeCommandPresentation(response.presentation, decided.mission);
  return decided === null || presentation === null
    ? null
    : Object.freeze({
        ...decided,
        presentation,
      });
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
      'requiredFact',
      'proposalId',
    ])
    || (
      continuation.outcome !== 'catalogue_not_found'
      && continuation.outcome !== 'choices_presented'
      && continuation.outcome !== 'empty'
      && continuation.outcome !== 'deferred_to_m2a2'
      && continuation.outcome !== 'details_requested'
      && continuation.outcome !== 'proposal_presented'
      && continuation.outcome !== 'catalogue_choice_pending'
      && continuation.outcome !== 'stable'
      && continuation.outcome !== 'superseded'
      && continuation.outcome !== 'replayed'
    )
    || !Number.isSafeInteger(continuation.presentedChoiceCount)
    || (continuation.presentedChoiceCount as number) < 0
    || (continuation.presentedChoiceCount as number) > 6
    || (
      continuation.requiredFact !== null
      && !AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS.includes(
        continuation.requiredFact as
          (typeof AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS)[number],
      )
    )
    || (
      continuation.proposalId !== null
      && !isCanonicalAgentMissionUuid(continuation.proposalId)
    )
    || (
      continuation.requiredFact !== null
      && continuation.proposalId !== null
    )
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
        || continuation.requiredFact !== null
        || continuation.proposalId !== null
      : continuation.outcome === 'stable'
        ? continuation.presentedChoiceCount !== 0
          || continuation.requiredFact !== null
          || continuation.proposalId !== null
      : !hasPendingLine
  ) {
    return null;
  }
  if (
    (
      continuation.outcome === 'choices_presented'
      || continuation.outcome === 'catalogue_choice_pending'
    )
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
  if (
    continuation.outcome === 'details_requested'
      ? continuation.requiredFact === null || continuation.proposalId !== null
      : continuation.outcome === 'proposal_presented'
        ? continuation.requiredFact !== null || continuation.proposalId === null
        : continuation.outcome === 'replayed'
          ? false
          : continuation.requiredFact !== null || continuation.proposalId !== null
  ) {
    return null;
  }
  return Object.freeze({
    outcome: continuation.outcome,
    pendingLineId: continuation.pendingLineId as string | null,
    presentedChoiceCount: continuation.presentedChoiceCount as number,
    requiredFact: continuation.requiredFact as
      RealtimeAgentMissionLineContinuation['requiredFact'],
    proposalId: continuation.proposalId as string | null,
  });
}

function continuationMatchesPresentation(
  continuation: RealtimeAgentMissionLineContinuation,
  presentation: QuoteAgentMissionPresentationV1,
): boolean {
  const samePendingLine = continuation.pendingLineId === null
    || presentation.pendingLine?.pendingLineId === continuation.pendingLineId;
  if (!samePendingLine) return false;
  if (continuation.outcome === 'details_requested') {
    return presentation.requiredFact === continuation.requiredFact;
  }
  if (continuation.outcome === 'proposal_presented') {
    return presentation.proposal?.proposalId === continuation.proposalId;
  }
  if (
    continuation.outcome === 'choices_presented'
    || continuation.outcome === 'catalogue_choice_pending'
    || (
      continuation.outcome === 'replayed'
      && continuation.presentedChoiceCount > 0
    )
  ) {
    return presentation.decision?.kind === 'catalogue'
      && presentation.catalogueChoices.length + 1
        === continuation.presentedChoiceCount;
  }
  if (
    continuation.outcome === 'replayed'
    && continuation.requiredFact !== null
  ) {
    return presentation.requiredFact === continuation.requiredFact;
  }
  if (
    continuation.outcome === 'replayed'
    && continuation.proposalId !== null
  ) {
    return presentation.proposal?.proposalId === continuation.proposalId;
  }
  return true;
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
      'presentation',
    ])
  ) {
    return null;
  }
  const mission = decodeAgentMissionView(response.mission, AGENT_MISSION_PROTOCOL_M2A);
  const continuation = decodeAgentMissionLineContinuation(response.continuation);
  const presentation = mission === null
    ? null
    : decodeCommandPresentation(response.presentation, mission);
  if (
    mission === null
    || mission.id !== expectedMissionId
    || continuation === null
    || presentation === null
    || !continuationMatchesPresentation(continuation, presentation)
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
    presentation,
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
      'presentation',
    ])
  ) {
    return null;
  }
  const mission = decodeAgentMissionView(response.mission, AGENT_MISSION_PROTOCOL_M2A);
  const continuation = decodeAgentMissionLineContinuation(response.continuation);
  const presentation = mission === null
    ? null
    : decodeCommandPresentation(response.presentation, mission);
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
    || presentation === null
    || !continuationMatchesPresentation(continuation, presentation)
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
    presentation,
  }) as RealtimeAgentMissionCatalogueChoiceOutput;
}

export function decodeAgentMissionPatchQuoteLine(
  value: unknown,
  expectedMissionId: string,
): RealtimeAgentMissionPatchQuoteLineOutput | null {
  const response = record(value);
  if (
    response === null
    || !exactKeys(response, [
      'outcome',
      'pendingLineId',
      'workRevisionAfter',
      'mission',
      'continuation',
      'presentation',
    ])
  ) {
    return null;
  }
  const mission = decodeAgentMissionView(response.mission, AGENT_MISSION_PROTOCOL_M2A);
  const continuation = decodeAgentMissionLineContinuation(response.continuation);
  const presentation = mission === null
    ? null
    : decodeCommandPresentation(response.presentation, mission);
  if (
    mission === null
    || mission.id !== expectedMissionId
    || continuation === null
    || presentation === null
    || !continuationMatchesPresentation(continuation, presentation)
    || (response.outcome !== 'patched' && response.outcome !== 'replayed')
    || !isCanonicalAgentMissionUuid(response.pendingLineId)
    || !positiveRevision(response.workRevisionAfter)
  ) {
    return null;
  }
  return Object.freeze({
    outcome: response.outcome,
    pendingLineId: response.pendingLineId,
    workRevisionAfter: response.workRevisionAfter,
    mission,
    continuation,
    presentation,
  }) as RealtimeAgentMissionPatchQuoteLineOutput;
}

export function decodeAgentMissionLineProposalDecision(
  value: unknown,
  expectedMissionId: string,
): RealtimeAgentMissionLineProposalDecisionOutput | null {
  const response = record(value);
  if (
    response === null
    || !exactKeys(response, [
      'outcome',
      'invalidationReason',
      'mission',
      'continuation',
      'presentation',
    ])
  ) {
    return null;
  }
  const mission = decodeAgentMissionView(response.mission, AGENT_MISSION_PROTOCOL_M2A);
  const continuation = decodeAgentMissionLineContinuation(response.continuation);
  const presentation = mission === null
    ? null
    : decodeCommandPresentation(response.presentation, mission);
  const invalidated = response.outcome === 'invalidated';
  if (
    mission === null
    || mission.id !== expectedMissionId
    || continuation === null
    || presentation === null
    || !continuationMatchesPresentation(continuation, presentation)
    || (
      response.outcome !== 'confirmed'
      && response.outcome !== 'edit_requested'
      && response.outcome !== 'cancelled'
      && !invalidated
      && response.outcome !== 'replayed'
    )
    || (
      invalidated
        ? (
            response.invalidationReason !== 'candidate_unavailable'
            && response.invalidationReason !== 'choice_set_stale'
          )
        : (
            response.invalidationReason !== null
            && response.outcome !== 'replayed'
          )
    )
    || (
      response.outcome === 'replayed'
      && response.invalidationReason !== null
      && response.invalidationReason !== 'candidate_unavailable'
      && response.invalidationReason !== 'choice_set_stale'
    )
  ) {
    return null;
  }
  return Object.freeze({
    outcome: response.outcome,
    invalidationReason: response.invalidationReason,
    mission,
    continuation,
    presentation,
  }) as RealtimeAgentMissionLineProposalDecisionOutput;
}
