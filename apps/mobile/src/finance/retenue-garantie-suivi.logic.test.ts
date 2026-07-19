import { describe, expect, it } from 'vitest';
import {
  deriveRetenueSuivi,
  type RetenueInvoiceProjection,
} from './retenue-garantie-suivi.logic';

const invoice = (
  over: Partial<RetenueInvoiceProjection> & { retained?: number },
): RetenueInvoiceProjection => ({
  id: over.id ?? 'i1',
  number: over.number ?? 'F-2026-0001',
  kind: over.kind ?? 'situation',
  status: over.status ?? 'issued',
  customerId: over.customerId ?? 'c1',
  totals: { retenueGarantieCents: over.retained ?? 0 },
});

describe('retenue-garantie-suivi.logic — créance suivie (B5, loi 71-584)', () => {
  it('aucune retenue constituée → null (jamais un zéro décoratif)', () => {
    expect(deriveRetenueSuivi([], '2026-07-19')).toBeNull();
    expect(deriveRetenueSuivi([invoice({ retained: 0 })], '2026-07-19')).toBeNull();
  });

  it('agrège les pièces ÉMISES porteuses — brouillons, annulées et avoirs exclus', () => {
    const suivi = deriveRetenueSuivi(
      [
        invoice({ id: 'a', retained: 5_000 }),
        invoice({ id: 'b', kind: 'final', status: 'partially_paid', retained: 2_500 }),
        invoice({ id: 'c', status: 'draft', retained: 9_999 }),
        invoice({ id: 'd', status: 'cancelled', retained: 9_999 }),
        invoice({ id: 'e', kind: 'credit_note', retained: 9_999 }),
      ],
      '2026-07-19',
    );
    expect(suivi).not.toBeNull();
    expect(suivi?.retainedCents).toBe(7_500);
    expect(suivi?.pieceCount).toBe(2);
    expect(suivi?.pieces.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('restreint à un client quand demandé (carte de la fiche chantier)', () => {
    const invoices = [
      invoice({ id: 'a', customerId: 'c1', retained: 5_000 }),
      invoice({ id: 'b', customerId: 'c2', retained: 3_000 }),
    ];
    expect(deriveRetenueSuivi(invoices, '2026-07-19', { customerId: 'c1' })?.retainedCents).toBe(
      5_000,
    );
    expect(deriveRetenueSuivi(invoices, '2026-07-19', { customerId: 'c3' })).toBeNull();
  });
});
