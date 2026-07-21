import { describe, expect, it } from 'vitest';
import { deriveVatPosition, type VatPositionInvoiceData } from './derive-vat-position';

const CHANTIER_TOTALS = { ht: 135667, vatByRate: { '20': 27133 }, vat: 27133, ttc: 162800, netToPay: 48840 };

function invoice(over: Partial<VatPositionInvoiceData> = {}): VatPositionInvoiceData {
  return { kind: 'deposit', status: 'paid', totals: CHANTIER_TOTALS, paid: 48840, ...over };
}

describe('deriveVatPosition (TVA sur les encaissements — art. 269, 2-c CGI)', () => {
  it('TEST D’OR : acompte 488,40 encaissé sur chantier 1 628,00 → TVA collectée 81,40', () => {
    const p = deriveVatPosition({ vatRegime: 'reel_normal', invoices: [invoice()], expenses: [] });
    expect(p.collectedCents).toBe(8140);
    expect(p.netDueCents).toBe(8140);
    expect(p.creditCents).toBe(0);
  });

  it('facture émise NON encaissée : zéro TVA exigible (exigibilité à l’encaissement)', () => {
    const p = deriveVatPosition({
      vatRegime: 'reel_simpl',
      invoices: [invoice({ status: 'issued', paid: 0 })],
      expenses: [],
    });
    expect(p.collectedCents).toBe(0);
  });

  it('brouillons/annulées exclus ; avoir émis régularise (soustrait sa TVA)', () => {
    const p = deriveVatPosition({
      vatRegime: 'reel_normal',
      invoices: [
        invoice(),
        invoice({ status: 'draft', paid: 48840 }),
        invoice({ status: 'cancelled', paid: 48840 }),
        { kind: 'credit_note', status: 'issued', totals: { ht: 4070, vatByRate: { '20': 814 }, vat: 814, ttc: 4884, netToPay: 4884 }, paid: 0 },
      ],
      expenses: [],
    });
    expect(p.collectedCents).toBe(8140 - 814);
  });

  it('déductible = TVA MENTIONNÉE seulement (null = pas de déduction) ; crédit de TVA net', () => {
    const p = deriveVatPosition({
      vatRegime: 'reel_normal',
      invoices: [invoice()],
      expenses: [{ vatCents: 3082 }, { vatCents: null }, { vatCents: 5700 }, { vatCents: 8673 }],
    });
    expect(p.deductibleCents).toBe(17455);
    expect(p.netDueCents).toBe(0); // 8 140 collectée < 17 455 déductible
    expect(p.creditCents).toBe(9315); // crédit reportable — jamais un dû négatif
  });

  it('jamais de collectée négative globale (avoirs > encaissements → plancher 0)', () => {
    const p = deriveVatPosition({
      vatRegime: 'reel_normal',
      invoices: [{ kind: 'credit_note', status: 'issued', totals: CHANTIER_TOTALS, paid: 0 }],
      expenses: [],
    });
    expect(p.collectedCents).toBe(0);
  });

  it('franchise en base : TVA fournisseur non déductible, aucun crédit annoncé', () => {
    const p = deriveVatPosition({
      vatRegime: 'franchise',
      invoices: [],
      expenses: [{ vatCents: 3_082 }, { vatCents: 5_700 }],
    });
    expect(p).toEqual({
      collectedCents: 0,
      deductibleCents: 0,
      netDueCents: 0,
      creditCents: 0,
    });
  });

  it('FAIL-CLOSED : régime non qualifié => position indisponible, jamais un zéro inventé', () => {
    const p = deriveVatPosition({ vatRegime: null, invoices: [], expenses: [{ vatCents: 3_082 }] });
    expect(p).toBeNull();
  });

  it('FAIL-CLOSED : franchise avec TVA de vente vivante incohérente => position indisponible', () => {
    const p = deriveVatPosition({
      vatRegime: 'franchise',
      invoices: [invoice()],
      expenses: [],
    });
    expect(p).toBeNull();
  });
});
