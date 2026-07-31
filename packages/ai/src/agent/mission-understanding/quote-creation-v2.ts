import {
  normalizeAgentMissionQuoteLinePatch,
  type AgentMissionQuoteLinePatchScope,
  type AgentMissionQuoteLinePatchV1,
  type AgentMissionQuoteLineRequiredFact,
} from '@bob/core';
import type {
  LlmToolCall,
  LlmToolSpec,
} from '../../llm/port';

const MAX_REFERENCE_LENGTH = 500;
// QuoteDraftPayloadV1 reste lu par N-1 et borne l'unité à 40 caractères.
const MAX_UNIT_LENGTH = 40;
const MAX_MODEL_LENGTH = 200;
// M2-A-1 applique une seule transition autoritaire enrichie de 0..20 lignes. Autoriser vingt
// opérations dans le schéma tout en n'en exécutant qu'une rendrait une sortie LLM conforme mais
// inutilisable. Les séquences multi-transitions seront ouvertes avec leur orchestrateur dédié.
const MAX_OPERATIONS = 1;
const MAX_LINES = 20;
const MAX_FRAME_BYTES = 32 * 1024;
const MAX_PRESENTED_CHOICES = 6;

const CATEGORY_HINTS = ['labor', 'supply', 'travel', 'subscription'] as const;
const PRICE_BASES = ['per_unit', 'total'] as const;
const VAT_RATE_HINTS = ['0', '2.1', '5.5', '10', '20'] as const;
const PATCH_SCOPES = ['answer_required_fact', 'explicit_correction'] as const;

export type QuoteCreationUnderstandingPhaseV2 =
  | 'inactive'
  | 'awaiting_customer'
  | 'awaiting_customer_choice'
  | 'awaiting_lines'
  | 'awaiting_catalogue_choice'
  | 'awaiting_line_details'
  | 'awaiting_line_confirmation';

export interface QuoteLineCandidateV1 {
  readonly serviceReference: string | null;
  readonly categoryHint: (typeof CATEGORY_HINTS)[number] | null;
  readonly quantityDecimal: string | null;
  readonly unitReference: string | null;
  readonly unitPriceDecimal: string | null;
  readonly currency: 'EUR' | null;
  readonly priceBasis: (typeof PRICE_BASES)[number] | null;
  readonly vatRateHint: (typeof VAT_RATE_HINTS)[number] | null;
}

export type QuoteCreationSemanticOperationV2 =
  | {
      readonly kind: 'start_quote_creation';
      readonly customerReference: string | null;
      readonly lines: readonly QuoteLineCandidateV1[];
    }
  | {
      readonly kind: 'set_customer_reference';
      readonly customerReference: string;
      readonly lines: readonly QuoteLineCandidateV1[];
    }
  | {
      readonly kind: 'append_line_candidates';
      readonly lines: readonly QuoteLineCandidateV1[];
    }
  | {
      readonly kind: 'select_presented_choice';
      readonly ordinal: 1 | 2 | 3 | 4 | 5 | 6;
      /** Une autre demande existe dans le tour et doit être redemandée sans la recopier. */
      readonly hasUnprocessedRequest: boolean;
    }
  | {
      readonly kind: 'patch_pending_line';
      readonly scope: AgentMissionQuoteLinePatchScope;
      readonly patch: AgentMissionQuoteLinePatchV1;
    }
  | { readonly kind: 'confirm_current_proposal' }
  | { readonly kind: 'reject_current_proposal' }
  | { readonly kind: 'cancel_current_line' };

export interface QuoteCreationSemanticFrameV2 {
  readonly schema: 'bob.semantic.quote-creation';
  readonly version: 2;
  readonly operations: readonly QuoteCreationSemanticOperationV2[];
  readonly model: string;
}

const LINE_SCHEMA = {
  type: 'object',
  properties: {
    service_reference: { type: ['string', 'null'], maxLength: MAX_REFERENCE_LENGTH },
    category_hint: { type: ['string', 'null'], enum: [...CATEGORY_HINTS, null] },
    quantity_decimal: { type: ['string', 'null'], maxLength: 64 },
    unit_reference: { type: ['string', 'null'], maxLength: MAX_UNIT_LENGTH },
    unit_price_decimal: { type: ['string', 'null'], maxLength: 64 },
    currency: { type: ['string', 'null'], enum: ['EUR', null] },
    price_basis: { type: ['string', 'null'], enum: [...PRICE_BASES, null] },
    vat_rate_hint: { type: ['string', 'null'], enum: [...VAT_RATE_HINTS, null] },
  },
  required: [
    'service_reference',
    'category_hint',
    'quantity_decimal',
    'unit_reference',
    'unit_price_decimal',
    'currency',
    'price_basis',
    'vat_rate_hint',
  ],
  additionalProperties: false,
} as const;

const LINES_SCHEMA = {
  type: 'array',
  items: LINE_SCHEMA,
  maxItems: MAX_LINES,
} as const;

const SERVICE_REFERENCE_PATCH_SCHEMA = {
      type: 'object',
      properties: {
        field: { type: 'string', const: 'service_reference' },
        value: { type: 'string', maxLength: MAX_REFERENCE_LENGTH },
      },
      required: ['field', 'value'],
      additionalProperties: false,
} as const;

const CATEGORY_PATCH_SCHEMA = {
      type: 'object',
      properties: {
        field: { type: 'string', const: 'category' },
        value: { type: 'string', enum: [...CATEGORY_HINTS] },
      },
      required: ['field', 'value'],
      additionalProperties: false,
} as const;

const QUANTITY_PATCH_SCHEMA = {
      type: 'object',
      properties: {
        field: { type: 'string', const: 'quantity' },
        decimal: { type: 'string', maxLength: 64 },
      },
      required: ['field', 'decimal'],
      additionalProperties: false,
} as const;

const UNIT_PATCH_SCHEMA = {
      type: 'object',
      properties: {
        field: { type: 'string', const: 'unit' },
        value: { type: 'string', maxLength: MAX_UNIT_LENGTH },
      },
      required: ['field', 'value'],
      additionalProperties: false,
} as const;

const UNIT_PRICE_PATCH_SCHEMA = {
      type: 'object',
      properties: {
        field: { type: 'string', const: 'unit_price' },
        decimal: { type: 'string', maxLength: 64 },
        currency: { type: 'string', const: 'EUR' },
        basis: { type: 'string', enum: [...PRICE_BASES] },
      },
      required: ['field', 'decimal', 'currency', 'basis'],
      additionalProperties: false,
} as const;

const VAT_RATE_PATCH_SCHEMA = {
      type: 'object',
      properties: {
        field: { type: 'string', const: 'vat_rate' },
        value: { type: 'string', enum: [...VAT_RATE_HINTS] },
      },
      required: ['field', 'value'],
      additionalProperties: false,
} as const;

const HOUSING_OLDER_THAN_2Y_PATCH_SCHEMA = {
      type: 'object',
      properties: {
        field: { type: 'string', const: 'housing_older_than_2y' },
        value: { type: 'boolean' },
      },
      required: ['field', 'value'],
      additionalProperties: false,
} as const;

const ENERGY_RENOVATION_PATCH_SCHEMA = {
      type: 'object',
      properties: {
        field: { type: 'string', const: 'energy_renovation' },
        value: { type: 'boolean' },
      },
      required: ['field', 'value'],
      additionalProperties: false,
} as const;

const PATCH_SCHEMA_BY_REQUIRED_FACT = {
  service_reference: SERVICE_REFERENCE_PATCH_SCHEMA,
  category: CATEGORY_PATCH_SCHEMA,
  quantity: QUANTITY_PATCH_SCHEMA,
  unit: UNIT_PATCH_SCHEMA,
  unit_price: UNIT_PRICE_PATCH_SCHEMA,
  vat_rate: VAT_RATE_PATCH_SCHEMA,
  housing_older_than_2y: HOUSING_OLDER_THAN_2Y_PATCH_SCHEMA,
  energy_renovation: ENERGY_RENOVATION_PATCH_SCHEMA,
} as const satisfies Readonly<
  Record<AgentMissionQuoteLineRequiredFact, Readonly<Record<string, unknown>>>
>;

const PATCH_SCHEMA = {
  anyOf: [
    SERVICE_REFERENCE_PATCH_SCHEMA,
    CATEGORY_PATCH_SCHEMA,
    QUANTITY_PATCH_SCHEMA,
    UNIT_PATCH_SCHEMA,
    UNIT_PRICE_PATCH_SCHEMA,
    VAT_RATE_PATCH_SCHEMA,
    HOUSING_OLDER_THAN_2Y_PATCH_SCHEMA,
    ENERGY_RENOVATION_PATCH_SCHEMA,
  ],
} as const;

const QUOTE_CREATION_V2_TOOL_NAME = 'mettre_a_jour_mission_devis_v2';

const START_OPERATION_SCHEMA = {
  type: 'object',
  description:
    'Démarrer un devis depuis une demande explicite. Extraire le client et toutes les lignes dites dans le même énoncé, sans compléter les faits absents.',
  properties: {
    kind: { type: 'string', const: 'start_quote_creation' },
    customer_reference: {
      type: ['string', 'null'],
      maxLength: MAX_REFERENCE_LENGTH,
    },
    lines: LINES_SCHEMA,
  },
  required: ['kind', 'customer_reference', 'lines'],
  additionalProperties: false,
} as const;

const SET_CUSTOMER_OPERATION_SCHEMA = {
  type: 'object',
  description:
    'Renseigner une référence client explicitement prononcée pendant une mission déjà ouverte ; conserver aussi les lignes dites dans le même tour.',
  properties: {
    kind: { type: 'string', const: 'set_customer_reference' },
    customer_reference: { type: 'string', maxLength: MAX_REFERENCE_LENGTH },
    lines: LINES_SCHEMA,
  },
  required: ['kind', 'customer_reference', 'lines'],
  additionalProperties: false,
} as const;

const APPEND_LINES_OPERATION_SCHEMA = {
  type: 'object',
  description:
    "Ajouter dans l'ordre une ou plusieurs lignes explicitement décrites dans la parole courante. Un chiffre contenu dans un nom métier ne devient jamais une quantité. Une TVA absente reste null et ne devient jamais 0.",
  properties: {
    kind: { type: 'string', const: 'append_line_candidates' },
    lines: LINES_SCHEMA,
  },
  required: ['kind', 'lines'],
  additionalProperties: false,
} as const;

const SELECT_CHOICE_OPERATION_SCHEMA = {
  type: 'object',
  description:
    "Choisir uniquement parmi C1…C6 actuellement présentés. Une description comme « celle à 55 euros » doit être résolue vers l'ordinal correspondant aux données visibles. Ne jamais recopier une ligne, un choix ou le contexte dans cette opération.",
  properties: {
    kind: { type: 'string', const: 'select_presented_choice' },
    ordinal: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_PRESENTED_CHOICES,
    },
    has_unprocessed_request: {
      type: 'boolean',
      description:
        'true uniquement si la parole courante contient une autre demande en plus du choix ; cette demande ne doit jamais être recopiée dans cette opération.',
    },
  },
  required: ['kind', 'ordinal', 'has_unprocessed_request'],
  additionalProperties: false,
} as const;

const EXPLICIT_PATCH_OPERATION_SCHEMA = {
  type: 'object',
  description:
    'Corriger spontanément un seul fait nommé de la ligne courante.',
  properties: {
    kind: { type: 'string', const: 'patch_pending_line' },
    scope: { type: 'string', const: 'explicit_correction' },
    patch: PATCH_SCHEMA,
  },
  required: ['kind', 'scope', 'patch'],
  additionalProperties: false,
} as const;

function answerRequiredFactPatchOperationSchema(
  requiredFact: AgentMissionQuoteLineRequiredFact,
) {
  return {
    type: 'object',
    description:
      'Répondre uniquement au fait précis demandé par Bob. Le champ est imposé par la mission persistée.',
    properties: {
      kind: { type: 'string', const: 'patch_pending_line' },
      scope: { type: 'string', const: 'answer_required_fact' },
      patch: PATCH_SCHEMA_BY_REQUIRED_FACT[requiredFact],
    },
    required: ['kind', 'scope', 'patch'],
    additionalProperties: false,
  } as const;
}

const CATALOGUE_REFERENCE_PATCH_OPERATION_SCHEMA = {
  type: 'object',
  description:
    'Corriger explicitement le libellé de la ligne avant de relancer la recherche catalogue.',
  properties: {
    kind: { type: 'string', const: 'patch_pending_line' },
    scope: { type: 'string', const: 'explicit_correction' },
    patch: {
      type: 'object',
      properties: {
        field: { type: 'string', const: 'service_reference' },
        value: { type: 'string', maxLength: MAX_REFERENCE_LENGTH },
      },
      required: ['field', 'value'],
      additionalProperties: false,
    },
  },
  required: ['kind', 'scope', 'patch'],
  additionalProperties: false,
} as const;

const CONFIRM_OPERATION_SCHEMA = {
  type: 'object',
  description: 'Confirmer la proposition courante uniquement quand elle est présentée.',
  properties: { kind: { type: 'string', const: 'confirm_current_proposal' } },
  required: ['kind'],
  additionalProperties: false,
} as const;

const REJECT_OPERATION_SCHEMA = {
  type: 'object',
  description: 'Refuser la proposition courante tout en conservant la ligne à corriger.',
  properties: { kind: { type: 'string', const: 'reject_current_proposal' } },
  required: ['kind'],
  additionalProperties: false,
} as const;

const CANCEL_OPERATION_SCHEMA = {
  type: 'object',
  description: 'Annuler uniquement la ligne courante, jamais la session Bob entière.',
  properties: { kind: { type: 'string', const: 'cancel_current_line' } },
  required: ['kind'],
  additionalProperties: false,
} as const;

type OperationSchema =
  | typeof START_OPERATION_SCHEMA
  | typeof SET_CUSTOMER_OPERATION_SCHEMA
  | typeof APPEND_LINES_OPERATION_SCHEMA
  | typeof SELECT_CHOICE_OPERATION_SCHEMA
  | typeof EXPLICIT_PATCH_OPERATION_SCHEMA
  | ReturnType<typeof answerRequiredFactPatchOperationSchema>
  | typeof CATALOGUE_REFERENCE_PATCH_OPERATION_SCHEMA
  | typeof CONFIRM_OPERATION_SCHEMA
  | typeof REJECT_OPERATION_SCHEMA
  | typeof CANCEL_OPERATION_SCHEMA;

function operationSchemasForPhase(
  phase: QuoteCreationUnderstandingPhaseV2,
  requiredFact: AgentMissionQuoteLineRequiredFact | null,
): readonly OperationSchema[] {
  switch (phase) {
    case 'inactive':
      return [START_OPERATION_SCHEMA];
    case 'awaiting_customer':
      return [SET_CUSTOMER_OPERATION_SCHEMA];
    case 'awaiting_customer_choice':
      return [SET_CUSTOMER_OPERATION_SCHEMA, SELECT_CHOICE_OPERATION_SCHEMA];
    case 'awaiting_lines':
      return [APPEND_LINES_OPERATION_SCHEMA];
    case 'awaiting_catalogue_choice':
      return [SELECT_CHOICE_OPERATION_SCHEMA, CATALOGUE_REFERENCE_PATCH_OPERATION_SCHEMA];
    case 'awaiting_line_details':
      return [
        ...(requiredFact === null
          ? []
          : [answerRequiredFactPatchOperationSchema(requiredFact)]),
        EXPLICIT_PATCH_OPERATION_SCHEMA,
        CANCEL_OPERATION_SCHEMA,
      ];
    case 'awaiting_line_confirmation':
      return [
        EXPLICIT_PATCH_OPERATION_SCHEMA,
        CONFIRM_OPERATION_SCHEMA,
        REJECT_OPERATION_SCHEMA,
        CANCEL_OPERATION_SCHEMA,
      ];
  }
}

export function quoteCreationUnderstandingToolV2ForPhase(
  phase: QuoteCreationUnderstandingPhaseV2,
  requiredFact: AgentMissionQuoteLineRequiredFact | null = null,
): LlmToolSpec {
  const operationSchemas = operationSchemasForPhase(phase, requiredFact);
  const items = operationSchemas.length === 1 ? operationSchemas[0] : { anyOf: operationSchemas };
  return Object.freeze({
    name: QUOTE_CREATION_V2_TOOL_NAME,
    description:
      "Comprendre la prochaine transition autorisée d'une mission de devis en français et restituer uniquement les faits explicitement dits. Ne jamais choisir d'identifiant, calculer un total ou convertir une absence en valeur.",
    schemaAdherence: 'strict',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_OPERATIONS,
          items,
        },
      },
      required: ['operations'],
      additionalProperties: false,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

function hasControlCharacter(value: string, allowFormattingWhitespace = false): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (
      point === 127
      || (point >= 128 && point <= 159)
      || (
        point < 32
        && !(allowFormattingWhitespace && (point === 9 || point === 10 || point === 13))
      )
    );
  });
}

function canonicalSingleLine(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string' || hasControlCharacter(value)) return null;
  const canonical = value.trim().replace(/\s+/gu, ' ');
  return canonical.length >= 1 && canonical.length <= maximumLength ? canonical : null;
}

function canonicalDecimal(
  value: unknown,
  maximumFractionDigits: 2 | 3,
): string | null {
  if (typeof value !== 'string') return null;
  const pattern = maximumFractionDigits === 2
    ? /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/u
    : /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/u;
  return value.length <= 64 && pattern.test(value) ? value : null;
}

function parseNullableReference(value: unknown, maximumLength: number): string | null | undefined {
  if (value === null) return null;
  const canonical = canonicalSingleLine(value, maximumLength);
  return canonical ?? undefined;
}

function parseLine(value: unknown): QuoteLineCandidateV1 | null {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      'service_reference',
      'category_hint',
      'quantity_decimal',
      'unit_reference',
      'unit_price_decimal',
      'currency',
      'price_basis',
      'vat_rate_hint',
    ])
  ) return null;

  const serviceReference = parseNullableReference(
    value['service_reference'],
    MAX_REFERENCE_LENGTH,
  );
  const unitReference = parseNullableReference(value['unit_reference'], MAX_UNIT_LENGTH);
  const quantityDecimal = value['quantity_decimal'] === null
    ? null
    : canonicalDecimal(value['quantity_decimal'], 3);
  const unitPriceDecimal = value['unit_price_decimal'] === null
    ? null
    : canonicalDecimal(value['unit_price_decimal'], 2);
  if (
    serviceReference === undefined
    || unitReference === undefined
    || (value['quantity_decimal'] !== null && quantityDecimal === null)
    || (value['unit_price_decimal'] !== null && unitPriceDecimal === null)
    || (
      value['category_hint'] !== null
      && !isOneOf(CATEGORY_HINTS, value['category_hint'])
    )
    || (value['currency'] !== null && value['currency'] !== 'EUR')
    || (value['price_basis'] !== null && !isOneOf(PRICE_BASES, value['price_basis']))
    || (value['vat_rate_hint'] !== null && !isOneOf(VAT_RATE_HINTS, value['vat_rate_hint']))
    || ((unitPriceDecimal === null) !== (value['currency'] === null))
    || ((unitPriceDecimal === null) !== (value['price_basis'] === null))
  ) return null;

  return Object.freeze({
    serviceReference,
    categoryHint: value['category_hint'] as QuoteLineCandidateV1['categoryHint'],
    quantityDecimal,
    unitReference,
    unitPriceDecimal,
    currency: value['currency'] as 'EUR' | null,
    priceBasis: value['price_basis'] as QuoteLineCandidateV1['priceBasis'],
    vatRateHint: value['vat_rate_hint'] as QuoteLineCandidateV1['vatRateHint'],
  });
}

function parseLines(value: unknown): readonly QuoteLineCandidateV1[] | null {
  if (!Array.isArray(value) || value.length > MAX_LINES) return null;
  const parsed = value.map(parseLine);
  return parsed.some((line) => line === null)
    ? null
    : Object.freeze(parsed as QuoteLineCandidateV1[]);
}

function parsePatch(value: unknown): AgentMissionQuoteLinePatchV1 | null {
  if (!isRecord(value) || typeof value['field'] !== 'string') return null;
  const normalized = normalizeAgentMissionQuoteLinePatch(value);
  if (!normalized.ok) return null;
  switch (value['field']) {
    case 'service_reference': {
      if (!exactKeys(value, ['field', 'value'])) return null;
      const canonical = canonicalSingleLine(value['value'], MAX_REFERENCE_LENGTH);
      return canonical === null
        ? null
        : Object.freeze({ field: value['field'], value: canonical });
    }
    case 'category':
      return exactKeys(value, ['field', 'value']) && isOneOf(CATEGORY_HINTS, value['value'])
        ? Object.freeze({ field: value['field'], value: value['value'] })
        : null;
    case 'quantity': {
      if (!exactKeys(value, ['field', 'decimal'])) return null;
      const decimal = canonicalDecimal(value['decimal'], 3);
      return decimal === null
        ? null
        : Object.freeze({ field: value['field'], decimal });
    }
    case 'unit': {
      if (!exactKeys(value, ['field', 'value'])) return null;
      const canonical = canonicalSingleLine(value['value'], MAX_UNIT_LENGTH);
      return canonical === null
        ? null
        : Object.freeze({ field: value['field'], value: canonical });
    }
    case 'unit_price': {
      if (
        !exactKeys(value, ['field', 'decimal', 'currency', 'basis'])
        || value['currency'] !== 'EUR'
        || !isOneOf(PRICE_BASES, value['basis'])
      ) return null;
      const decimal = canonicalDecimal(value['decimal'], 2);
      return decimal === null
        ? null
        : Object.freeze({
            field: value['field'],
            decimal,
            currency: value['currency'],
            basis: value['basis'],
          });
    }
    case 'vat_rate':
      return exactKeys(value, ['field', 'value']) && isOneOf(VAT_RATE_HINTS, value['value'])
        ? Object.freeze({ field: value['field'], value: value['value'] })
        : null;
    case 'housing_older_than_2y':
    case 'energy_renovation':
      return exactKeys(value, ['field', 'value']) && typeof value['value'] === 'boolean'
        ? Object.freeze({ field: value['field'], value: value['value'] })
        : null;
    default:
      return null;
  }
}

function phaseAllows(
  phase: QuoteCreationUnderstandingPhaseV2,
  operation: QuoteCreationSemanticOperationV2,
): boolean {
  switch (phase) {
    case 'inactive':
      return operation.kind === 'start_quote_creation';
    case 'awaiting_customer':
      return operation.kind === 'set_customer_reference';
    case 'awaiting_customer_choice':
      return (
        operation.kind === 'set_customer_reference' || operation.kind === 'select_presented_choice'
      );
    case 'awaiting_lines':
      return operation.kind === 'append_line_candidates';
    case 'awaiting_catalogue_choice':
      return (
        operation.kind === 'select_presented_choice' ||
        (operation.kind === 'patch_pending_line' &&
          operation.scope === 'explicit_correction' &&
          operation.patch.field === 'service_reference')
        );
    case 'awaiting_line_details':
      return operation.kind === 'patch_pending_line' || operation.kind === 'cancel_current_line';
    case 'awaiting_line_confirmation':
      return (
        operation.kind === 'patch_pending_line' ||
        operation.kind === 'confirm_current_proposal' ||
        operation.kind === 'reject_current_proposal' ||
        operation.kind === 'cancel_current_line'
      );
  }
}

function parseOperation(
  value: unknown,
  input: {
    readonly phase: QuoteCreationUnderstandingPhaseV2;
    readonly presentedChoiceCount: number;
    readonly requiredFact: AgentMissionQuoteLineRequiredFact | null;
  },
): QuoteCreationSemanticOperationV2 | null {
  if (!isRecord(value) || typeof value['kind'] !== 'string') return null;
  let operation: QuoteCreationSemanticOperationV2 | null = null;
  if (value['kind'] === 'start_quote_creation') {
    if (!exactKeys(value, ['kind', 'customer_reference', 'lines'])) return null;
    const reference = parseNullableReference(value['customer_reference'], MAX_REFERENCE_LENGTH);
    const lines = parseLines(value['lines']);
    if (reference !== undefined && lines !== null) {
      operation = Object.freeze({
        kind: value['kind'],
        customerReference: reference,
        lines,
      });
    }
  } else if (value['kind'] === 'set_customer_reference') {
    if (!exactKeys(value, ['kind', 'customer_reference', 'lines'])) return null;
    const reference = canonicalSingleLine(value['customer_reference'], MAX_REFERENCE_LENGTH);
    const lines = parseLines(value['lines']);
    if (reference !== null && lines !== null) {
      operation = Object.freeze({
        kind: value['kind'],
        customerReference: reference,
        lines,
      });
    }
  } else if (value['kind'] === 'append_line_candidates') {
    if (!exactKeys(value, ['kind', 'lines'])) return null;
    const lines = parseLines(value['lines']);
    if (lines !== null && lines.length > 0) {
      operation = Object.freeze({ kind: value['kind'], lines });
    }
  } else if (value['kind'] === 'select_presented_choice') {
    if (
      !exactKeys(value, ['kind', 'ordinal', 'has_unprocessed_request']) ||
      !Number.isInteger(value['ordinal']) ||
      (value['ordinal'] as number) < 1 ||
      (value['ordinal'] as number) > input.presentedChoiceCount ||
      typeof value['has_unprocessed_request'] !== 'boolean'
    )
      return null;
      operation = Object.freeze({
        kind: value['kind'],
        ordinal: value['ordinal'] as 1 | 2 | 3 | 4 | 5 | 6,
      hasUnprocessedRequest: value['has_unprocessed_request'],
      });
  } else if (value['kind'] === 'patch_pending_line') {
    if (!exactKeys(value, ['kind', 'scope', 'patch']) || !isOneOf(PATCH_SCOPES, value['scope']))
      return null;
    const patch = parsePatch(value['patch']);
    if (
      patch !== null &&
      (value['scope'] === 'explicit_correction' ||
        (input.requiredFact !== null && patch.field === input.requiredFact))
    ) {
      operation = Object.freeze({
        kind: value['kind'],
        scope: value['scope'],
        patch,
      });
    }
  } else if (
    value['kind'] === 'confirm_current_proposal'
    || value['kind'] === 'reject_current_proposal'
    || value['kind'] === 'cancel_current_line'
  ) {
    if (exactKeys(value, ['kind'])) operation = Object.freeze({ kind: value['kind'] });
  }
  return operation !== null && phaseAllows(input.phase, operation) ? operation : null;
}

function frameByteLength(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
}

function validOperationSequence(
  _phase: QuoteCreationUnderstandingPhaseV2,
  operations: readonly QuoteCreationSemanticOperationV2[],
): boolean {
  return operations.length === 1;
}

export function parseQuoteCreationSemanticToolCallV2(input: {
  readonly call: LlmToolCall;
  readonly phase: QuoteCreationUnderstandingPhaseV2;
  readonly presentedChoiceCount: number;
  readonly requiredFact: AgentMissionQuoteLineRequiredFact | null;
  readonly model: string;
}): QuoteCreationSemanticFrameV2 | null {
  if (
    input.call.name !== QUOTE_CREATION_V2_TOOL_NAME
    || !isRecord(input.call.arguments)
    || !exactKeys(input.call.arguments, ['operations'])
    || !Array.isArray(input.call.arguments['operations'])
    || input.call.arguments['operations'].length > MAX_OPERATIONS
  ) return null;
  const operations = input.call.arguments['operations'].map((operation) => (
    parseOperation(operation, input)
  ));
  if (
    operations.some((operation) => operation === null)
    || !validOperationSequence(
      input.phase,
      operations as QuoteCreationSemanticOperationV2[],
    )
  ) return null;
  const lineCount = (operations as QuoteCreationSemanticOperationV2[]).reduce(
    (count, operation) => count + ('lines' in operation ? operation.lines.length : 0),
    0,
  );
  const model = canonicalSingleLine(input.model, MAX_MODEL_LENGTH);
  if (lineCount > MAX_LINES || model === null) return null;
  const frame: QuoteCreationSemanticFrameV2 = Object.freeze({
    schema: 'bob.semantic.quote-creation',
    version: 2,
    operations: Object.freeze(operations as QuoteCreationSemanticOperationV2[]),
    model,
  });
  const bytes = frameByteLength(frame);
  return bytes !== null && bytes <= MAX_FRAME_BYTES ? frame : null;
}
