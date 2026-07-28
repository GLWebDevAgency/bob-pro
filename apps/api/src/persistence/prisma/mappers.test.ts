import { describe, expect, it } from 'vitest';
import {
  companyPropsToCreate,
  companyRowToProps,
  customerPropsToCreate,
  customerRowToProps,
  expensePropsToPersistence,
  expenseRowToProps,
  invoiceRowToSnapshot,
  invoicePredecessorRowToSnapshot,
  invoicePredecessorToCreate,
  lineRowToQuoteLine,
  paymentRowToRecordInput,
  paymentToPersistence,
  quoteLineToCreate,
  quoteRowToSnapshot,
  signatureProofToPersistence,
} from './mappers';
import { Payment } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';

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
  // A1 — ligne historique SANS date d'établissement (jamais rétro-datée, compat ascendante).
  issuedAt: null,
  validUntil: null,
  depositPct: null,
  signerName: 'Mme Durand',
  signedAt: new Date('2026-07-14T10:00:00.000Z'),
  signatureProof: null as unknown,
  // A3 — ligne historique SANS demande d'exécution anticipée (jamais rétro-remplie).
  earlyExecutionRequestedAt: null as Date | null,
  // A3 — ligne historique SANS qualité figée ni rétractation (compat ascendante honnête).
  signatureCustomerType: null as string | null,
  retractedAt: null as Date | null,
  // Ligne historique SANS exception dépannage urgent (jamais inventée — embargo plein).
  urgentRepairRequestedAt: null as Date | null,
  lines: [],
  // B8 — colonnes bon de commande : ligne historique SANS bon de commande (compat ascendante).
  purchaseOrderNumber: null,
  purchaseOrderReceivedAt: null,
  purchaseOrderDocumentId: null,
  // B3/B5 — ligne historique SANS remise globale ni retenue (compat ascendante honnête).
  globalDiscountPercent: null,
  globalDiscountAmountCents: null,
  retenueGarantiePct: null,
  // PR-08 — ligne historique SANS site (null honnête, jamais rétro-rempli).
  chantierId: null,
  revision: 1,
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

  it('A3 : demande d’exécution anticipée persistée → réhydratée horodatée (L221-25)', () => {
    const snapshot = quoteRowToSnapshot({
      ...baseRow,
      signatureProof: { method: 'remote_link' },
      earlyExecutionRequestedAt: new Date('2026-07-14T10:00:00.000Z'),
    });
    expect(snapshot.signature?.earlyExecution).toEqual({ requestedAt: '2026-07-14T10:00:00.000Z' });
  });

  it('A3 : colonne NULL → AUCUNE demande fabriquée (le gel de rétractation reste dû)', () => {
    const snapshot = quoteRowToSnapshot({ ...baseRow, signatureProof: { method: 'remote_link' } });
    expect(snapshot.signature?.earlyExecution).toBeUndefined();
  });

  it('A3 : signature legacy (preuve NULL) avec demande persistée → la demande survit', () => {
    // Le canal peut être inconnu (legacy_declared) sans invalider un consentement réellement
    // enregistré : les deux faits sont indépendants — on ne jette jamais une donnée légale.
    const snapshot = quoteRowToSnapshot({
      ...baseRow,
      earlyExecutionRequestedAt: new Date('2026-07-14T10:00:00.000Z'),
    });
    expect(snapshot.signature?.method).toBe('legacy_declared');
    expect(snapshot.signature?.earlyExecution).toEqual({ requestedAt: '2026-07-14T10:00:00.000Z' });
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
    customerPortfolio: null as string | null,
    rcsOrRm: MERCIER_PROPS.rcsOrRm ?? null,
    addrLine1: MERCIER_PROPS.address.line1,
    addrZip: MERCIER_PROPS.address.zip,
    addrCity: MERCIER_PROPS.address.city,
    tvaIntracom: null,
    dateCreation: null,
    natureJuridiqueCode: null,
    estRge: null as boolean | null,
    // A6/A2 — colonnes fiche légale : NULL = jamais saisi (aucune valeur inventée).
    capitalSocialCents: null as bigint | null,
    mediateurConsoNom: null as string | null,
    mediateurConsoCoordonnees: null as string | null,
    // A3 — coordonnées de l'entreprise (modèles R221-1/R221-3) : NULL = jamais saisies.
    email: null as string | null,
    phone: null as string | null,
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

  it('clientèle absente → NULL, clientèle confirmée → aller-retour exact sans déduction', () => {
    expect(companyRowToProps(closeAccountRow).customerPortfolio).toBeUndefined();
    expect(companyPropsToCreate(MERCIER_PROPS).customerPortfolio).toBeNull();

    const props = companyRowToProps({ ...closeAccountRow, customerPortfolio: 'b2g' });
    expect(props.customerPortfolio).toBe('b2g');
    expect(companyPropsToCreate({ ...MERCIER_PROPS, customerPortfolio: 'mixte' }).customerPortfolio).toBe('mixte');
  });
});

describe('customer mappers — aucune métrique synthétique persistée', () => {
  const row = {
    id: 'customer-1',
    companyId: 'company-1',
    type: 'b2b',
    name: 'Client réel',
    siren: '732829320',
    tvaIntracom: null,
    isInternational: false,
    addrLine1: '1 rue du Test',
    addrZip: '75001',
    addrCity: 'Paris',
    email: null,
    phone: null,
    contactName: null,
    ptLabel: null,
    // B4 — fiche historique SANS conditions de paiement propres ni canal de facturation.
    paymentTermsDays: null,
    paymentTermsEndOfMonth: null,
    paymentTermsLabel: null,
    billingChannelType: null,
    billingChorusServiceCode: null,
    billingPortailNom: null,
    billingPortailUrl: null,
    // PR-04 — fiche historique SANS garde « BC obligatoire » (NULL = non exigé).
    requiresPurchaseOrder: null,
    isSubcontractingBtp: false,
  };

  it('réhydrate uniquement l’identité client, sans score/délai/encours legacy', () => {
    const legacyRow = {
      ...row,
      score: 100,
      avgDelayDays: 0,
      outstanding: 0,
    };
    const props = customerRowToProps(legacyRow);
    expect(props).not.toHaveProperty('score');
    expect(props).not.toHaveProperty('avgDelayDays');
    expect(props).not.toHaveProperty('outstanding');
  });

  it('n’écrit jamais de métrique financière depuis une fiche client', () => {
    const data = customerPropsToCreate(customerRowToProps(row));
    expect(data).not.toHaveProperty('score');
    expect(data).not.toHaveProperty('avgDelayDays');
    expect(data).not.toHaveProperty('outstanding');
  });
});

describe('expense payment mappers — preuve BDD ou historique explicite', () => {
  const row = {
    id: 'expense-1',
    companyId: 'company-1',
    supplierName: 'Fournisseur réel',
    supplierSiren: null,
    documentDate: '2026-07-01',
    totalTtcCents: 12_000,
    totalHtCents: 10_000,
    vatCents: 2_000,
    vatRatePct: 20,
    category: 'materiel',
    status: 'paid',
    paymentPaidOn: new Date('2026-07-03T00:00:00.000Z'),
    paymentMethod: 'transfer',
    paymentReference: 'VIR-2026-007',
    paymentProofDocumentId: 'document-1',
    paymentEvidenceLegacyUnverified: false,
    source: 'manual',
    supplierInvoiceNumber: 'F-2026-42',
    dueAt: '2026-07-31',
    chantierId: null,
  };

  it('imputation chantier : round-trip fidèle, projection toujours explicite (null = hors chantier)', () => {
    expect(expenseRowToProps(row).chantierId).toBeNull();
    expect(expensePropsToPersistence(expenseRowToProps(row))).toMatchObject({ chantierId: null });

    const assigned = expenseRowToProps({ ...row, chantierId: 'chantier-durand' });
    expect(assigned.chantierId).toBe('chantier-durand');
    expect(expensePropsToPersistence(assigned)).toMatchObject({ chantierId: 'chantier-durand' });
  });

  it('réhydrate exactement la preuve structurée persistée', () => {
    expect(expenseRowToProps(row).paymentEvidence).toEqual({
      paidOn: '2026-07-03',
      method: 'transfer',
      reference: 'VIR-2026-007',
      proofDocumentId: 'document-1',
    });
  });

  it('conserve une ligne historique comme non justifiée, sans date ni moyen inventés', () => {
    const props = expenseRowToProps({
      ...row,
      paymentPaidOn: null,
      paymentMethod: null,
      paymentReference: null,
      paymentProofDocumentId: null,
      paymentEvidenceLegacyUnverified: true,
    });
    expect(props.paymentEvidence).toBeNull();
    expect(expensePropsToPersistence(props)).toMatchObject({
      paymentPaidOn: null,
      paymentMethod: null,
      paymentReference: null,
      paymentProofDocumentId: null,
      paymentEvidenceLegacyUnverified: true,
    });
  });

  it('refuse une preuve partielle ou contradictoire au lieu de masquer la corruption', () => {
    expect(() => expenseRowToProps({ ...row, paymentMethod: null })).toThrow(/incomplete/);
    expect(() => expenseRowToProps({ ...row, paymentEvidenceLegacyUnverified: true })).toThrow(/incomplete/);
    expect(() => expenseRowToProps({
      ...row,
      status: 'to_pay',
      paymentPaidOn: null,
      paymentMethod: null,
    })).toThrow(/unpaid/);
  });

  it('écrit tous les scalaires Prisma explicitement, sans propriété paymentEvidence implicite', () => {
    const persisted = expensePropsToPersistence(expenseRowToProps(row));
    expect(persisted).toMatchObject({
      id: 'expense-1',
      status: 'paid',
      paymentPaidOn: new Date('2026-07-03T00:00:00.000Z'),
      paymentMethod: 'transfer',
      paymentReference: 'VIR-2026-007',
      paymentProofDocumentId: 'document-1',
      paymentEvidenceLegacyUnverified: false,
    });
    expect(persisted).not.toHaveProperty('paymentEvidence');
  });
});

// ─── ÉPIC « facturation terrain » (B1/B2/B3/B5 + canal de facturation) ───────────────────────

describe('B3 — remise de ligne : round-trip colonnes ↔ QuoteLine', () => {
  const lineRow = {
    id: 'line-1',
    sourceQuoteLineId: null as string | null,
    label: 'Rénovation fournil',
    category: 'labor',
    qty: 1,
    unit: null,
    unitPriceHt: 200_000,
    vatRate: 20,
    discountPercent: null as { toString(): string } | null,
    discountAmountCents: null as number | null,
  };

  it('sans remise : NULL/NULL, la ligne réhydratée ne porte AUCUN champ discount', () => {
    const line = lineRowToQuoteLine(lineRow);
    expect(line).not.toHaveProperty('discount');
    const created = quoteLineToCreate(line, { quoteId: 'q-1' }, 0);
    expect(created).toMatchObject({ discountPercent: null, discountAmountCents: null });
  });

  it('percent et amount : round-trip exact', () => {
    const percent = lineRowToQuoteLine({ ...lineRow, discountPercent: 12.5 });
    expect(percent.discount).toEqual({ type: 'percent', value: 12.5 });
    expect(quoteLineToCreate(percent, { quoteId: 'q-1' }, 0)).toMatchObject({
      discountPercent: 12.5,
      discountAmountCents: null,
    });
    const amount = lineRowToQuoteLine({ ...lineRow, discountAmountCents: 25_000 });
    expect(amount.discount).toEqual({ type: 'amount', cents: 25_000 });
    expect(quoteLineToCreate(amount, { invoiceId: 'i-1' }, 0)).toMatchObject({
      discountPercent: null,
      discountAmountCents: 25_000,
    });
  });

  it('préserve le lien exact vers la ligne du devis, absent sinon', () => {
    const derived = lineRowToQuoteLine({ ...lineRow, sourceQuoteLineId: 'quote-line-42' });
    expect(derived.sourceQuoteLineId).toBe('quote-line-42');
    expect(quoteLineToCreate(derived, { invoiceId: 'i-1' }, 0).sourceQuoteLineId)
      .toBe('quote-line-42');
    expect(quoteLineToCreate(lineRowToQuoteLine(lineRow), { quoteId: 'q-1' }, 0).sourceQuoteLineId)
      .toBeNull();
  });

  it('corruption (percent ET amount) : échec de lecture EXPLICITE, jamais une remise réinventée', () => {
    expect(() =>
      lineRowToQuoteLine({ ...lineRow, discountPercent: 10, discountAmountCents: 500 }),
    ).toThrow(/Corrupted discount/);
  });
});

describe('B4/canal — customer mappers : conditions de paiement + canal de facturation', () => {
  const row = {
    id: 'customer-1',
    companyId: 'company-1',
    type: 'b2b',
    name: 'Boulangerie Lefèvre',
    siren: '402118558',
    tvaIntracom: null,
    isInternational: false,
    addrLine1: '3 place du Marché',
    addrZip: '92310',
    addrCity: 'Sèvres',
    email: null,
    phone: null,
    contactName: null,
    ptLabel: null,
    paymentTermsDays: 45 as number | null,
    paymentTermsEndOfMonth: true as boolean | null,
    paymentTermsLabel: '45 jours fin de mois' as string | null,
    billingChannelType: 'chorus' as string | null,
    billingChorusServiceCode: 'SERV-42' as string | null,
    billingPortailNom: null as string | null,
    billingPortailUrl: null as string | null,
    requiresPurchaseOrder: null as boolean | null,
    isSubcontractingBtp: false,
  };

  it('round-trip fidèle : paymentTerms + billingChannel chorus', () => {
    const props = customerRowToProps(row);
    expect(props.paymentTerms).toEqual({ days: 45, endOfMonth: true, label: '45 jours fin de mois' });
    expect(props.billingChannel).toEqual({ type: 'chorus', chorusServiceCode: 'SERV-42' });
    expect(customerPropsToCreate(props)).toMatchObject({
      paymentTermsDays: 45,
      paymentTermsEndOfMonth: true,
      paymentTermsLabel: '45 jours fin de mois',
      billingChannelType: 'chorus',
      billingChorusServiceCode: 'SERV-42',
      billingPortailNom: null,
      billingPortailUrl: null,
    });
  });

  it('conditions INCOMPLÈTES (corruption partielle) : réhydratées « défaut société », jamais inventées', () => {
    const props = customerRowToProps({ ...row, paymentTermsLabel: null });
    expect(props).not.toHaveProperty('paymentTerms');
  });

  it('type de canal hors référentiel : réhydraté « email par défaut » fail-closed', () => {
    const props = customerRowToProps({ ...row, billingChannelType: 'fax' });
    expect(props).not.toHaveProperty('billingChannel');
  });

  it('champs annexes d’un AUTRE type ignorés à la lecture (jamais un code service sur portail)', () => {
    const props = customerRowToProps({
      ...row,
      billingChannelType: 'portail',
      billingChorusServiceCode: 'SERV-42',
      billingPortailNom: 'Portail Vinci',
      billingPortailUrl: 'https://f.vinci.com',
    });
    expect(props.billingChannel).toEqual({
      type: 'portail',
      portailNom: 'Portail Vinci',
      portailUrl: 'https://f.vinci.com',
    });
  });

  it('PR-04 — round-trip garde « BC obligatoire » : NULL = champ absent (défaut), true préservé', () => {
    expect(customerRowToProps(row)).not.toHaveProperty('requiresPurchaseOrder');
    const props = customerRowToProps({ ...row, requiresPurchaseOrder: true });
    expect(props.requiresPurchaseOrder).toBe(true);
    expect(customerPropsToCreate(props)).toMatchObject({ requiresPurchaseOrder: true });
    expect(customerPropsToCreate(customerRowToProps(row))).toMatchObject({
      requiresPurchaseOrder: null,
    });
  });
});

describe('règlement V2 — mappers paiement et prédécesseurs', () => {
  it('round-trip exact d’une ventilation 411/4117 explicite', () => {
    const recorded = Payment.record({
      id: 'payment-v2',
      companyId: 'company-1',
      invoiceId: 'invoice-1',
      amount: 10_000,
      method: 'transfer',
      receivedAt: '2026-07-21T10:30:00.000Z',
      idempotencyKey: 'payment-v2-key',
      ordinaryReceivableCents: 7_500,
      retentionReceivableCents: 2_500,
    });
    if (!recorded.ok) throw new Error('fixture payment V2 invalide');

    const row = paymentToPersistence(recorded.value);
    expect(paymentRowToRecordInput(row)).toEqual({
      id: 'payment-v2',
      companyId: 'company-1',
      invoiceId: 'invoice-1',
      amount: 10_000,
      method: 'transfer',
      receivedAt: '2026-07-21T10:30:00.000Z',
      idempotencyKey: 'payment-v2-key',
      ordinaryReceivableCents: 7_500,
      retentionReceivableCents: 2_500,
    });
  });

  it('legacy NULL/NULL relit l’écriture historique 100 % 411, jamais une moitié incomplète', () => {
    const legacy = {
      id: 'payment-v1',
      companyId: 'company-1',
      invoiceId: 'invoice-1',
      amount: 10_000,
      method: 'cash',
      receivedAt: new Date('2026-07-20T09:00:00.000Z'),
      idempotencyKey: null,
      ordinaryReceivableCents: null,
      retentionReceivableCents: null,
    };
    expect(paymentRowToRecordInput(legacy)).toMatchObject({
      ordinaryReceivableCents: 10_000,
      retentionReceivableCents: 0,
    });
    expect(() => paymentRowToRecordInput({ ...legacy, retentionReceivableCents: 0 }))
      .toThrow(/partial allocation/);
  });

  it('round-trip ordonné d’un snapshot de situation antérieure', () => {
    const source = {
      invoiceId: 'situation-2',
      kind: 'situation' as const,
      number: 'F-2026-0042',
      issuedAt: '2026-07-19',
    };
    const row = invoicePredecessorToCreate(
      source,
      { companyId: 'company-1', invoiceId: 'final-1' },
      1,
    );
    expect(row).toMatchObject({
      companyId: 'company-1',
      invoiceId: 'final-1',
      sourceInvoiceId: 'situation-2',
      kind: 'situation',
      number: 'F-2026-0042',
      position: 1,
    });
    expect(invoicePredecessorRowToSnapshot(row)).toEqual(source);
    expect(() => invoicePredecessorRowToSnapshot({ ...row, kind: 'invoice' }))
      .toThrow(/unsupported kind/);
  });
});

describe('B1/B2/B3/B5 — invoiceRowToSnapshot : nouveaux faits + compléments de totaux', () => {
  const invoiceRow = {
    id: 'inv-1',
    companyId: 'company-1',
    customerId: 'customer-1',
    kind: 'situation',
    status: 'issued',
    number: 'F-2026-0042',
    issuedAt: new Date('2026-07-19T00:00:00.000Z'),
    dueAt: new Date('2026-08-18T00:00:00.000Z'),
    servicePeriodStart: null,
    servicePeriodEnd: null,
    deliveryAddress: null,
    parentQuoteId: 'q-1',
    depositPct: null,
    sourceInvoiceId: null,
    sourceInvoiceKind: null,
    sourceInvoiceNumber: null,
    sourceInvoiceIssuedAt: null,
    depositDeductionCents: 0,
    depositInvoiceId: null,
    settlementSemanticsVersion: 2,
    paidCents: 0,
    totalsHt: 300_000,
    totalsVat: 60_000,
    totalsTtc: 360_000,
    totalsNetToPay: 342_000,
    totalsDuePayableCents: 360_000 as number | null,
    vatByRate: { '20': 60_000 },
    legalMentions: [],
    totalsGrossHt: null as number | null,
    totalsDiscountCents: null as number | null,
    totalsRetenueGarantieCents: 18_000 as number | null,
    situationOrder: 2 as number | null,
    situationDeductionCents: 0,
    globalDiscountPercent: null as { toString(): string } | null,
    globalDiscountAmountCents: null as number | null,
    retenueGarantiePct: 5 as { toString(): string } | null,
    urgentRepairRequestedAt: null as Date | null,
    transmissionDepositedAt: new Date('2026-07-21T00:00:00.000Z') as Date | null,
    transmissionAcceptedAt: null as Date | null,
    vatTreatmentAtIssuance: 'standard',
    frenchBillingModeAtIssuance: 'S1',
    purchaseOrderNumber: null,
    purchaseOrderReceivedAt: null,
    purchaseOrderDocumentId: null,
    // PR-08 — pièce historique SANS site (null honnête, jamais rétro-rempli).
    chantierId: null as string | null,
    // PR-12b — pièce historique SANS contrat (null honnête, jamais rétro-rempli).
    maintenanceContractId: null as string | null,
    revision: 1,
    lines: [],
    precedingInvoices: [],
  };

  it('situation émise avec retenue : faits + complément de totaux réhydratés', () => {
    const snapshot = invoiceRowToSnapshot(invoiceRow);
    expect(snapshot.kind).toBe('situation');
    expect(snapshot.situationOrder).toBe(2);
    expect(snapshot.retenueGarantiePct).toBe(5);
    expect(snapshot.frozenTotals).toMatchObject({
      ht: 300_000,
      netToPay: 342_000,
      duePayableCents: 360_000,
      retenueGarantieCents: 18_000,
    });
    // Compléments ABSENTS quand NULL — les totaux des pièces antérieures restent identiques.
    expect(snapshot.frozenTotals).not.toHaveProperty('grossHt');
    expect(snapshot.frozenTotals).not.toHaveProperty('discountCents');
    expect(snapshot.transmission).toEqual({ depositedAt: '2026-07-21', acceptedAt: null });
    expect(snapshot.frenchBillingModeAtIssuance).toBe('S1');
  });

  it('ligne historique : aucun fait inventé (nulls honnêtes, transmission absente)', () => {
    const snapshot = invoiceRowToSnapshot({
      ...invoiceRow,
      kind: 'invoice',
      settlementSemanticsVersion: 1,
      totalsDuePayableCents: null,
      situationOrder: null,
      retenueGarantiePct: null,
      totalsRetenueGarantieCents: null,
      transmissionDepositedAt: null,
      frenchBillingModeAtIssuance: null,
    });
    expect(snapshot.situationOrder).toBeNull();
    expect(snapshot.retenueGarantiePct).toBeNull();
    expect(snapshot.globalDiscount).toBeNull();
    expect(snapshot.urgentRepair).toBeNull();
    expect(snapshot.transmission).toBeNull();
    expect(snapshot.frenchBillingModeAtIssuance).toBeNull();
    expect(snapshot.frozenTotals).not.toHaveProperty('retenueGarantieCents');
    expect(snapshot.frozenTotals).not.toHaveProperty('duePayableCents');
    expect(snapshot.settlementSemanticsVersion).toBe(1);
  });

  it('remise globale en montant + urgence : réhydratées exactement', () => {
    const snapshot = invoiceRowToSnapshot({
      ...invoiceRow,
      kind: 'invoice',
      situationOrder: null,
      globalDiscountAmountCents: 20_000,
      retenueGarantiePct: null,
      totalsRetenueGarantieCents: null,
      totalsDuePayableCents: 342_000,
      totalsGrossHt: 320_000,
      totalsDiscountCents: 20_000,
      urgentRepairRequestedAt: new Date('2026-07-19T08:30:00.000Z'),
    });
    expect(snapshot.globalDiscount).toEqual({ type: 'amount', cents: 20_000 });
    expect(snapshot.urgentRepair).toEqual({ requestedAt: '2026-07-19T08:30:00.000Z' });
    expect(snapshot.frozenTotals).toMatchObject({ grossHt: 320_000, discountCents: 20_000 });
  });

  it('finale V2 : créance légale et antécédents ordonnés survivent au mapper', () => {
    const snapshot = invoiceRowToSnapshot({
      ...invoiceRow,
      kind: 'invoice',
      situationOrder: null,
      precedingInvoices: [
        {
          sourceInvoiceId: 'deposit-1',
          kind: 'deposit_invoice',
          number: 'F-2026-0039',
          issuedAt: new Date('2026-07-10T00:00:00.000Z'),
          position: 0,
        },
        {
          sourceInvoiceId: 'situation-2',
          kind: 'situation',
          number: 'F-2026-0042',
          issuedAt: new Date('2026-07-19T00:00:00.000Z'),
          position: 1,
        },
      ],
    });
    expect(snapshot.settlementSemanticsVersion).toBe(2);
    expect(snapshot.frozenTotals?.duePayableCents).toBe(360_000);
    expect(snapshot.precedingInvoices).toEqual([
      { invoiceId: 'deposit-1', kind: 'deposit', number: 'F-2026-0039', issuedAt: '2026-07-10' },
      { invoiceId: 'situation-2', kind: 'situation', number: 'F-2026-0042', issuedAt: '2026-07-19' },
    ]);
  });

  it('version de règlement hors contrat : corruption explicite, jamais rabattue sur V1', () => {
    expect(() => invoiceRowToSnapshot({ ...invoiceRow, settlementSemanticsVersion: 3 }))
      .toThrow(/Corrupted settlement semantics/);
    expect(() => invoiceRowToSnapshot({ ...invoiceRow, totalsDuePayableCents: 360_001 }))
      .toThrow(/due payable must equal net to pay plus retention/);
  });
});
