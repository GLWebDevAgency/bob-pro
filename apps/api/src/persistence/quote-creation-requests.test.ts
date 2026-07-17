import { describe, expect, it } from 'vitest';
import type { CreateQuoteInput } from '@bob/core';
import {
  quoteCreationFingerprint,
} from './quote-creation-requests';
import { InMemoryQuoteCreationRequestStore } from './quote-creation-requests.testing';

const quote: Omit<CreateQuoteInput, 'companyId'> = {
  customerId: 'customer-1',
  idempotencyKey: 'mobile-voice:quote:secret-retry-1',
  lines: [
    { label: 'Main d’œuvre', category: 'labor', qty: 2, unit: 'h', unitPriceHT: 8_000, vatRate: 20 },
  ],
};

describe('quote creation request fingerprints', () => {
  it('sale la clé par tenant, fige le payload et ne restitue jamais la clé brute', () => {
    const first = quoteCreationFingerprint('company-1', quote);
    const otherTenant = quoteCreationFingerprint('company-2', quote);
    const otherPayload = quoteCreationFingerprint('company-1', {
      ...quote,
      lines: [{ ...quote.lines[0]!, unitPriceHT: 8_001 }],
    });

    expect(first).not.toBeNull();
    expect(first?.keyHash).not.toBe(otherTenant?.keyHash);
    expect(first?.payloadHash).not.toBe(otherPayload?.payloadHash);
    expect(JSON.stringify(first)).not.toContain(quote.idempotencyKey);
  });

  it('stocke uniquement les empreintes et une copie de la réponse gagnante', async () => {
    const fingerprint = quoteCreationFingerprint('company-1', quote);
    if (!fingerprint) throw new Error('fixture idempotency key required');
    const store = new InMemoryQuoteCreationRequestStore();
    const output = {
      quoteId: 'quote-1',
      totals: { ht: 16_000, vat: 3_200, ttc: 19_200, netToPay: 19_200, vatByRate: { 20: 3_200 } },
    };
    await store.putIfAbsent({
      companyId: 'company-1',
      ...fingerprint,
      output,
      createdAt: '2026-07-14T12:00:00.000Z',
    });
    output.totals.ht = 1;

    const persisted = await store.find({ companyId: 'company-1', keyHash: fingerprint.keyHash });
    expect(persisted?.output.totals.ht).toBe(16_000);
    expect(JSON.stringify(store.snapshot())).not.toContain(quote.idempotencyKey);
  });
});
