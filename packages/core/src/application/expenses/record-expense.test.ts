import { describe, expect, it } from 'vitest';
import { RecordExpense, canonicalRecordExpensePayload, type RecordExpenseInput } from './record-expense';
import { type Expense } from '../../domain/expense/expense';

function input(overrides: Partial<Omit<RecordExpenseInput, 'companyId'>> = {}): Omit<RecordExpenseInput, 'companyId'> {
  return {
    supplierName: ' Cedeo ',
    supplierSiren: '552 100 554',
    documentDate: '2026-07-13',
    totalTtcCents: 12_000,
    category: 'fournitures',
    ...overrides,
  };
}

describe('canonicalRecordExpensePayload', () => {
  it('normalise les variantes sans effet comptable et exclut la clé technique', () => {
    const implicit = canonicalRecordExpensePayload(input({ idempotencyKey: 'secret-retry-key' }));
    const explicit = canonicalRecordExpensePayload(input({
      idempotencyKey: 'autre-cle',
      supplierName: 'Cedeo',
      supplierSiren: '552100554',
      totalHtCents: null,
      vatCents: null,
      vatRatePct: null,
      source: 'manual',
      supplierInvoiceNumber: '',
      dueAt: null,
    }));

    expect(implicit).toEqual(explicit);
    expect(implicit).not.toHaveProperty('idempotencyKey');
  });

  it('conserve toute différence qui change la dépense', () => {
    expect(canonicalRecordExpensePayload(input({ totalTtcCents: 12_001 }))).not.toEqual(
      canonicalRecordExpensePayload(input()),
    );
  });

  it('sans règlement déclaré : empreinte STRICTEMENT identique aux versions antérieures (clé payment absente)', () => {
    expect(canonicalRecordExpensePayload(input())).not.toHaveProperty('payment');
    expect(canonicalRecordExpensePayload(input({ payment: null }))).not.toHaveProperty('payment');
  });

  it('un règlement déclaré (ticket payé) change l’empreinte et normalise ses champs optionnels', () => {
    const paid = canonicalRecordExpensePayload(input({
      payment: { paidOn: '2026-07-13', method: 'card' },
    }));
    expect(paid).not.toEqual(canonicalRecordExpensePayload(input()));
    expect(paid).toHaveProperty('payment', {
      paidOn: '2026-07-13',
      method: 'card',
      reference: null,
      proofDocumentId: null,
    });
    expect(canonicalRecordExpensePayload(input({
      payment: { paidOn: '2026-07-13', method: 'card', reference: '', proofDocumentId: ' doc-1 ' },
    }))).toHaveProperty('payment', {
      paidOn: '2026-07-13',
      method: 'card',
      reference: null,
      proofDocumentId: 'doc-1',
    });
  });
});

describe('RecordExpense — création payée d’emblée (ticket de caisse scanné)', () => {
  function makeDeps() {
    const saved: Expense[] = [];
    return {
      saved,
      deps: {
        expenses: {
          save: async (expense: Expense) => {
            saved.push(expense);
          },
          findById: async () => null,
          listByCompany: async () => [],
        },
        ids: { newId: () => 'expense-1' },
        clock: { now: () => '2026-07-18T10:00:00.000Z', today: () => '2026-07-18' },
      },
    };
  }

  it('sans payment : la dépense naît « à payer », sans preuve (comportement historique intact)', async () => {
    const { saved, deps } = makeDeps();
    const r = await new RecordExpense(deps).execute({
      companyId: 'co-1',
      supplierName: 'Cedeo',
      documentDate: '2026-07-13',
      totalTtcCents: 12_000,
      category: 'fournitures',
      source: 'ocr',
    });
    expect(r.ok).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.toProps()).toMatchObject({ status: 'to_pay', paymentEvidence: null });
  });

  it('avec payment : dépense PAYÉE d’emblée, preuve complète (paidOn/moyen/justificatif du coffre)', async () => {
    const { saved, deps } = makeDeps();
    const r = await new RecordExpense(deps).execute({
      companyId: 'co-1',
      supplierName: 'Leroy Merlin',
      documentDate: '2026-07-13',
      totalTtcCents: 18_490,
      category: 'fournitures',
      source: 'ocr',
      payment: { paidOn: '2026-07-13', method: 'card', proofDocumentId: 'document-42' },
    });
    expect(r.ok).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.toProps()).toMatchObject({
      status: 'paid',
      paymentEvidence: {
        paidOn: '2026-07-13',
        method: 'card',
        reference: null,
        proofDocumentId: 'document-42',
      },
    });
  });

  it('refuse un règlement daté dans le futur (jour métier Paris) — le domaine garde le dernier mot', async () => {
    const { saved, deps } = makeDeps();
    const r = await new RecordExpense(deps).execute({
      companyId: 'co-1',
      supplierName: 'Leroy Merlin',
      documentDate: '2026-07-13',
      totalTtcCents: 18_490,
      category: 'fournitures',
      payment: { paidOn: '2026-07-20', method: 'card' },
    });
    expect(r.ok).toBe(false);
    expect(saved).toHaveLength(0);
  });
});
