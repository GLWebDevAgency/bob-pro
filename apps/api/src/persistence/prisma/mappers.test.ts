import { describe, expect, it } from 'vitest';
import { quoteRowToSnapshot, signatureProofToPersistence } from './mappers';

/**
 * P0 R4 — le mapper ne fabrique plus JAMAIS une méthode de signature :
 * - ligne historique (signatureProof NULL) → 'legacy_declared', sans proof ;
 * - preuve persistée → méthode réelle + proof seulement si hash + horodatage présents ;
 * - JSON corrompu/forgé (méthode inconnue, hash non hex) → retombe en 'legacy_declared'.
 */
const baseRow = {
  id: 'quote-1',
  companyId: 'co-1',
  customerId: 'cust-1',
  status: 'signed',
  number: 'D-2026-0001',
  validUntil: null,
  depositPct: null,
  signerName: 'Mme Durand',
  signedAt: new Date('2026-07-14T10:00:00.000Z'),
  signatureProof: null as unknown,
  lines: [],
};

const SHA = 'a'.repeat(64);

describe('quoteRowToSnapshot — signature honnête (R4)', () => {
  it('ligne historique sans preuve → legacy_declared, jamais une méthode réinventée', () => {
    const snapshot = quoteRowToSnapshot({ ...baseRow });
    expect(snapshot.signature).toEqual({
      signerName: 'Mme Durand',
      signedAt: '2026-07-14T10:00:00.000Z',
      method: 'legacy_declared',
      accepted: true,
    });
  });

  it('preuve onsite_draw complète → méthode + proof (hash + capturedAt)', () => {
    const snapshot = quoteRowToSnapshot({
      ...baseRow,
      signatureProof: { method: 'onsite_draw', sha256: SHA, capturedAt: '2026-07-14T10:00:00.000Z' },
    });
    expect(snapshot.signature?.method).toBe('onsite_draw');
    expect(snapshot.signature?.proof).toEqual({
      method: 'onsite_draw',
      sha256: SHA,
      capturedAt: '2026-07-14T10:00:00.000Z',
    });
  });

  it('remote_link sans hash (lien distant sans tracé) → méthode portée, AUCUNE proof fabriquée', () => {
    const snapshot = quoteRowToSnapshot({ ...baseRow, signatureProof: { method: 'remote_link' } });
    expect(snapshot.signature?.method).toBe('remote_link');
    expect(snapshot.signature?.proof).toBeUndefined();
  });

  it.each([
    [{ method: 'draw' }],
    [['remote_link']],
    ['remote_link'],
  ])('méthode inconnue/JSON corrompu (%j) → retombe en legacy_declared sans proof', (signatureProof) => {
    const snapshot = quoteRowToSnapshot({ ...baseRow, signatureProof });
    expect(snapshot.signature?.method).toBe('legacy_declared');
    expect(snapshot.signature?.proof).toBeUndefined();
  });

  it('hash corrompu (non hex) → le canal reste porté mais AUCUNE proof n’est réhydratée', () => {
    // méthode = canal réellement enregistré ; proof = évidence — une évidence invalide tombe,
    // le canal connu reste (le CHECK SQL rend ce cas impossible hors corruption manuelle).
    const snapshot = quoteRowToSnapshot({
      ...baseRow,
      signatureProof: { method: 'onsite_draw', sha256: 'pas-un-hash', capturedAt: '2026-07-14T10:00:00.000Z' },
    });
    expect(snapshot.signature?.method).toBe('onsite_draw');
    expect(snapshot.signature?.proof).toBeUndefined();
  });

  it('sans signerName/signedAt : aucune signature, quelle que soit la colonne preuve', () => {
    const snapshot = quoteRowToSnapshot({
      ...baseRow,
      signerName: null,
      signedAt: null,
      signatureProof: { method: 'onsite_draw', sha256: SHA, capturedAt: '2026-07-14T10:00:00.000Z' },
    });
    expect(snapshot.signature).toBeNull();
  });
});

describe('signatureProofToPersistence — write-side symétrique', () => {
  it('onsite_draw avec proof → JSON méthode + hash + capturedAt', () => {
    expect(
      signatureProofToPersistence({
        signerName: 'Mme Durand',
        signedAt: '2026-07-14T10:00:00.000Z',
        method: 'onsite_draw',
        accepted: true,
        proof: { method: 'onsite_draw', sha256: SHA, capturedAt: '2026-07-14T10:00:00.000Z' },
      }),
    ).toEqual({ method: 'onsite_draw', sha256: SHA, capturedAt: '2026-07-14T10:00:00.000Z' });
  });

  it('remote_link sans proof → JSON méthode seule', () => {
    expect(
      signatureProofToPersistence({
        signerName: 'Client Distant',
        signedAt: '2026-07-14T10:00:00.000Z',
        method: 'remote_link',
        accepted: true,
      }),
    ).toEqual({ method: 'remote_link' });
  });

  it('legacy_declared → NULL : une ligne historique re-sauvée reste historique', () => {
    expect(
      signatureProofToPersistence({
        signerName: 'Mme Durand',
        signedAt: '2026-07-14T10:00:00.000Z',
        method: 'legacy_declared',
        accepted: true,
      }),
    ).toBeNull();
    expect(signatureProofToPersistence(null)).toBeNull();
  });
});
