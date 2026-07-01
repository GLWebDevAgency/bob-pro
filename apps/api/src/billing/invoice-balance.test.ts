import { describe, expect, it } from 'vitest';
import { remainingInvoiceBalanceCents } from './invoice-balance';

describe('remainingInvoiceBalanceCents', () => {
  it('utilise le net à payer, pas le total TTC, pour les factures d’acompte', () => {
    const remaining = remainingInvoiceBalanceCents({
      totals: { netToPay: 48840 },
      paid: 0,
    });

    expect(remaining).toBe(48840);
  });

  it('déduit les paiements déjà enregistrés et ne descend jamais sous zéro', () => {
    expect(remainingInvoiceBalanceCents({ totals: { netToPay: 10000 }, paid: 2500 })).toBe(7500);
    expect(remainingInvoiceBalanceCents({ totals: { netToPay: 10000 }, paid: 12000 })).toBe(0);
  });
});
