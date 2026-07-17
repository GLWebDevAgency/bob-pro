import { describe, expect, it, vi } from 'vitest';
import {
  expenseCreationFingerprint,
  InvalidExpenseCreationRequestError,
  PrismaExpenseCreationRequestStore,
  type ExpenseCreationRequestRecord,
} from './expense-creation-requests';
import { InMemoryExpenseCreationRequestStore } from './expense-creation-requests.testing';
import type { PrismaService } from './prisma/prisma.service';

const NOW = '2026-07-13T12:00:00.000Z';

function record(overrides: Partial<ExpenseCreationRequestRecord> = {}): ExpenseCreationRequestRecord {
  return {
    companyId: 'co-1',
    keyHash: 'a'.repeat(64),
    payloadHash: 'b'.repeat(64),
    expenseId: 'expense-1',
    createdAt: NOW,
    ...overrides,
  };
}

describe('expenseCreationFingerprint', () => {
  const base = {
    supplierName: ' Cedeo ',
    supplierSiren: '552 100 554',
    documentDate: '2026-07-13',
    totalTtcCents: 12_000,
    category: 'fournitures' as const,
    idempotencyKey: 'retry-secret-123',
  };

  it('ne restitue jamais la clé brute et stabilise les variantes métier équivalentes', () => {
    const first = expenseCreationFingerprint('co-1', base);
    const same = expenseCreationFingerprint('co-1', {
      ...base,
      supplierName: 'Cedeo',
      supplierSiren: '552100554',
      source: 'manual',
      vatCents: null,
    });
    expect(first).toEqual(same);
    expect(JSON.stringify(first)).not.toContain(base.idempotencyKey);
    expect(first?.keyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('isole le hash de clé par tenant et détecte un payload différent', () => {
    const first = expenseCreationFingerprint('co-1', base);
    const otherTenant = expenseCreationFingerprint('co-2', base);
    const otherPayload = expenseCreationFingerprint('co-1', { ...base, totalTtcCents: 12_001 });
    expect(first?.keyHash).not.toBe(otherTenant?.keyHash);
    expect(first?.payloadHash).not.toBe(otherPayload?.payloadHash);
  });

  it('rejette les clés vides, de contrôle ou surdimensionnées', () => {
    expect(() => expenseCreationFingerprint('co-1', { ...base, idempotencyKey: '   ' }))
      .toThrow(InvalidExpenseCreationRequestError);
    expect(() => expenseCreationFingerprint('co-1', { ...base, idempotencyKey: 'bad\nkey' }))
      .toThrow(InvalidExpenseCreationRequestError);
    expect(() => expenseCreationFingerprint('co-1', { ...base, idempotencyKey: 'x'.repeat(201) }))
      .toThrow(InvalidExpenseCreationRequestError);
  });
});

describe('InMemoryExpenseCreationRequestStore', () => {
  it('conserve le premier gagnant concurrent et isole les tenants', async () => {
    const store = new InMemoryExpenseCreationRequestStore();
    const [first, second] = await Promise.all([
      store.putIfAbsent(record()),
      store.putIfAbsent(record({ expenseId: 'expense-loser' })),
    ]);
    expect(first.expenseId).toBe('expense-1');
    expect(second.expenseId).toBe('expense-1');
    await store.putIfAbsent(record({ companyId: 'co-2', expenseId: 'expense-2' }));
    await expect(store.find({ companyId: 'co-2', keyHash: 'a'.repeat(64) }))
      .resolves.toMatchObject({ expenseId: 'expense-2' });
  });
});

describe('PrismaExpenseCreationRequestStore', () => {
  it('fait un INSERT ON CONFLICT DO NOTHING puis relit le gagnant tenant-scoped', async () => {
    const winner = record({ expenseId: 'expense-winner' });
    const expenseCreationRequest = {
      createMany: vi.fn(async () => ({ count: 0 })),
      findUnique: vi.fn(async () => ({ ...winner, createdAt: new Date(winner.createdAt) })),
    };
    const store = new PrismaExpenseCreationRequestStore({
      client: () => ({ expenseCreationRequest }),
    } as unknown as PrismaService);

    await expect(store.putIfAbsent(record({ expenseId: 'expense-loser' })))
      .resolves.toMatchObject({ expenseId: 'expense-winner' });
    expect(expenseCreationRequest.createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
      data: expect.objectContaining({ companyId: 'co-1', keyHash: 'a'.repeat(64) }),
    }));
    expect(expenseCreationRequest.findUnique).toHaveBeenCalledWith({
      where: { expense_creation_request_key: { companyId: 'co-1', keyHash: 'a'.repeat(64) } },
    });
  });
});
