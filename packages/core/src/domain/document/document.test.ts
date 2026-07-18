import { describe, expect, it } from 'vitest';
import { Document, type DocumentProps } from './document';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function props(over: Partial<DocumentProps> = {}): DocumentProps {
  return {
    id: 'doc-1',
    companyId: 'co-1',
    kind: 'expense_receipt',
    origin: 'ocr',
    status: 'active',
    filename: 'ticket.jpg',
    mimeType: 'image/jpeg',
    byteSize: 12,
    sha256: SHA_A,
    storageKey: `companies/co-1/documents/doc-1/v1/${SHA_A}.jpg`,
    linkedEntityType: 'expense',
    linkedEntityId: 'exp-1',
    documentDate: '2026-06-01',
    issuedAt: null,
    createdAt: '2026-06-01T10:00:00.000Z',
    createdBy: 'user-1',
    tags: [],
  retentionUntil: '2036-06-01',
    deletedAt: null,
    versions: [
      {
        id: 'ver-1',
        documentId: 'doc-1',
        version: 1,
        storageKey: `companies/co-1/documents/doc-1/v1/${SHA_A}.jpg`,
        sha256: SHA_A,
        mimeType: 'image/jpeg',
        byteSize: 12,
        createdAt: '2026-06-01T10:00:00.000Z',
        reason: 'initial',
      },
    ],
    ...over,
  };
}

describe('Document', () => {
  it('enregistre les métadonnées et la version initiale', () => {
    const r = Document.record(props({ filename: '  ticket.jpg  ' }));

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.toProps().filename).toBe('ticket.jpg');
  });

  it('rejette une clé de stockage hors périmètre tenant', () => {
    const r = Document.record(props({ storageKey: `companies/co-2/documents/doc-1/v1/${SHA_A}.jpg` }));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'VALIDATION', field: 'storageKey' });
  });

  it('rejette des métadonnées qui ne correspondent pas à la version courante', () => {
    const r = Document.record(props({ sha256: SHA_B }));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'VALIDATION', field: 'versions' });
  });

  it('impose le couple de rattachement null/null ou type/id non vide et canonise l’id', () => {
    const missingId = Document.record(props({ linkedEntityType: 'expense', linkedEntityId: null }));
    const blankId = Document.record(props({ linkedEntityType: 'expense', linkedEntityId: '   ' }));
    const missingType = Document.record(props({ linkedEntityType: null, linkedEntityId: 'exp-1' }));
    const unlinked = Document.record(props({ linkedEntityType: null, linkedEntityId: null }));
    const linked = Document.record(props({ linkedEntityId: '  exp-1  ' }));

    expect(missingId.ok).toBe(false);
    expect(blankId.ok).toBe(false);
    expect(missingType.ok).toBe(false);
    expect(unlinked.ok).toBe(true);
    expect(linked.ok && linked.value.toProps().linkedEntityId).toBe('exp-1');
  });

  it('ajoute une nouvelle version sans écraser l’historique', () => {
    const r = Document.record(props());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const added = r.value.addVersion({
      id: 'ver-2',
      documentId: 'doc-1',
      version: 2,
      storageKey: `companies/co-1/documents/doc-1/v2/${SHA_B}.jpg`,
      sha256: SHA_B,
      mimeType: 'image/jpeg',
      byteSize: 34,
      createdAt: '2026-06-02T10:00:00.000Z',
      reason: 'recadrage',
    });

    expect(added.ok).toBe(true);
    expect(r.value.sha256).toBe(SHA_B);
    expect(r.value.toProps().versions.map((v) => v.version)).toEqual([1, 2]);
  });
});

describe('Document — displayName (libellé d’affichage, filename immuable)', () => {
  it('défaut : le libellé reprend le filename ; fourni : il est validé et normalisé', () => {
    const byDefault = Document.record(props());
    expect(byDefault.ok && byDefault.value.displayName).toBe('ticket.jpg');
    expect(byDefault.ok && byDefault.value.toProps().displayName).toBe('ticket.jpg');

    const provided = Document.record(props({ displayName: '  Facture   Leroy Merlin — 184,90 € ' }));
    expect(provided.ok && provided.value.displayName).toBe('Facture Leroy Merlin — 184,90 €');
  });

  it('rejette à l’enregistrement un libellé fourni invalide (vide, trop long, contrôle)', () => {
    expect(Document.record(props({ displayName: '   ' })).ok).toBe(false);
    expect(Document.record(props({ displayName: 'x'.repeat(121) })).ok).toBe(false);
    expect(Document.record(props({ displayName: 'nom\u0000interdit' })).ok).toBe(false);
  });

  it('rename : nouveau libellé + révision incrémentée, filename et versions intacts', () => {
    const r = Document.record(props());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const renamed = r.value.rename('Facture Leroy Merlin');
    expect(renamed.ok).toBe(true);
    expect(r.value.displayName).toBe('Facture Leroy Merlin');
    expect(r.value.revision).toBe(2);
    expect(r.value.toProps().filename).toBe('ticket.jpg');
    expect(r.value.toProps().versions).toHaveLength(1);
  });

  it('rename : idempotent à libellé identique, refuse un libellé invalide ou un doc supprimé', () => {
    const r = Document.record(props({ displayName: 'Facture Leroy Merlin' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.rename('Facture Leroy Merlin').ok).toBe(true);
    expect(r.value.revision).toBe(1); // aucune écriture fantôme

    const invalid = r.value.rename('   ');
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toMatchObject({ code: 'VALIDATION', field: 'displayName' });

    expect(r.value.markDeleted('2026-06-02T10:00:00.000Z').ok).toBe(true);
    const onDeleted = r.value.rename('Autre nom');
    expect(onDeleted.ok).toBe(false);
    if (!onDeleted.ok) expect(onDeleted.error.code).toBe('INVALID_TRANSITION');
  });

  it('réhydrate une ligne historique sans displayName : retombe sur le filename', () => {
    const historical = Document.rehydrate(props());
    expect(historical.displayName).toBe('ticket.jpg');
    expect(historical.toProps().displayName).toBe('ticket.jpg');
  });
});

describe('Document — reviewedAt (confirmation humaine, LOT 2)', () => {
  it('défaut : reviewedAt null, y compris pour une ligne historique sans le champ', () => {
    const recorded = Document.record(props());
    expect(recorded.ok).toBe(true);
    if (recorded.ok) {
      expect(recorded.value.reviewedAt).toBeNull();
      expect(recorded.value.toProps().reviewedAt).toBeNull();
    }
    // Réhydratation d'une ligne persistée AVANT la feature (champ absent) : jamais de crash.
    const historical = Document.rehydrate(props());
    expect(historical.reviewedAt).toBeNull();
    expect(historical.toProps().reviewedAt).toBeNull();
  });

  it('markReviewed pose la confirmation et incrémente la révision — sans toucher au reste', () => {
    const r = Document.record(props());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const before = r.value.toProps();
    expect(r.value.markReviewed('2026-07-16T09:00:00.000Z').ok).toBe(true);
    const after = r.value.toProps();
    expect(after.reviewedAt).toBe('2026-07-16T09:00:00.000Z');
    expect(after.revision).toBe(2);
    // Le filename d'archive, le rangement et le lien métier restent strictement intacts.
    expect(after.filename).toBe(before.filename);
    expect(after.displayName).toBe(before.displayName);
    expect(after.folderId).toBe(before.folderId);
    expect(after.linkedEntityType).toBe(before.linkedEntityType);
    expect(after.linkedEntityId).toBe(before.linkedEntityId);
  });

  it('markReviewed est idempotent : re-marquer conserve la première validation, sans révision fantôme', () => {
    const r = Document.record(props());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.markReviewed('2026-07-16T09:00:00.000Z').ok).toBe(true);
    expect(r.value.markReviewed('2026-07-17T15:00:00.000Z').ok).toBe(true);
    expect(r.value.reviewedAt).toBe('2026-07-16T09:00:00.000Z'); // la première fait foi
    expect(r.value.revision).toBe(2);
  });

  it('markReviewed refuse un horodatage vide et un document supprimé non validé', () => {
    const invalid = Document.record(props());
    expect(invalid.ok).toBe(true);
    if (invalid.ok) {
      const empty = invalid.value.markReviewed('   ');
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.error).toMatchObject({ code: 'VALIDATION', field: 'reviewedAt' });
      expect(invalid.value.reviewedAt).toBeNull();
      expect(invalid.value.revision).toBe(1);
    }

    const deleted = Document.record(props({ status: 'deleted', deletedAt: '2026-06-02T10:00:00.000Z' }));
    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      const onDeleted = deleted.value.markReviewed('2026-07-16T09:00:00.000Z');
      expect(onDeleted.ok).toBe(false);
      if (!onDeleted.ok) expect(onDeleted.error.code).toBe('INVALID_TRANSITION');
    }
  });

  it('record rejette un reviewedAt fourni mais vide, accepte null et une valeur réelle', () => {
    const empty = Document.record(props({ reviewedAt: '  ' }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toMatchObject({ code: 'VALIDATION', field: 'reviewedAt' });

    const explicitNull = Document.record(props({ reviewedAt: null }));
    expect(explicitNull.ok && explicitNull.value.reviewedAt).toBeNull();

    const reviewed = Document.record(props({ reviewedAt: '2026-07-16T09:00:00.000Z' }));
    expect(reviewed.ok).toBe(true);
    if (reviewed.ok) expect(reviewed.value.reviewedAt).toBe('2026-07-16T09:00:00.000Z');
  });
});
