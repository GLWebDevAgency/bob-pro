import {
  CATALOGUE_CATEGORIES,
  isCatalogueCategory,
  isCustomPrestationId,
  type CatalogueCategory,
} from '../catalogue/derive-catalogue';
import {
  hasBillingControlCharacter,
  MAX_BILLING_AMOUNT_CENTS,
} from '../../domain/billing/shared/line-item';
import {
  equivalentBillingUnitReferences,
} from '../../domain/billing/shared/billing-unit-reference';
import {
  isVatRate,
  type VatRate,
} from '../../domain/billing/shared/vat-rate';
import {
  AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS,
  type AgentMissionQuoteLineRequiredFact,
} from '../../domain/agent/agent-mission-event';
import { type Instant } from '../../shared-kernel/time';
import {
  AGENT_MISSION_OPAQUE_IDENTIFIER_MAX_LENGTH,
  isCanonicalAgentMissionOpaqueIdentifier,
} from './agent-mission-identifiers';
import {
  type CatalogueCandidateRecord,
} from '../ports/catalogue-candidate-search';
import {
  type NormalizedAgentMissionQuoteLinePatch,
} from './quote-line-patch';

export const AGENT_MISSION_QUOTE_LINE_WORK_STATES = [
  'queued',
  'awaiting_catalogue_choice',
  'awaiting_details',
  'awaiting_confirmation',
] as const;

export type AgentMissionQuoteLineWorkState =
  (typeof AGENT_MISSION_QUOTE_LINE_WORK_STATES)[number];

export const AGENT_MISSION_QUOTE_LINE_WORK_ORIGINS = [
  'user_voice',
  'user_tap',
] as const;

export type AgentMissionQuoteLineWorkOrigin =
  (typeof AGENT_MISSION_QUOTE_LINE_WORK_ORIGINS)[number];

export {
  AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS,
  type AgentMissionQuoteLineRequiredFact,
} from '../../domain/agent/agent-mission-event';

export const AGENT_MISSION_QUOTE_LINE_CATALOGUE_RESOLUTIONS = [
  'pending',
  'free',
  'selected',
] as const;

export type AgentMissionQuoteLineCatalogueResolution =
  (typeof AGENT_MISSION_QUOTE_LINE_CATALOGUE_RESOLUTIONS)[number];

export const AGENT_MISSION_QUOTE_LINE_PRICE_BASES = [
  'per_unit',
  'total',
] as const;

export type AgentMissionQuoteLinePriceBasis =
  (typeof AGENT_MISSION_QUOTE_LINE_PRICE_BASES)[number];

export const AGENT_MISSION_QUOTE_LINE_MAX_WORK_ITEMS = 20;
export const AGENT_MISSION_QUOTE_LINE_MAX_ORDINAL = 2_147_483_647;
export const AGENT_MISSION_QUOTE_LINE_MAX_SERVICE_REFERENCE_LENGTH = 500;
export const AGENT_MISSION_QUOTE_LINE_MAX_UNIT_LENGTH = 40;
export const AGENT_MISSION_QUOTE_LINE_MAX_QUANTITY_MILLI =
  MAX_BILLING_AMOUNT_CENTS * 1_000;
export const AGENT_MISSION_QUOTE_LINE_PROPOSAL_REVISION = 1;

export interface AgentMissionQuoteLineWork {
  readonly id: string;
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly missionId: string;
  readonly ordinal: number;
  readonly revision: number;
  readonly state: AgentMissionQuoteLineWorkState;
  readonly origin: AgentMissionQuoteLineWorkOrigin;
  readonly serviceReference: string | null;
  readonly category: CatalogueCategory | null;
  readonly quantityMilli: number | null;
  readonly unit: string | null;
  readonly unitPriceCents: number | null;
  readonly requestedVatRate: VatRate | null;
  readonly priceBasis: AgentMissionQuoteLinePriceBasis | null;
  readonly housingOlderThan2y: boolean | null;
  readonly energyRenovation: boolean | null;
  readonly requiredFact: AgentMissionQuoteLineRequiredFact | null;
  readonly catalogueResolution: AgentMissionQuoteLineCatalogueResolution;
  readonly catalogueItemId: string | null;
  readonly expectedCatalogueRevision: number | null;
  readonly catalogueCategoryOverrideConfirmed: boolean;
  readonly catalogueUnitOverrideConfirmed: boolean;
  readonly proposalId: string | null;
  readonly proposalRevision: typeof AGENT_MISSION_QUOTE_LINE_PROPOSAL_REVISION | null;
  readonly proposalDiffHash: string | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export type AgentMissionQuoteLineWorkErrorReason =
  | 'invalid_shape'
  | 'invalid_identifier'
  | 'invalid_uuid'
  | 'invalid_revision'
  | 'invalid_instant'
  | 'invalid_value'
  | 'inconsistent_state';

export interface AgentMissionQuoteLineWorkError {
  readonly code: 'invalid_agent_mission_quote_line_work';
  readonly field: string;
  readonly reason: AgentMissionQuoteLineWorkErrorReason;
}

export type AgentMissionQuoteLineWorkResult =
  | { readonly ok: true; readonly value: AgentMissionQuoteLineWork }
  | { readonly ok: false; readonly error: AgentMissionQuoteLineWorkError };

export const AGENT_MISSION_QUOTE_LINE_WORK_M2A1_KEYS = [
  'id',
  'companyId',
  'ownerUserId',
  'missionId',
  'ordinal',
  'revision',
  'state',
  'origin',
  'serviceReference',
  'category',
  'quantityMilli',
  'unit',
  'unitPriceCents',
  'requestedVatRate',
  'priceBasis',
  'housingOlderThan2y',
  'energyRenovation',
  'requiredFact',
  'catalogueResolution',
  'catalogueItemId',
  'expectedCatalogueRevision',
  'proposalId',
  'proposalRevision',
  'proposalDiffHash',
  'createdAt',
  'updatedAt',
] as const;

export const AGENT_MISSION_QUOTE_LINE_WORK_KEYS = [
  ...AGENT_MISSION_QUOTE_LINE_WORK_M2A1_KEYS.slice(0, 21),
  'catalogueCategoryOverrideConfirmed',
  'catalogueUnitOverrideConfirmed',
  'proposalId',
  'proposalRevision',
  'proposalDiffHash',
  'createdAt',
  'updatedAt',
] as const;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const INT4_MAX = 2_147_483_647;

function fail(
  field: string,
  reason: AgentMissionQuoteLineWorkErrorReason,
): AgentMissionQuoteLineWorkResult {
  return {
    ok: false,
    error: {
      code: 'invalid_agent_mission_quote_line_work',
      field,
      reason,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function isOneOf<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === 'string'
    && (values as readonly string[]).includes(value);
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isPositiveInt4(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 1
    && (value as number) <= INT4_MAX;
}

function isCanonicalSingleLine(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maximumLength
    && value === value.trim()
    && !hasBillingControlCharacter(value);
}

function isCanonicalInstant(value: unknown): value is Instant {
  if (typeof value !== 'string') return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}

function allNull(values: readonly unknown[]): boolean {
  return values.every((value) => value === null);
}

function allPresent(values: readonly unknown[]): boolean {
  return values.every((value) => value !== null);
}

function validateStateCoherence(
  value: Record<string, unknown>,
): AgentMissionQuoteLineWorkResult | null {
  const catalogueFence = [
    value['catalogueItemId'],
    value['expectedCatalogueRevision'],
  ];
  if (!allNull(catalogueFence) && !allPresent(catalogueFence)) {
    return fail('catalogue', 'inconsistent_state');
  }
  if (
    (value['catalogueResolution'] === 'selected') !== allPresent(catalogueFence)
    || (
      value['catalogueResolution'] !== 'selected'
      && !allNull(catalogueFence)
    )
  ) {
    return fail('catalogueResolution', 'inconsistent_state');
  }
  if (
    value['catalogueResolution'] !== 'selected'
    && (
      value['catalogueCategoryOverrideConfirmed'] !== false
      || value['catalogueUnitOverrideConfirmed'] !== false
    )
  ) {
    return fail('catalogueOverride', 'inconsistent_state');
  }
  if (
    (
      value['catalogueCategoryOverrideConfirmed'] === true
      && value['category'] === null
    )
    || (
      value['catalogueUnitOverrideConfirmed'] === true
      && value['unit'] === null
    )
  ) {
    return fail('catalogueOverride', 'inconsistent_state');
  }

  const price = [value['unitPriceCents'], value['priceBasis']];
  if (!allNull(price) && !allPresent(price)) {
    return fail('price', 'inconsistent_state');
  }

  const proposal = [
    value['proposalId'],
    value['proposalRevision'],
    value['proposalDiffHash'],
  ];
  if (!allNull(proposal) && !allPresent(proposal)) {
    return fail('proposal', 'inconsistent_state');
  }

  switch (value['state']) {
    case 'queued':
      return value['requiredFact'] === null
        && allNull(proposal)
        ? null
        : fail('state', 'inconsistent_state');
    case 'awaiting_catalogue_choice':
      return value['serviceReference'] !== null
        && value['requiredFact'] === null
        && value['catalogueResolution'] === 'pending'
        && allNull(catalogueFence)
        && allNull(proposal)
        ? null
        : fail('state', 'inconsistent_state');
    case 'awaiting_details':
      return (
        value['requiredFact'] === null
          ? value['catalogueResolution'] !== 'pending'
          : (
              value['catalogueResolution'] !== 'pending'
              || value['requiredFact'] === 'service_reference'
            )
      )
        && allNull(proposal)
        ? null
        : fail('state', 'inconsistent_state');
    case 'awaiting_confirmation':
      return value['serviceReference'] !== null
        && value['category'] !== null
        && value['quantityMilli'] !== null
        && value['unit'] !== null
        && value['unitPriceCents'] !== null
        && value['requestedVatRate'] !== null
        && value['priceBasis'] === 'per_unit'
        && value['requiredFact'] === null
        && value['catalogueResolution'] !== 'pending'
        && allPresent(proposal)
        ? null
        : fail('state', 'inconsistent_state');
    default:
      return fail('state', 'invalid_value');
  }
}

/**
 * Frontière stricte commune au core, à l'adapter Prisma et aux tests de migration.
 *
 * Aucun texte LLM brut n'entre ici : uniquement les faits normalisés nécessaires à la reprise.
 */
export function parseAgentMissionQuoteLineWork(
  input: unknown,
): AgentMissionQuoteLineWorkResult {
  if (!isRecord(input)) {
    return fail('$', 'invalid_shape');
  }
  const normalizedInput = hasExactKeys(
    input,
    AGENT_MISSION_QUOTE_LINE_WORK_M2A1_KEYS,
  )
    ? {
        ...input,
        catalogueCategoryOverrideConfirmed: false,
        catalogueUnitOverrideConfirmed: false,
      }
    : input;
  if (!hasExactKeys(normalizedInput, AGENT_MISSION_QUOTE_LINE_WORK_KEYS)) {
    return fail('$', 'invalid_shape');
  }
  input = normalizedInput;
  if (!isRecord(input)) return fail('$', 'invalid_shape');

  if (!isCanonicalUuid(input['id'])) return fail('id', 'invalid_uuid');
  if (
    !isCanonicalAgentMissionOpaqueIdentifier(input['companyId'])
    || input['companyId'].length > AGENT_MISSION_OPAQUE_IDENTIFIER_MAX_LENGTH
  ) {
    return fail('companyId', 'invalid_identifier');
  }
  if (
    !isCanonicalAgentMissionOpaqueIdentifier(input['ownerUserId'])
    || input['ownerUserId'].length > AGENT_MISSION_OPAQUE_IDENTIFIER_MAX_LENGTH
  ) {
    return fail('ownerUserId', 'invalid_identifier');
  }
  if (!isCanonicalUuid(input['missionId'])) return fail('missionId', 'invalid_uuid');

  if (
    !Number.isSafeInteger(input['ordinal'])
    || (input['ordinal'] as number) < 1
    || (input['ordinal'] as number) > AGENT_MISSION_QUOTE_LINE_MAX_ORDINAL
  ) {
    return fail('ordinal', 'invalid_value');
  }
  if (!isPositiveInt4(input['revision'])) return fail('revision', 'invalid_revision');
  if (!isOneOf(AGENT_MISSION_QUOTE_LINE_WORK_STATES, input['state'])) {
    return fail('state', 'invalid_value');
  }
  if (!isOneOf(AGENT_MISSION_QUOTE_LINE_WORK_ORIGINS, input['origin'])) {
    return fail('origin', 'invalid_value');
  }

  if (
    input['serviceReference'] !== null
    && !isCanonicalSingleLine(
      input['serviceReference'],
      AGENT_MISSION_QUOTE_LINE_MAX_SERVICE_REFERENCE_LENGTH,
    )
  ) {
    return fail('serviceReference', 'invalid_value');
  }
  if (
    input['category'] !== null
    && !isCatalogueCategory(input['category'])
  ) {
    return fail('category', 'invalid_value');
  }
  if (
    input['quantityMilli'] !== null
    && (
      !Number.isSafeInteger(input['quantityMilli'])
      || (input['quantityMilli'] as number) < 1
      || (input['quantityMilli'] as number) > AGENT_MISSION_QUOTE_LINE_MAX_QUANTITY_MILLI
    )
  ) {
    return fail('quantityMilli', 'invalid_value');
  }
  if (
    input['unit'] !== null
    && !isCanonicalSingleLine(
      input['unit'],
      AGENT_MISSION_QUOTE_LINE_MAX_UNIT_LENGTH,
    )
  ) {
    return fail('unit', 'invalid_value');
  }
  if (
    input['unitPriceCents'] !== null
    && (
      !Number.isSafeInteger(input['unitPriceCents'])
      || (input['unitPriceCents'] as number) < 1
      || (input['unitPriceCents'] as number) > MAX_BILLING_AMOUNT_CENTS
    )
  ) {
    return fail('unitPriceCents', 'invalid_value');
  }
  if (
    input['requestedVatRate'] !== null
    && (
      typeof input['requestedVatRate'] !== 'number'
      || !isVatRate(input['requestedVatRate'])
    )
  ) {
    return fail('requestedVatRate', 'invalid_value');
  }
  if (
    input['priceBasis'] !== null
    && !isOneOf(AGENT_MISSION_QUOTE_LINE_PRICE_BASES, input['priceBasis'])
  ) {
    return fail('priceBasis', 'invalid_value');
  }
  if (!isNullableBoolean(input['housingOlderThan2y'])) {
    return fail('housingOlderThan2y', 'invalid_value');
  }
  if (!isNullableBoolean(input['energyRenovation'])) {
    return fail('energyRenovation', 'invalid_value');
  }
  if (
    input['requiredFact'] !== null
    && !isOneOf(AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS, input['requiredFact'])
  ) {
    return fail('requiredFact', 'invalid_value');
  }
  if (
    !isOneOf(
      AGENT_MISSION_QUOTE_LINE_CATALOGUE_RESOLUTIONS,
      input['catalogueResolution'],
    )
  ) {
    return fail('catalogueResolution', 'invalid_value');
  }
  if (
    input['catalogueItemId'] !== null
    && !isCustomPrestationId(input['catalogueItemId'])
  ) {
    return fail('catalogueItemId', 'invalid_identifier');
  }
  if (
    input['expectedCatalogueRevision'] !== null
    && !isPositiveInt4(input['expectedCatalogueRevision'])
  ) {
    return fail('expectedCatalogueRevision', 'invalid_revision');
  }
  if (typeof input['catalogueCategoryOverrideConfirmed'] !== 'boolean') {
    return fail('catalogueCategoryOverrideConfirmed', 'invalid_value');
  }
  if (typeof input['catalogueUnitOverrideConfirmed'] !== 'boolean') {
    return fail('catalogueUnitOverrideConfirmed', 'invalid_value');
  }
  if (input['proposalId'] !== null && !isCanonicalUuid(input['proposalId'])) {
    return fail('proposalId', 'invalid_uuid');
  }
  if (
    input['proposalRevision'] !== null
    && input['proposalRevision'] !== AGENT_MISSION_QUOTE_LINE_PROPOSAL_REVISION
  ) {
    return fail('proposalRevision', 'invalid_revision');
  }
  if (
    input['proposalDiffHash'] !== null
    && (
      typeof input['proposalDiffHash'] !== 'string'
      || !SHA256.test(input['proposalDiffHash'])
    )
  ) {
    return fail('proposalDiffHash', 'invalid_value');
  }
  if (!isCanonicalInstant(input['createdAt'])) return fail('createdAt', 'invalid_instant');
  if (!isCanonicalInstant(input['updatedAt'])) return fail('updatedAt', 'invalid_instant');
  if (Date.parse(input['updatedAt']) < Date.parse(input['createdAt'])) {
    return fail('updatedAt', 'inconsistent_state');
  }

  const coherenceError = validateStateCoherence(input);
  if (coherenceError) return coherenceError;

  return {
    ok: true,
    value: {
      id: input['id'],
      companyId: input['companyId'],
      ownerUserId: input['ownerUserId'],
      missionId: input['missionId'],
      ordinal: input['ordinal'] as number,
      revision: input['revision'] as number,
      state: input['state'],
      origin: input['origin'],
      serviceReference: input['serviceReference'] as string | null,
      category: input['category'] as CatalogueCategory | null,
      quantityMilli: input['quantityMilli'] as number | null,
      unit: input['unit'] as string | null,
      unitPriceCents: input['unitPriceCents'] as number | null,
      requestedVatRate: input['requestedVatRate'] as VatRate | null,
      priceBasis: input['priceBasis'] as AgentMissionQuoteLinePriceBasis | null,
      housingOlderThan2y: input['housingOlderThan2y'],
      energyRenovation: input['energyRenovation'],
      requiredFact: input['requiredFact'] as AgentMissionQuoteLineRequiredFact | null,
      catalogueResolution: input['catalogueResolution'],
      catalogueItemId: input['catalogueItemId'] as string | null,
      expectedCatalogueRevision: input['expectedCatalogueRevision'] as number | null,
      catalogueCategoryOverrideConfirmed:
        input['catalogueCategoryOverrideConfirmed'],
      catalogueUnitOverrideConfirmed: input['catalogueUnitOverrideConfirmed'],
      proposalId: input['proposalId'] as string | null,
      proposalRevision: input['proposalRevision'] as
        | typeof AGENT_MISSION_QUOTE_LINE_PROPOSAL_REVISION
        | null,
      proposalDiffHash: input['proposalDiffHash'] as string | null,
      createdAt: input['createdAt'],
      updatedAt: input['updatedAt'],
    },
  };
}

/**
 * Valeurs fermées réutilisées par le générateur de migration. Leur export évite toute liste SQL
 * recopiée à la main.
 */
export const AGENT_MISSION_QUOTE_LINE_CATEGORIES = CATALOGUE_CATEGORIES;

export type AgentMissionQuoteLineWorkTransitionError =
  | AgentMissionQuoteLineWorkError
  | {
      readonly code: 'agent_mission_quote_line_work_revision_conflict';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    }
  | {
      readonly code: 'agent_mission_quote_line_work_invalid_transition';
      readonly state: AgentMissionQuoteLineWorkState;
      readonly action:
        | 'present_catalogue_choices'
        | 'record_catalogue_not_found'
        | 'consume_catalogue_choice'
        | 'invalidate_catalogue_choice'
        | 'request_line_details'
        | 'patch_line_fact'
        | 'present_line_proposal'
        | 'reject_line_proposal';
    }
  | {
      readonly code: 'agent_mission_quote_line_work_catalogue_fence_conflict';
    }
  | {
      readonly code: 'agent_mission_quote_line_work_revision_overflow';
    };

export type AgentMissionQuoteLineWorkTransitionResult =
  | { readonly ok: true; readonly value: AgentMissionQuoteLineWork }
  | { readonly ok: false; readonly error: AgentMissionQuoteLineWorkTransitionError };

export type AgentMissionQuoteLineCatalogueChoiceResolution =
  | { readonly kind: 'free' }
  | {
      readonly kind: 'selected';
      readonly catalogueItemId: string;
      readonly expectedCatalogueRevision: number;
    };

export type AgentMissionQuoteLinePatchScope =
  | 'answer_required_fact'
  | 'explicit_correction';

export interface ResolvedAgentMissionQuoteLineFacts {
  readonly serviceReference: string;
  readonly category: CatalogueCategory;
  readonly quantityMilli: number;
  readonly unit: string;
  readonly unitPriceCents: number;
  readonly requestedVatRate: VatRate;
  readonly priceBasis: 'per_unit';
  readonly housingOlderThan2y: boolean | null;
  readonly energyRenovation: boolean | null;
}

function transitionFailure(
  error: AgentMissionQuoteLineWorkTransitionError,
): AgentMissionQuoteLineWorkTransitionResult {
  return { ok: false, error };
}

function prepareTransition(input: {
  readonly workItem: AgentMissionQuoteLineWork;
  readonly expectedRevision: number;
  readonly occurredAt: Instant;
}): AgentMissionQuoteLineWorkTransitionResult | null {
  const current = parseAgentMissionQuoteLineWork(input.workItem);
  if (!current.ok) return current;
  if (!isPositiveInt4(input.expectedRevision)) {
    return transitionFailure({
      code: 'invalid_agent_mission_quote_line_work',
      field: 'expectedRevision',
      reason: 'invalid_revision',
    });
  }
  if (input.expectedRevision !== current.value.revision) {
    return transitionFailure({
      code: 'agent_mission_quote_line_work_revision_conflict',
      expectedRevision: input.expectedRevision,
      actualRevision: current.value.revision,
    });
  }
  if (current.value.revision === INT4_MAX) {
    return transitionFailure({
      code: 'agent_mission_quote_line_work_revision_overflow',
    });
  }
  if (
    !isCanonicalInstant(input.occurredAt)
    || Date.parse(input.occurredAt) < Date.parse(current.value.updatedAt)
  ) {
    return transitionFailure({
      code: 'invalid_agent_mission_quote_line_work',
      field: 'occurredAt',
      reason: 'invalid_instant',
    });
  }
  return null;
}

function transitionValue(
  value: AgentMissionQuoteLineWork,
): AgentMissionQuoteLineWorkTransitionResult {
  const parsed = parseAgentMissionQuoteLineWork(value);
  return parsed.ok ? parsed : transitionFailure(parsed.error);
}

function invalidTransition(
  workItem: AgentMissionQuoteLineWork,
  action: Extract<
    AgentMissionQuoteLineWorkTransitionError,
    { readonly code: 'agent_mission_quote_line_work_invalid_transition' }
  >['action'],
): AgentMissionQuoteLineWorkTransitionResult {
  return transitionFailure({
    code: 'agent_mission_quote_line_work_invalid_transition',
    state: workItem.state,
    action,
  });
}

function catalogueFenceMatches(
  workItem: AgentMissionQuoteLineWork,
  selectedCatalogue: CatalogueCandidateRecord | null,
): boolean {
  return workItem.catalogueResolution !== 'selected'
    ? selectedCatalogue === null
    : selectedCatalogue !== null
      && selectedCatalogue.id === workItem.catalogueItemId
      && selectedCatalogue.revision === workItem.expectedCatalogueRevision;
}

function applyQuoteLinePatch(
  workItem: AgentMissionQuoteLineWork,
  patch: NormalizedAgentMissionQuoteLinePatch,
  selectedCatalogue: CatalogueCandidateRecord | null,
): AgentMissionQuoteLineWork {
  const resetProposal = {
    proposalId: null,
    proposalRevision: null,
    proposalDiffHash: null,
  } as const;
  switch (patch.field) {
    case 'service_reference':
      return {
        ...workItem,
        serviceReference: patch.value,
        state: 'queued',
        requiredFact: null,
        catalogueResolution: 'pending',
        catalogueItemId: null,
        expectedCatalogueRevision: null,
        catalogueCategoryOverrideConfirmed: false,
        catalogueUnitOverrideConfirmed: false,
        ...resetProposal,
      };
    case 'category':
      return {
        ...workItem,
        category: patch.value,
        state: 'queued',
        requiredFact: null,
        catalogueCategoryOverrideConfirmed:
          selectedCatalogue !== null
          && patch.value !== selectedCatalogue.category,
        ...resetProposal,
      };
    case 'quantity':
      return {
        ...workItem,
        quantityMilli: patch.quantityMilli,
        state: 'queued',
        requiredFact: null,
        ...resetProposal,
      };
    case 'unit':
      return {
        ...workItem,
        unit: patch.value,
        state: 'queued',
        requiredFact: null,
        catalogueUnitOverrideConfirmed:
          selectedCatalogue !== null
          && !equivalentBillingUnitReferences(patch.value, selectedCatalogue.unit),
        ...resetProposal,
      };
    case 'unit_price':
      return {
        ...workItem,
        unitPriceCents: patch.unitPriceCents,
        priceBasis: patch.basis,
        state: 'queued',
        requiredFact: null,
        ...resetProposal,
      };
    case 'vat_rate':
      return {
        ...workItem,
        requestedVatRate: patch.value,
        state: 'queued',
        requiredFact: null,
        ...resetProposal,
      };
    case 'housing_older_than_2y':
      return {
        ...workItem,
        housingOlderThan2y: patch.value,
        state: 'queued',
        requiredFact: null,
        ...resetProposal,
      };
    case 'energy_renovation':
      return {
        ...workItem,
        energyRenovation: patch.value,
        state: 'queued',
        requiredFact: null,
        ...resetProposal,
      };
  }
}

/**
 * Applique un fait déjà normalisé avec une autorité explicite. Une réponse courte ne peut cibler
 * que la question durable courante ; une correction nommée peut corriger une autre valeur.
 */
export function patchQuoteLineFactOnWork(input: {
  readonly workItem: AgentMissionQuoteLineWork;
  readonly expectedRevision: number;
  readonly patch: NormalizedAgentMissionQuoteLinePatch;
  readonly scope: AgentMissionQuoteLinePatchScope;
  readonly selectedCatalogue: CatalogueCandidateRecord | null;
  readonly selectedCatalogueStatus: 'not_required' | 'matched' | 'stale';
  readonly occurredAt: Instant;
}): AgentMissionQuoteLineWorkTransitionResult {
  const preparation = prepareTransition(input);
  if (preparation !== null) return preparation;
  const isRequiredFactAnswer = input.scope === 'answer_required_fact';
  const isExplicitCorrection = input.scope === 'explicit_correction';
  const validRequiredFactAnswer = isRequiredFactAnswer
    && input.workItem.state === 'awaiting_details'
    && input.workItem.requiredFact !== null
    && input.patch.field === input.workItem.requiredFact;
  const validExplicitCorrection = isExplicitCorrection && (
    input.workItem.state === 'awaiting_details'
    || input.workItem.state === 'awaiting_confirmation'
    || (
      input.workItem.state === 'awaiting_catalogue_choice'
      && input.patch.field === 'service_reference'
    )
  );
  if (!validRequiredFactAnswer && !validExplicitCorrection) {
    return invalidTransition(input.workItem, 'patch_line_fact');
  }
  const needsCatalogueFence = input.workItem.catalogueResolution === 'selected'
    && (
      input.patch.field === 'category'
      || input.patch.field === 'unit'
    );
  if (
    needsCatalogueFence
    && input.selectedCatalogueStatus === 'matched'
    && !catalogueFenceMatches(input.workItem, input.selectedCatalogue)
  ) {
    return transitionFailure({
      code: 'agent_mission_quote_line_work_catalogue_fence_conflict',
    });
  }
  if (
    needsCatalogueFence
    && input.selectedCatalogueStatus === 'not_required'
  ) {
    return transitionFailure({
      code: 'invalid_agent_mission_quote_line_work',
      field: 'selectedCatalogueStatus',
      reason: 'inconsistent_state',
    });
  }
  if (
    needsCatalogueFence
    && input.selectedCatalogueStatus === 'stale'
    && input.selectedCatalogue !== null
  ) {
    return transitionFailure({
      code: 'invalid_agent_mission_quote_line_work',
      field: 'selectedCatalogue',
      reason: 'inconsistent_state',
    });
  }
  if (
    !needsCatalogueFence
    && (
      input.selectedCatalogue !== null
      || input.selectedCatalogueStatus !== 'not_required'
    )
  ) {
    return transitionFailure({
      code: 'invalid_agent_mission_quote_line_work',
      field: 'selectedCatalogue',
      reason: 'inconsistent_state',
    });
  }
  const patched = applyQuoteLinePatch(
    input.workItem,
    input.patch,
    input.selectedCatalogue,
  );
  return transitionValue({
    ...patched,
    ...(needsCatalogueFence && input.selectedCatalogueStatus === 'stale'
      ? {
          catalogueResolution: 'pending' as const,
          catalogueItemId: null,
          expectedCatalogueRevision: null,
          catalogueCategoryOverrideConfirmed: false,
          catalogueUnitOverrideConfirmed: false,
        }
      : {}),
    revision: input.workItem.revision + 1,
    updatedAt: input.occurredAt,
  });
}

export function requestQuoteLineDetailsOnWork(input: {
  readonly workItem: AgentMissionQuoteLineWork;
  readonly expectedRevision: number;
  readonly requiredFact: AgentMissionQuoteLineRequiredFact;
  readonly occurredAt: Instant;
}): AgentMissionQuoteLineWorkTransitionResult {
  const preparation = prepareTransition(input);
  if (preparation !== null) return preparation;
  if (
    input.workItem.state !== 'queued'
    || (
      input.workItem.catalogueResolution === 'pending'
      && input.requiredFact !== 'service_reference'
    )
  ) {
    return invalidTransition(input.workItem, 'request_line_details');
  }
  return transitionValue({
    ...input.workItem,
    revision: input.workItem.revision + 1,
    state: 'awaiting_details',
    requiredFact: input.requiredFact,
    proposalId: null,
    proposalRevision: null,
    proposalDiffHash: null,
    updatedAt: input.occurredAt,
  });
}

/**
 * Un item catalogue sélectionné puis supprimé/révisé n'est jamais utilisé avec ses anciennes
 * valeurs. La référence utilisateur reste visible, mais la fence est effacée et Bob demande une
 * confirmation/correction explicite avant de relancer la recherche.
 */
export function requestQuoteLineCatalogueRefreshOnWork(input: {
  readonly workItem: AgentMissionQuoteLineWork;
  readonly expectedRevision: number;
  readonly occurredAt: Instant;
}): AgentMissionQuoteLineWorkTransitionResult {
  const preparation = prepareTransition(input);
  if (preparation !== null) return preparation;
  if (
    input.workItem.state !== 'queued'
    || input.workItem.catalogueResolution !== 'selected'
    || input.workItem.serviceReference === null
  ) {
    return invalidTransition(input.workItem, 'request_line_details');
  }
  return transitionValue({
    ...input.workItem,
    revision: input.workItem.revision + 1,
    state: 'awaiting_details',
    requiredFact: 'service_reference',
    catalogueResolution: 'pending',
    catalogueItemId: null,
    expectedCatalogueRevision: null,
    catalogueCategoryOverrideConfirmed: false,
    catalogueUnitOverrideConfirmed: false,
    proposalId: null,
    proposalRevision: null,
    proposalDiffHash: null,
    updatedAt: input.occurredAt,
  });
}

export function presentQuoteLineProposalOnWork(input: {
  readonly workItem: AgentMissionQuoteLineWork;
  readonly expectedRevision: number;
  readonly facts: ResolvedAgentMissionQuoteLineFacts;
  readonly proposalId: string;
  readonly proposalDiffHash: string;
  readonly occurredAt: Instant;
}): AgentMissionQuoteLineWorkTransitionResult {
  const preparation = prepareTransition(input);
  if (preparation !== null) return preparation;
  if (
    input.workItem.state !== 'queued'
    || input.workItem.catalogueResolution === 'pending'
  ) {
    return invalidTransition(input.workItem, 'present_line_proposal');
  }
  return transitionValue({
    ...input.workItem,
    ...input.facts,
    revision: input.workItem.revision + 1,
    state: 'awaiting_confirmation',
    requiredFact: null,
    proposalId: input.proposalId,
    proposalRevision: AGENT_MISSION_QUOTE_LINE_PROPOSAL_REVISION,
    proposalDiffHash: input.proposalDiffHash,
    updatedAt: input.occurredAt,
  });
}

export function rejectQuoteLineProposalOnWork(input: {
  readonly workItem: AgentMissionQuoteLineWork;
  readonly expectedRevision: number;
  readonly proposalId: string;
  readonly occurredAt: Instant;
}): AgentMissionQuoteLineWorkTransitionResult {
  const preparation = prepareTransition(input);
  if (preparation !== null) return preparation;
  if (
    input.workItem.state !== 'awaiting_confirmation'
    || input.workItem.proposalId !== input.proposalId
  ) {
    return invalidTransition(input.workItem, 'reject_line_proposal');
  }
  return transitionValue({
    ...input.workItem,
    revision: input.workItem.revision + 1,
    state: 'awaiting_details',
    requiredFact: null,
    proposalId: null,
    proposalRevision: null,
    proposalDiffHash: null,
    updatedAt: input.occurredAt,
  });
}

/**
 * Invalide une proposition dont une autorité relue a changé entre présentation et décision.
 * Une révision catalogue perdue exige une nouvelle confirmation de référence ; un changement
 * fiscal/diff remet seulement la tête en file afin de recalculer une proposition fraîche.
 */
export function invalidateQuoteLineProposalOnWork(input: {
  readonly workItem: AgentMissionQuoteLineWork;
  readonly expectedRevision: number;
  readonly reason: 'catalogue_stale' | 'proposal_stale';
  readonly occurredAt: Instant;
}): AgentMissionQuoteLineWorkTransitionResult {
  const preparation = prepareTransition(input);
  if (preparation !== null) return preparation;
  if (
    input.workItem.state !== 'awaiting_confirmation'
    || input.workItem.proposalId === null
  ) {
    return invalidTransition(input.workItem, 'reject_line_proposal');
  }
  const catalogueStale = input.reason === 'catalogue_stale';
  return transitionValue({
    ...input.workItem,
    revision: input.workItem.revision + 1,
    state: catalogueStale ? 'awaiting_details' : 'queued',
    requiredFact: catalogueStale ? 'service_reference' : null,
    ...(catalogueStale
      ? {
          catalogueResolution: 'pending' as const,
          catalogueItemId: null,
          expectedCatalogueRevision: null,
          catalogueCategoryOverrideConfirmed: false,
          catalogueUnitOverrideConfirmed: false,
        }
      : {}),
    proposalId: null,
    proposalRevision: null,
    proposalDiffHash: null,
    updatedAt: input.occurredAt,
  });
}

/**
 * Frontière M2-A-1 : présente des choix sans copier la moindre valeur catalogue dans le work.
 */
export function presentCatalogueChoicesOnQuoteLineWork(input: {
  readonly workItem: AgentMissionQuoteLineWork;
  readonly expectedRevision: number;
  readonly occurredAt: Instant;
}): AgentMissionQuoteLineWorkTransitionResult {
  const preparation = prepareTransition(input);
  if (preparation !== null) return preparation;
  if (
    input.workItem.state !== 'queued'
    || input.workItem.catalogueResolution !== 'pending'
    || input.workItem.serviceReference === null
  ) {
    return invalidTransition(input.workItem, 'present_catalogue_choices');
  }
  return transitionValue({
    ...input.workItem,
    revision: input.workItem.revision + 1,
    state: 'awaiting_catalogue_choice',
    requiredFact: null,
    catalogueItemId: null,
    expectedCatalogueRevision: null,
    catalogueCategoryOverrideConfirmed: false,
    catalogueUnitOverrideConfirmed: false,
    proposalId: null,
    proposalRevision: null,
    proposalDiffHash: null,
    updatedAt: input.occurredAt,
  });
}

/**
 * Zéro candidat est un fait BDD réel : la tête reste `queued`, explicitement résolue en libre.
 */
export function recordCatalogueNotFoundOnQuoteLineWork(input: {
  readonly workItem: AgentMissionQuoteLineWork;
  readonly expectedRevision: number;
  readonly occurredAt: Instant;
}): AgentMissionQuoteLineWorkTransitionResult {
  const preparation = prepareTransition(input);
  if (preparation !== null) return preparation;
  if (
    input.workItem.state !== 'queued'
    || input.workItem.catalogueResolution !== 'pending'
    || input.workItem.serviceReference === null
  ) {
    return invalidTransition(input.workItem, 'record_catalogue_not_found');
  }
  return transitionValue({
    ...input.workItem,
    revision: input.workItem.revision + 1,
    state: 'queued',
    requiredFact: null,
    catalogueResolution: 'free',
    catalogueItemId: null,
    expectedCatalogueRevision: null,
    catalogueCategoryOverrideConfirmed: false,
    catalogueUnitOverrideConfirmed: false,
    proposalId: null,
    proposalRevision: null,
    proposalDiffHash: null,
    updatedAt: input.occurredAt,
  });
}

/**
 * Consomme le `choiceId` déjà autorisé par l'agrégat mission. Seule la fence catalogue change.
 */
export function consumeCatalogueChoiceOnQuoteLineWork(input: {
  readonly workItem: AgentMissionQuoteLineWork;
  readonly expectedRevision: number;
  readonly resolution: AgentMissionQuoteLineCatalogueChoiceResolution;
  readonly occurredAt: Instant;
}): AgentMissionQuoteLineWorkTransitionResult {
  const preparation = prepareTransition(input);
  if (preparation !== null) return preparation;
  if (
    input.workItem.state !== 'awaiting_catalogue_choice'
    || input.workItem.catalogueResolution !== 'pending'
  ) {
    return invalidTransition(input.workItem, 'consume_catalogue_choice');
  }
  if (
    !isRecord(input.resolution)
    || (
      input.resolution.kind === 'free'
        ? !hasExactKeys(input.resolution, ['kind'])
        : input.resolution.kind === 'selected'
          ? !hasExactKeys(input.resolution, [
              'kind',
              'catalogueItemId',
              'expectedCatalogueRevision',
            ])
          : true
    )
  ) {
    return transitionFailure({
      code: 'invalid_agent_mission_quote_line_work',
      field: 'resolution',
      reason: 'invalid_shape',
    });
  }

  return transitionValue({
    ...input.workItem,
    revision: input.workItem.revision + 1,
    state: 'queued',
    requiredFact: null,
    catalogueResolution: input.resolution.kind,
    catalogueItemId: input.resolution.kind === 'selected'
      ? input.resolution.catalogueItemId
      : null,
    expectedCatalogueRevision: input.resolution.kind === 'selected'
      ? input.resolution.expectedCatalogueRevision
      : null,
    catalogueCategoryOverrideConfirmed: false,
    catalogueUnitOverrideConfirmed: false,
    proposalId: null,
    proposalRevision: null,
    proposalDiffHash: null,
    updatedAt: input.occurredAt,
  });
}

export function invalidateCatalogueChoiceOnQuoteLineWork(input: {
  readonly workItem: AgentMissionQuoteLineWork;
  readonly expectedRevision: number;
  readonly occurredAt: Instant;
}): AgentMissionQuoteLineWorkTransitionResult {
  const preparation = prepareTransition(input);
  if (preparation !== null) return preparation;
  if (
    input.workItem.state !== 'awaiting_catalogue_choice'
    || input.workItem.catalogueResolution !== 'pending'
  ) {
    return invalidTransition(input.workItem, 'invalidate_catalogue_choice');
  }
  return transitionValue({
    ...input.workItem,
    revision: input.workItem.revision + 1,
    state: 'queued',
    requiredFact: null,
    catalogueResolution: 'pending',
    catalogueItemId: null,
    expectedCatalogueRevision: null,
    catalogueCategoryOverrideConfirmed: false,
    catalogueUnitOverrideConfirmed: false,
    proposalId: null,
    proposalRevision: null,
    proposalDiffHash: null,
    updatedAt: input.occurredAt,
  });
}
