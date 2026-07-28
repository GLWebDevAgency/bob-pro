import { describe, expect, it } from 'vitest';
import {
  QUOTE_DRAFT_PAYLOAD_SCHEMA,
  QUOTE_DRAFT_PAYLOAD_VERSION,
  QUOTE_DRAFT_REVISION_MAX,
  createEmptyQuoteDraftPayload,
  isMeaningfulQuoteDraftPayload,
  parseQuoteDraftPayload,
  type QuoteDraftPayloadV1,
} from './quote-draft-slot';

function payload(): QuoteDraftPayloadV1 {
  return {
    schema: QUOTE_DRAFT_PAYLOAD_SCHEMA,
    version: QUOTE_DRAFT_PAYLOAD_VERSION,
    draft: {
      sessionId: 'draft-session-1',
      contentRevision: 2,
      stagingRevision: 3,
      step: 'lignes',
      customer: { id: 'customer-1', name: 'Camping Les Pins' },
      lines: [{ label: 'Main-d’œuvre', category: 'labor', qty: 2, unitPriceHT: 5_500, vatRate: 20 }],
      lineMetadata: [{ id: 'line-1', interaction: 'voice' }],
      lineForm: { label: '', quantity: '1', unitPrice: '', category: 'labor' },
      vatDecision: { rate: 20 },
      depositPct: 30,
      signMode: null,
    },
  };
}

describe('QuoteDraftPayloadV1', () => {
  it('accepte et clone le contrat exact versionné', () => {
    const input = payload();
    const result = parseQuoteDraftPayload(input);
    expect(result).toEqual({ ok: true, value: input });
    if (result.ok) expect(result.value).not.toBe(input);
  });

  it('refuse les champs inconnus et les versions futures', () => {
    expect(parseQuoteDraftPayload({ ...payload(), hidden: 'replay' })).toEqual({
      ok: false,
      error: { code: 'invalid_shape', path: '$' },
    });
    expect(parseQuoteDraftPayload({ ...payload(), version: 2 })).toEqual({
      ok: false,
      error: { code: 'unsupported_version', path: '$.version' },
    });
  });

  it('refuse une ligne sans décision TVA ou des métadonnées désynchronisées', () => {
    const missingVat = payload();
    expect(parseQuoteDraftPayload({
      ...missingVat,
      draft: { ...missingVat.draft, vatDecision: null },
    })).toEqual({ ok: false, error: { code: 'invalid_value', path: '$.draft.vatDecision' } });

    const desynchronized = payload();
    expect(parseQuoteDraftPayload({
      ...desynchronized,
      draft: { ...desynchronized.draft, lineMetadata: [] },
    })).toEqual({ ok: false, error: { code: 'invalid_value', path: '$.draft.lineMetadata' } });
  });

  it('ne persiste ni recap, ni signature, ni proposition/mission IA', () => {
    const input = payload();
    expect(parseQuoteDraftPayload({ ...input, draft: { ...input.draft, step: 'recap' } })).toEqual({
      ok: false,
      error: { code: 'invalid_value', path: '$.draft.step' },
    });
    expect(parseQuoteDraftPayload({
      ...input,
      draft: { ...input.draft, proposal: { id: 'proposal-1' } },
    })).toEqual({ ok: false, error: { code: 'invalid_shape', path: '$.draft' } });
  });

  it('construit un slot initial honnête et non significatif', () => {
    const result = createEmptyQuoteDraftPayload('draft-session-empty');
    expect(result).toMatchObject({
      ok: true,
      value: {
        draft: {
          sessionId: 'draft-session-empty',
          contentRevision: 0,
          stagingRevision: 0,
          step: 'client',
          customer: null,
          lines: [],
          depositPct: 30,
        },
      },
    });
    if (result.ok) expect(isMeaningfulQuoteDraftPayload(result.value)).toBe(false);
  });

  it.each([
    ['client', { customer: { id: 'customer-1', name: 'Camping Les Pins' } }],
    ['ligne en préparation', { lineForm: { label: 'Main-d’œuvre', quantity: '1', unitPrice: '', category: 'labor' } }],
    ['quantité en préparation', { lineForm: { label: '', quantity: '2', unitPrice: '', category: 'labor' } }],
    ['prix en préparation', { lineForm: { label: '', quantity: '1', unitPrice: '55', category: 'labor' } }],
    ['acompte modifié', { depositPct: 0 }],
    ['signature choisie', { signMode: 'remote' }],
    ['urgence confirmée', { urgentRepairRequested: true }],
  ])('considère significatif le contenu durable %s', (_label, patch) => {
    const empty = createEmptyQuoteDraftPayload('draft-session-meaningful');
    if (!empty.ok) throw new Error('fixture vide invalide');
    const candidate = {
      ...empty.value,
      draft: { ...empty.value.draft, ...patch },
    } as QuoteDraftPayloadV1;
    expect(isMeaningfulQuoteDraftPayload(candidate)).toBe(true);
  });

  it('n’interprète pas une révision seule comme une donnée utilisateur', () => {
    const empty = createEmptyQuoteDraftPayload('draft-session-revisions');
    if (!empty.ok) throw new Error('fixture vide invalide');
    const candidate: QuoteDraftPayloadV1 = {
      ...empty.value,
      draft: {
        ...empty.value.draft,
        contentRevision: 42,
        stagingRevision: 12,
      },
    };
    expect(isMeaningfulQuoteDraftPayload(candidate)).toBe(false);
  });

  it('rejette les révisions qui dépassent PostgreSQL integer', () => {
    const input = payload();
    expect(parseQuoteDraftPayload({
      ...input,
      draft: { ...input.draft, contentRevision: QUOTE_DRAFT_REVISION_MAX + 1 },
    })).toEqual({
      ok: false,
      error: { code: 'invalid_value', path: '$.draft.contentRevision' },
    });
  });
});
