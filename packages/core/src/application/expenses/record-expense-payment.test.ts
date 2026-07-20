import { describe, expect, it } from 'vitest';
import { Expense, type ExpenseProps } from '../../domain/expense/expense';
import { AccountingEntry } from '../../domain/accounting/accounting-entry';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ExpenseRepository } from '../ports/repositories';
import { type DocumentRepository } from '../ports/document-repository';
import { RecordExpensePayment } from './record-expense-payment';
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
    paymentEvidence: null,
    source: 'ocr',
    ...over,
  };
}

function makeEnv(seed: ExpenseProps[], clockNow = '2026-07-04T10:00:00.000Z') {
  const byId = new Map(seed.map((p) => [p.id, Expense.rehydrate(p)]));
  const saved = new Map<string, AccountingEntry>();
  let expenseSaveCount = 0;
  let entrySaveCount = 0;
  let expenseLockCount = 0;
  const expenses: ExpenseRepository = {
    save: async (e) => {
      expenseSaveCount += 1;
      byId.set(e.id, Expense.rehydrate(e.toProps()));
    },
    findById: async (id) => {
      const found = byId.get(id);
      return found ? Expense.rehydrate(found.toProps()) : null;
    },
    lockById: async (id) => {
      expenseLockCount += 1;
      const found = byId.get(id);
      return found ? Expense.rehydrate(found.toProps()) : null;
    },
    listByCompany: async (companyId) => [...byId.values()]
      .filter((e) => e.companyId === companyId)
      .map((e) => Expense.rehydrate(e.toProps())),
  };
  const entries: AccountingEntryRepository = {
    save: async (entry) => {
      entrySaveCount += 1;
      saved.set(entry.id, AccountingEntry.rehydrate(entry.toProps()));
    },
    findById: async (_companyId, id) => {
      const found = saved.get(id);
      return found ? AccountingEntry.rehydrate(found.toProps()) : null;
    },
    listByCompany: async () => [...saved.values()].map((entry) => AccountingEntry.rehydrate(entry.toProps())),
  };
  // `today()` reste l'UTC brut de SystemClock : les tests vérifient que les bornes calendrier
  // métier n'en dépendent plus (jour Europe/Paris dérivé de `now()`).
  const clock = { now: () => clockNow, today: () => clockNow.slice(0, 10) };
  const documents = {
    findById: async (companyId: string, id: string) => (
      companyId === 'co-1' && id === 'document-proof-1'
        ? { id, companyId, status: 'active' }
        : null
    ),
  } as unknown as DocumentRepository;
  return {
    byId,
    saved,
    counts: () => ({ expenseSaveCount, entrySaveCount }),
    locks: () => expenseLockCount,
    usecase: new RecordExpensePayment({ expenses, entries, clock, documents }),
  };
}

const command = {
  companyId: 'co-1',
  expenseId: 'exp-1',
  paidOn: '2026-07-03',
  method: 'transfer' as const,
  reference: 'VIR-2026-0042',
  proofDocumentId: 'document-proof-1',
};

describe('RecordExpensePayment (preuve d’un règlement déjà effectué)', () => {
  it('persiste la preuve et poste 401/512 à sa date réelle', async () => {
    const env = makeEnv([props()]);
    const r = await env.usecase.execute(command);
    expect(r).toEqual({
      ok: true,
      value: { status: 'paid', alreadyRecorded: false, paymentEntryId: 'expense:exp-1:paid' },
    });
    expect(env.byId.get('exp-1')?.toProps()).toMatchObject({
      status: 'paid',
      paymentEvidence: {
        paidOn: '2026-07-03',
        method: 'transfer',
        reference: 'VIR-2026-0042',
        proofDocumentId: 'document-proof-1',
      },
    });
    const entry = env.saved.get('expense:exp-1:paid');
    expect(entry?.entryDate).toBe('2026-07-03');
    expect(entry?.reference).toBe('VIR-2026-0042');
    expect(entry?.lines.map((line) => line.account)).toEqual(['401', '512']);
    expect(env.locks()).toBe(1);
  });

  it('espèces crédite 530 et carte crédite 512', async () => {
    const cash = makeEnv([props()]);
    const card = makeEnv([props()]);
    await cash.usecase.execute({ ...command, method: 'cash' });
    await card.usecase.execute({ ...command, method: 'card' });
    expect(cash.saved.get('expense:exp-1:paid')?.lines.map((line) => line.account)).toEqual(['401', '530']);
    expect(card.saved.get('expense:exp-1:paid')?.lines.map((line) => line.account)).toEqual(['401', '512']);
  });

  it('retry strictement identique est idempotent', async () => {
    const env = makeEnv([props()]);
    await env.usecase.execute(command);
    const replay = await env.usecase.execute(command);
    expect(replay.ok && replay.value.alreadyRecorded).toBe(true);
    expect(env.counts()).toEqual({ expenseSaveCount: 1, entrySaveCount: 1 });
  });

  it('retry avec preuve différente échoue en conflit et conserve l’original', async () => {
    const env = makeEnv([props()]);
    await env.usecase.execute(command);
    const replay = await env.usecase.execute({ ...command, paidOn: '2026-07-02' });
    expect(!replay.ok && replay.error.kind).toBe('conflict');
    expect(env.byId.get('exp-1')?.paymentEvidence?.paidOn).toBe('2026-07-03');
    expect(env.counts()).toEqual({ expenseSaveCount: 1, entrySaveCount: 1 });
  });

  it('écriture déterministe existante mais différente : conflit avant mutation', async () => {
    const env = makeEnv([props()]);
    const wrong = AccountingEntry.create({
      id: 'expense:exp-1:paid',
      companyId: 'co-1',
      journal: 'bank',
      sourceType: 'expense',
      sourceId: 'exp-1',
      entryDate: '2026-07-02',
      reference: 'AUTRE',
      label: 'Règlement Leroy Merlin',
      lines: [
        { account: '401', label: 'Règlement Leroy Merlin', debitCents: 18490, creditCents: 0 },
        { account: '512', label: 'Règlement Leroy Merlin', debitCents: 0, creditCents: 18490 },
      ],
    });
    expect(wrong.ok).toBe(true);
    if (!wrong.ok) return;
    env.saved.set(wrong.value.id, wrong.value);
    const r = await env.usecase.execute(command);
    expect(!r.ok && r.error.kind).toBe('conflict');
    expect(env.byId.get('exp-1')?.status).toBe('to_pay');
    expect(env.counts()).toEqual({ expenseSaveCount: 0, entrySaveCount: 0 });
  });

  it('fenêtre nocturne Paris : « aujourd’hui » (jour Paris) est accepté alors que l’UTC est encore hier', async () => {
    // 23h30 UTC le 3 juillet = 01h30 le 4 juillet à Paris (été, UTC+2) : le jour métier est le 4.
    const env = makeEnv([props()], '2026-07-03T23:30:00.000Z');
    const r = await env.usecase.execute({ ...command, paidOn: '2026-07-04' });
    expect(r).toEqual({
      ok: true,
      value: { status: 'paid', alreadyRecorded: false, paymentEntryId: 'expense:exp-1:paid' },
    });
    expect(env.saved.get('expense:exp-1:paid')?.entryDate).toBe('2026-07-04');
  });

  it('fenêtre nocturne Paris : après-demain (Paris) reste rejeté comme futur', async () => {
    const env = makeEnv([props()], '2026-07-03T23:30:00.000Z');
    const r = await env.usecase.execute({ ...command, paidOn: '2026-07-05' });
    expect(!r.ok && r.error.kind).toBe('domain');
    expect(env.counts()).toEqual({ expenseSaveCount: 0, entrySaveCount: 0 });
  });

  it('rejette date future et moyen inconnu sans aucune écriture', async () => {
    const future = makeEnv([props()]);
    const unknown = makeEnv([props()]);
    const r1 = await future.usecase.execute({ ...command, paidOn: '2026-07-05' });
    const r2 = await unknown.usecase.execute({ ...command, method: 'cheque' as unknown as 'transfer' });
    expect(!r1.ok && r1.error.kind).toBe('domain');
    expect(!r2.ok && r2.error.kind).toBe('domain');
    expect(future.counts()).toEqual({ expenseSaveCount: 0, entrySaveCount: 0 });
    expect(unknown.counts()).toEqual({ expenseSaveCount: 0, entrySaveCount: 0 });
  });

  it('masque une dépense d’un autre tenant comme introuvable', async () => {
    const env = makeEnv([props({ companyId: 'co-other' })]);
    const r = await env.usecase.execute(command);
    expect(!r.ok && r.error.kind).toBe('not_found');
    expect(env.counts()).toEqual({ expenseSaveCount: 0, entrySaveCount: 0 });
  });

  it('fail-closed sur une dépense historique payée sans preuve — entité dédiée pour router vers la régularisation', async () => {
    const env = makeEnv([props({ status: 'paid', paymentEvidence: null })]);
    const r = await env.usecase.execute(command);
    expect(!r.ok && r.error.kind).toBe('conflict');
    if (r.ok || r.error.kind !== 'conflict') return;
    expect(r.error.entity).toBe('expense_payment_legacy');
    expect(env.counts()).toEqual({ expenseSaveCount: 0, entrySaveCount: 0 });
  });

  it('dépense introuvable → not_found', async () => {
    const env = makeEnv([]);
    const r = await env.usecase.execute(command);
    expect(!r.ok && r.error.kind).toBe('not_found');
  });

  it('rejette une preuve documentaire absente ou hors tenant avant toute mutation', async () => {
    const env = makeEnv([props()]);
    const r = await env.usecase.execute({ ...command, proofDocumentId: 'document-other' });
    expect(!r.ok && r.error.kind).toBe('not_found');
    expect(env.counts()).toEqual({ expenseSaveCount: 0, entrySaveCount: 0 });
  });
});

describe('summarizeExpenses (E10 — la synthèse de l’écran Dépenses)', () => {
  it('reste à payer, payé du mois, TVA déductible du mois, ventilation par catégorie', () => {
    const s = summarizeExpenses(
      [
        props({ status: 'to_pay' }),
        props({ id: 'e2', status: 'paid', totalTtcCents: 34200, vatCents: 5700, category: 'materiel' }),
        props({ id: 'e3', status: 'paid', documentDate: '2026-06-14', totalTtcCents: 52040, vatCents: 8673, category: 'materiel' }),
        props({ id: 'e4', status: 'to_pay', totalTtcCents: 6000, vatCents: null, category: 'repas' }),
      ],
      { month: '2026-07' },
    );
    expect(s.toPayCents).toBe(24490);
    expect(s.toPayCount).toBe(2);
    expect(s.paidThisMonthCents).toBe(34200);
    expect(s.vatDeductibleThisMonthCents).toBe(3082 + 5700);
    expect(s.byCategory).toEqual([
      { category: 'fournitures', count: 1, ttcCents: 18490 },
      { category: 'materiel', count: 2, ttcCents: 86240 },
      { category: 'repas', count: 1, ttcCents: 6000 },
    ]);
  });
});
