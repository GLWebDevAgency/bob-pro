import { describe, expect, it } from 'vitest';
import {
  QUOTE_DRAFT_PAYLOAD_SCHEMA,
  QUOTE_DRAFT_PAYLOAD_VERSION,
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
});
