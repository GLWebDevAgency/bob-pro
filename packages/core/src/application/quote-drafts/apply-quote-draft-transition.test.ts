import { describe, expect, it } from 'vitest';
import {
  createEmptyQuoteDraftPayload,
  QUOTE_DRAFT_REVISION_MAX,
  type QuoteDraftPayloadV1,
} from './quote-draft-slot';
import {
  applyQuoteDraftCustomerSelection,
  deriveQuoteDraftCustomerSelectionTransition,
} from './apply-quote-draft-transition';

function emptyDraft(): QuoteDraftPayloadV1 {
  const result = createEmptyQuoteDraftPayload('draft-session-1');
  if (!result.ok) throw new Error('test fixture must be valid');
  return result.value;
}

describe('deriveQuoteDraftCustomerSelectionTransition', () => {
  it('sélectionne le client et avance à lignes dans une seule révision de contenu', () => {
    expect(deriveQuoteDraftCustomerSelectionTransition(
      { step: 'client', customer: null, contentRevision: 4 },
      { id: 'customer-1', name: 'Camping les Pins' },
    )).toEqual({
      ok: true,
      value: {
        step: 'lignes',
        customer: { id: 'customer-1', name: 'Camping les Pins' },
        contentRevision: 5,
      },
    });
  });

  it.each([
    [{ id: '', name: 'Camping les Pins' }, 'customer'],
    [{ id: 'customer-1', name: ' Camping les Pins' }, 'customer'],
    [{ id: 'customer-1', name: 'Camping\nles Pins' }, 'customer'],
  ] as const)('refuse un client non canonique %#', (customer, field) => {
    expect(deriveQuoteDraftCustomerSelectionTransition(
      { step: 'client', customer: null, contentRevision: 0 },
      customer,
    )).toEqual({
      ok: false,
      error: { code: 'invalid_customer_selection', field },
    });
  });

  it('refuse une sélection hors étape client ou après une sélection existante', () => {
    expect(deriveQuoteDraftCustomerSelectionTransition(
      {
        step: 'lignes',
        customer: { id: 'customer-1', name: 'Camping les Pins' },
        contentRevision: 1,
      },
      { id: 'customer-2', name: 'Martin' },
    )).toEqual({
      ok: false,
      error: { code: 'invalid_quote_draft_step', field: 'step' },
    });
  });

  it('refuse de dépasser la colonne PostgreSQL integer', () => {
    expect(deriveQuoteDraftCustomerSelectionTransition(
      { step: 'client', customer: null, contentRevision: QUOTE_DRAFT_REVISION_MAX },
      { id: 'customer-1', name: 'Camping les Pins' },
    )).toEqual({
      ok: false,
      error: { code: 'quote_draft_revision_overflow', field: 'contentRevision' },
    });
  });
});

describe('applyQuoteDraftCustomerSelection', () => {
  it('préserve toutes les autres saisies et stagingRevision', () => {
    const payload = emptyDraft();
    const input: QuoteDraftPayloadV1 = {
      ...payload,
      draft: {
        ...payload.draft,
        contentRevision: 7,
        stagingRevision: 11,
        urgentRepairRequested: true,
      },
    };

    const result = applyQuoteDraftCustomerSelection(input, {
      id: 'customer-1',
      name: 'Camping les Pins',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.draft).toEqual({
      ...input.draft,
      step: 'lignes',
      customer: { id: 'customer-1', name: 'Camping les Pins' },
      contentRevision: 8,
    });
  });

  it('repasse par le parseur exact et refuse un payload entrant invalide', () => {
    const payload = emptyDraft();
    expect(applyQuoteDraftCustomerSelection(
      {
        ...payload,
        draft: {
          ...payload.draft,
          contentRevision: QUOTE_DRAFT_REVISION_MAX + 1,
        },
      },
      { id: 'customer-1', name: 'Camping les Pins' },
    )).toEqual({
      ok: false,
      error: { code: 'invalid_value', path: '$.draft.contentRevision' },
    });
  });
});
