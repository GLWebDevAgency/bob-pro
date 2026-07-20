import { describe, expect, it } from 'vitest';
import { Expense, type ExpenseProps } from '../../domain/expense/expense';
import { AccountingEntry } from '../../domain/accounting/accounting-entry';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ExpenseRepository } from '../ports/repositories';
import { type DocumentRepository } from '../ports/document-repository';
import { RegularizeLegacyExpensePayment } from './regularize-legacy-expense-payment';

function props(over: Partial<ExpenseProps> = {}): ExpenseProps {
  return {
    id: 'exp-legacy-1',
    companyId: 'co-1',
    supplierName: 'Point P',
    supplierSiren: null,
    documentDate: '2025-11-12',
    totalTtcCents: 52040,
    totalHtCents: 43367,
    vatCents: 8673,
    vatRatePct: 20,
    category: 'materiel',
    // État HISTORIQUE régularisable : payée sans preuve (paymentEvidenceLegacyUnverified).
    status: 'paid',
    paymentEvidence: null,
    source: 'manual',
    ...over,
  };
}

function makeEnv(seed: ExpenseProps[], clockNow = '2026-07-04T10:00:00.000Z') {
  const byId = new Map(seed.map((p) => [p.id, Expense.rehydrate(p)]));
  const saved = new Map<string, AccountingEntry>();
  let expenseSaveCount = 0;
  let entrySaveCount = 0;
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
    usecase: new RegularizeLegacyExpensePayment({ expenses, entries, clock, documents }),
  };
}

const command = {
  companyId: 'co-1',
  expenseId: 'exp-legacy-1',
  paidOn: '2025-11-20',
  method: 'transfer' as const,
  reference: 'VIR-2025-118',
  proofDocumentId: 'document-proof-1',
};

describe('RegularizeLegacyExpensePayment (sortie de l’impasse historique « payée sans preuve »)', () => {
  it('attache la preuve et poste l’écriture 401/512 manquante à sa date réelle', async () => {
    const env = makeEnv([props()]);
    const r = await env.usecase.execute(command);
    expect(r).toEqual({
      ok: true,
      value: { status: 'paid', alreadyRegularized: false, paymentEntryId: 'expense:exp-legacy-1:paid' },
    });
    expect(env.byId.get('exp-legacy-1')?.toProps()).toMatchObject({
      status: 'paid',
      paymentEvidence: {
        paidOn: '2025-11-20',
        method: 'transfer',
        reference: 'VIR-2025-118',
        proofDocumentId: 'document-proof-1',
      },
    });
    const entry = env.saved.get('expense:exp-legacy-1:paid');
    expect(entry?.entryDate).toBe('2025-11-20');
    expect(entry?.lines.map((line) => line.account)).toEqual(['401', '512']);
  });

  it('espèces : l’écriture crédite 530, jamais 512', async () => {
    const env = makeEnv([props()]);
    await env.usecase.execute({ ...command, method: 'cash' });
    expect(env.saved.get('expense:exp-legacy-1:paid')?.lines.map((line) => line.account)).toEqual(['401', '530']);
  });

  it('refuse une dépense encore à payer : c’est un règlement, pas une régularisation', async () => {
    const env = makeEnv([props({ status: 'to_pay', paymentEvidence: null })]);
    const r = await env.usecase.execute(command);
    expect(!r.ok && r.error.kind).toBe('conflict');
    expect(env.counts()).toEqual({ expenseSaveCount: 0, entrySaveCount: 0 });
  });

  it('refuse une dépense déjà justifiée par une preuve différente', async () => {
    const env = makeEnv([props({
      paymentEvidence: { paidOn: '2025-11-18', method: 'card', reference: null, proofDocumentId: null },
    })]);
    const r = await env.usecase.execute(command);
    expect(!r.ok && r.error.kind).toBe('conflict');
    expect(env.byId.get('exp-legacy-1')?.paymentEvidence?.paidOn).toBe('2025-11-18');
    expect(env.counts()).toEqual({ expenseSaveCount: 0, entrySaveCount: 0 });
  });

  it('retry strictement identique est idempotent (aucune double écriture)', async () => {
    const env = makeEnv([props()]);
    await env.usecase.execute(command);
    const replay = await env.usecase.execute(command);
    expect(replay.ok && replay.value.alreadyRegularized).toBe(true);
    expect(env.counts()).toEqual({ expenseSaveCount: 1, entrySaveCount: 1 });
  });

  it('écriture déterministe existante mais différente : conflit avant mutation', async () => {
    const env = makeEnv([props()]);
    const wrong = AccountingEntry.create({
      id: 'expense:exp-legacy-1:paid',
      companyId: 'co-1',
      journal: 'bank',
      sourceType: 'expense',
      sourceId: 'exp-legacy-1',
      entryDate: '2025-11-02',
      reference: 'AUTRE',
      label: 'Règlement Point P',
      lines: [
        { account: '401', label: 'Règlement Point P', debitCents: 52040, creditCents: 0 },
        { account: '512', label: 'Règlement Point P', debitCents: 0, creditCents: 52040 },
      ],
    });
    expect(wrong.ok).toBe(true);
    if (!wrong.ok) return;
    env.saved.set(wrong.value.id, wrong.value);
    const r = await env.usecase.execute(command);
    expect(!r.ok && r.error.kind).toBe('conflict');
    expect(env.byId.get('exp-legacy-1')?.paymentEvidence).toBeNull();
    expect(env.counts()).toEqual({ expenseSaveCount: 0, entrySaveCount: 0 });
  });

  it('rejette une date future, une preuve hors tenant et une dépense d’un autre tenant', async () => {
    const future = makeEnv([props()]);
    const rFuture = await future.usecase.execute({ ...command, paidOn: '2026-07-05' });
    expect(!rFuture.ok && rFuture.error.kind).toBe('domain');

    const badProof = makeEnv([props()]);
    const rProof = await badProof.usecase.execute({ ...command, proofDocumentId: 'document-autre' });
    expect(!rProof.ok && rProof.error.kind).toBe('not_found');

    const otherTenant = makeEnv([props({ companyId: 'co-other' })]);
    const rTenant = await otherTenant.usecase.execute(command);
    expect(!rTenant.ok && rTenant.error.kind).toBe('not_found');
    expect(future.counts()).toEqual({ expenseSaveCount: 0, entrySaveCount: 0 });
  });

  it('fenêtre nocturne Paris : une régularisation datée du jour Paris est acceptée', async () => {
    // 23h30 UTC le 3 juillet = 01h30 le 4 juillet à Paris (été) : le jour métier est le 4.
    const env = makeEnv([props()], '2026-07-03T23:30:00.000Z');
    const r = await env.usecase.execute({ ...command, paidOn: '2026-07-04' });
    expect(r.ok && r.value.alreadyRegularized).toBe(false);
    expect(env.saved.get('expense:exp-legacy-1:paid')?.entryDate).toBe('2026-07-04');
  });
});
