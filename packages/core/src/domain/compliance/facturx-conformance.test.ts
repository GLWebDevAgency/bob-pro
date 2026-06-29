import { describe, it, expect } from 'vitest';
import { validateFacturXBasic } from './facturx-validation';
import { facturXDataFromInvoice, buildFacturXBasicXml, type FacturXInvoiceData } from './facturx';
import { Invoice } from '../billing/invoice/invoice';
import { Company } from '../company/company';
import { DocNumber } from '../billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { type LineInput } from '../billing/shared/line-item';
import { seedCompany, MERCIER_PROPS } from '../../application/fixtures/index';

const BUYER = { name: 'Client Conformité', address: { line1: '10 rue de Rivoli', zip: '75004', city: 'Paris' } };

/** Émet une vraie facture (numéro + totaux figés) à partir d'une société et de lignes. */
function issuedInvoice(company: Company, lines: Omit<LineInput, 'unit'>[], seq: number): Invoice {
  const inv = (Invoice.composeStandalone({ id: `inv-${seq}`, companyId: company.id, customerId: 'cust' }) as {
    ok: true;
    value: Invoice;
  }).value;
  lines.forEach((l, i) => inv.addLine({ id: `l${seq}-${i}`, ...l }));
  inv.assignNumber(DocNumber.format('F', 2026, seq), '2026-06-29T10:00:00Z');
  const terms = (PaymentTerms.of({ days: 30, endOfMonth: false, label: '30 jours' }) as { ok: true; value: PaymentTerms }).value;
  inv.issue({ mentions: ['TVA sur les débits'], terms, issuedAt: '2026-06-29', at: '2026-06-29T10:00:00Z' });
  return inv;
}

const franchiseCompany = (Company.of({ ...MERCIER_PROPS, vatRegime: 'franchise' }) as { ok: true; value: Company }).value;

describe('Conformité Factur-X e2e (devis→facture émise → validation EN 16931)', () => {
  it('régime réel, taux unique : conforme', () => {
    const inv = issuedInvoice(seedCompany(), [{ label: 'Pose', category: 'labor', qty: 1, unitPriceHT: 120000, vatRate: 20 }], 1);
    const data = facturXDataFromInvoice(inv, seedCompany(), BUYER);
    const res = validateFacturXBasic(data);
    expect(res.violations).toEqual([]);
    expect(res.valid).toBe(true);
    expect(buildFacturXBasicXml(data)).toContain('urn:factur-x.eu:1p0:basic');
  });

  it('régime réel, multi-taux (20 % + 10 % + 5,5 %) : conforme', () => {
    const inv = issuedInvoice(
      seedCompany(),
      [
        { label: 'Main d’œuvre', category: 'labor', qty: 2, unitPriceHT: 10000, vatRate: 20 },
        { label: 'Matériaux', category: 'supply', qty: 3, unitPriceHT: 4990, vatRate: 10 },
        { label: 'Repas', category: 'travel', qty: 1, unitPriceHT: 1850, vatRate: 5.5 },
      ],
      2,
    );
    const data = facturXDataFromInvoice(inv, seedCompany(), BUYER);
    const res = validateFacturXBasic(data);
    expect(res.violations).toEqual([]);
    expect(data.vatBreakdown.length).toBe(3);
  });

  it('franchise en base : conforme, sans TVA, catégorie E unique', () => {
    const inv = issuedInvoice(
      franchiseCompany,
      [{ label: 'Prestation', category: 'labor', qty: 1, unitPriceHT: 80000, vatRate: 20 }],
      3,
    );
    const data = facturXDataFromInvoice(inv, franchiseCompany, BUYER);
    const res = validateFacturXBasic(data);
    expect(res.violations).toEqual([]);
    expect(data.taxTotalCents).toBe(0);
  });

  it('détecte une incohérence arithmétique (BR-CO-15)', () => {
    const inv = issuedInvoice(seedCompany(), [{ label: 'X', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 }], 4);
    const broken: FacturXInvoiceData = { ...facturXDataFromInvoice(inv, seedCompany(), BUYER), grandTotalCents: 999999 };
    const res = validateFacturXBasic(broken);
    expect(res.valid).toBe(false);
    expect(res.violations.some((v) => v.rule === 'BR-CO-15')).toBe(true);
  });

  it('détecte une ventilation TVA incohérente avec les lignes (BR-CO-18)', () => {
    const inv = issuedInvoice(seedCompany(), [{ label: 'X', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 }], 6);
    const base = facturXDataFromInvoice(inv, seedCompany(), BUYER);
    // Lignes en S/20 mais ventilation déclarée en Z/0 (mislabel d'exonération).
    const broken: FacturXInvoiceData = {
      ...base,
      vatBreakdown: [{ category: 'Z', ratePct: 0, basisCents: base.taxBasisTotalCents, vatCents: 0 }],
      taxTotalCents: 0,
      grandTotalCents: base.taxBasisTotalCents,
      duePayableCents: base.taxBasisTotalCents,
    };
    const res = validateFacturXBasic(broken);
    expect(res.violations.some((v) => v.rule === 'BR-CO-18')).toBe(true);
  });

  it('détecte un acompte mal réparti (BR-CO-16)', () => {
    const inv = issuedInvoice(seedCompany(), [{ label: 'X', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 }], 5);
    const base = facturXDataFromInvoice(inv, seedCompany(), BUYER);
    const broken: FacturXInvoiceData = { ...base, prepaidCents: 500, duePayableCents: base.grandTotalCents };
    const res = validateFacturXBasic(broken);
    expect(res.violations.some((v) => v.rule === 'BR-CO-16')).toBe(true);
  });
});
