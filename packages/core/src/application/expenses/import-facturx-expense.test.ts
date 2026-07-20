import { describe, it, expect } from 'vitest';
import { buildFacturXBasicXml, type FacturXInvoiceData } from '../../domain/compliance/facturx';
import { buildRecordedExpenseAccountingEntry } from '../../domain/accounting/expense-accounting';
import { Expense } from '../../domain/expense/expense';
import {
  importFacturXExpense,
  withSupplierCategory,
  facturXDraftToRecordExpenseInput,
  facturXExpenseKey,
  expenseDuplicateKey,
  type FacturXExpenseDraft,
  type ImportFacturXExpenseError,
} from './import-facturx-expense';

const MY_SIREN = '732829320'; // Mercier Plomberie (Luhn valide)
const SUPPLIER_SIREN = '552100554'; // fournisseur (Luhn valide)

/** Facture fournisseur MULTI-TAUX (20 % + 10 % + 5,5 %) adressée à MA société, échéance BT-9. */
const inboundData = (): FacturXInvoiceData => ({
  number: 'FC-2026-118',
  typeCode: '380',
  issueDate: '2026-06-20',
  dueDate: '2026-07-20',
  currency: 'EUR',
  seller: {
    name: 'Sanit Chauffe SAS',
    legalId: SUPPLIER_SIREN,
    vatId: 'FR96552100554',
    address: { line1: '4 rue des Forges', postcode: '69007', city: 'Lyon', countryCode: 'FR' },
  },
  buyer: {
    name: 'Mercier Plomberie',
    legalId: MY_SIREN,
    address: { line1: '12 rue des Artisans', postcode: '92000', city: 'Nanterre', countryCode: 'FR' },
  },
  lines: [
    { id: '1', name: 'Chauffe-eau 200 L', qty: 1, unitCode: 'C62', unitPriceHTCents: 41000, netAmountCents: 41000, vatCategory: 'S', vatRatePct: 20 },
    { id: '2', name: 'Abonnement entretien', qty: 1, unitCode: 'C62', unitPriceHTCents: 6000, netAmountCents: 6000, vatCategory: 'S', vatRatePct: 10 },
    { id: '3', name: 'Denrées chantier', qty: 1, unitCode: 'C62', unitPriceHTCents: 1234, netAmountCents: 1234, vatCategory: 'S', vatRatePct: 5.5 },
  ],
  vatBreakdown: [
    { category: 'S', ratePct: 5.5, basisCents: 1234, vatCents: 68 },
    { category: 'S', ratePct: 10, basisCents: 6000, vatCents: 600 },
    { category: 'S', ratePct: 20, basisCents: 41000, vatCents: 8200 },
  ],
  lineTotalHTCents: 48234,
  taxBasisTotalCents: 48234,
  taxTotalCents: 8868,
  grandTotalCents: 57102,
  prepaidCents: 0,
  duePayableCents: 57102,
});

/** Facture de SOUS-TRAITANCE en AUTOLIQUIDATION preneur (catégorie AE — le piège P21). */
const autoliquidationData = (): FacturXInvoiceData => ({
  number: 'ST-2026-007',
  typeCode: '380',
  issueDate: '2026-06-25',
  currency: 'EUR',
  seller: {
    name: 'Bâti Sous-Traitance SARL',
    legalId: SUPPLIER_SIREN,
    address: { line1: '9 rue Haute', postcode: '59000', city: 'Lille', countryCode: 'FR' },
  },
  buyer: {
    name: 'Mercier Plomberie',
    legalId: MY_SIREN,
    address: { line1: '12 rue des Artisans', postcode: '92000', city: 'Nanterre', countryCode: 'FR' },
  },
  lines: [
    { id: '1', name: 'Sous-traitance pose réseau cuivre', qty: 1, unitCode: 'C62', unitPriceHTCents: 100000, netAmountCents: 100000, vatCategory: 'AE', vatRatePct: 0 },
  ],
  vatBreakdown: [
    { category: 'AE', ratePct: 0, basisCents: 100000, vatCents: 0, exemptionReason: 'Autoliquidation, art. 283-2 nonies CGI' },
  ],
  lineTotalHTCents: 100000,
  taxBasisTotalCents: 100000,
  taxTotalCents: 0,
  grandTotalCents: 100000,
  prepaidCents: 0,
  duePayableCents: 100000,
});

/** Facture d'un fournisseur EXONÉRÉ / en franchise (catégorie E, 293 B). */
const exemptData = (): FacturXInvoiceData => ({
  number: 'MICRO-2026-31',
  typeCode: '380',
  issueDate: '2026-06-10',
  currency: 'EUR',
  seller: {
    name: 'Dessinateur Indé',
    legalId: '900123456',
    address: { line1: '2 impasse Verte', postcode: '31000', city: 'Toulouse', countryCode: 'FR' },
  },
  buyer: {
    name: 'Mercier Plomberie',
    legalId: MY_SIREN,
    address: { line1: '12 rue des Artisans', postcode: '92000', city: 'Nanterre', countryCode: 'FR' },
  },
  lines: [
    { id: '1', name: 'Plans salle de bain', qty: 1, unitCode: 'C62', unitPriceHTCents: 30000, netAmountCents: 30000, vatCategory: 'E', vatRatePct: 0 },
  ],
  vatBreakdown: [
    { category: 'E', ratePct: 0, basisCents: 30000, vatCents: 0, exemptionReason: 'TVA non applicable, art. 293 B du CGI' },
  ],
  lineTotalHTCents: 30000,
  taxBasisTotalCents: 30000,
  taxTotalCents: 0,
  grandTotalCents: 30000,
  prepaidCents: 0,
  duePayableCents: 30000,
});

function importOk(data: FacturXInvoiceData): FacturXExpenseDraft {
  const r = importFacturXExpense({ xml: buildFacturXBasicXml(data), mySiren: MY_SIREN, existingInvoiceKeys: [] });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(`import KO: ${r.error.code}`);
  return r.value;
}

function importErr(data: FacturXInvoiceData | string, keys: string[] = []): ImportFacturXExpenseError {
  const xml = typeof data === 'string' ? data : buildFacturXBasicXml(data);
  const r = importFacturXExpense({ xml, mySiren: MY_SIREN, existingInvoiceKeys: keys });
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('attendu err');
  return r.error;
}

describe('importFacturXExpense — contrôles bloquants (un par un)', () => {
  it('XML invalide → xml_invalide (rejet TECHNIQUE, AFNOR 213 proposé)', () => {
    const e = importErr('<pas-une-facture>');
    expect(e.code).toBe('xml_invalide');
    if (e.code === 'xml_invalide') expect(e.suggestedAfnorStatus).toBe(213);
  });

  it('MAL ADRESSÉE : SIREN acheteur ≠ ma société → refus AFNOR 210 proposé, LES 2 SIREN exposés', () => {
    const data = inboundData();
    data.buyer = { ...data.buyer, legalId: '900123456' };
    const e = importErr(data);
    expect(e.code).toBe('mal_adressee');
    if (e.code !== 'mal_adressee') return;
    expect(e.buyerSiren).toBe('900123456');
    expect(e.mySiren).toBe(MY_SIREN);
    expect(e.suggestedAfnorStatus).toBe(210);
  });

  it('MAL ADRESSÉE : acheteur sans SIREN vérifiable → buyerSiren null (rien de prouvable)', () => {
    const data = inboundData();
    const { legalId: _omit, ...buyerSansSiren } = data.buyer;
    data.buyer = buyerSansSiren;
    const e = importErr(data);
    expect(e.code).toBe('mal_adressee');
    if (e.code === 'mal_adressee') expect(e.buyerSiren).toBeNull();
  });

  it('destinataire vérifiable par le n° TVA FR (BT-31) quand le SIREN (BT-30) manque', () => {
    const data = inboundData();
    const { legalId: _omit, ...buyerBase } = data.buyer;
    data.buyer = { ...buyerBase, vatId: 'FR44732829320' }; // FR + clé 44 + MON SIREN
    expect(importOk(data).supplierSiren).toBe(SUPPLIER_SIREN);
  });

  it('INCOHÉRENTE : totaux EN 16931 faux → violations exposées (validateFacturXBasic rejoué)', () => {
    const data = inboundData();
    data.grandTotalCents = 57103; // base + TVA ≠ TTC (et TTC − acompte ≠ net à payer)
    const e = importErr(data);
    expect(e.code).toBe('incoherente');
    if (e.code !== 'incoherente') return;
    expect(e.violations.length).toBeGreaterThan(0);
    expect(e.violations.map((v) => v.rule)).toContain('BR-CO-15');
    expect(e.suggestedAfnorStatus).toBe(210);
  });

  it('DOUBLON EXACT : SIREN fournisseur + n° déjà en base → import refusé avec la clé (anti P17)', () => {
    const existing = expenseDuplicateKey({
      supplierSiren: SUPPLIER_SIREN,
      supplierName: 'Sanit Chauffe SAS',
      supplierInvoiceNumber: ' fc-2026-118 ', // normalisation : trim + majuscules
    });
    expect(existing).toBe(`${SUPPLIER_SIREN}|FC-2026-118`);
    const e = importErr(inboundData(), existing === null ? [] : [existing]);
    expect(e.code).toBe('doublon');
    if (e.code === 'doublon') expect(e.duplicateKey).toBe(`${SUPPLIER_SIREN}|FC-2026-118`);
  });

  it('AVOIR (381) refusé : un avoir importé en charge = double déduction — jamais', () => {
    const data = inboundData();
    data.typeCode = '381';
    const e = importErr(data);
    expect(e.code).toBe('type_non_gere');
  });

  it('devise ≠ EUR refusée (aucune conversion inventée)', () => {
    const data = inboundData();
    data.currency = 'USD';
    const e = importErr(data);
    expect(e.code).toBe('devise_non_geree');
  });
});

describe('importFacturXExpense — mapping expert du brouillon', () => {
  it('MULTI-TAUX AU CENTIME : vatCents = somme exacte des ventilations, vatRatePct null', () => {
    const draft = importOk(inboundData());
    expect(draft).toMatchObject({
      supplierName: 'Sanit Chauffe SAS',
      supplierSiren: SUPPLIER_SIREN,
      supplierInvoiceNumber: 'FC-2026-118',
      documentDate: '2026-06-20',
      dueAt: '2026-07-20', // BT-9 → dueAt
      totalTtcCents: 57102,
      totalHtCents: 48234,
      vatCents: 8868, // 68 + 600 + 8200 — la somme EXACTE, pas un taux rejoué
      vatRatePct: null, // plusieurs taux → null
      vatNonDeductible: false,
      vatNote: null,
      categoryGuess: 'autre',
      categorySource: 'default',
      source: 'facturx',
      duplicateKey: `${SUPPLIER_SIREN}|FC-2026-118`,
    });
  });

  it('taux UNIQUE : vatRatePct porté (et clé de doublon stable via facturXExpenseKey)', () => {
    const data = inboundData();
    data.lines = [data.lines[0]!];
    data.vatBreakdown = [{ category: 'S', ratePct: 20, basisCents: 41000, vatCents: 8200 }];
    data.lineTotalHTCents = 41000;
    data.taxBasisTotalCents = 41000;
    data.taxTotalCents = 8200;
    data.grandTotalCents = 49200;
    data.duePayableCents = 49200;
    const draft = importOk(data);
    expect(draft.vatRatePct).toBe(20);
    expect(draft.vatCents).toBe(8200);
    expect(draft.duplicateKey).toBe(
      facturXExpenseKey({ supplierSiren: SUPPLIER_SIREN, supplierName: 'Sanit Chauffe SAS', supplierInvoiceNumber: 'FC-2026-118' }),
    );
  });

  it('AUTOLIQUIDATION (AE) : TVA non déductible + note art. 283-2 nonies + sous_traitance proposé', () => {
    const draft = importOk(autoliquidationData());
    expect(draft.vatCents).toBe(0); // EN 16931 : TVA 0 SUR LA PIÈCE, le preneur autoliquide
    expect(draft.vatNonDeductible).toBe(true);
    expect(draft.vatNote).toContain('283-2 nonies');
    expect(draft.categoryGuess).toBe('sous_traitance');
    expect(draft.dueAt).toBeNull();
  });

  it('EXONÉRÉ / franchise (E) : zéro déductible + note avec le motif 293 B', () => {
    const draft = importOk(exemptData());
    expect(draft.vatCents).toBe(0);
    expect(draft.vatNonDeductible).toBe(false);
    expect(draft.vatNote).toContain('293 B');
  });

  it('withSupplierCategory : la MÉMOIRE fournisseur prime sur le défaut, null ne change rien', () => {
    const draft = importOk(inboundData());
    const withMemory = withSupplierCategory(draft, 'materiel');
    expect(withMemory.categoryGuess).toBe('materiel');
    expect(withMemory.categorySource).toBe('memory');
    expect(withSupplierCategory(draft, null)).toEqual(draft);
  });
});

describe('facturXDraftToRecordExpenseInput — approbation vers RecordExpense (E1)', () => {
  it('autoliquidation : vatCents 0 / vatRatePct null → AUCUNE ligne 44566 dans l’écriture d’achat', () => {
    const draft = importOk(autoliquidationData());
    const input = facturXDraftToRecordExpenseInput(draft);
    expect(input.vatCents).toBe(0);
    expect(input.vatRatePct).toBeNull();
    expect(input.source).toBe('facturx');

    const expense = Expense.record({
      id: 'exp-ae',
      companyId: 'company-mercier',
      supplierName: input.supplierName,
      supplierSiren: input.supplierSiren ?? null,
      documentDate: input.documentDate,
      totalTtcCents: input.totalTtcCents,
      totalHtCents: input.totalHtCents ?? null,
      vatCents: input.vatCents ?? null,
      vatRatePct: input.vatRatePct ?? null,
      category: input.category,
      status: 'to_pay',
      source: 'facturx',
      supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
      dueAt: input.dueAt ?? null,
    });
    expect(expense.ok).toBe(true);
    if (!expense.ok) return;
    const entry = buildRecordedExpenseAccountingEntry({ entryId: 'e-ae', expense: expense.value });
    expect(entry.ok).toBe(true);
    if (!entry.ok) return;
    const lines = entry.value.toProps().lines;
    expect(lines.some((l) => l.account === '44566')).toBe(false); // le piège P21 neutralisé
    expect(lines).toEqual([
      expect.objectContaining({ account: '611', debitCents: 100000, creditCents: 0 }), // charge = TTC intégral
      expect.objectContaining({ account: '401', debitCents: 0, creditCents: 100000 }),
    ]);
  });

  it('TVA classique multi-taux : la somme exacte part en 44566, la catégorie confirmée prime', () => {
    const draft = importOk(inboundData());
    const input = facturXDraftToRecordExpenseInput(draft, { category: 'materiel' });
    expect(input.category).toBe('materiel');
    expect(input.vatCents).toBe(8868);
    expect(input.supplierInvoiceNumber).toBe('FC-2026-118');
    expect(input.dueAt).toBe('2026-07-20');

    const expense = Expense.record({
      id: 'exp-multi',
      companyId: 'company-mercier',
      supplierName: input.supplierName,
      supplierSiren: input.supplierSiren ?? null,
      documentDate: input.documentDate,
      totalTtcCents: input.totalTtcCents,
      totalHtCents: input.totalHtCents ?? null,
      vatCents: input.vatCents ?? null,
      vatRatePct: input.vatRatePct ?? null,
      category: input.category,
      status: 'to_pay',
      source: 'facturx',
      supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
      dueAt: input.dueAt ?? null,
    });
    expect(expense.ok).toBe(true);
    if (!expense.ok) return;
    const entry = buildRecordedExpenseAccountingEntry({ entryId: 'e-multi', expense: expense.value });
    expect(entry.ok).toBe(true);
    if (!entry.ok) return;
    expect(entry.value.toProps().lines).toEqual([
      expect.objectContaining({ account: '606', debitCents: 48234, creditCents: 0 }), // TTC − TVA = HT exact
      expect.objectContaining({ account: '44566', debitCents: 8868, creditCents: 0 }),
      expect.objectContaining({ account: '401', debitCents: 0, creditCents: 57102 }),
    ]);
  });
});
