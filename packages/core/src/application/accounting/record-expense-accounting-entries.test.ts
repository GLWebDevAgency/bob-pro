import { describe, expect, it } from 'vitest';
import { Expense, type ExpenseProps } from '../../domain/expense/expense';
import { AccountingEntry } from '../../domain/accounting/accounting-entry';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ExpenseRepository } from '../ports/repositories';
import {
  RecordExpenseAccountingEntries,
  type RecordExpenseAccountingEntriesDeps,
} from './record-expense-accounting-entries';
import { Company, type VatRegime } from '../../domain/company/company';
import { MERCIER_PROPS } from '../fixtures';

function companyFor(vatRegime: VatRegime = 'reel_normal') {
  const result = Company.of({ ...MERCIER_PROPS, id: 'co-1', vatRegime });
  if (!result.ok) throw new Error('Fixture company invalide');
  return result.value;
}

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
    paymentEvidence: {
      paidOn: '2026-07-02',
      method: 'transfer',
      reference: 'VIR-TEST-1',
      proofDocumentId: null,
    },
    source: 'ocr',
    ...over,
  };
}

function makeEnv(expenses: ExpenseProps[], vatRegime: VatRegime = 'reel_normal') {
  const byId = new Map(expenses.map((p) => [p.id, Expense.rehydrate(p)]));
  const saved = new Map<string, AccountingEntry>();
  const company = companyFor(vatRegime);
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
  return {
    saved,
    usecase: new RecordExpenseAccountingEntries({
      expenses: expenseRepo,
      entries: entryRepo,
      companies: { findById: async (id) => (id === company.id ? company : null) },
    }),
  };
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
    const env = makeEnv([expenseProps({ id: 'exp-2', status: 'to_pay', paymentEvidence: null })]);
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

  it('franchise : le cycle complet poste le TTC en 6xx et aucun 44566', async () => {
    const env = makeEnv([expenseProps({ status: 'to_pay', paymentEvidence: null })], 'franchise');
    const r = await env.usecase.execute({ expenseId: 'exp-1' });
    expect(r.ok).toBe(true);
    expect(env.saved.get('expense:exp-1:recorded')?.lines).toEqual([
      { account: '606', label: 'Achat Cedeo', debitCents: 34_200, creditCents: 0 },
      { account: '401', label: 'Achat Cedeo', debitCents: 0, creditCents: 34_200 },
    ]);
  });

  it('refuse de valider silencieusement un ancien 44566 incompatible avec une franchise', async () => {
    const env = makeEnv([expenseProps({ status: 'to_pay', paymentEvidence: null })], 'franchise');
    env.saved.set('expense:exp-1:recorded', AccountingEntry.rehydrate({
      id: 'expense:exp-1:recorded',
      companyId: 'co-1',
      journal: 'purchases',
      sourceType: 'expense',
      sourceId: 'exp-1',
      entryDate: '2026-07-01',
      reference: 'Cedeo',
      label: 'Achat Cedeo',
      lines: [
        { account: '606', label: 'Achat Cedeo', debitCents: 28_500, creditCents: 0 },
        { account: '44566', label: 'Achat Cedeo', debitCents: 5_700, creditCents: 0 },
        { account: '401', label: 'Achat Cedeo', debitCents: 0, creditCents: 34_200 },
      ],
    }));
    const r = await env.usecase.execute({ expenseId: 'exp-1' });
    expect(r).toMatchObject({ ok: false, error: { kind: 'conflict', entity: 'accounting_entry' } });
    expect(env.saved.get('expense:exp-1:recorded')?.lines.some((line) => line.account === '44566')).toBe(true);
  });

  it('dépense introuvable : not_found (jamais d’écriture orpheline)', async () => {
    const env = makeEnv([]);
    const r = await env.usecase.execute({ expenseId: 'ghost' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });

  it('FAIL-CLOSED : sans source du régime TVA, aucune écriture n’est postée', async () => {
    const byId = new Map([['exp-1', Expense.rehydrate(expenseProps())]]);
    const saved = new Map<string, AccountingEntry>();
    const depsWithoutCompanies = {
      expenses: {
        save: async (e: Expense) => void byId.set(e.id, e),
        findById: async (id: string) => byId.get(id) ?? null,
        listByCompany: async () => [...byId.values()],
      },
      entries: {
        save: async (entry: AccountingEntry) => void saved.set(entry.id, entry),
        findById: async () => null,
        listByCompany: async () => [],
      },
    } as unknown as RecordExpenseAccountingEntriesDeps;
    const r = await new RecordExpenseAccountingEntries(depsWithoutCompanies).execute({ expenseId: 'exp-1' });
    expect(r).toMatchObject({ ok: false, error: { kind: 'dependency', port: 'CompanyRepository' } });
    expect(saved.size).toBe(0);
  });
});
