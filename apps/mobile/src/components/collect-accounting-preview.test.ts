import { describe, expect, it, vi } from 'vitest';
import type { BobClient } from '@bob/api-client';
import { resolveCollectAccountingPreview } from './collect-accounting-preview';

const lines = [
  { account: '512', label: 'Encaissement F-1', debitCents: 12_000, creditCents: 0 },
  { account: '411', label: 'Encaissement F-1', debitCents: 0, creditCents: 12_000 },
];

function clientReturning(
  result: Awaited<ReturnType<BobClient['paymentAccountingPreview']>>,
): Pick<BobClient, 'paymentAccountingPreview'> {
  return { paymentAccountingPreview: vi.fn(async () => result) };
}

describe('resolveCollectAccountingPreview', () => {
  it('rend uniquement les lignes réellement confirmées par le serveur', async () => {
    const result = await resolveCollectAccountingPreview(
      clientReturning({
        ok: true,
        value: {
          invoiceId: 'invoice-1',
          available: true,
          reference: 'F-1',
          amountCents: 12_000,
          remainingCents: 12_000,
          method: 'transfer',
          totalDebitCents: 12_000,
          totalCreditCents: 12_000,
          lines,
        },
      }),
      { invoiceId: 'invoice-1', expectedRemainingCents: 12_000 },
    );

    expect(result).toEqual({ kind: 'ready', lines });
  });

  it("propage l'indisponibilité sans lui ajouter un total ou des lignes", async () => {
    const result = await resolveCollectAccountingPreview(
      clientReturning({
        ok: true,
        value: {
          invoiceId: 'invoice-1',
          available: false,
          reason: 'Paiement supérieur au reste dû.',
        },
      }),
      { invoiceId: 'invoice-1', expectedRemainingCents: 12_001 },
    );

    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'Paiement supérieur au reste dû.',
    });
    expect(result).not.toHaveProperty('lines');
  });

  it('bloque une photographie serveur dont le reste dû a changé', async () => {
    const result = await resolveCollectAccountingPreview(
      clientReturning({
        ok: true,
        value: {
          invoiceId: 'invoice-1',
          available: true,
          reference: 'F-1',
          amountCents: 12_000,
          remainingCents: 10_000,
          method: 'transfer',
          totalDebitCents: 12_000,
          totalCreditCents: 12_000,
          lines,
        },
      }),
      { invoiceId: 'invoice-1', expectedRemainingCents: 12_000 },
    );

    expect(result).toEqual({ kind: 'stale' });
  });

  it('bloque une variante disponible incohérente au lieu de fabriquer une preuve', async () => {
    const result = await resolveCollectAccountingPreview(
      clientReturning({
        ok: true,
        value: {
          invoiceId: 'invoice-1',
          available: true,
          reference: 'F-1',
          amountCents: 12_000,
          remainingCents: 12_000,
          method: 'transfer',
          totalDebitCents: 0,
          totalCreditCents: 0,
          lines: [],
        },
      }),
      { invoiceId: 'invoice-1', expectedRemainingCents: 12_000 },
    );

    expect(result).toEqual({ kind: 'invalid_contract' });
  });
});
