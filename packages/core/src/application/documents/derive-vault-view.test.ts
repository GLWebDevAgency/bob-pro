import { describe, it, expect } from 'vitest';
import {
  deriveVaultView,
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

describe('deriveVaultView — à valider (OCR non classé)', () => {
  it('ne retient que les docs OCR sans lien, du plus récent au plus ancien', () => {
    const v = deriveVaultView({
      ...EMPTY,
      documents: [
        doc({ id: 'a', origin: 'ocr', createdAt: '2026-07-01T08:00:00.000Z' }),
        doc({ id: 'b', origin: 'ocr', createdAt: '2026-07-02T08:00:00.000Z' }),
        doc({ id: 'c', origin: 'ocr', linkedEntityType: 'expense', linkedEntityId: 'exp-9' }),
        doc({ id: 'd', origin: 'uploaded' }),
      ],
    });
    expect(v.toValidate.map((p) => p.id)).toEqual(['b', 'a']);
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
