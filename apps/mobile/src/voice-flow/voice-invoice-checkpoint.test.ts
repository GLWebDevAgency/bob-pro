import { describe, expect, it } from 'vitest';
import type { QuoteView } from '@bob/api-client';
import {
  advanceVoiceInvoiceCheckpoint,
  createVoiceInvoiceCheckpoint,
  nextVoiceInvoiceExecutionAction,
  parseVoiceInvoiceCheckpoint,
  reconcileVoiceInvoiceQuote,
  serializeVoiceInvoiceCheckpoint,
  voiceInvoiceCheckpointProgress,
  voiceInvoicePaymentIdempotencyKey,
  type VoiceInvoiceCheckpoint,
} from './voice-invoice-checkpoint';

const draft = {
  transcript: 'Deux heures de main d’œuvre à 80 euros',
  customerId: 'customer-1',
  lines: [
    {
      label: 'Main d’œuvre',
      category: 'labor' as const,
      qty: 2,
      unit: 'h',
      unitPriceHT: 8_000,
      vatRate: 20 as const,
    },
  ],
};

function prepared(outcome: 'encaissee' | 'envoyee' = 'encaissee'): VoiceInvoiceCheckpoint {
  return createVoiceInvoiceCheckpoint({
    draft,
    outcome,
    method: 'transfer',
    baselineQuoteIds: ['quote-before'],
    quoteCreationIdempotencyKey: 'mobile-voice:quote:checkpoint-1',
  });
}

function quote(id: string, overrides: Partial<QuoteView> = {}): QuoteView {
  return {
    id,
    companyId: 'company-1',
    customerId: 'customer-1',
    status: 'draft',
    number: null,
    depositPct: null,
    lines: [{ id: 'line-1', ...draft.lines[0]! }],
    totals: { ht: 16_000, vat: 3_200, ttc: 19_200, netToPay: 19_200, vatByRate: { 20: 3_200 } },
    validUntil: null,
    signed: false,
    ...overrides,
  };
}

describe('voice invoice execution checkpoint', () => {
  it('reprend toujours à la première action non confirmée', () => {
    let checkpoint = prepared();
    expect(nextVoiceInvoiceExecutionAction(checkpoint)).toBe('create_quote');
    checkpoint = advanceVoiceInvoiceCheckpoint(checkpoint, { type: 'quote_creation_started' });
    checkpoint = advanceVoiceInvoiceCheckpoint(checkpoint, {
      type: 'quote_created',
      quoteId: 'quote-1',
    });
    expect(nextVoiceInvoiceExecutionAction(checkpoint)).toBe('send_quote');
    checkpoint = advanceVoiceInvoiceCheckpoint(checkpoint, { type: 'quote_sent' });
    expect(nextVoiceInvoiceExecutionAction(checkpoint)).toBe('sign_quote');
    checkpoint = advanceVoiceInvoiceCheckpoint(checkpoint, { type: 'quote_signed' });
    checkpoint = advanceVoiceInvoiceCheckpoint(checkpoint, {
      type: 'invoice_generated',
      invoiceId: 'invoice-1',
    });
    expect(nextVoiceInvoiceExecutionAction(checkpoint)).toBe('issue_invoice');
    checkpoint = advanceVoiceInvoiceCheckpoint(checkpoint, {
      type: 'invoice_issued',
      number: 'F-2026-0001',
    });
    expect(nextVoiceInvoiceExecutionAction(checkpoint)).toBe('register_payment');
    checkpoint = advanceVoiceInvoiceCheckpoint(checkpoint, { type: 'payment_registered' });
    expect(nextVoiceInvoiceExecutionAction(checkpoint)).toBe('complete');
    expect(voiceInvoiceCheckpointProgress(checkpoint)).toEqual({ completed: 6, total: 6 });
  });

  it("termine après l'émission quand l'issue est seulement envoyée", () => {
    let checkpoint = prepared('envoyee');
    checkpoint = advanceVoiceInvoiceCheckpoint(checkpoint, { type: 'quote_creation_started' });
    checkpoint = advanceVoiceInvoiceCheckpoint(checkpoint, {
      type: 'quote_created',
      quoteId: 'quote-1',
    });
    checkpoint = advanceVoiceInvoiceCheckpoint(checkpoint, { type: 'quote_sent' });
    checkpoint = advanceVoiceInvoiceCheckpoint(checkpoint, { type: 'quote_signed' });
    checkpoint = advanceVoiceInvoiceCheckpoint(checkpoint, {
      type: 'invoice_generated',
      invoiceId: 'invoice-1',
    });
    checkpoint = advanceVoiceInvoiceCheckpoint(checkpoint, {
      type: 'invoice_issued',
      number: 'F-2026-0001',
    });
    expect(nextVoiceInvoiceExecutionAction(checkpoint)).toBe('complete');
    expect(voiceInvoiceCheckpointProgress(checkpoint)).toEqual({ completed: 5, total: 5 });
  });

  it('refuse un saut de phase qui pourrait masquer une écriture non faite', () => {
    expect(() => advanceVoiceInvoiceCheckpoint(prepared(), { type: 'quote_sent' })).toThrow(
      'VOICE_CHECKPOINT_INVALID_TRANSITION',
    );
  });

  it('borne le snapshot de réconciliation avant toute écriture', () => {
    expect(() =>
      createVoiceInvoiceCheckpoint({
        draft,
        outcome: 'envoyee',
        method: 'transfer',
        baselineQuoteIds: Array.from({ length: 5_001 }, (_, index) => `quote-${index}`),
        quoteCreationIdempotencyKey: 'mobile-voice:quote:checkpoint-1',
      }),
    ).toThrow('VOICE_CHECKPOINT_BASELINE_INVALID');
  });

  it('réconcilie une réponse de création perdue sans reprendre un ancien devis identique', () => {
    const checkpoint = advanceVoiceInvoiceCheckpoint(prepared(), {
      type: 'quote_creation_started',
    });
    expect(reconcileVoiceInvoiceQuote(checkpoint, [quote('quote-before'), quote('quote-new')])).toEqual({
      kind: 'found',
      quoteId: 'quote-new',
    });
  });

  it('bloque quand plusieurs nouveaux devis identiques rendent la reprise ambiguë', () => {
    const checkpoint = advanceVoiceInvoiceCheckpoint(prepared(), {
      type: 'quote_creation_started',
    });
    expect(reconcileVoiceInvoiceQuote(checkpoint, [quote('quote-new-1'), quote('quote-new-2')])).toEqual({
      kind: 'ambiguous',
    });
  });

  it('ne rapproche pas une pièce dont le client ou les lignes diffèrent', () => {
    const checkpoint = advanceVoiceInvoiceCheckpoint(prepared(), {
      type: 'quote_creation_started',
    });
    expect(
      reconcileVoiceInvoiceQuote(checkpoint, [
        quote('wrong-customer', { customerId: 'customer-2' }),
        quote('wrong-amount', {
          lines: [{ id: 'line-2', ...draft.lines[0]!, unitPriceHT: 9_000 }],
        }),
      ]),
    ).toEqual({ kind: 'not_found' });
  });

  it('valide strictement la reprise persistée et rejette une structure incohérente', () => {
    const checkpoint = advanceVoiceInvoiceCheckpoint(
      advanceVoiceInvoiceCheckpoint(prepared(), { type: 'quote_creation_started' }),
      {
        type: 'quote_created',
        quoteId: 'quote-1',
      },
    );
    expect(parseVoiceInvoiceCheckpoint(JSON.stringify(checkpoint))).toEqual(checkpoint);
    expect(parseVoiceInvoiceCheckpoint('{not json')).toBeNull();
    expect(parseVoiceInvoiceCheckpoint(JSON.stringify({ ...checkpoint, quoteId: null }))).toBeNull();
    expect(parseVoiceInvoiceCheckpoint(JSON.stringify({ ...checkpoint, quoteId: '' }))).toBeNull();
    expect(parseVoiceInvoiceCheckpoint(JSON.stringify({ ...checkpoint, draft: { ...draft, lines: [] } }))).toBeNull();
  });

  it('conserve une clé de paiement déterministe sur tous les retries', () => {
    const input = { invoiceId: 'invoice-1', amount: 19_200, method: 'transfer' as const };
    expect(voiceInvoicePaymentIdempotencyKey(input)).toBe('mobile-voice:payment:invoice-1:19200:transfer');
    expect(voiceInvoicePaymentIdempotencyKey(input)).toBe(voiceInvoicePaymentIdempotencyKey({ ...input }));
  });

  it('conserve la clé createQuote dans le checkpoint et lit encore un checkpoint historique', () => {
    const current = prepared();
    expect(parseVoiceInvoiceCheckpoint(serializeVoiceInvoiceCheckpoint(current))?.quoteCreationIdempotencyKey)
      .toBe('mobile-voice:quote:checkpoint-1');

    const legacy = JSON.parse(serializeVoiceInvoiceCheckpoint(current)) as Record<string, unknown>;
    delete legacy['quoteCreationIdempotencyKey'];
    expect(parseVoiceInvoiceCheckpoint(JSON.stringify(legacy))?.quoteCreationIdempotencyKey).toBeNull();
  });

  it('ne persiste jamais le transcript vocal brut', () => {
    const serialized = serializeVoiceInvoiceCheckpoint(prepared());
    expect(serialized).not.toContain(draft.transcript);
    expect(parseVoiceInvoiceCheckpoint(serialized)?.draft.transcript).toBeNull();
  });
});
