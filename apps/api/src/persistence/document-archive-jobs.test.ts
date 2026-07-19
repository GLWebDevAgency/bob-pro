import { describe, expect, it } from 'vitest';
import { InMemoryDocumentArchiveJobRepository } from './in-memory';

describe('InMemoryDocumentArchiveJobRepository', () => {
  it('enqueue de façon idempotente et liste les jobs dus par tenant', async () => {
    const repo = new InMemoryDocumentArchiveJobRepository();
    await repo.enqueue({
      id: 'job-1',
      companyId: 'co-1',
      pieceId: 'inv-1',
      reason: 'invoice-issued',
      now: '2026-07-01T10:00:00.000Z',
    });
    await repo.enqueue({
      id: 'job-duplicate',
      companyId: 'co-1',
      pieceId: 'inv-1',
      reason: 'invoice-issued',
      now: '2026-07-01T10:01:00.000Z',
    });
    await repo.enqueue({
      id: 'job-other-tenant',
      companyId: 'co-2',
      pieceId: 'inv-1',
      reason: 'invoice-issued',
      now: '2026-07-01T10:00:00.000Z',
    });

    const due = await repo.listDue('co-1', '2026-07-01T10:01:00.000Z', 10);
    expect(due).toHaveLength(1);
    expect(due[0]!).toMatchObject({ id: 'job-1', status: 'pending', pieceId: 'inv-1' });
  });

  it('marque un échec puis sort le job des dus jusqu’au prochain essai', async () => {
    const repo = new InMemoryDocumentArchiveJobRepository();
    await repo.enqueue({
      id: 'job-1',
      companyId: 'co-1',
      pieceId: 'inv-1',
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

  it('A8 : distingue par motif — un devis signé et une facture partagent un id de pièce sans collision', async () => {
    const repo = new InMemoryDocumentArchiveJobRepository();
    await repo.enqueue({
      id: 'job-invoice',
      companyId: 'co-1',
      pieceId: 'piece-1',
      reason: 'invoice-issued',
      now: '2026-07-01T10:00:00.000Z',
    });
    await repo.enqueue({
      id: 'job-quote',
      companyId: 'co-1',
      pieceId: 'piece-1',
      reason: 'quote-signed',
      now: '2026-07-01T10:00:00.000Z',
    });

    expect(await repo.listDue('co-1', '2026-07-01T10:00:00.000Z', 10)).toHaveLength(2);
    expect(await repo.findByPiece('co-1', 'piece-1', 'quote-signed')).toMatchObject({
      id: 'job-quote',
      reason: 'quote-signed',
    });
    expect(await repo.findByPiece('co-1', 'piece-2', 'quote-signed')).toBeNull();
    expect(await repo.findByPiece('co-2', 'piece-1', 'quote-signed')).toBeNull();
  });

  it('A8 : countIncomplete ne compte que les ordres non aboutis du motif demandé', async () => {
    const repo = new InMemoryDocumentArchiveJobRepository();
    await repo.enqueue({
      id: 'job-quote-1',
      companyId: 'co-1',
      pieceId: 'quote-1',
      reason: 'quote-signed',
      now: '2026-07-01T10:00:00.000Z',
    });
    await repo.enqueue({
      id: 'job-quote-2',
      companyId: 'co-1',
      pieceId: 'quote-2',
      reason: 'quote-signed',
      now: '2026-07-01T10:00:00.000Z',
    });
    await repo.enqueue({
      id: 'job-invoice',
      companyId: 'co-1',
      pieceId: 'inv-1',
      reason: 'invoice-issued',
      now: '2026-07-01T10:00:00.000Z',
    });

    expect(await repo.countIncomplete('co-1', 'quote-signed')).toBe(2);

    await repo.markDone('job-quote-1', '2026-07-01T10:01:00.000Z');
    expect(await repo.countIncomplete('co-1', 'quote-signed')).toBe(1);

    // Un échec reste incomplet : la barrière ne se lève qu'à l'archivage abouti.
    await repo.markFailed('job-quote-2', '2026-07-01T10:02:00.000Z', '2026-07-01T10:10:00.000Z', 'storage down');
    expect(await repo.countIncomplete('co-1', 'quote-signed')).toBe(1);

    await repo.markDone('job-quote-2', '2026-07-01T10:15:00.000Z');
    expect(await repo.countIncomplete('co-1', 'quote-signed')).toBe(0);
    expect(await repo.countIncomplete('co-1', 'invoice-issued')).toBe(1);
  });
});
