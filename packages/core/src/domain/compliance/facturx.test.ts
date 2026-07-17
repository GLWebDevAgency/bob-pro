import { describe, it, expect } from 'vitest';
import { buildFacturXBasicXml, facturXDataFromInvoice, frenchVatNumber, type FacturXInvoiceData } from './facturx';
import { Invoice } from '../billing/invoice/invoice';
import { Company } from '../company/company';
import { DocNumber } from '../billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { seedCompany, MERCIER_PROPS } from '../../application/fixtures/index';

function issueForFacturX(invoice: Invoice, sequence: number): void {
  const assigned = invoice.assignNumber(
    DocNumber.format('F', 2026, sequence),
    '2026-06-29T10:00:00Z',
  );
  if (!assigned.ok) throw new Error('Facture de test non numérotée.');
  const terms = PaymentTerms.of({ days: 30, endOfMonth: false, label: '30 jours' });
  if (!terms.ok) throw new Error('Conditions de paiement de test invalides.');
  const issued = invoice.issue({
    mentions: [],
    terms: terms.value,
    issuedAt: '2026-06-29',
    at: '2026-06-29T10:00:00Z',
  });
  if (!issued.ok) throw new Error('Facture de test non émise.');
}

const baseData = (): FacturXInvoiceData => ({
  number: 'F-2026-0001',
  typeCode: '380',
  issueDate: '2026-06-29',
  dueDate: '2026-07-29',
  currency: 'EUR',
  seller: {
    name: 'Plomberie Martin & Fils',
    legalId: '73282932000074',
    vatId: 'FR32732829320',
    address: { line1: '12 rue des Lilas', postcode: '92000', city: 'Nanterre', countryCode: 'FR' },
  },
  buyer: { name: 'Client <SARL>', address: { line1: '1 av', postcode: '75001', city: 'Paris', countryCode: 'FR' } },
  lines: [
    { id: '1', name: 'Main d’œuvre', qty: 2, unitCode: 'C62', unitPriceHTCents: 10000, netAmountCents: 20000, vatCategory: 'S', vatRatePct: 20 },
    { id: '2', name: 'Fourniture', qty: 1, unitCode: 'C62', unitPriceHTCents: 5000, netAmountCents: 5000, vatCategory: 'S', vatRatePct: 10 },
  ],
  vatBreakdown: [
    { category: 'S', ratePct: 10, basisCents: 5000, vatCents: 500 },
    { category: 'S', ratePct: 20, basisCents: 20000, vatCents: 4000 },
  ],
  lineTotalHTCents: 25000,
  taxBasisTotalCents: 25000,
  taxTotalCents: 4500,
  grandTotalCents: 29500,
  prepaidCents: 0,
  duePayableCents: 29500,
});

describe('buildFacturXBasicXml — sérialisation CII BASIC', () => {
  it('émet un XML bien formé avec le profil BASIC et les totaux EN 16931', () => {
    const xml = buildFacturXBasicXml(baseData());
    expect(xml).toContain('urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic');
    expect(xml).toContain('<ram:TypeCode>380</ram:TypeCode>');
    expect(xml).toContain('<udt:DateTimeString format="102">20260629</udt:DateTimeString>');
    expect(xml).toContain('<ram:ID schemeID="0002">73282932000074</ram:ID>');
    expect(xml).toContain('<ram:ID schemeID="VA">FR32732829320</ram:ID>');
    // BR-CO-15 : GrandTotal = TaxBasisTotal + TaxTotal (250.00 + 45.00 = 295.00)
    expect(xml).toContain('<ram:TaxBasisTotalAmount>250.00</ram:TaxBasisTotalAmount>');
    expect(xml).toContain('<ram:TaxTotalAmount currencyID="EUR">45.00</ram:TaxTotalAmount>');
    expect(xml).toContain('<ram:GrandTotalAmount>295.00</ram:GrandTotalAmount>');
    expect(xml).toContain('<ram:DuePayableAmount>295.00</ram:DuePayableAmount>');
  });

  it('échappe le texte libre (XML bien formé)', () => {
    const xml = buildFacturXBasicXml(baseData());
    expect(xml).toContain('Client &lt;SARL&gt;');
    expect(xml).not.toContain('Client <SARL>');
  });

  it('acompte : émet TotalPrepaidAmount et DuePayable < GrandTotal (BR-CO-16)', () => {
    const d = baseData();
    d.typeCode = '386';
    d.prepaidCents = 20650; // 295.00 - 88.50
    d.duePayableCents = 8850;
    const xml = buildFacturXBasicXml(d);
    expect(xml).toContain('<ram:TotalPrepaidAmount>206.50</ram:TotalPrepaidAmount>');
    expect(xml).toContain('<ram:DuePayableAmount>88.50</ram:DuePayableAmount>');
  });

  it('franchise en base : catégorie E + motif 293 B, pas de TVA', () => {
    const d = baseData();
    delete d.seller.vatId;
    d.vatBreakdown = [{ category: 'E', ratePct: 0, basisCents: 25000, vatCents: 0, exemptionReason: 'TVA non applicable, art. 293 B du CGI' }];
    d.taxTotalCents = 0;
    d.grandTotalCents = 25000;
    d.duePayableCents = 25000;
    const xml = buildFacturXBasicXml(d);
    expect(xml).toContain('<ram:CategoryCode>E</ram:CategoryCode>');
    expect(xml).toContain('TVA non applicable, art. 293 B du CGI');
    expect(xml).not.toContain('schemeID="VA"');
  });
});

describe('frenchVatNumber', () => {
  it('calcule la clé TVA intracom française', () => {
    const v = frenchVatNumber('732829320');
    expect(v).toMatch(/^FR\d{2}732829320$/);
  });
});

describe('facturXDataFromInvoice — mapping depuis l’agrégat', () => {
  it('dérive ventilation TVA, totaux et identifiants vendeur (régime réel)', () => {
    const company = seedCompany();
    const inv = (Invoice.composeStandalone({ id: 'inv1', companyId: company.id, customerId: 'cust1' }) as { ok: true; value: Invoice }).value;
    inv.addLine({ id: 'l1', label: 'Pose chaudière', category: 'labor', qty: 2, unitPriceHT: 10000, vatRate: 20 });
    inv.addLine({ id: 'l2', label: 'Joint', category: 'supply', qty: 1, unitPriceHT: 5000, vatRate: 10 });
    issueForFacturX(inv, 1);

    const data = facturXDataFromInvoice(inv, company, { name: 'Client Test', address: { line1: '1 av', zip: '75001', city: 'Paris' } });

    expect(data.lineTotalHTCents).toBe(25000);
    expect(data.taxTotalCents).toBe(4500);
    expect(data.grandTotalCents).toBe(29500);
    expect(data.duePayableCents).toBe(29500);
    expect(data.prepaidCents).toBe(0);
    // ventilation triée par taux croissant
    expect(data.vatBreakdown.map((b) => [b.ratePct, b.basisCents, b.vatCents, b.category])).toEqual([
      [10, 5000, 500, 'S'],
      [20, 20000, 4000, 'S'],
    ]);
    expect(data.seller.legalId).toBe(company.siren); // BT-30 = SIREN sous schemeID 0002
    expect(data.seller.vatId).toBeDefined(); // réel -> n° TVA présent
    expect(data.buyer.legalId).toBeUndefined();
    // l’arithmétique sérialisée reste cohérente
    expect(data.taxBasisTotalCents + data.taxTotalCents).toBe(data.grandTotalCents);
  });

  it('franchise : un seul groupe E (taux 0, TVA 0) même si une ligne porte un taux erroné', () => {
    const company = (Company.of({ ...MERCIER_PROPS, vatRegime: 'franchise' }) as { ok: true; value: Company }).value;
    const inv = (Invoice.composeStandalone({ id: 'inv2', companyId: company.id, customerId: 'c' }) as { ok: true; value: Invoice }).value;
    inv.addLine({ id: 'l1', label: 'Prestation', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 });
    issueForFacturX(inv, 2);

    const data = facturXDataFromInvoice(inv, company, { name: 'Client', address: { line1: 'x', zip: '75001', city: 'Paris' } });

    expect(data.taxTotalCents).toBe(0); // jamais de TVA en franchise
    expect(data.grandTotalCents).toBe(10000); // total = HT
    expect(data.duePayableCents).toBe(10000);
    expect(data.vatBreakdown).toHaveLength(1);
    const b0 = data.vatBreakdown[0]!;
    expect(b0).toMatchObject({ category: 'E', ratePct: 0, vatCents: 0, basisCents: 10000 });
    expect(b0.exemptionReason).toContain('293 B');
    expect(data.seller.vatId).toBeUndefined();
    expect(data.lines[0]!).toMatchObject({ vatCategory: 'E', vatRatePct: 0 });
  });

  it('refuse une facture brouillon au lieu de fabriquer un numéro et une date', () => {
    const company = seedCompany();
    const inv = (Invoice.composeStandalone({ id: 'draft', companyId: company.id, customerId: 'c' }) as {
      ok: true;
      value: Invoice;
    }).value;
    inv.addLine({ id: 'l1', label: 'Prestation', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 });

    expect(() =>
      facturXDataFromInvoice(inv, company, {
        name: 'Client',
        address: { line1: 'x', zip: '75001', city: 'Paris' },
      }),
    ).toThrowError('FACTURX_ISSUED_INVOICE_REQUIRED');
  });
});
