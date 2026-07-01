import { describe, expect, it } from 'vitest';
import { InMemoryDocumentArchiveJobRepository } from './in-memory';

describe('InMemoryDocumentArchiveJobRepository', () => {
  it('enqueue de façon idempotente et liste les jobs dus par tenant', async () => {
    const repo = new InMemoryDocumentArchiveJobRepository();
    await repo.enqueue({
      id: 'job-1',
      companyId: 'co-1',
      invoiceId: 'inv-1',
      reason: 'invoice-issued',
      now: '2026-07-01T10:00:00.000Z',
    });
    await repo.enqueue({
      id: 'job-duplicate',
      companyId: 'co-1',
      invoiceId: 'inv-1',
      reason: 'invoice-issued',
      now: '2026-07-01T10:01:00.000Z',
    });
    await repo.enqueue({
      id: 'job-other-tenant',
      companyId: 'co-2',
      invoiceId: 'inv-1',
      reason: 'invoice-issued',
      now: '2026-07-01T10:00:00.000Z',
    });

    const due = await repo.listDue('co-1', '2026-07-01T10:01:00.000Z', 10);
    expect(due).toHaveLength(1);
    expect(due[0]!).toMatchObject({ id: 'job-1', status: 'pending', invoiceId: 'inv-1' });
  });

  it('marque un échec puis sort le job des dus jusqu’au prochain essai', async () => {
    const repo = new InMemoryDocumentArchiveJobRepository();
    await repo.enqueue({
      id: 'job-1',
      companyId: 'co-1',
      invoiceId: 'inv-1',
      reason: 'invoice-issued',
      now: '2026-07-01T10:00:00.000Z',
    });

    await repo.markFailed('job-1', '2026-07-01T10:00:05.000Z', '2026-07-01T10:05:00.000Z', 'supabase down');

    expect(await repo.listDue('co-1', '2026-07-01T10:04:59.000Z', 10)).toHaveLength(0);
    const due = await repo.listDue('co-1', '2026-07-01T10:05:00.000Z', 10);
    expect(due).toHaveLength(1);
    expect(due[0]!).toMatchObject({ attempts: 1, status: 'failed', lastError: 'supabase down' });

    await repo.markDone('job-1', '2026-07-01T10:05:10.000Z');
    expect(await repo.listDue('co-1', '2026-07-01T11:00:00.000Z', 10)).toHaveLength(0);
  });
});
