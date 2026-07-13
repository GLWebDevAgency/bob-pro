import {
  appConflict,
  err,
  ok,
  type ClockPort,
  type IdGeneratorPort,
  type RecordExpenseInput,
} from '@bob/core';
import { describe, expect, it, vi } from 'vitest';
import { expenseCreationFingerprint, type ExpenseCreationRequestRecord } from '../persistence/expense-creation-requests';
import { InMemoryPersistence } from '../persistence/persistence';
import { ExpenseCreationCoordinator } from './expense-creation-coordinator';

const COMPANY = 'company-expense-coordinator';
const NOW = '2026-07-13T12:00:00.000Z';

const BASE_EXPENSE = {
  supplierName: 'Cedeo',
  documentDate: '2026-07-12',
  totalTtcCents: 18_490,
  vatCents: 3_082,
  vatRatePct: 20,
  category: 'fournitures',
  source: 'ocr',
} satisfies Omit<RecordExpenseInput, 'companyId'>;

class FixedClock implements ClockPort {
  now(): string {
    return NOW;
  }

  today(): string {
    return NOW.slice(0, 10);
  }
}

class QueuedIds implements IdGeneratorPort {
  constructor(private readonly values: string[] = ['expense-1', 'expense-2', 'expense-3']) {}

  newId(): string {
    const value = this.values.shift();
    if (!value) throw new Error('No test id left.');
    return value;
  }
}

function harness(ids = new QueuedIds()) {
  const persistence = new InMemoryPersistence();
  const coordinator = new ExpenseCreationCoordinator({
    persistence,
    ids,
    clock: new FixedClock(),
  });
  return { persistence, coordinator };
}

describe('ExpenseCreationCoordinator', () => {
  it('possède la racine tenant/transaction et retourne les métadonnées post-commit', async () => {
    const { persistence, coordinator } = harness();
    const forgedRuntimeExpense = { ...BASE_EXPENSE, companyId: 'company-forged-by-caller' };
    const tenantRoot = vi.spyOn(persistence, 'runWithTenant');
    const transactionRoot = vi.spyOn(persistence, 'runInTransaction');
    const followUp = vi.fn(async (context) => {
      expect((await persistence.expenses.findById(context.expenseId))?.companyId).toBe(COMPANY);
      expect(await persistence.accountingEntries.findById(
        COMPANY,
        `expense:${context.expenseId}:recorded`,
      )).not.toBeNull();
      return ok({ documentId: 'document-1', expenseId: context.expenseId });
    });

    const result = await coordinator.execute(
      { companyId: COMPANY, expense: forgedRuntimeExpense },
      followUp,
    );

    expect(result).toEqual(ok({
      expenseId: 'expense-1',
      created: true,
      accounting: {
        purchaseEntryId: 'expense:expense-1:recorded',
        paymentEntryId: null,
        created: true,
      },
      followUp: { documentId: 'document-1', expenseId: 'expense-1' },
    }));
    expect(followUp).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY,
      expenseId: 'expense-1',
      expense: expect.objectContaining({ supplierName: 'Cedeo', companyId: COMPANY }),
    }));
    expect(tenantRoot).toHaveBeenCalledOnce();
    expect(tenantRoot).toHaveBeenCalledWith(COMPANY, expect.any(Function));
    expect(transactionRoot).toHaveBeenCalledOnce();
  });

  it('exécute aussi le follow-up idempotent sur replay et ne recrée rien', async () => {
    const { persistence, coordinator } = harness();
    const expense = { ...BASE_EXPENSE, idempotencyKey: 'scan-response-lost-1' };
    const followUp = vi.fn(async (context) => ok({
      documentId: 'document-1',
      linkedExpenseId: context.expenseId,
    }));

    const first = await coordinator.execute({ companyId: COMPANY, expense }, followUp);
    const replay = await coordinator.execute({ companyId: COMPANY, expense }, followUp);

    expect(first.ok && first.value.created).toBe(true);
    expect(replay).toEqual(ok({
      expenseId: 'expense-1',
      created: false,
      accounting: {
        purchaseEntryId: 'expense:expense-1:recorded',
        paymentEntryId: null,
        created: false,
      },
      followUp: { documentId: 'document-1', linkedExpenseId: 'expense-1' },
    }));
    expect(followUp).toHaveBeenCalledTimes(2);
    expect(await persistence.expenses.listByCompany(COMPANY)).toHaveLength(1);
    expect(await persistence.accountingEntries.listByCompany(COMPANY)).toHaveLength(1);
  });

  it('rollback dépense, comptabilité et claim si le follow-up renvoie une AppError', async () => {
    const { persistence, coordinator } = harness();
    const expense = { ...BASE_EXPENSE, idempotencyKey: 'scan-follow-up-conflict-1' };
    const conflict = appConflict('document', 'Le document est déjà lié à une autre dépense.');

    const result = await coordinator.execute(
      { companyId: COMPANY, expense },
      async () => err(conflict),
    );

    expect(result).toEqual(err(conflict));
    expect(await persistence.expenses.listByCompany(COMPANY)).toHaveLength(0);
    expect(await persistence.accountingEntries.listByCompany(COMPANY)).toHaveLength(0);
    const fingerprint = expenseCreationFingerprint(COMPANY, expense);
    expect(fingerprint).not.toBeNull();
    if (!fingerprint) return;
    expect(await persistence.expenseCreationRequests.find({
      companyId: COMPANY,
      keyHash: fingerprint.keyHash,
    })).toBeNull();
  });

  it('la sentinelle claim-lost sort de la racine puis rejoue tout sur le gagnant', async () => {
    const { persistence, coordinator } = harness();
    const winner = await coordinator.execute({ companyId: COMPANY, expense: BASE_EXPENSE });
    expect(winner.ok).toBe(true);
    if (!winner.ok) return;

    let published: ExpenseCreationRequestRecord | null = null;
    let findCalls = 0;
    vi.spyOn(persistence.expenseCreationRequests, 'find').mockImplementation(async () => {
      findCalls += 1;
      return findCalls === 1 || published === null ? null : { ...published };
    });
    vi.spyOn(persistence.expenseCreationRequests, 'putIfAbsent').mockImplementation(async (candidate) => {
      published = { ...candidate, expenseId: winner.value.expenseId };
      return { ...published };
    });
    const tenantRoot = vi.spyOn(persistence, 'runWithTenant');
    const transactionRoot = vi.spyOn(persistence, 'runInTransaction');
    const followUp = vi.fn(async (context) => ok(context.expenseId));

    const result = await coordinator.execute({
      companyId: COMPANY,
      expense: { ...BASE_EXPENSE, idempotencyKey: 'forced-claim-lost-1' },
    }, followUp);

    expect(result.ok && result.value).toMatchObject({
      expenseId: winner.value.expenseId,
      created: false,
      followUp: winner.value.expenseId,
    });
    expect(tenantRoot).toHaveBeenCalledTimes(2);
    expect(transactionRoot).toHaveBeenCalledTimes(2);
    expect(followUp).toHaveBeenCalledOnce();
    expect(followUp).toHaveBeenCalledWith(expect.objectContaining({ expenseId: winner.value.expenseId }));
    expect(await persistence.expenses.listByCompany(COMPANY)).toHaveLength(1);
    expect(await persistence.accountingEntries.listByCompany(COMPANY)).toHaveLength(1);
  });

  it('réessaie aussi un doublon unique idempotent avant de converger sur sa claim', async () => {
    const { persistence, coordinator } = harness();
    const invoiceExpense = {
      ...BASE_EXPENSE,
      supplierSiren: '552100554',
      supplierInvoiceNumber: 'FAC-2026-0042',
    };
    const winner = await coordinator.execute({ companyId: COMPANY, expense: invoiceExpense });
    expect(winner.ok).toBe(true);
    if (!winner.ok) return;

    const request = { ...invoiceExpense, idempotencyKey: 'invoice-response-lost-1' };
    const fingerprint = expenseCreationFingerprint(COMPANY, request);
    expect(fingerprint).not.toBeNull();
    if (!fingerprint) return;
    const published: ExpenseCreationRequestRecord = {
      companyId: COMPANY,
      keyHash: fingerprint.keyHash,
      payloadHash: fingerprint.payloadHash,
      expenseId: winner.value.expenseId,
      createdAt: NOW,
    };
    let findCalls = 0;
    vi.spyOn(persistence.expenseCreationRequests, 'find').mockImplementation(async () => {
      findCalls += 1;
      return findCalls === 1 ? null : { ...published };
    });
    const tenantRoot = vi.spyOn(persistence, 'runWithTenant');
    const followUp = vi.fn(async (context) => ok(context.expenseId));

    const result = await coordinator.execute({ companyId: COMPANY, expense: request }, followUp);

    expect(result.ok && result.value).toMatchObject({
      expenseId: winner.value.expenseId,
      created: false,
      followUp: winner.value.expenseId,
    });
    expect(tenantRoot).toHaveBeenCalledTimes(2);
    expect(followUp).toHaveBeenCalledOnce();
    expect(await persistence.expenses.listByCompany(COMPANY)).toHaveLength(1);
  });

  it('borne le retry claim-lost à une seule nouvelle racine', async () => {
    const { persistence, coordinator } = harness();
    vi.spyOn(persistence.expenseCreationRequests, 'find').mockResolvedValue(null);
    vi.spyOn(persistence.expenseCreationRequests, 'putIfAbsent').mockImplementation(async (candidate) => ({
      ...candidate,
      expenseId: 'concurrent-winner-never-visible',
    }));
    const tenantRoot = vi.spyOn(persistence, 'runWithTenant');
    const transactionRoot = vi.spyOn(persistence, 'runInTransaction');
    const followUp = vi.fn(async () => ok(undefined));

    const result = await coordinator.execute({
      companyId: COMPANY,
      expense: { ...BASE_EXPENSE, idempotencyKey: 'never-converges-1' },
    }, followUp);

    expect(result).toEqual(err(expect.objectContaining({
      kind: 'dependency',
      port: 'expense-creation-idempotency',
    })));
    expect(tenantRoot).toHaveBeenCalledTimes(2);
    expect(transactionRoot).toHaveBeenCalledTimes(2);
    expect(followUp).not.toHaveBeenCalled();
    expect(await persistence.expenses.listByCompany(COMPANY)).toHaveLength(0);
    expect(await persistence.accountingEntries.listByCompany(COMPANY)).toHaveLength(0);
  });

  it('mappe les validations de clé, les AppErrors domaine et le doublon fonctionnel', async () => {
    const { persistence, coordinator } = harness();
    const tenantRoot = vi.spyOn(persistence, 'runWithTenant');

    const invalidKey = await coordinator.execute({
      companyId: COMPANY,
      expense: { ...BASE_EXPENSE, idempotencyKey: 'bad\nkey' },
    });
    expect(invalidKey).toEqual(err(expect.objectContaining({ kind: 'validation' })));
    expect(tenantRoot).not.toHaveBeenCalled();

    const invalidExpense = await coordinator.execute({
      companyId: COMPANY,
      expense: { ...BASE_EXPENSE, supplierName: '   ' },
    });
    expect(invalidExpense).toEqual(err({
      kind: 'domain',
      error: { code: 'VALIDATION', field: 'supplierName', message: 'Fournisseur requis.' },
    }));

    const invoiceExpense = {
      ...BASE_EXPENSE,
      supplierSiren: '552100554',
      supplierInvoiceNumber: 'FAC-DOUBLON-1',
    };
    expect((await coordinator.execute({ companyId: COMPANY, expense: invoiceExpense })).ok).toBe(true);
    const duplicate = await coordinator.execute({ companyId: COMPANY, expense: invoiceExpense });
    expect(duplicate).toEqual(err(expect.objectContaining({
      kind: 'validation',
      issues: [expect.objectContaining({ field: 'facturx.doublon' })],
    })));
    expect(await persistence.expenses.listByCompany(COMPANY)).toHaveLength(1);
  });
});
