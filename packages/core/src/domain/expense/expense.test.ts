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

  it('rejette HT/TVA > TTC et statut/source inconnus', () => {
    expect(Expense.record({ ...base, totalHtCents: 20000, totalTtcCents: 12000 }).ok).toBe(false);
    expect(Expense.record({ ...base, vatCents: 20000, totalTtcCents: 12000 }).ok).toBe(false);
    expect(Expense.record({ ...base, status: 'weird' as unknown as 'to_pay' }).ok).toBe(false);
    expect(Expense.record({ ...base, source: 'x' as unknown as 'ocr' }).ok).toBe(false);
  });

  it('rejette une date future (avec horloge) ; rehydrate ne revalide pas', () => {
    expect(Expense.record({ ...base, documentDate: '2030-01-01' }, { today: '2026-06-29' }).ok).toBe(false);
    expect(Expense.record({ ...base, documentDate: '2026-06-01' }, { today: '2026-06-29' }).ok).toBe(true);
    const e = Expense.rehydrate({ ...base, documentDate: '2030-01-01' });
    expect(e.documentDate).toBe('2030-01-01');
  });

  it('accepte et conserve un SIREN valide', () => {
    const r = Expense.record({ ...base, supplierSiren: '732829320' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.toProps().supplierSiren).toBe('732829320');
    }
  });

  it('enregistre une preuve de règlement explicite, normalisée et non future', () => {
    const r = Expense.record(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const paid = r.value.recordPayment(
      {
        paidOn: '2026-06-14',
        method: 'transfer',
        reference: '  VIR-2026-0042  ',
        proofDocumentId: '  document-1  ',
      },
      { today: '2026-06-15' },
    );
    expect(paid).toEqual({ ok: true, value: { alreadyRecorded: false } });
    expect(r.value.toProps()).toMatchObject({
      status: 'paid',
      paymentEvidence: {
        paidOn: '2026-06-14',
        method: 'transfer',
        reference: 'VIR-2026-0042',
        proofDocumentId: 'document-1',
      },
    });
  });

  it('refuse date future, moyen inconnu et références non bornées sans changer le statut', () => {
    const cases = [
      { paidOn: '2026-06-16', method: 'transfer' as const },
      { paidOn: '2026-06-14', method: 'cheque' as unknown as 'transfer' },
      { paidOn: '2026-06-14', method: 'card' as const, reference: 'x'.repeat(141) },
      { paidOn: '2026-06-14', method: 'cash' as const, proofDocumentId: 'x'.repeat(201) },
    ];
    for (const evidence of cases) {
      const r = Expense.record(base);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.value.recordPayment(evidence, { today: '2026-06-15' }).ok).toBe(false);
      expect(r.value.status).toBe('to_pay');
      expect(r.value.paymentEvidence).toBeNull();
    }
  });

  it('un retry identique est idempotent ; une preuve différente échoue sans réécriture', () => {
    const r = Expense.record(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const evidence = { paidOn: '2026-06-14', method: 'card' as const, reference: 'CB-42' };
    expect(r.value.recordPayment(evidence, { today: '2026-06-15' })).toEqual({
      ok: true,
      value: { alreadyRecorded: false },
    });
    expect(r.value.recordPayment(evidence, { today: '2026-06-15' })).toEqual({
      ok: true,
      value: { alreadyRecorded: true },
    });
    expect(r.value.recordPayment({ ...evidence, paidOn: '2026-06-13' }, { today: '2026-06-15' }).ok).toBe(false);
    expect(r.value.paymentEvidence?.paidOn).toBe('2026-06-14');
  });

  it('interdit de créer un statut payé sans preuve ou une preuve sur un statut à payer', () => {
    expect(Expense.record({ ...base, status: 'paid' }).ok).toBe(false);
    expect(Expense.record({
      ...base,
      paymentEvidence: { paidOn: '2026-06-14', method: 'cash', reference: null, proofDocumentId: null },
    }).ok).toBe(false);
  });

  // C-EXP6b — extension ADDITIVE : n° de facture fournisseur (BT-1) + échéance (BT-9).
  it('champs Factur-X optionnels : absents → null (rien ne casse), normalisés quand présents', () => {
    const legacy = Expense.record(base); // sans les nouveaux champs — call-sites historiques intacts
    expect(legacy.ok).toBe(true);
    if (legacy.ok) {
      expect(legacy.value.supplierInvoiceNumber).toBeNull();
      expect(legacy.value.dueAt).toBeNull();
    }
    const full = Expense.record({
      ...base,
      source: 'facturx',
      supplierInvoiceNumber: '  FC-2026-118  ',
      dueAt: '2026-07-20',
    });
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.value.supplierInvoiceNumber).toBe('FC-2026-118');
      expect(full.value.dueAt).toBe('2026-07-20');
      expect(full.value.toProps().source).toBe('facturx');
    }
    const blankNumber = Expense.record({ ...base, supplierInvoiceNumber: '   ' });
    expect(blankNumber.ok).toBe(true);
    if (blankNumber.ok) expect(blankNumber.value.supplierInvoiceNumber).toBeNull(); // vide → null
    expect(Expense.record({ ...base, dueAt: '2026-02-30' }).ok).toBe(false); // échéance impossible
  });
});
