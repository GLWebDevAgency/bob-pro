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
  isVatRate,
  type VatRate,
} from '../../domain/billing/shared/vat-rate';
import { type Instant } from '../../shared-kernel/time';
import {
  AGENT_MISSION_OPAQUE_IDENTIFIER_MAX_LENGTH,
  isCanonicalAgentMissionOpaqueIdentifier,
} from './agent-mission-identifiers';

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

export const AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS = [
  'service_reference',
  'category',
  'quantity',
  'unit',
  'unit_price',
  'vat_rate',
  'housing_older_than_2y',
  'energy_renovation',
] as const;

export type AgentMissionQuoteLineRequiredFact =
  (typeof AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS)[number];

export const AGENT_MISSION_QUOTE_LINE_PRICE_BASES = [
  'per_unit',
  'total',
] as const;

export type AgentMissionQuoteLinePriceBasis =
  (typeof AGENT_MISSION_QUOTE_LINE_PRICE_BASES)[number];

export const AGENT_MISSION_QUOTE_LINE_MAX_WORK_ITEMS = 20;
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
  readonly catalogueItemId: string | null;
  readonly expectedCatalogueRevision: number | null;
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

export const AGENT_MISSION_QUOTE_LINE_WORK_KEYS = [
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
  'catalogueItemId',
  'expectedCatalogueRevision',
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
        && allNull(catalogueFence)
        && allNull(proposal)
        ? null
        : fail('state', 'inconsistent_state');
    case 'awaiting_catalogue_choice':
      return value['serviceReference'] !== null
        && value['requiredFact'] === null
        && allNull(catalogueFence)
        && allNull(proposal)
        ? null
        : fail('state', 'inconsistent_state');
    case 'awaiting_details':
      return value['requiredFact'] !== null && allNull(proposal)
        ? null
        : fail('state', 'inconsistent_state');
    case 'awaiting_confirmation':
      return value['serviceReference'] !== null
        && value['category'] !== null
        && value['quantityMilli'] !== null
        && value['unit'] !== null
        && value['unitPriceCents'] !== null
        && value['requestedVatRate'] !== null
        && value['priceBasis'] !== null
        && value['requiredFact'] === null
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
  if (!isRecord(input) || !hasExactKeys(input, AGENT_MISSION_QUOTE_LINE_WORK_KEYS)) {
    return fail('$', 'invalid_shape');
  }

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
    || (input['ordinal'] as number) > AGENT_MISSION_QUOTE_LINE_MAX_WORK_ITEMS
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
      catalogueItemId: input['catalogueItemId'] as string | null,
      expectedCatalogueRevision: input['expectedCatalogueRevision'] as number | null,
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
