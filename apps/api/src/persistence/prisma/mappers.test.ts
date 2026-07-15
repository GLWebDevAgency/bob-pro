import { describe, expect, it } from 'vitest';
import { companyPropsToCreate, companyRowToProps, quoteRowToSnapshot, signatureProofToPersistence } from './mappers';
import { MERCIER_PROPS } from '@bob/core';

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

describe('companyRowToProps / companyPropsToCreate — clôture de compte (closedAt/closureReason)', () => {
  const closeAccountRow = {
    id: MERCIER_PROPS.id,
    name: MERCIER_PROPS.name,
    legalForm: MERCIER_PROPS.legalForm,
    siren: MERCIER_PROPS.siren,
    siret: MERCIER_PROPS.siret,
    apeCode: MERCIER_PROPS.apeCode ?? null,
    trade: MERCIER_PROPS.trade,
    vatRegime: MERCIER_PROPS.vatRegime,
    rcsOrRm: MERCIER_PROPS.rcsOrRm ?? null,
    addrLine1: MERCIER_PROPS.address.line1,
    addrZip: MERCIER_PROPS.address.zip,
    addrCity: MERCIER_PROPS.address.city,
    tvaIntracom: null,
    dateCreation: null,
    iban: MERCIER_PROPS.iban ?? null,
    bic: MERCIER_PROPS.bic ?? null,
    insurerName: MERCIER_PROPS.decennale?.insurer ?? null,
    policyNo: MERCIER_PROPS.decennale?.policyNo ?? null,
    coverage: MERCIER_PROPS.decennale?.coverage ?? null,
    policyExpiresAt: MERCIER_PROPS.decennale ? new Date(MERCIER_PROPS.decennale.expiresAt) : null,
    closedAt: null as Date | null,
    closureReason: null as string | null,
  };

  it('row ouverte (closedAt NULL) → props SANS closedAt/closureReason (jamais un champ fantôme)', () => {
    const props = companyRowToProps(closeAccountRow);
    expect(props.closedAt).toBeUndefined();
    expect(props.closureReason).toBeUndefined();
  });

  it('row clôturée → closedAt ISO + closureReason repris tels quels', () => {
    const props = companyRowToProps({
      ...closeAccountRow,
      closedAt: new Date('2026-07-16T09:00:00.000Z'),
      closureReason: 'je change de métier',
    });
    expect(props.closedAt).toBe('2026-07-16T09:00:00.000Z');
    expect(props.closureReason).toBe('je change de métier');
  });

  it('companyPropsToCreate : closedAt/closureReason absents → NULL en base (jamais une valeur inventée)', () => {
    const data = companyPropsToCreate(MERCIER_PROPS);
    expect(data.closedAt).toBeNull();
    expect(data.closureReason).toBeNull();
  });

  it('companyPropsToCreate : le reste de la fiche légale (name/siret/adresse/iban/décennale) est écrit tel quel', () => {
    const data = companyPropsToCreate({ ...MERCIER_PROPS, closedAt: '2026-07-16T09:00:00.000Z' });
    expect(data.name).toBe(MERCIER_PROPS.name);
    expect(data.siret).toBe(MERCIER_PROPS.siret);
    expect(data.addrLine1).toBe(MERCIER_PROPS.address.line1);
    expect(data.iban).toBe(MERCIER_PROPS.iban);
    expect(data.insurerName).toBe(MERCIER_PROPS.decennale?.insurer);
    expect(data.closedAt).toEqual(new Date('2026-07-16T09:00:00.000Z'));
  });
});
