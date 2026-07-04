import { describe, expect, it } from 'vitest';
import { Expense, type ExpenseProps } from '../../domain/expense/expense';
import { AccountingEntry } from '../../domain/accounting/accounting-entry';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ExpenseRepository } from '../ports/repositories';
import { RecordExpenseAccountingEntries } from './record-expense-accounting-entries';

function expenseProps(over: Partial<ExpenseProps> = {}): ExpenseProps {
  return {
    id: 'exp-1',
    companyId: 'co-1',
    supplierName: 'Cedeo',
    supplierSiren: null,
    documentDate: '2026-07-01',
    totalTtcCents: 34200,
    totalHtCents: 28500,
    vatCents: 5700,
    vatRatePct: 20,
    category: 'materiel',
    status: 'paid',
    source: 'ocr',
    ...over,
  };
}

function makeEnv(expenses: ExpenseProps[]) {
  const byId = new Map(expenses.map((p) => [p.id, Expense.rehydrate(p)]));
  const saved = new Map<string, AccountingEntry>();
  const expenseRepo: ExpenseRepository = {
    save: async (e) => void byId.set(e.id, e),
    findById: async (id) => byId.get(id) ?? null,
    listByCompany: async (companyId) => [...byId.values()].filter((e) => e.companyId === companyId),
  };
  const entryRepo: AccountingEntryRepository = {
    save: async (entry) => void saved.set(entry.id, entry),
    findById: async (_companyId, id) => saved.get(id) ?? null,
    listByCompany: async (companyId) => [...saved.values()].filter((e) => e.companyId === companyId),
  };
  return { saved, usecase: new RecordExpenseAccountingEntries({ expenses: expenseRepo, entries: entryRepo }) };
}

describe('RecordExpenseAccountingEntries (cycle achats complet)', () => {
  it('dépense PAYÉE : poste l’achat (AC) ET le décaissement (BQ) — 401 soldé', async () => {
    const env = makeEnv([expenseProps()]);
    const r = await env.usecase.execute({ expenseId: 'exp-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      purchaseEntryId: 'expense:exp-1:recorded',
      paymentEntryId: 'expense:exp-1:paid',
      created: true,
    });
    const purchase = env.saved.get('expense:exp-1:recorded');
    const payment = env.saved.get('expense:exp-1:paid');
    expect(purchase?.journal).toBe('purchases');
    expect(payment?.journal).toBe('bank');
    // Le 401 est crédité par l'achat (34 200) puis débité par le règlement (34 200) : soldé.
    const on401 = [...(purchase?.lines ?? []), ...(payment?.lines ?? [])].filter((l) => l.account === '401');
    expect(on401.reduce((s, l) => s + l.creditCents - l.debitCents, 0)).toBe(0);
  });

  it('dépense À PAYER : achat seul, pas de décaissement (401 reste créditeur — dette réelle)', async () => {
    const env = makeEnv([expenseProps({ id: 'exp-2', status: 'to_pay' })]);
    const r = await env.usecase.execute({ expenseId: 'exp-2' });
    expect(r.ok && r.value.paymentEntryId).toBeNull();
    expect(env.saved.size).toBe(1);
  });

  it('idempotent : le rejeu ne double AUCUNE écriture (ids déterministes)', async () => {
    const env = makeEnv([expenseProps()]);
    await env.usecase.execute({ expenseId: 'exp-1' });
    const replay = await env.usecase.execute({ expenseId: 'exp-1' });
    expect(replay.ok && replay.value.created).toBe(false);
    expect(env.saved.size).toBe(2);
  });

  it('dépense introuvable : not_found (jamais d’écriture orpheline)', async () => {
    const env = makeEnv([]);
    const r = await env.usecase.execute({ expenseId: 'ghost' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });
});
