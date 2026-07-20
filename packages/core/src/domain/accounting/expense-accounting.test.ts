import { describe, expect, it } from 'vitest';
import { Expense, type ExpenseProps } from '../expense/expense';
import { buildExpensePaymentAccountingEntry, buildRecordedExpenseAccountingEntry } from './expense-accounting';
import { createFrenchOperationalChartOfAccounts } from './chart-of-accounts';

function expense(over: Partial<ExpenseProps> = {}): Expense {
  return Expense.rehydrate({
    id: 'exp-1',
    companyId: 'co-1',
    supplierName: 'Leroy Merlin',
    supplierSiren: null,
    documentDate: '2026-07-03',
    totalTtcCents: 18490,
    totalHtCents: 15408,
    vatCents: 3082,
    vatRatePct: 20,
    category: 'fournitures',
    status: 'to_pay',
    source: 'ocr',
    ...over,
  });
}

const chart = (() => {
  const r = createFrenchOperationalChartOfAccounts('co-1');
  if (!r.ok) throw new Error('chart seed invalide');
  return r.value;
})();

describe('buildRecordedExpenseAccountingEntry (cycle achats — journal AC)', () => {
  it('poste 606 débit (TTC−TVA) + 44566 débit + 401 crédit, équilibrée, validée par le plan', () => {
    const r = buildRecordedExpenseAccountingEntry({ entryId: 'expense:exp-1:recorded', expense: expense(), chart });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.journal).toBe('purchases');
    expect(r.value.entryDate).toBe('2026-07-03');
    expect(r.value.lines).toEqual([
      { account: '606', label: 'Achat Leroy Merlin', debitCents: 15408, creditCents: 0 },
      { account: '44566', label: 'Achat Leroy Merlin', debitCents: 3082, creditCents: 0 },
      { account: '401', label: 'Achat Leroy Merlin', debitCents: 0, creditCents: 18490 },
    ]);
    expect(r.value.totalDebitCents).toBe(r.value.totalCreditCents);
  });

  it('TVA absente : PAS de 44566 (prudence art. 242 nonies A) — tout le TTC en charge', () => {
    const r = buildRecordedExpenseAccountingEntry({
      entryId: 'expense:exp-2:recorded',
      expense: expense({ id: 'exp-2', vatCents: null, totalHtCents: null }),
      chart,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.lines.map((l) => l.account)).toEqual(['606', '401']);
    expect(r.value.lines[0]?.debitCents).toBe(18490);
  });

  it('mapping par catégorie : repas → 625, sous-traitance → 611 (comptes postables du plan)', () => {
    const repas = buildRecordedExpenseAccountingEntry({
      entryId: 'e:repas',
      expense: expense({ id: 'e-repas', category: 'repas' }),
      chart,
    });
    const sstt = buildRecordedExpenseAccountingEntry({
      entryId: 'e:sstt',
      expense: expense({ id: 'e-sstt', category: 'sous_traitance' }),
      chart,
    });
    expect(repas.ok && repas.value.lines[0]?.account).toBe('625');
    expect(sstt.ok && sstt.value.lines[0]?.account).toBe('611');
  });

  it('refuse un TTC nul (rien à comptabiliser)', () => {
    const r = buildRecordedExpenseAccountingEntry({
      entryId: 'e:zero',
      expense: expense({ id: 'e-zero', totalTtcCents: 0, totalHtCents: null, vatCents: null }),
      chart,
    });
    expect(r.ok).toBe(false);
  });
});

describe('buildExpensePaymentAccountingEntry (décaissement — journal BQ)', () => {
  it('virement : date/référence de preuve, 401 débit / 512 crédit', () => {
    const r = buildExpensePaymentAccountingEntry({
      entryId: 'expense:exp-1:paid',
      expense: expense({
        status: 'paid',
        paymentEvidence: {
          paidOn: '2026-07-08',
          method: 'transfer',
          reference: 'VIR-2026-0042',
          proofDocumentId: null,
        },
      }),
      chart,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.journal).toBe('bank');
    expect(r.value.entryDate).toBe('2026-07-08');
    expect(r.value.reference).toBe('VIR-2026-0042');
    expect(r.value.lines).toEqual([
      { account: '401', label: 'Règlement Leroy Merlin', debitCents: 18490, creditCents: 0 },
      { account: '512', label: 'Règlement Leroy Merlin', debitCents: 0, creditCents: 18490 },
    ]);
  });

  it('carte → 512 ; espèces → 530, sans moyen comptable inventé', () => {
    const build = (method: 'card' | 'cash') => buildExpensePaymentAccountingEntry({
      entryId: `expense:exp-1:${method}`,
      expense: expense({
        status: 'paid',
        paymentEvidence: { paidOn: '2026-07-08', method, reference: null, proofDocumentId: null },
      }),
      chart,
    });
    const card = build('card');
    const cash = build('cash');
    expect(card.ok && card.value.lines.map((line) => line.account)).toEqual(['401', '512']);
    expect(cash.ok && cash.value.lines.map((line) => line.account)).toEqual(['401', '530']);
  });

  it('refuse le décaissement d’une dépense encore à payer', () => {
    const r = buildExpensePaymentAccountingEntry({ entryId: 'e:topay', expense: expense(), chart });
    expect(r.ok).toBe(false);
  });

  it('refuse une dépense marquée payée sans preuve historique fiable', () => {
    const r = buildExpensePaymentAccountingEntry({
      entryId: 'e:legacy',
      expense: expense({ status: 'paid', paymentEvidence: null }),
      chart,
    });
    expect(r.ok).toBe(false);
  });
});
