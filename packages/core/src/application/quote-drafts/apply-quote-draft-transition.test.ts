import { describe, expect, it } from 'vitest';
import {
  createEmptyQuoteDraftPayload,
  QUOTE_DRAFT_REVISION_MAX,
  type QuoteDraftPayloadV1,
} from './quote-draft-slot';
import {
  appendResolvedQuoteDraftLine,
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

describe('appendResolvedQuoteDraftLine', () => {
  function linesPayload() {
    const empty = createEmptyQuoteDraftPayload('quote-session-1');
    if (!empty.ok) throw new Error('fixture');
    const selected = applyQuoteDraftCustomerSelection(empty.value, {
      id: 'customer-1',
      name: 'Camping Les Pins',
    });
    if (!selected.ok) throw new Error('fixture');
    return selected.value;
  }

  it('ajoute exactement une ligne, sa metadata et réinitialise le formulaire', () => {
    const payload = linesPayload();
    const appended = appendResolvedQuoteDraftLine({
      payload,
      expectedContentRevision: 1,
      resolvedLine: {
        label: 'Main-d’œuvre plomberie',
        category: 'labor',
        qty: 2,
        unit: 'heure',
        unitPriceHT: 5_500,
        vatRate: 20,
      },
      metadata: {
        id: 'line-work-1',
        interaction: 'voice',
        catalogue: {
          id: 'catalogue-1',
          source: 'perso',
          indicative: false,
        },
      },
      vatDecision: { rate: 20 },
    });
    expect(appended).toMatchObject({
      ok: true,
      value: {
        draft: {
          contentRevision: 2,
          stagingRevision: 1,
          lineForm: {
            label: '',
            quantity: '1',
            unitPrice: '',
            category: 'labor',
          },
          vatDecision: { rate: 20 },
        },
      },
    });
    if (!appended.ok) return;
    expect(appended.value.draft.lines).toHaveLength(1);
    expect(appended.value.draft.lineMetadata).toHaveLength(1);
  });

  it('refuse une ancienne révision, un taux divergent et un identifiant dupliqué', () => {
    const payload = linesPayload();
    const line = {
      label: 'Déplacement',
      category: 'travel' as const,
      qty: 1,
      unitPriceHT: 3_000,
      vatRate: 20 as const,
    };
    const metadata = { id: 'line-work-1', interaction: 'manual' as const };
    expect(appendResolvedQuoteDraftLine({
      payload,
      expectedContentRevision: 0,
      resolvedLine: line,
      metadata,
      vatDecision: { rate: 20 },
    })).toMatchObject({
      ok: false,
      error: { path: '$.draft.contentRevision' },
    });
    expect(appendResolvedQuoteDraftLine({
      payload,
      expectedContentRevision: 1,
      resolvedLine: line,
      metadata,
      vatDecision: { rate: 10, housingOlderThan2y: true },
    })).toMatchObject({
      ok: false,
      error: { path: '$.draft.vatDecision.rate' },
    });
    const first = appendResolvedQuoteDraftLine({
      payload,
      expectedContentRevision: 1,
      resolvedLine: line,
      metadata,
      vatDecision: { rate: 20 },
    });
    if (!first.ok) throw new Error('fixture');
    expect(appendResolvedQuoteDraftLine({
      payload: first.value,
      expectedContentRevision: 2,
      resolvedLine: line,
      metadata,
      vatDecision: { rate: 20 },
    })).toMatchObject({
      ok: false,
      error: { path: '$.draft.lineMetadata.id' },
    });
  });
});
