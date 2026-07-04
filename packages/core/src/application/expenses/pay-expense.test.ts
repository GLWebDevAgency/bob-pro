import { describe, expect, it } from 'vitest';
import { Expense, type ExpenseProps } from '../../domain/expense/expense';
import { AccountingEntry } from '../../domain/accounting/accounting-entry';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ExpenseRepository } from '../ports/repositories';
import { PayExpense } from './pay-expense';
import { summarizeExpenses } from './summarize-expenses';

function props(over: Partial<ExpenseProps> = {}): ExpenseProps {
  return {
    id: 'exp-1',
    companyId: 'co-1',
    supplierName: 'Leroy Merlin',
    supplierSiren: null,
    documentDate: '2026-07-01',
    totalTtcCents: 18490,
    totalHtCents: 15408,
    vatCents: 3082,
    vatRatePct: 20,
    category: 'fournitures',
    status: 'to_pay',
    source: 'ocr',
    ...over,
  };
}

function makeEnv(seed: ExpenseProps[]) {
  const byId = new Map(seed.map((p) => [p.id, Expense.rehydrate(p)]));
  const saved = new Map<string, AccountingEntry>();
  const expenses: ExpenseRepository = {
    save: async (e) => void byId.set(e.id, e),
    findById: async (id) => byId.get(id) ?? null,
    listByCompany: async (companyId) => [...byId.values()].filter((e) => e.companyId === companyId),
  };
  const entries: AccountingEntryRepository = {
    save: async (entry) => void saved.set(entry.id, entry),
    findById: async (_c, id) => saved.get(id) ?? null,
    listByCompany: async () => [...saved.values()],
  };
  const clock = { now: () => '2026-07-04T10:00:00.000Z', today: () => '2026-07-04' };
  return { byId, saved, usecase: new PayExpense({ expenses, entries, clock }) };
}

describe('PayExpense (E4 — régler un fournisseur)', () => {
  it('passe la dépense payée ET poste le décaissement 401/512 À LA DATE DU RÈGLEMENT', async () => {
    const env = makeEnv([props()]);
    const r = await env.usecase.execute({ expenseId: 'exp-1' });
    expect(r.ok && r.value).toEqual({ status: 'paid', alreadyPaid: false });
    expect(env.byId.get('exp-1')?.status).toBe('paid');
    const entry = env.saved.get('expense:exp-1:paid');
    expect(entry?.journal).toBe('bank');
    expect(entry?.entryDate).toBe('2026-07-04'); // date du règlement, PAS la date de la pièce
    expect(entry?.lines.map((l) => l.account)).toEqual(['401', '512']);
  });

  it('idempotent : rejouer ne double ni le statut ni l’écriture', async () => {
    const env = makeEnv([props()]);
    await env.usecase.execute({ expenseId: 'exp-1' });
    const replay = await env.usecase.execute({ expenseId: 'exp-1' });
    expect(replay.ok && replay.value.alreadyPaid).toBe(true);
    expect(env.saved.size).toBe(1);
  });

  it('dépense introuvable → not_found', async () => {
    const env = makeEnv([]);
    const r = await env.usecase.execute({ expenseId: 'ghost' });
    expect(!r.ok && r.error.kind).toBe('not_found');
  });
});

describe('summarizeExpenses (E10 — la synthèse de l’écran Dépenses)', () => {
  it('reste à payer, payé du mois, TVA déductible du mois, ventilation par catégorie', () => {
    const s = summarizeExpenses(
      [
        props({ status: 'to_pay' }), // 184,90 à payer, TVA 30,82 (juillet)
        props({ id: 'e2', status: 'paid', totalTtcCents: 34200, vatCents: 5700, category: 'materiel' }),
        props({ id: 'e3', status: 'paid', documentDate: '2026-06-14', totalTtcCents: 52040, vatCents: 8673, category: 'materiel' }),
        props({ id: 'e4', status: 'to_pay', totalTtcCents: 6000, vatCents: null, category: 'repas' }),
      ],
      { month: '2026-07' },
    );
    expect(s.toPayCents).toBe(24490);
    expect(s.toPayCount).toBe(2);
    expect(s.paidThisMonthCents).toBe(34200); // Point P (juin) exclu
    expect(s.vatDeductibleThisMonthCents).toBe(3082 + 5700); // TVA null (repas) = pas de déduction
    expect(s.byCategory).toEqual([
      { category: 'fournitures', count: 1, ttcCents: 18490 },
      { category: 'materiel', count: 2, ttcCents: 86240 },
      { category: 'repas', count: 1, ttcCents: 6000 },
    ]);
  });
});
