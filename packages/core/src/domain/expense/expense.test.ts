import { describe, it, expect } from 'vitest';
import { Expense, type ExpenseProps } from './expense';

const base: ExpenseProps = {
  id: 'e1',
  companyId: 'c1',
  supplierName: '  Leroy Merlin  ',
  supplierSiren: null,
  documentDate: '2026-06-12',
  totalTtcCents: 12000,
  totalHtCents: 10000,
  vatCents: 2000,
  vatRatePct: 20,
  category: 'fournitures',
  status: 'to_pay',
  source: 'ocr',
};

describe('Expense.record', () => {
  it('normalise une dépense valide', () => {
    const r = Expense.record(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.supplierName).toBe('Leroy Merlin');
      expect(r.value.status).toBe('to_pay');
      expect(r.value.totalTtcCents).toBe(12000);
    }
  });

  it('rejette fournisseur vide, TTC non entier, date impossible, SIREN invalide', () => {
    expect(Expense.record({ ...base, supplierName: '   ' }).ok).toBe(false);
    expect(Expense.record({ ...base, totalTtcCents: 12.5 }).ok).toBe(false);
    expect(Expense.record({ ...base, documentDate: '2026-02-30' }).ok).toBe(false);
    expect(Expense.record({ ...base, supplierSiren: '123456789' }).ok).toBe(false); // Luhn KO
  });

  it('accepte et conserve un SIREN valide ; markPaid bascule le statut', () => {
    const r = Expense.record({ ...base, supplierSiren: '732829320' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      r.value.markPaid();
      expect(r.value.status).toBe('paid');
      expect(r.value.toProps().supplierSiren).toBe('732829320');
    }
  });
});
