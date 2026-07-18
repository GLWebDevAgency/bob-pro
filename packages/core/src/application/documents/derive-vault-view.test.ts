import { describe, it, expect } from 'vitest';
import {
  deriveVaultView,
  documentNeedsHumanReview,
  normalizeSupplierName,
  vaultFolderOf,
  VAULT_FOLDER_KEYS,
  type DeriveVaultViewInput,
  type VaultDocumentData,
  type VaultExpenseData,
  type VaultInvoiceData,
} from './derive-vault-view';
import { searchVault } from './search-vault';

const TODAY = '2026-07-03';

function doc(over: Partial<VaultDocumentData>): VaultDocumentData {
  return {
    id: 'doc-1',
    kind: 'other',
    origin: 'uploaded',
    status: 'active',
    filename: 'document.pdf',
    linkedEntityType: null,
    linkedEntityId: null,
    documentDate: null,
    createdAt: '2026-07-01T10:00:00.000Z',
    ...over,
  };
}

function expense(over: Partial<VaultExpenseData>): VaultExpenseData {
  return {
    id: 'exp-1',
    supplierName: 'Leroy Merlin',
    documentDate: '2026-07-01',
    totalTtcCents: 18490,
    vatCents: 3082,
    ...over,
  };
}

function invoice(over: Partial<VaultInvoiceData>): VaultInvoiceData {
  return {
    id: 'inv-1',
    kind: 'deposit',
    status: 'issued',
    number: 'F-2026-118',
    customerId: 'c-martin',
    totals: { ht: 40700, vatByRate: { '20': 8140 }, vat: 8140, ttc: 48840, netToPay: 48840 },
    ...over,
  };
}

const EMPTY: DeriveVaultViewInput = { documents: [], expenses: [], invoices: [], customers: [], today: TODAY };

describe('deriveVaultView — états vides de premier rang', () => {
  it('sans données : sections vides, dossiers à 0, TVA inconnue (null)', () => {
    const v = deriveVaultView(EMPTY);
    expect(v.toValidate).toEqual([]);
    expect(v.folders).toHaveLength(6);
    expect(v.folders.every((f) => f.count === 0)).toBe(true);
    expect(v.monthSummary).toEqual({
      month: '2026-07',
      salesCount: 0,
      purchasesCount: 0,
      vatRecoverableCents: null,
      missingReceiptsCount: 0,
    });
    expect(v.recentInvoices).toEqual([]);
    expect(v.supplierMemory).toEqual({ count: 0, examples: [] });
    expect(v.totalCount).toBe(0);
  });

  it('ignore les documents supprimés (status deleted)', () => {
    const v = deriveVaultView({ ...EMPTY, documents: [doc({ status: 'deleted', kind: 'invoice_pdf' })] });
    expect(v.totalCount).toBe(0);
    expect(v.folders.find((f) => f.key === 'comptable')?.count).toBe(0);
  });
});

describe('vaultFolderOf — mapping v1 des 6 dossiers du proto', () => {
  it('chantier prime, puis achats, puis comptable ; sinon aucun dossier', () => {
    expect(vaultFolderOf({ kind: 'invoice_pdf', linkedEntityType: 'chantier' })).toBe('chantiers');
    expect(vaultFolderOf({ kind: 'expense_receipt', linkedEntityType: null })).toBe('achats');
    expect(vaultFolderOf({ kind: 'other', linkedEntityType: 'expense' })).toBe('achats');
    expect(vaultFolderOf({ kind: 'facturx_xml', linkedEntityType: 'invoice' })).toBe('comptable');
    expect(vaultFolderOf({ kind: 'signed_quote', linkedEntityType: 'quote' })).toBe('comptable');
    expect(vaultFolderOf({ kind: 'other', linkedEntityType: 'company' })).toBeNull();
  });

  it('la grille garde l’ordre du proto (DOCS_FOLDERS)', () => {
    expect(VAULT_FOLDER_KEYS).toEqual(['chantiers', 'achats', 'assurances', 'fiscal', 'banque', 'comptable']);
  });
});

describe('documentNeedsHumanReview — règle unique file « À valider » ↔ écrans', () => {
  it('OCR jamais confirmé (reviewedAt null ou absent) hors dépense → à confirmer', () => {
    expect(documentNeedsHumanReview(doc({ origin: 'ocr' }))).toBe(true);
    expect(documentNeedsHumanReview(doc({ origin: 'ocr', reviewedAt: null }))).toBe(true);
    // Lié à un chantier : le lien métier ne vaut pas confirmation à lui seul.
    expect(documentNeedsHumanReview(doc({ origin: 'ocr', linkedEntityType: 'chantier', linkedEntityId: 'ch-1' }))).toBe(true);
  });

  it('confirmé, non-OCR ou lié à une dépense → plus rien à confirmer', () => {
    expect(documentNeedsHumanReview(doc({ origin: 'ocr', reviewedAt: '2026-07-01T10:00:00.000Z' }))).toBe(false);
    expect(documentNeedsHumanReview(doc({ origin: 'uploaded' }))).toBe(false);
    expect(documentNeedsHumanReview(doc({ origin: 'ocr', linkedEntityType: 'expense', linkedEntityId: 'exp-1' }))).toBe(false);
  });
});

describe('deriveVaultView — à valider (OCR non CONFIRMÉ, LOT 2)', () => {
  it('retient les docs OCR jamais confirmés — y compris rangés — sauf liés à une dépense, du plus récent au plus ancien', () => {
    const v = deriveVaultView({
      ...EMPTY,
      documents: [
        doc({ id: 'a', origin: 'ocr', createdAt: '2026-07-01T08:00:00.000Z' }),
        doc({ id: 'b', origin: 'ocr', createdAt: '2026-07-02T08:00:00.000Z' }),
        // Lié à une dépense : traité par construction (réconciliation comptable) — ABSENT.
        doc({ id: 'c', origin: 'ocr', linkedEntityType: 'expense', linkedEntityId: 'exp-9' }),
        doc({ id: 'd', origin: 'uploaded' }),
        // Rangé par erreur et jamais validé : la carte RESTE visible (« Rangé — à confirmer »).
        doc({ id: 'e', origin: 'ocr', folderId: 'folder-insurance', createdAt: '2026-07-01T10:00:00.000Z' }),
      ],
    });
    expect(v.toValidate.map((p) => p.id)).toEqual(['b', 'e', 'a']);
  });

  it('un doc rangé mais non confirmé est VISIBLE et porte folderId + folderName (« Rangé · Achats — à confirmer »)', () => {
    const v = deriveVaultView({
      ...EMPTY,
      documents: [
        doc({ id: 'range', origin: 'ocr', folderId: 'folder-achats', folderName: 'Achats' }),
      ],
    });
    expect(v.toValidate[0]).toMatchObject({ id: 'range', folderId: 'folder-achats', folderName: 'Achats' });
  });

  it('un doc acquitté (reviewedAt posé) est ABSENT de la file, rangé ou non', () => {
    const v = deriveVaultView({
      ...EMPTY,
      documents: [
        doc({ id: 'ack-nu', origin: 'ocr', reviewedAt: '2026-07-02T09:00:00.000Z' }),
        doc({ id: 'ack-range', origin: 'ocr', folderId: 'folder-achats', reviewedAt: '2026-07-02T09:00:00.000Z' }),
        doc({ id: 'encore-la', origin: 'ocr' }),
      ],
    });
    expect(v.toValidate.map((p) => p.id)).toEqual(['encore-la']);
  });

  it('compat historique : reviewedAt null ou ABSENT de la projection ⇒ toujours à confirmer, jamais de crash', () => {
    const v = deriveVaultView({
      ...EMPTY,
      documents: [
        doc({ id: 'explicit-null', origin: 'ocr', reviewedAt: null }),
        doc({ id: 'absent', origin: 'ocr' }),
        // Classé vers un chantier AVANT le LOT 2 (reviewedAt inconnu) : reste à confirmer.
        doc({ id: 'chantier-historique', origin: 'ocr', linkedEntityType: 'chantier', linkedEntityId: 'ch-1' }),
      ],
    });
    expect(v.toValidate.map((p) => p.id).sort()).toEqual(['absent', 'chantier-historique', 'explicit-null']);
  });

  it('non rangé : folderId et folderName null ; rangé sans nom résolu : folderName null (rien d’inventé)', () => {
    const v = deriveVaultView({
      ...EMPTY,
      documents: [
        doc({ id: 'nu', origin: 'ocr', createdAt: '2026-07-02T08:00:00.000Z' }),
        doc({ id: 'sans-nom', origin: 'ocr', folderId: 'folder-x', folderName: '  ', createdAt: '2026-07-01T08:00:00.000Z' }),
      ],
    });
    expect(v.toValidate[0]).toMatchObject({ id: 'nu', folderId: null, folderName: null });
    expect(v.toValidate[1]).toMatchObject({ id: 'sans-nom', folderId: 'folder-x', folderName: null });
  });

  it('rapproche la dépense dont le fournisseur figure dans le nom de fichier (casse/accents/tirets ignorés)', () => {
    const v = deriveVaultView({
      ...EMPTY,
      documents: [doc({ id: 'a', origin: 'ocr', filename: 'recu-leroy-merlin.jpg' })],
      expenses: [expense({ supplierName: 'Leroy Merlin' })],
    });
    expect(v.toValidate[0]?.matchedExpense?.supplierName).toBe('Leroy Merlin');
    expect(v.toValidate[0]?.matchedExpense?.id).toBe('exp-1');
    expect(v.toValidate[0]?.matchedExpense?.vatCents).toBe(3082);
  });

  it('préfère le lien explicite (proofDocumentId) au rapprochement fragile par nom de fichier', () => {
    const v = deriveVaultView({
      ...EMPTY,
      documents: [doc({ id: 'doc-scan', origin: 'ocr', filename: 'recu-leroy-merlin.jpg' })],
      expenses: [
        expense({ id: 'e-filename', supplierName: 'Leroy Merlin' }),
        expense({ id: 'e-explicit', supplierName: 'Cedeo', proofDocumentId: 'doc-scan', totalTtcCents: 4200 }),
      ],
    });
    expect(v.toValidate[0]?.matchedExpense?.id).toBe('e-explicit');
    expect(v.toValidate[0]?.metrics?.totalTtcCents).toBe(4200);
  });
});

describe('deriveVaultView — carte « À valider » enrichie (analyse + extraction réelles)', () => {
  const analysis = {
    type: 'supplier_invoice',
    typeConfidence: 0.93,
    suggestedDisplayName: 'Facture Leroy Merlin — 184,90 €',
    suggestedDestination: {
      kind: 'chantier',
      chantierId: 'ch-durand',
      label: 'Rénovation Durand',
      motif: 'matériel pour le chantier Durand',
    },
  } as const;

  it('porte le type réel, le libellé intelligent et la destination validée de l’analyse', () => {
    const v = deriveVaultView({
      ...EMPTY,
      documents: [doc({ id: 'a', origin: 'ocr', filename: 'scan-083012.jpg', analysis })],
    });
    const pending = v.toValidate[0];
    expect(pending).toMatchObject({
      analysisType: 'supplier_invoice',
      typeConfidence: 0.93,
      displayName: 'Facture Leroy Merlin — 184,90 €',
      suggestedDestination: { kind: 'chantier', chantierId: 'ch-durand', label: 'Rénovation Durand' },
    });
  });

  it('chips depuis l’extraction OCR MÊME SANS dépense rapprochée ; la dépense reste prioritaire', () => {
    const extraction = { supplierName: 'Leroy Merlin', totalTtcCents: 18490, vatCents: 3082, documentDate: '2026-06-27' };
    const sansDepense = deriveVaultView({
      ...EMPTY,
      documents: [doc({ id: 'a', origin: 'ocr', filename: 'scan-083012.jpg', extraction })],
    });
    expect(sansDepense.toValidate[0]?.metrics).toEqual({
      totalTtcCents: 18490,
      vatCents: 3082,
      documentDate: '2026-06-27',
    });
    expect(sansDepense.toValidate[0]?.displayName).toBe('Leroy Merlin'); // fournisseur réel, pas le filename brut

    const avecDepense = deriveVaultView({
      ...EMPTY,
      documents: [doc({ id: 'a', origin: 'ocr', filename: 'recu-leroy-merlin.jpg', extraction })],
      expenses: [expense({ totalTtcCents: 19990, vatCents: 3332, documentDate: '2026-07-01' })],
    });
    expect(avecDepense.toValidate[0]?.metrics).toEqual({
      totalTtcCents: 19990,
      vatCents: 3332,
      documentDate: '2026-07-01',
    });
  });

  it('un renommage explicite (displayName ≠ filename) prime sur la suggestion d’analyse', () => {
    const v = deriveVaultView({
      ...EMPTY,
      documents: [
        doc({ id: 'a', origin: 'ocr', filename: 'scan-083012.jpg', displayName: 'Mon nom choisi', analysis }),
      ],
    });
    expect(v.toValidate[0]?.displayName).toBe('Mon nom choisi');
  });

  it('sans mieux que le filename : displayName = filename, métriques et destination nulles (rien d’inventé)', () => {
    const v = deriveVaultView({
      ...EMPTY,
      documents: [doc({ id: 'a', origin: 'ocr', filename: 'scan-083012.jpg' })],
    });
    expect(v.toValidate[0]).toMatchObject({
      displayName: 'scan-083012.jpg',
      analysisType: null,
      typeConfidence: null,
      metrics: null,
      suggestedDestination: null,
    });
  });

  it('analyse historique sans destination : fallback déterministe par type ; null explicite respecté', () => {
    const historique = deriveVaultView({
      ...EMPTY,
      documents: [
        doc({ id: 'a', origin: 'ocr', analysis: { type: 'insurance_certificate', typeConfidence: 0.8 } }),
      ],
    });
    expect(historique.toValidate[0]?.suggestedDestination).toMatchObject({
      kind: 'system_folder',
      systemKey: 'insurance',
      label: 'Assurances',
    });

    const explicite = deriveVaultView({
      ...EMPTY,
      documents: [
        doc({ id: 'a', origin: 'ocr', analysis: { type: 'company_record', typeConfidence: 0.8, suggestedDestination: null } }),
      ],
    });
    expect(explicite.toValidate[0]?.suggestedDestination).toBeNull();
  });
});

describe('deriveVaultView — résumé du mois (compta & conformité)', () => {
  it('ventes dédupliquées par facture liée (PDF + Factur-X = 1 vente), hors mois exclues', () => {
    const v = deriveVaultView({
      ...EMPTY,
      documents: [
        doc({ id: 'p', kind: 'invoice_pdf', linkedEntityType: 'invoice', linkedEntityId: 'inv-1', documentDate: '2026-07-02' }),
        doc({ id: 'x', kind: 'facturx_xml', linkedEntityType: 'invoice', linkedEntityId: 'inv-1', documentDate: '2026-07-02' }),
        doc({ id: 'q', kind: 'invoice_pdf', documentDate: '2026-07-01' }), // non liée : compte pour 1
        doc({ id: 'old', kind: 'invoice_pdf', documentDate: '2026-06-15' }),
      ],
    });
    expect(v.monthSummary.salesCount).toBe(2);
  });

  it('achats et TVA récupérable = dépenses du mois ; justificatif manquant si aucun reçu lié', () => {
    const v = deriveVaultView({
      ...EMPTY,
      documents: [doc({ id: 'r', kind: 'expense_receipt', linkedEntityType: 'expense', linkedEntityId: 'e1' })],
      expenses: [
        expense({ id: 'e1', documentDate: '2026-07-01', vatCents: 3082 }),
        expense({ id: 'e2', documentDate: '2026-07-02', vatCents: 1000, supplierName: 'Cedeo' }),
        expense({ id: 'e3', documentDate: '2026-06-20', vatCents: 9999, supplierName: 'Point P' }), // hors mois
      ],
    });
    expect(v.monthSummary.purchasesCount).toBe(2);
    expect(v.monthSummary.vatRecoverableCents).toBe(4082);
    expect(v.monthSummary.missingReceiptsCount).toBe(1); // e2 sans reçu
  });

  it('TVA inconnue (null) quand aucune dépense du mois ne porte de vatCents', () => {
    const v = deriveVaultView({ ...EMPTY, expenses: [expense({ vatCents: null })] });
    expect(v.monthSummary.vatRecoverableCents).toBeNull();
  });
});

describe('deriveVaultView — factures récentes & canal e-facture', () => {
  it('trie par numéro décroissant, limite à 2, brouillons/sans numéro exclus', () => {
    const v = deriveVaultView({
      ...EMPTY,
      invoices: [
        invoice({ id: 'i1', number: 'F-2026-118' }),
        invoice({ id: 'i2', number: 'F-2026-121', customerId: 'c-durand' }),
        invoice({ id: 'i3', number: 'F-2026-9' }),
        invoice({ id: 'i4', number: null }),
        invoice({ id: 'i5', number: 'F-2026-200', status: 'draft' }),
      ],
      customers: [
        { id: 'c-martin', name: 'SARL Martin Rénovation', type: 'b2b' },
        { id: 'c-durand', name: 'Mme Durand', type: 'b2c' },
      ],
    });
    expect(v.recentInvoices.map((r) => r.number)).toEqual(['F-2026-121', 'F-2026-118']);
    expect(v.recentInvoices[0]).toMatchObject({ customerName: 'Mme Durand', channel: 'ereporting' });
    expect(v.recentInvoices[1]).toMatchObject({ customerName: 'SARL Martin Rénovation', channel: 'pa' });
  });

  it('signale une relation client absente sans fabriquer un profil B2C', () => {
    const v = deriveVaultView({
      ...EMPTY,
      invoices: [invoice({ id: 'orphan', customerId: 'missing-customer' })],
      customers: [],
    });

    expect(v.recentInvoices).toEqual([
      expect.objectContaining({
        id: 'orphan',
        customerName: null,
        customerType: null,
        channel: null,
      }),
    ]);
  });
});

describe('deriveVaultView — mémoire fournisseurs', () => {
  it('compte les fournisseurs distincts (normalisés) et garde 3 exemples max', () => {
    const v = deriveVaultView({
      ...EMPTY,
      expenses: [
        expense({ id: 'e1', supplierName: 'Leroy Merlin' }),
        expense({ id: 'e2', supplierName: '  LEROY  MERLIN ' }),
        expense({ id: 'e3', supplierName: 'Cedeo' }),
        expense({ id: 'e4', supplierName: 'Point P' }),
        expense({ id: 'e5', supplierName: 'Rexel' }),
      ],
    });
    expect(v.supplierMemory.count).toBe(4);
    expect(v.supplierMemory.examples).toEqual(['Leroy Merlin', 'Cedeo', 'Point P']);
  });
});

describe('searchVault — recherche normalisée du coffre', () => {
  const docs = [
    doc({ id: 'a', filename: 'Reçu Leroy Merlin radiateur.pdf', kind: 'expense_receipt', createdAt: '2026-07-01T08:00:00.000Z' }),
    doc({ id: 'b', filename: 'F-2026-118.pdf', kind: 'invoice_pdf', createdAt: '2026-07-02T08:00:00.000Z' }),
    doc({ id: 'c', filename: 'Relevé juin.pdf', createdAt: '2026-07-03T08:00:00.000Z' }),
  ];

  it('matche sans casse ni accents, tous les mots requis', () => {
    expect(searchVault(docs, 'RADIATEUR leroy').map((d) => d.id)).toEqual(['a']);
    expect(searchVault(docs, 'releve').map((d) => d.id)).toEqual(['c']);
  });

  it('matche le titre intelligent (displayName) d’un document renommé, pas seulement le filename', () => {
    const renamed = [
      doc({ id: 'r', filename: 'IMG_4521.jpg', displayName: 'Facture Leroy Merlin — juin', createdAt: '2026-07-04T08:00:00.000Z' }),
    ];
    expect(searchVault(renamed, 'leroy').map((d) => d.id)).toEqual(['r']);
    expect(searchVault(renamed, 'img 4521').map((d) => d.id)).toEqual(['r']); // le filename reste indexé
  });

  it('matche aussi la clé de dossier (achats, comptable)', () => {
    expect(searchVault(docs, 'achats').map((d) => d.id)).toEqual(['a']);
    expect(searchVault(docs, 'comptable').map((d) => d.id)).toEqual(['b']);
  });

  it('requête vide → tout le coffre ; sans résultat → liste vide', () => {
    expect(searchVault(docs, '  ')).toHaveLength(3);
    expect(searchVault(docs, 'introuvable')).toEqual([]);
  });
});

describe('normalizeSupplierName', () => {
  it('minuscules, accents retirés, espaces réduits', () => {
    expect(normalizeSupplierName('  Chauffage  Général ÉLEC ')).toBe('chauffage general elec');
  });
});
