import { hasAsciiControlCharacter } from '../../shared-kernel/control-characters';
import {
  parseQuoteDraftPayload,
  QUOTE_DRAFT_REVISION_MAX,
  type QuoteDraftPayloadLine,
  type QuoteDraftPayloadLineMetadata,
  type QuoteDraftPayloadV1,
  type QuoteDraftPayloadResult,
} from './quote-draft-slot';

export interface QuoteDraftCustomerSelection {
  readonly id: string;
  readonly name: string;
}

export interface QuoteDraftCustomerSelectionState {
  readonly step: QuoteDraftPayloadV1['draft']['step'];
  readonly customer: QuoteDraftPayloadV1['draft']['customer'];
  readonly contentRevision: number;
}

export type QuoteDraftCustomerSelectionTransitionErrorCode =
  | 'invalid_customer_selection'
  | 'invalid_quote_draft_step'
  | 'quote_draft_revision_overflow';

export type QuoteDraftCustomerSelectionTransitionErrorField =
  | 'customer'
  | 'step'
  | 'contentRevision';

export type QuoteDraftCustomerSelectionTransitionResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly step: 'lignes';
        readonly customer: QuoteDraftCustomerSelection;
        readonly contentRevision: number;
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: QuoteDraftCustomerSelectionTransitionErrorCode;
        readonly field: QuoteDraftCustomerSelectionTransitionErrorField;
      };
    };

function invalid(
  code: QuoteDraftCustomerSelectionTransitionErrorCode,
  field: QuoteDraftCustomerSelectionTransitionErrorField,
): QuoteDraftCustomerSelectionTransitionResult {
  return { ok: false, error: { code, field } };
}

function canonicalIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string'
    && value.length >= 1
    && value.length <= maxLength
    && value === value.trim()
    && !hasAsciiControlCharacter(value)
  );
}

/**
 * Règle pure commune au writer serveur et au wizard manuel : sélectionner un client réel puis
 * avancer d'un seul commit logique vers l'étape lignes.
 */
export function deriveQuoteDraftCustomerSelectionTransition(
  state: QuoteDraftCustomerSelectionState,
  customer: QuoteDraftCustomerSelection,
): QuoteDraftCustomerSelectionTransitionResult {
  if (
    !canonicalIdentifier(customer?.id, 200)
    || !canonicalIdentifier(customer?.name, 300)
  ) {
    return invalid('invalid_customer_selection', 'customer');
  }
  if (state.step !== 'client' || state.customer !== null) {
    return invalid('invalid_quote_draft_step', 'step');
  }
  if (
    !Number.isSafeInteger(state.contentRevision)
    || state.contentRevision < 0
    || state.contentRevision >= QUOTE_DRAFT_REVISION_MAX
  ) {
    return invalid('quote_draft_revision_overflow', 'contentRevision');
  }
  return {
    ok: true,
    value: {
      step: 'lignes',
      customer: Object.freeze({ id: customer.id, name: customer.name }),
      contentRevision: state.contentRevision + 1,
    },
  };
}

/** Applique la règle commune au payload durable, puis repasse par le parseur exact du core. */
export function applyQuoteDraftCustomerSelection(
  payload: QuoteDraftPayloadV1,
  customer: QuoteDraftCustomerSelection,
): QuoteDraftPayloadResult {
  const parsed = parseQuoteDraftPayload(payload);
  if (!parsed.ok) return parsed;
  const transition = deriveQuoteDraftCustomerSelectionTransition({
    step: parsed.value.draft.step,
    customer: parsed.value.draft.customer,
    contentRevision: parsed.value.draft.contentRevision,
  }, customer);
  if (!transition.ok) {
    return {
      ok: false,
      error: {
        code: 'invalid_value',
        path: `$.draft.${transition.error.field}`,
      },
    };
  }
  return parseQuoteDraftPayload({
    ...parsed.value,
    draft: {
      ...parsed.value.draft,
      step: transition.value.step,
      customer: transition.value.customer,
      contentRevision: transition.value.contentRevision,
    },
  });
}

/**
 * Ajoute une ligne déjà résolue par les autorités métier.
 *
 * Cette primitive est la frontière partagée entre le wizard manuel et AgentMission : elle ne
 * connaît ni proposition IA, ni capability, ni ORM. Les appelants restent responsables de la
 * relecture fiscale et catalogue ; la primitive protège la forme durable, la révision et
 * l'invariant mono-taux du payload V1.
 */
export function appendResolvedQuoteDraftLine(input: {
  readonly payload: QuoteDraftPayloadV1;
  readonly expectedContentRevision: number;
  readonly resolvedLine: QuoteDraftPayloadLine;
  readonly metadata: QuoteDraftPayloadLineMetadata;
  readonly vatDecision: NonNullable<QuoteDraftPayloadV1['draft']['vatDecision']>;
}): QuoteDraftPayloadResult {
  const parsed = parseQuoteDraftPayload(input.payload);
  if (!parsed.ok) return parsed;
  const draft = parsed.value.draft;
  if (
    !Number.isSafeInteger(input.expectedContentRevision)
    || input.expectedContentRevision < 0
    || input.expectedContentRevision > QUOTE_DRAFT_REVISION_MAX
    || draft.contentRevision !== input.expectedContentRevision
  ) {
    return {
      ok: false,
      error: { code: 'invalid_value', path: '$.draft.contentRevision' },
    };
  }
  if (
    draft.contentRevision === QUOTE_DRAFT_REVISION_MAX
    || draft.stagingRevision === QUOTE_DRAFT_REVISION_MAX
  ) {
    return {
      ok: false,
      error: { code: 'invalid_value', path: '$.draft.revision' },
    };
  }
  if (draft.step !== 'lignes' || draft.customer === null) {
    return {
      ok: false,
      error: { code: 'invalid_value', path: '$.draft.step' },
    };
  }
  if (
    input.resolvedLine.vatRate !== input.vatDecision.rate
    || (
      draft.vatDecision !== null
      && draft.vatDecision.rate !== input.vatDecision.rate
    )
    || (
      draft.lines.length > 0
      && draft.vatDecision === null
    )
  ) {
    return {
      ok: false,
      error: { code: 'invalid_value', path: '$.draft.vatDecision.rate' },
    };
  }
  if (draft.lineMetadata.some((metadata) => metadata.id === input.metadata.id)) {
    return {
      ok: false,
      error: { code: 'invalid_value', path: '$.draft.lineMetadata.id' },
    };
  }

  return parseQuoteDraftPayload({
    ...parsed.value,
    draft: {
      ...draft,
      contentRevision: draft.contentRevision + 1,
      stagingRevision: draft.stagingRevision + 1,
      lines: [...draft.lines, { ...input.resolvedLine }],
      lineMetadata: [
        ...draft.lineMetadata,
        {
          ...input.metadata,
          ...(input.metadata.catalogue === undefined
            ? {}
            : { catalogue: { ...input.metadata.catalogue } }),
        },
      ],
      lineForm: {
        label: '',
        quantity: '1',
        unitPrice: '',
        category: input.resolvedLine.category,
      },
      vatDecision: {
        ...input.vatDecision,
      },
    },
  });
}
