import { hasAsciiControlCharacter } from '../../shared-kernel/control-characters';
import {
  parseQuoteDraftPayload,
  QUOTE_DRAFT_REVISION_MAX,
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
