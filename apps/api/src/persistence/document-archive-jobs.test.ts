import { describe, expect, it } from 'vitest';
import {
  documentArchiveIntegrityProofSha256,
  isValidDocumentArchiveIntegrityProof,
  type DocumentArchiveIntegrityProof,
  type DocumentArchiveJobReason,
} from './document-archive-jobs';
import { InMemoryDocumentArchiveJobRepository } from './in-memory';

const SHA = 'a'.repeat(64);

function proof(
  companyId: string,
  pieceId: string,
  reason: DocumentArchiveJobReason,
): DocumentArchiveIntegrityProof {
  const artifact = (kind: 'invoice_pdf' | 'facturx_xml' | 'signed_quote') => ({
    kind,
    contentProfile: (
      kind === 'facturx_xml'
        ? 'facturx_xml'
        : kind === 'signed_quote' || reason === 'invoice-issued-pdf-only-b2c'
          ? 'plain_pdf'
          : 'facturx_pdfa3'
    ) as 'plain_pdf' | 'facturx_pdfa3' | 'facturx_xml',
    documentId: `doc-${kind}-${pieceId}`,
    versionId: `ver-${kind}-${pieceId}`,
    version: 1 as const,
    storageKey: `companies/${companyId}/documents/doc-${kind}-${pieceId}/1-${SHA}`,
    mimeType: kind === 'facturx_xml' ? 'application/xml' : 'application/pdf',
    byteSize: 42,
    sha256: SHA,
  });
  return {
    version: 1,
    algorithm: 'sha256',
    companyId,
    pieceId,
    reason,
    artifacts: reason === 'invoice-issued'
      ? [artifact('facturx_xml'), artifact('invoice_pdf')]
      : reason === 'invoice-issued-pdf-only-b2c'
        ? [artifact('invoice_pdf')]
        : [artifact('signed_quote')],
  };
}

describe('InMemoryDocumentArchiveJobRepository', () => {
  it('fige un manifeste PDF seul explicite pour une facture B2C sans endpoint', () => {
    const pdfOnly = proof('co-b2c', 'invoice-b2c', 'invoice-issued-pdf-only-b2c');
    expect(isValidDocumentArchiveIntegrityProof(pdfOnly)).toBe(true);
    expect(isValidDocumentArchiveIntegrityProof({
      ...pdfOnly,
      artifacts: [...pdfOnly.artifacts, {
        ...pdfOnly.artifacts[0]!,
        kind: 'facturx_xml',
        documentId: 'xml-forbidden',
        versionId: 'xml-forbidden-v1',
        storageKey: `companies/co-b2c/documents/xml-forbidden/1-${SHA}`,
        mimeType: 'application/xml',
      }],
    })).toBe(false);
  });

  it('refuse de changer une facture de PDF seul vers PDF + XML après enqueue', async () => {
    const repo = new InMemoryDocumentArchiveJobRepository();
    await repo.enqueue({
      id: 'job-b2c',
      companyId: 'co-b2c',
      pieceId: 'invoice-b2c',
      reason: 'invoice-issued-pdf-only-b2c',
      now: '2026-07-01T10:00:00.000Z',
    });

    await expect(repo.enqueue({
      id: 'job-b2b-late',
      companyId: 'co-b2c',
      pieceId: 'invoice-b2c',
      reason: 'invoice-issued',
      now: '2026-07-01T10:01:00.000Z',
    })).rejects.toThrow('scope is immutable');
    expect(repo.snapshot()).toHaveLength(1);
  });

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

    const dueAt = (await repo.listDue('co-1', '2026-07-01T10:00:00.000Z', 1))[0]!;
    const firstClaim = await repo.claimForArchive(
      dueAt.id,
      dueAt.companyId,
      dueAt.updatedAt,
      '2026-07-01T10:00:00.000Z',
      '2026-07-01T10:01:00.000Z',
      'lease-1',
    );
    expect(firstClaim.outcome).toBe('claimed');
    expect(await repo.markFailed(
      'job-1',
      'co-1',
      'lease-1',
      '2026-07-01T10:00:05.000Z',
      '2026-07-01T10:05:00.000Z',
      'supabase down',
    )).toBe(true);

    expect(await repo.listDue('co-1', '2026-07-01T10:04:59.000Z', 10)).toHaveLength(0);
    const due = await repo.listDue('co-1', '2026-07-01T10:05:00.000Z', 10);
    expect(due).toHaveLength(1);
    expect(due[0]!).toMatchObject({ attempts: 1, status: 'failed', lastError: 'supabase down' });

    const retry = due[0]!;
    const retryClaim = await repo.claimForArchive(
      retry.id,
      retry.companyId,
      retry.updatedAt,
      '2026-07-01T10:05:00.000Z',
      '2026-07-01T10:06:00.000Z',
      'lease-2',
    );
    expect(retryClaim.outcome).toBe('claimed');
    const invoiceProof = proof('co-1', 'inv-1', 'invoice-issued');
    expect(await repo.markDone(
      'job-1',
      'co-1',
      'lease-2',
      invoiceProof,
      documentArchiveIntegrityProofSha256(invoiceProof),
      '2026-07-01T10:05:10.000Z',
    )).toBe(true);
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

    const quote1 = (await repo.listDue('co-1', '2026-07-01T10:00:00.000Z', 10))
      .find((job) => job.id === 'job-quote-1')!;
    await repo.claimForArchive(
      quote1.id,
      quote1.companyId,
      quote1.updatedAt,
      '2026-07-01T10:00:00.000Z',
      '2026-07-01T10:05:00.000Z',
      'lease-quote-1',
    );
    const quote1Proof = proof('co-1', 'quote-1', 'quote-signed');
    await repo.markDone(
      'job-quote-1',
      'co-1',
      'lease-quote-1',
      quote1Proof,
      documentArchiveIntegrityProofSha256(quote1Proof),
      '2026-07-01T10:01:00.000Z',
    );
    expect(await repo.countIncomplete('co-1', 'quote-signed')).toBe(1);

    // Un échec reste incomplet : la barrière ne se lève qu'à l'archivage abouti.
    const quote2 = (await repo.listDue('co-1', '2026-07-01T10:00:00.000Z', 10))
      .find((job) => job.id === 'job-quote-2')!;
    await repo.claimForArchive(
      quote2.id,
      quote2.companyId,
      quote2.updatedAt,
      '2026-07-01T10:00:00.000Z',
      '2026-07-01T10:05:00.000Z',
      'lease-quote-2',
    );
    await repo.markFailed(
      'job-quote-2',
      'co-1',
      'lease-quote-2',
      '2026-07-01T10:02:00.000Z',
      '2026-07-01T10:10:00.000Z',
      'storage down',
    );
    expect(await repo.countIncomplete('co-1', 'quote-signed')).toBe(1);

    const quote2Retry = (await repo.listDue('co-1', '2026-07-01T10:15:00.000Z', 10))
      .find((job) => job.id === 'job-quote-2')!;
    await repo.claimForArchive(
      quote2Retry.id,
      quote2Retry.companyId,
      quote2Retry.updatedAt,
      '2026-07-01T10:15:00.000Z',
      '2026-07-01T10:20:00.000Z',
      'lease-quote-2b',
    );
    const quote2Proof = proof('co-1', 'quote-2', 'quote-signed');
    await repo.markDone(
      'job-quote-2',
      'co-1',
      'lease-quote-2b',
      quote2Proof,
      documentArchiveIntegrityProofSha256(quote2Proof),
      '2026-07-01T10:15:01.000Z',
    );
    expect(await repo.countIncomplete('co-1', 'quote-signed')).toBe(0);
    expect(await repo.countIncomplete('co-1', 'invoice-issued')).toBe(1);
  });

  it('fence deux workers : seul le lease courant peut terminer avec une preuve exacte', async () => {
    const repo = new InMemoryDocumentArchiveJobRepository();
    await repo.enqueue({
      id: 'job-race',
      companyId: 'co-1',
      pieceId: 'inv-race',
      reason: 'invoice-issued',
      now: '2026-07-01T10:00:00.000Z',
    });
    const candidate = (await repo.listDue('co-1', '2026-07-01T10:00:00.000Z', 1))[0]!;
    expect((await repo.claimForArchive(
      candidate.id,
      candidate.companyId,
      candidate.updatedAt,
      '2026-07-01T10:00:00.000Z',
      '2026-07-01T10:01:00.000Z',
      'lease-a',
    )).outcome).toBe('claimed');
    expect((await repo.claimForArchive(
      candidate.id,
      candidate.companyId,
      candidate.updatedAt,
      '2026-07-01T10:00:00.000Z',
      '2026-07-01T10:01:00.000Z',
      'lease-b',
    )).outcome).toBe('skipped');

    const p = proof('co-1', 'inv-race', 'invoice-issued');
    expect(await repo.markDone(
      'job-race', 'co-1', 'lease-b', p, documentArchiveIntegrityProofSha256(p),
      '2026-07-01T10:00:10.000Z',
    )).toBe(false);
    expect(await repo.markDone(
      'job-race', 'co-1', 'lease-a', p, documentArchiveIntegrityProofSha256(p),
      '2026-07-01T10:00:10.000Z',
    )).toBe(true);
    expect(await repo.countIncomplete('co-1', 'invoice-issued')).toBe(0);
  });

  it.each([
    ['artefact XML absent', (value: DocumentArchiveIntegrityProof) => ({
      ...value,
      artifacts: value.artifacts.filter((artifact) => artifact.kind !== 'facturx_xml'),
    })],
    ['type dupliqué', (value: DocumentArchiveIntegrityProof) => ({
      ...value,
      artifacts: value.artifacts.map((artifact) =>
        artifact.kind === 'facturx_xml'
          ? { ...artifact, kind: 'invoice_pdf' as const, mimeType: 'application/pdf' }
          : artifact),
    })],
    ['mauvais tenant', (value: DocumentArchiveIntegrityProof) => ({
      ...value,
      companyId: 'co-2',
    })],
    ['mauvaise pièce', (value: DocumentArchiveIntegrityProof) => ({
      ...value,
      pieceId: 'inv-other',
    })],
    ['mauvais motif', (_value: DocumentArchiveIntegrityProof) =>
      proof('co-1', 'inv-proof', 'quote-signed')],
    ['champ non authentifié', (value: DocumentArchiveIntegrityProof) => ({
      ...value,
      unexpected: 'forbidden',
    }) as DocumentArchiveIntegrityProof],
  ])('refuse markDone avec une preuve invalide : %s', async (_label, mutate) => {
    const repo = new InMemoryDocumentArchiveJobRepository();
    await repo.enqueue({
      id: 'job-proof',
      companyId: 'co-1',
      pieceId: 'inv-proof',
      reason: 'invoice-issued',
      now: '2026-07-01T10:00:00.000Z',
    });
    const candidate = (await repo.listDue('co-1', '2026-07-01T10:00:00.000Z', 1))[0]!;
    await repo.claimForArchive(
      candidate.id,
      candidate.companyId,
      candidate.updatedAt,
      '2026-07-01T10:00:00.000Z',
      '2026-07-01T10:05:00.000Z',
      'lease-proof',
    );
    const invalid = mutate(proof('co-1', 'inv-proof', 'invoice-issued'));

    expect(await repo.markDone(
      'job-proof',
      'co-1',
      'lease-proof',
      invalid,
      documentArchiveIntegrityProofSha256(invalid),
      '2026-07-01T10:01:00.000Z',
    )).toBe(false);
    expect(await repo.countIncomplete('co-1', 'invoice-issued')).toBe(1);
    expect(await repo.findByPiece('co-1', 'inv-proof', 'invoice-issued')).toMatchObject({
      status: 'pending',
      leaseToken: 'lease-proof',
      integrityProof: null,
      integrityProofSha256: null,
      completedAt: null,
    });
  });

  it('refuse un digest qui ne correspond pas exactement au manifeste', async () => {
    const repo = new InMemoryDocumentArchiveJobRepository();
    await repo.enqueue({
      id: 'job-digest',
      companyId: 'co-1',
      pieceId: 'inv-digest',
      reason: 'invoice-issued',
      now: '2026-07-01T10:00:00.000Z',
    });
    const candidate = (await repo.listDue('co-1', '2026-07-01T10:00:00.000Z', 1))[0]!;
    await repo.claimForArchive(
      candidate.id,
      candidate.companyId,
      candidate.updatedAt,
      '2026-07-01T10:00:00.000Z',
      '2026-07-01T10:05:00.000Z',
      'lease-digest',
    );
    const valid = proof('co-1', 'inv-digest', 'invoice-issued');

    expect(await repo.markDone(
      'job-digest', 'co-1', 'lease-digest', valid, 'b'.repeat(64),
      '2026-07-01T10:01:00.000Z',
    )).toBe(false);
    expect(await repo.countIncomplete('co-1', 'invoice-issued')).toBe(1);
  });
});
