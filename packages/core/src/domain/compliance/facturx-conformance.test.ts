import { describe, it, expect } from 'vitest';
import { validateFacturXBasic } from './facturx-validation';
import {
  FR_DISBURSEMENT_OUTSIDE_VAT_SCOPE,
  FR_VATEX_FRANCHISE,
  VATEX_EU_NOT_SUBJECT_TO_VAT,
  facturXDataFromInvoice,
  buildFacturXBasicXml,
  type FacturXInvoiceData,
} from './facturx';
import { Invoice } from '../billing/invoice/invoice';
import { Company } from '../company/company';
import { DocNumber } from '../billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { type LineInput } from '../billing/shared/line-item';
import { seedCompany, MERCIER_PROPS } from '../../application/fixtures/index';
import type { FrenchBillingMode } from './french-billing-mode';

const BUYER = {
  name: 'Client Conformité',
  // Flux 2 : preneur professionnel français identifié par son SIREN réel.
  type: 'b2b',
  siren: '821503646',
  email: 'client-conformite@example.fr',
  isInternational: false,
  isSubcontractingBtp: false,
  address: { line1: '10 rue de Rivoli', zip: '75004', city: 'Paris' },
} as const;

/** A4 — donneur d'ordre b2b en sous-traitance BTP : pièce autoliquidée (art. 283, 2 nonies CGI). */
const DONNEUR_ORDRE = {
  name: 'BTP Grand Œuvre',
  siren: '821503646',
  tvaIntracom: 'FR37821503646',
  type: 'b2b',
  isInternational: false,
  isSubcontractingBtp: true,
  address: { line1: 'ZA des Bruyères', zip: '92140', city: 'Clamart' },
} as const;

/** Émet une vraie facture (numéro + totaux figés) à partir d'une société et de lignes. */
function issuedInvoice(
  company: Company,
  lines: Omit<LineInput, 'unit'>[],
  seq: number,
  frenchBillingMode: FrenchBillingMode = 'S1',
): Invoice {
  const inv = (Invoice.composeStandalone({ id: `inv-${seq}`, companyId: company.id, customerId: 'cust' }) as {
    ok: true;
    value: Invoice;
  }).value;
  lines.forEach((l, i) => inv.addLine({ id: `l${seq}-${i}`, ...l }));
  inv.assignNumber(DocNumber.format('F', 2026, seq), '2026-06-29T10:00:00Z');
  const terms = (PaymentTerms.of({ days: 30, endOfMonth: false, label: '30 jours' }) as { ok: true; value: PaymentTerms }).value;
  inv.issue({
    mentions: [
      // Mention LITTÉRALE de l'art. 242 nonies A, I-11° bis de l'annexe II au CGI (le raccourci
      // de langage « TVA sur les débits » n'est pas la mention légale — cf. build-mentions).
      "Option pour le paiement de la taxe d'après les débits",
      'Escompte pour paiement anticipé : néant.',
      'Pénalités de retard : taux BCE + 10 points (art. L441-10 du code de commerce). Indemnité forfaitaire de recouvrement : 40 € (art. D441-5 du code de commerce).',
    ],
    terms,
    issuedAt: '2026-06-29',
    at: '2026-06-29T10:00:00Z',
    frenchBillingMode,
  });
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
    expect(buildFacturXBasicXml(data)).toContain('<ram:ID>urn:cen.eu:en16931:2017</ram:ID>');
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

  it('franchise en base : conforme CIUS France, sans TVA, catégorie E + VATEX + identifiant fiscal FC', () => {
    const inv = issuedInvoice(
      franchiseCompany,
      [{ label: 'Prestation', category: 'labor', qty: 1, unitPriceHT: 80000, vatRate: 20 }],
      3,
    );
    const data = facturXDataFromInvoice(inv, franchiseCompany, BUYER);
    const res = validateFacturXBasic(data);
    expect(res.violations).toEqual([]);
    expect(data.taxTotalCents).toBe(0);
    expect(data.vatBreakdown).toEqual([
      expect.objectContaining({ category: 'E', exemptionReasonCode: FR_VATEX_FRANCHISE }),
    ]);
  });

  it('A4 — autoliquidation sous-traitance BTP : conforme, catégorie AE unique, TVA 0, mention portée', () => {
    const inv = issuedInvoice(
      seedCompany(),
      [{ label: 'Lot plomberie — sous-traitance', category: 'labor', qty: 1, unitPriceHT: 300000, vatRate: 0 }],
      7,
      'S5',
    );
    const data = facturXDataFromInvoice(inv, seedCompany(), DONNEUR_ORDRE);
    const res = validateFacturXBasic(data);
    expect(res.violations).toEqual([]);
    expect(res.valid).toBe(true);
    expect(data.vatBreakdown).toEqual([
      {
        category: 'AE',
        ratePct: 0,
        basisCents: 300000,
        vatCents: 0,
        exemptionReason: 'Autoliquidation — art. 283, 2 nonies du CGI',
      },
    ]);
    expect(data.taxTotalCents).toBe(0);
  });

  it('débours — conforme BR-O : catégorie unique, aucun taux, aucun identifiant TVA', () => {
    const company = seedCompany();
    const inv = issuedInvoice(
      company,
      [{ label: 'Débours greffe', category: 'disbursement', qty: 1, unitPriceHT: 9900, vatRate: 0 }],
      10,
      'S1',
    );
    const data = facturXDataFromInvoice(inv, company, BUYER);
    expect(validateFacturXBasic(data)).toEqual({ valid: true, violations: [] });
    expect(data.vatBreakdown).toEqual([
      {
        category: 'O',
        basisCents: 9900,
        vatCents: 0,
        exemptionReason: FR_DISBURSEMENT_OUTSIDE_VAT_SCOPE,
        exemptionReasonCode: VATEX_EU_NOT_SUBJECT_TO_VAT,
      },
    ]);
    const xml = buildFacturXBasicXml(data);
    expect(xml).not.toContain('RateApplicablePercent');
    expect(xml).not.toContain('schemeID="VA"');
  });

  it('A4 — refuse de construire une pièce AE sans SIREN du preneur', () => {
    const inv = issuedInvoice(
      seedCompany(),
      [{ label: 'Lot plomberie — sous-traitance', category: 'labor', qty: 1, unitPriceHT: 300000, vatRate: 0 }],
      8,
    );
    // Donneur d'ordre SANS SIREN : le BT-48 ne peut pas être dérivé — jamais inventé,
    // la violation est SIGNALÉE (fail-closed) au lieu d'émettre un XML rejetable en silence.
    const { siren: _sirenOmis, ...donneurOrdreSansSiren } = DONNEUR_ORDRE;
    expect(() => facturXDataFromInvoice(inv, seedCompany(), donneurOrdreSansSiren)).toThrowError(
      'FACTURX_PROFESSIONAL_BUYER_SIREN_REQUIRED',
    );
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

  it('refuse VATEX-FR-FRANCHISE avec une catégorie autre que E (BR-FR-CO-16)', () => {
    const inv = issuedInvoice(
      franchiseCompany,
      [{ label: 'X', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 }],
      9,
    );
    const base = facturXDataFromInvoice(inv, franchiseCompany, BUYER);
    const broken: FacturXInvoiceData = {
      ...base,
      lines: base.lines.map((line) => ({ ...line, vatCategory: 'Z' })),
      vatBreakdown: base.vatBreakdown.map((breakdown) => ({ ...breakdown, category: 'Z' })),
    };
    const res = validateFacturXBasic(broken);
    expect(res.violations.some((violation) => violation.rule === 'BR-FR-CO-16')).toBe(true);
  });

  it('détecte un acompte mal réparti (BR-CO-16)', () => {
    const inv = issuedInvoice(seedCompany(), [{ label: 'X', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 }], 5);
    const base = facturXDataFromInvoice(inv, seedCompany(), BUYER);
    const broken: FacturXInvoiceData = { ...base, prepaidCents: 500, duePayableCents: base.grandTotalCents };
    const res = validateFacturXBasic(broken);
    expect(res.violations.some((v) => v.rule === 'BR-CO-16')).toBe(true);
  });
});
