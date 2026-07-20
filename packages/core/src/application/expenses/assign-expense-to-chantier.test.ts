import { describe, expect, it } from 'vitest';
import { Expense, type ExpenseProps } from '../../domain/expense/expense';
import { type DocumentLinkTargetInput } from '../ports/document-link-target';
import { AssignExpenseToChantier } from './assign-expense-to-chantier';

const COMPANY = 'co-mercier';

function makeExpense(over: Partial<ExpenseProps> = {}): Expense {
  return Expense.rehydrate({
    id: 'exp-leroy',
    companyId: COMPANY,
    supplierName: 'Leroy Merlin',
    supplierSiren: null,
    documentDate: '2026-07-01',
    totalTtcCents: 18_490,
    totalHtCents: null,
    vatCents: null,
    vatRatePct: null,
    category: 'fournitures',
    status: 'to_pay',
    source: 'ocr',
    ...over,
  });
}

function makeDeps(over: {
  expenses?: Expense[];
  chantierExists?: boolean;
  withLock?: boolean;
} = {}) {
  const store = new Map((over.expenses ?? [makeExpense()]).map((e) => [e.id, e]));
  const saved: Expense[] = [];
  const existsCalls: DocumentLinkTargetInput[] = [];
  let lockCalls = 0;
  const deps = {
    expenses: {
      save: async (e: Expense) => {
        saved.push(e);
      },
      findById: async (id: string) => store.get(id) ?? null,
      ...(over.withLock
        ? {
            lockById: async (id: string) => {
              lockCalls += 1;
              return store.get(id) ?? null;
            },
          }
        : {}),
      listByCompany: async (companyId: string) =>
        [...store.values()].filter((e) => e.companyId === companyId),
    },
    chantierTargets: {
      exists: async (input: DocumentLinkTargetInput) => {
        existsCalls.push(input);
        return over.chantierExists ?? true;
      },
    },
  };
  return { deps, saved, existsCalls, lockCalls: () => lockCalls, store };
}

describe('AssignExpenseToChantier (imputation rentabilité par chantier)', () => {
  it('impute la dépense au chantier prouvé dans le tenant et persiste', async () => {
    const { deps, saved, existsCalls } = makeDeps();
    const r = await new AssignExpenseToChantier(deps).execute({
      companyId: COMPANY,
      expenseId: 'exp-leroy',
      chantierId: 'chantier-durand',
    });

    expect(r).toEqual({ ok: true, value: { chantierId: 'chantier-durand', changed: true } });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.toProps().chantierId).toBe('chantier-durand');
    // La preuve tenant passe par le MÊME port anti-IDOR que le coffre (type 'chantier').
    expect(existsCalls).toEqual([
      { companyId: COMPANY, linkedEntityType: 'chantier', linkedEntityId: 'chantier-durand' },
    ]);
  });

  it('est idempotent : ré-imputer le même chantier réussit SANS écriture', async () => {
    const { deps, saved } = makeDeps({ expenses: [makeExpense({ chantierId: 'chantier-durand' })] });
    const r = await new AssignExpenseToChantier(deps).execute({
      companyId: COMPANY,
      expenseId: 'exp-leroy',
      chantierId: '  chantier-durand  ', // id normalisé comme au domaine
    });

    expect(r).toEqual({ ok: true, value: { chantierId: 'chantier-durand', changed: false } });
    expect(saved).toHaveLength(0);
  });

  it('délie avec null explicite (sans consommer le port) ; re-délier ne réécrit rien', async () => {
    const { deps, saved, existsCalls } = makeDeps({
      expenses: [makeExpense({ chantierId: 'chantier-durand' })],
    });
    const uc = new AssignExpenseToChantier(deps);

    const unlinked = await uc.execute({ companyId: COMPANY, expenseId: 'exp-leroy', chantierId: null });
    expect(unlinked).toEqual({ ok: true, value: { chantierId: null, changed: true } });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.toProps().chantierId).toBeNull();
    expect(existsCalls).toHaveLength(0); // aucun chantier visé → rien à prouver

    const replay = await uc.execute({ companyId: COMPANY, expenseId: 'exp-leroy', chantierId: null });
    expect(replay).toEqual({ ok: true, value: { chantierId: null, changed: false } });
    expect(saved).toHaveLength(1); // pas d'écriture fantôme
  });

  it('refuse une dépense inconnue — et une dépense d’un AUTRE tenant, indistinguables (anti-IDOR)', async () => {
    const { deps, saved } = makeDeps({ expenses: [makeExpense({ companyId: 'co-autre' })] });
    const uc = new AssignExpenseToChantier(deps);

    const unknown = await uc.execute({ companyId: COMPANY, expenseId: 'exp-inconnue', chantierId: 'chantier-durand' });
    const foreign = await uc.execute({ companyId: COMPANY, expenseId: 'exp-leroy', chantierId: 'chantier-durand' });

    expect(unknown).toEqual({ ok: false, error: { kind: 'not_found', entity: 'expense', id: 'exp-inconnue' } });
    expect(foreign).toEqual({ ok: false, error: { kind: 'not_found', entity: 'expense', id: 'exp-leroy' } });
    expect(saved).toHaveLength(0);
  });

  it('refuse un chantier absent ou hors tenant (port → false) SANS muter la dépense', async () => {
    const expense = makeExpense();
    const { deps, saved } = makeDeps({ expenses: [expense], chantierExists: false });
    const r = await new AssignExpenseToChantier(deps).execute({
      companyId: COMPANY,
      expenseId: 'exp-leroy',
      chantierId: 'chantier-vole',
    });

    expect(r).toEqual({ ok: false, error: { kind: 'not_found', entity: 'chantier', id: 'chantier-vole' } });
    expect(saved).toHaveLength(0);
    expect(expense.chantierId).toBeNull(); // l'agrégat n'a pas bougé
  });

  it('refuse un id de chantier blanc (VALIDATION du domaine) sans consommer le port', async () => {
    const { deps, saved, existsCalls } = makeDeps();
    const r = await new AssignExpenseToChantier(deps).execute({
      companyId: COMPANY,
      expenseId: 'exp-leroy',
      chantierId: '   ',
    });

    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'domain', error: { code: 'VALIDATION', field: 'chantierId' } },
    });
    expect(existsCalls).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it('préfère le verrou pessimiste lockById quand l’adaptateur le fournit (convention des mutations dépense)', async () => {
    const { deps, lockCalls } = makeDeps({ withLock: true });
    const r = await new AssignExpenseToChantier(deps).execute({
      companyId: COMPANY,
      expenseId: 'exp-leroy',
      chantierId: 'chantier-durand',
    });

    expect(r.ok).toBe(true);
    expect(lockCalls()).toBe(1);
  });
});
