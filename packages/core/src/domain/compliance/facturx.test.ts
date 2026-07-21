import { describe, it, expect } from 'vitest';
import {
  FR_DISBURSEMENT_OUTSIDE_VAT_SCOPE,
  FR_VATEX_FRANCHISE,
  VATEX_EU_NOT_SUBJECT_TO_VAT,
  buildFacturXBasicXml,
  facturXDataFromInvoice,
  type FacturXInvoiceData,
} from './facturx';
import { makePurchaseOrderRef } from '../billing/shared/purchase-order-ref';
import { Invoice } from '../billing/invoice/invoice';
import { Quote } from '../billing/quote/quote';
import { validateFacturXBasic } from './facturx-validation';
import { Company } from '../company/company';
import { DocNumber } from '../billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { seedCompany, MERCIER_PROPS } from '../../application/fixtures/index';
import type { FrenchBillingMode } from './french-billing-mode';
import type { VatTreatment } from '../billing/invoice/invoice';

function issueForFacturX(
  invoice: Invoice,
  sequence: number,
  emission?: {
    servicePeriod?: { start: string; end: string | null } | null;
    deliveryAddress?: string | null;
    frenchBillingMode?: FrenchBillingMode;
    vatTreatment?: VatTreatment;
  },
): void {
  const assigned = invoice.assignNumber(
    DocNumber.format(invoice.kind === 'credit_note' ? 'A' : 'F', 2026, sequence),
    '2026-06-29T10:00:00Z',
  );
  if (!assigned.ok) throw new Error('Facture de test non numérotée.');
  const terms = PaymentTerms.of({ days: 30, endOfMonth: false, label: '30 jours' });
  if (!terms.ok) throw new Error('Conditions de paiement de test invalides.');
  const issued = invoice.issue({
    mentions: [
      'Escompte pour paiement anticipé : néant.',
      'Pénalités de retard : taux BCE + 10 points (art. L441-10 du code de commerce). Indemnité forfaitaire de recouvrement : 40 € (art. D441-5 du code de commerce).',
    ],
    terms: terms.value,
    issuedAt: '2026-06-29',
    at: '2026-06-29T10:00:00Z',
    frenchBillingMode: emission?.frenchBillingMode ?? 'S1',
    ...(emission ?? {}),
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

describe('buildFacturXBasicXml — sérialisation CII EN16931', () => {
  it('émet un XML bien formé avec le profil EN16931 et les totaux cohérents', () => {
    const xml = buildFacturXBasicXml(baseData());
    expect(xml).toContain('<ram:ID>urn:cen.eu:en16931:2017</ram:ID>');
    expect(xml).not.toContain('factur-x.eu:1p0:basic');
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

  it('sérialise BT-113 uniquement quand le contrat de données fournit un vrai prépaiement', () => {
    const d = baseData();
    d.typeCode = '386';
    d.prepaidCents = 20650; // 295.00 - 88.50
    d.duePayableCents = 8850;
    const xml = buildFacturXBasicXml(d);
    expect(xml).toContain('<ram:TotalPrepaidAmount>206.50</ram:TotalPrepaidAmount>');
    expect(xml).toContain('<ram:DuePayableAmount>88.50</ram:DuePayableAmount>');
  });

  it('B8 — BT-13 : émet BuyerOrderReferencedDocument avec le numéro d’engagement, échappé ; jamais sans BC', () => {
    const xml = buildFacturXBasicXml({ ...baseData(), purchaseOrderReference: 'BC <4500123>' });
    expect(xml).toContain('<ram:BuyerOrderReferencedDocument>');
    expect(xml).toContain('<ram:IssuerAssignedID>BC &lt;4500123&gt;</ram:IssuerAssignedID>');
    // Sans bon de commande, l'élément est ABSENT (jamais une valeur inventée ou vide).
    expect(buildFacturXBasicXml(baseData())).not.toContain('BuyerOrderReferencedDocument');
  });

  // —— A7 : BT-72 (livraison jour unique), BG-14 (période) et BG-13 (adresse de chantier) ——
  it('A7 — prestation d’UN jour (end null) : BT-72 ActualDeliverySupplyChainEvent, pas de BG-14', () => {
    const xml = buildFacturXBasicXml({ ...baseData(), servicePeriod: { start: '2026-06-02', end: null } });
    expect(xml).toContain('<ram:ActualDeliverySupplyChainEvent>');
    expect(xml).toContain('<udt:DateTimeString format="102">20260602</udt:DateTimeString>');
    expect(xml).not.toContain('BillingSpecifiedPeriod');
    expect(xml).not.toContain('<ram:ApplicableHeaderTradeDelivery />');
  });

  it('A7 — période multi-jours : BG-14 porte la période et BT-72 sa date de fin réelle', () => {
    const xml = buildFacturXBasicXml({
      ...baseData(),
      servicePeriod: { start: '2026-06-02', end: '2026-06-13' },
    });
    expect(xml).toContain('<ram:BillingSpecifiedPeriod>');
    expect(xml).toContain('<udt:DateTimeString format="102">20260602</udt:DateTimeString>');
    expect(xml).toContain('<udt:DateTimeString format="102">20260613</udt:DateTimeString>');
    expect(xml).toContain('ActualDeliverySupplyChainEvent');
    // Sans chantier distinct, aucun ShipTo n'est fabriqué depuis l'adresse de facturation.
    expect(xml).not.toContain('<ram:ShipToTradeParty>');
    expect(xml).not.toContain('<ram:ApplicableHeaderTradeDelivery />');
    // Ordre CII : BillingSpecifiedPeriod AVANT SpecifiedTradePaymentTerms.
    expect(xml.indexOf('BillingSpecifiedPeriod')).toBeLessThan(xml.indexOf('SpecifiedTradePaymentTerms'));
  });

  it('A7 — adresse de chantier : BG-13 ShipToTradeParty (texte libre en LineOne, pays BT-80 FR), échappée', () => {
    const xml = buildFacturXBasicXml({
      ...baseData(),
      deliveryAddress: 'Chantier <bât. B> — 8 allée des Roses, 92190 Meudon',
    });
    expect(xml).toContain('<ram:ShipToTradeParty>');
    expect(xml).toContain('<ram:LineOne>Chantier &lt;bât. B&gt; — 8 allée des Roses, 92190 Meudon</ram:LineOne>');
    expect(xml).toContain('<ram:CountryID>FR</ram:CountryID>');
    expect(xml).not.toContain('<ram:ApplicableHeaderTradeDelivery />');
  });

  it('A7 — sans période ni adresse distincte : BT-72 reprend la date d’opération (= émission), sans faux ShipTo', () => {
    const xml = buildFacturXBasicXml(baseData());
    expect(xml).not.toContain('<ram:ApplicableHeaderTradeDelivery />');
    expect(xml).not.toContain('ShipToTradeParty');
    expect(xml).toContain('ActualDeliverySupplyChainEvent');
    expect(xml).toContain('<udt:DateTimeString format="102">20260629</udt:DateTimeString>');
    expect(xml).not.toContain('BillingSpecifiedPeriod');
  });

  it('France 2026 — sérialise une seule fois notes légales et endpoints réels', () => {
    const xml = buildFacturXBasicXml({
      ...baseData(),
      notes: [
        { subject: 'PMT', content: 'Frais réels' },
        { subject: 'PMD', content: 'Pénalités réelles' },
        { subject: 'AAB', content: 'Escompte réel' },
        { subject: 'BAR', content: 'B2B' },
      ],
      seller: {
        ...baseData().seller,
        electronicAddress: { schemeId: '0225', value: '732829320' },
      },
      buyer: {
        ...baseData().buyer,
        electronicAddress: { schemeId: 'EM', value: 'facturation@client.fr' },
      },
    });
    expect(xml.match(/<ram:SubjectCode>PMT<\/ram:SubjectCode>/g)).toHaveLength(1);
    expect(xml).toContain('<ram:URIID schemeID="0225">732829320</ram:URIID>');
    expect(xml).toContain('<ram:URIID schemeID="EM">facturation@client.fr</ram:URIID>');
  });

  it('France 2026 — sérialise BT-23 avant le profil et conserve le cas d’usage réel', () => {
    const xml = buildFacturXBasicXml({ ...baseData(), billingMode: 'M4' });
    expect(xml).toContain('<ram:BusinessProcessSpecifiedDocumentContextParameter>');
    expect(xml).toContain('<ram:ID>M4</ram:ID>');
    expect(xml.indexOf('BusinessProcessSpecifiedDocumentContextParameter')).toBeLessThan(
      xml.indexOf('GuidelineSpecifiedDocumentContextParameter'),
    );
  });

  it('avoir — sérialise BG-3 avec BT-25 et BT-26 après les totaux', () => {
    const xml = buildFacturXBasicXml({
      ...baseData(),
      typeCode: '381',
      precedingInvoiceReference: { number: 'F-2026-0042', issueDate: '2026-06-12' },
    });

    expect(xml).toContain('<ram:InvoiceReferencedDocument>');
    expect(xml).toContain('<ram:IssuerAssignedID>F-2026-0042</ram:IssuerAssignedID>');
    expect(xml).toContain('<qdt:DateTimeString format="102">20260612</qdt:DateTimeString>');
    expect(xml.indexOf('SpecifiedTradeSettlementHeaderMonetarySummation')).toBeLessThan(
      xml.indexOf('InvoiceReferencedDocument'),
    );
  });

  it('finale après situations — sérialise un BG-3 par pièce antérieure, dans l’ordre fourni', () => {
    const xml = buildFacturXBasicXml({
      ...baseData(),
      precedingInvoiceReferences: [
        { number: 'F-2026-0010', issueDate: '2026-03-01' },
        { number: 'F-2026-0018', issueDate: '2026-04-01' },
      ],
    });

    expect(xml.match(/<ram:InvoiceReferencedDocument>/g)).toHaveLength(2);
    expect(xml.indexOf('F-2026-0010')).toBeLessThan(xml.indexOf('F-2026-0018'));
    expect(validateFacturXBasic({
      ...baseData(),
      precedingInvoiceReferences: [
        { number: 'F-2026-0010', issueDate: '2026-03-01' },
        { number: 'F-2026-0018', issueDate: '2026-04-01' },
      ],
    }).valid).toBe(true);
  });

  it('débours hors champ — catégorie O sans taux ni identifiant TVA', () => {
    const { vatId: _sellerVatId, ...sellerWithoutVat } = baseData().seller;
    const d: FacturXInvoiceData = {
      ...baseData(),
      seller: sellerWithoutVat,
      lines: [
        {
          id: '1',
          name: 'Débours greffe',
          qty: 1,
          unitCode: 'C62',
          unitPriceHTCents: 2500,
          netAmountCents: 2500,
          vatCategory: 'O',
        },
      ],
      vatBreakdown: [
        {
          category: 'O',
          basisCents: 2500,
          vatCents: 0,
          exemptionReason: FR_DISBURSEMENT_OUTSIDE_VAT_SCOPE,
          exemptionReasonCode: VATEX_EU_NOT_SUBJECT_TO_VAT,
        },
      ],
      lineTotalHTCents: 2500,
      taxBasisTotalCents: 2500,
      taxTotalCents: 0,
      grandTotalCents: 2500,
      prepaidCents: 0,
      duePayableCents: 2500,
    };

    const xml = buildFacturXBasicXml(d);
    expect(xml.match(/<ram:CategoryCode>O<\/ram:CategoryCode>/g)).toHaveLength(2);
    expect(xml).toContain(`<ram:ExemptionReasonCode>${VATEX_EU_NOT_SUBJECT_TO_VAT}</ram:ExemptionReasonCode>`);
    expect(xml).not.toContain('RateApplicablePercent');
    expect(xml).not.toContain('schemeID="VA"');
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

/** Preneur professionnel français minimal pour un Flux 2 : SIREN/end-point réel, jamais dérivé. */
const B2B_BUYER = {
  type: 'b2b',
  siren: '821503646',
  email: 'facturation@example.fr',
  isInternational: false,
  isSubcontractingBtp: false,
} as const;

describe('facturXDataFromInvoice — mapping depuis l’agrégat', () => {
  it('utilise l’unité UN/ECE réelle de la ligne au lieu de C62 systématique', () => {
    const company = seedCompany();
    const inv = (Invoice.composeStandalone({ id: 'inv-unit', companyId: company.id, customerId: 'cust1' }) as {
      ok: true;
      value: Invoice;
    }).value;
    inv.addLine({
      id: 'l1',
      label: 'Main-d’œuvre plomberie',
      category: 'labor',
      qty: 2,
      unit: 'heures',
      unitPriceHT: 5500,
      vatRate: 20,
    });
    issueForFacturX(inv, 20);

    const data = facturXDataFromInvoice(inv, company, {
      name: 'Client',
      ...B2B_BUYER,
      address: { line1: '1 rue du Test', zip: '75001', city: 'Paris' },
    });

    expect(data.lines[0]?.unitCode).toBe('HUR');
    expect(buildFacturXBasicXml(data)).toContain('BilledQuantity unitCode="HUR"');
  });

  it('qualifie une pièce 100 % débours en O, sans taux ni identifiants TVA', () => {
    const company = seedCompany();
    const inv = (Invoice.composeStandalone({ id: 'inv-debours', companyId: company.id, customerId: 'cust1' }) as {
      ok: true;
      value: Invoice;
    }).value;
    inv.addLine({
      id: 'l1',
      label: 'Frais de greffe avancés pour le client',
      category: 'disbursement',
      qty: 1,
      unitPriceHT: 6500,
      vatRate: 0,
    });
    // Un débours n'est pas le cas « TVA déjà collectée » S7. Faute d'un fait plus précis dans
    // ce test de mapping, on conserve le cadre de la prestation sous-jacente (S1).
    issueForFacturX(inv, 21, { frenchBillingMode: 'S1', vatTreatment: 'standard' });

    const data = facturXDataFromInvoice(inv, company, {
      name: 'Client assujetti',
      siren: '821503646',
      tvaIntracom: 'FR37821503646',
      type: 'b2b',
      isInternational: false,
      isSubcontractingBtp: false,
      address: { line1: '1 rue du Test', zip: '75001', city: 'Paris' },
    });

    expect(data.lines).toEqual([expect.objectContaining({ vatCategory: 'O' })]);
    expect(data.lines[0]).not.toHaveProperty('vatRatePct');
    expect(data.vatBreakdown).toEqual([
      {
        category: 'O',
        basisCents: 6500,
        vatCents: 0,
        exemptionReason: FR_DISBURSEMENT_OUTSIDE_VAT_SCOPE,
        exemptionReasonCode: VATEX_EU_NOT_SUBJECT_TO_VAT,
      },
    ]);
    expect(data.seller.vatId).toBeUndefined();
    expect(data.buyer.vatId).toBeUndefined();
    expect(validateFacturXBasic(data)).toMatchObject({ valid: true, violations: [] });
  });

  it('avoir — reprend la référence structurée exacte de la facture source', () => {
    const company = seedCompany();
    const source = (Invoice.composeStandalone({ id: 'inv-source', companyId: company.id, customerId: 'cust1' }) as {
      ok: true;
      value: Invoice;
    }).value;
    source.addLine({
      id: 'l1',
      label: 'Pose',
      category: 'labor',
      qty: 1,
      unitPriceHT: 10000,
      vatRate: 20,
    });
    issueForFacturX(source, 22, { vatTreatment: 'standard' });
    const creditResult = Invoice.creditNoteFor(source, 'credit-source');
    if (!creditResult.ok) throw new Error('Avoir de test non créé.');
    issueForFacturX(creditResult.value, 23, { frenchBillingMode: 'S1' });

    const data = facturXDataFromInvoice(creditResult.value, company, {
      name: 'Client',
      ...B2B_BUYER,
      address: { line1: '1 rue du Test', zip: '75001', city: 'Paris' },
    });

    expect(data.typeCode).toBe('381');
    expect(data.precedingInvoiceReference).toEqual({
      number: 'F-2026-0022',
      issueDate: '2026-06-29',
    });
    expect(validateFacturXBasic(data).valid).toBe(true);
  });

  it('avoir d’acompte — émet le type réglementaire 503 et conserve BG-3', () => {
    const company = seedCompany();
    const quote = Quote.compose({
      id: 'q-deposit-credit',
      companyId: company.id,
      customerId: 'cust1',
      at: '2026-06-01T09:00:00Z',
    });
    if (!quote.ok) throw new Error('devis de test invalide');
    quote.value.addLine({
      id: 'l1',
      label: 'Installation',
      category: 'labor',
      qty: 1,
      unitPriceHT: 100_000,
      vatRate: 20,
    });
    quote.value.setDeposit(30);
    quote.value.assignNumber(DocNumber.format('D', 2026, 24), '2026-06-01T09:00:00Z');
    quote.value.send('2026-06-01T09:00:00Z');
    quote.value.sign(
      {
        signerName: 'Martin',
        signedAt: '2026-06-01T09:00:00Z',
        method: 'remote_link',
        accepted: true,
      },
      '2026-06-01T09:00:00Z',
    );
    const deposit = Invoice.fromSignedQuote(quote.value, 'deposit', 'inv-deposit');
    if (!deposit.ok) throw new Error('acompte de test invalide');
    issueForFacturX(deposit.value, 24, { vatTreatment: 'standard' });
    const buyer = {
      name: 'Client',
      ...B2B_BUYER,
      address: { line1: '1 rue du Test', zip: '75001', city: 'Paris' },
    };
    const depositData = facturXDataFromInvoice(deposit.value, company, buyer);
    expect(depositData.typeCode).toBe('386');
    expect(depositData.lineTotalHTCents).toBe(30_000);
    expect(depositData.taxTotalCents).toBe(6_000);
    expect(depositData.grandTotalCents).toBe(36_000);
    expect(depositData.prepaidCents).toBe(0);
    expect(depositData.duePayableCents).toBe(36_000);
    const credit = Invoice.creditNoteFor(deposit.value, 'credit-deposit');
    if (!credit.ok) throw new Error('avoir d’acompte de test invalide');
    issueForFacturX(credit.value, 25, { frenchBillingMode: 'S1' });

    const data = facturXDataFromInvoice(credit.value, company, buyer);

    expect(data.typeCode).toBe('503');
    expect(data.precedingInvoiceReference).toEqual({
      number: 'F-2026-0024',
      issueDate: '2026-06-29',
    });
    expect(data.prepaidCents).toBe(0);
    expect(data.duePayableCents).toBe(data.grandTotalCents);
  });
  it('dérive ventilation TVA, totaux et identifiants vendeur (régime réel)', () => {
    const company = seedCompany();
    const inv = (Invoice.composeStandalone({ id: 'inv1', companyId: company.id, customerId: 'cust1' }) as { ok: true; value: Invoice }).value;
    inv.addLine({ id: 'l1', label: 'Pose chaudière', category: 'labor', qty: 2, unitPriceHT: 10000, vatRate: 20 });
    inv.addLine({ id: 'l2', label: 'Joint', category: 'supply', qty: 1, unitPriceHT: 5000, vatRate: 10 });
    issueForFacturX(inv, 1);

    const data = facturXDataFromInvoice(inv, company, { name: 'Client Test', ...B2B_BUYER, address: { line1: '1 av', zip: '75001', city: 'Paris' } });

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
    expect(data.buyer.legalId).toBe(B2B_BUYER.siren);
    // l’arithmétique sérialisée reste cohérente
    expect(data.taxBasisTotalCents + data.taxTotalCents).toBe(data.grandTotalCents);
  });

  it('franchise : groupe E + VATEX + identifiant fiscal FC réel, jamais de TVA ou n° TVA inventé', () => {
    const company = (Company.of({ ...MERCIER_PROPS, vatRegime: 'franchise' }) as { ok: true; value: Company }).value;
    const inv = (Invoice.composeStandalone({ id: 'inv2', companyId: company.id, customerId: 'c' }) as { ok: true; value: Invoice }).value;
    inv.addLine({ id: 'l1', label: 'Prestation', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 });
    issueForFacturX(inv, 2);

    const data = facturXDataFromInvoice(inv, company, { name: 'Client', ...B2B_BUYER, address: { line1: 'x', zip: '75001', city: 'Paris' } });

    expect(data.taxTotalCents).toBe(0); // jamais de TVA en franchise
    expect(data.grandTotalCents).toBe(10000); // total = HT
    expect(data.duePayableCents).toBe(10000);
    expect(data.vatBreakdown).toHaveLength(1);
    const b0 = data.vatBreakdown[0]!;
    expect(b0).toEqual({
      category: 'E',
      ratePct: 0,
      vatCents: 0,
      basisCents: 10000,
      exemptionReasonCode: FR_VATEX_FRANCHISE,
    });
    expect(data.seller.vatId).toBeUndefined();
    expect(data.seller.fiscalId).toBe(company.siren);
    expect(data.lines[0]!).toMatchObject({ vatCategory: 'E', vatRatePct: 0 });
    const xml = buildFacturXBasicXml(data);
    expect(xml).toContain(`<ram:ID schemeID="FC">${company.siren}</ram:ID>`);
    expect(xml).toContain(`<ram:ExemptionReasonCode>${FR_VATEX_FRANCHISE}</ram:ExemptionReasonCode>`);
  });

  it('B8 : le numéro d’engagement porté par la facture voyage en BT-13 — absent sans bon de commande', () => {
    const company = seedCompany();
    const inv = (Invoice.composeStandalone({ id: 'inv-po', companyId: company.id, customerId: 'cust1' }) as { ok: true; value: Invoice }).value;
    inv.addLine({ id: 'l1', label: 'Pose chaudière', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 });
    const ref = makePurchaseOrderRef({ number: '4500123' });
    if (!ref.ok) throw new Error('Référence de bon de commande de test invalide.');
    const attached = inv.attachPurchaseOrder(ref.value, '2026-06-29T09:00:00Z');
    if (!attached.ok) throw new Error('Attachement de test refusé.');
    issueForFacturX(inv, 9);

    const data = facturXDataFromInvoice(inv, company, { name: 'RATP', ...B2B_BUYER, address: { line1: '54 quai de la Rapée', zip: '75012', city: 'Paris' } });
    expect(data.purchaseOrderReference).toBe('4500123');
    expect(buildFacturXBasicXml(data)).toContain('<ram:IssuerAssignedID>4500123</ram:IssuerAssignedID>');

    // Sans bon de commande : la référence n'est JAMAIS inventée.
    const bare = (Invoice.composeStandalone({ id: 'inv-sans-po', companyId: company.id, customerId: 'cust1' }) as { ok: true; value: Invoice }).value;
    bare.addLine({ id: 'l1', label: 'Joint', category: 'supply', qty: 1, unitPriceHT: 5000, vatRate: 10 });
    issueForFacturX(bare, 10);
    const bareData = facturXDataFromInvoice(bare, company, { name: 'Client', ...B2B_BUYER, address: { line1: 'x', zip: '75001', city: 'Paris' } });
    expect(bareData.purchaseOrderReference).toBeUndefined();
  });

  it('A7 : période de prestation + adresse de chantier figées à l’émission voyagent dans les données puis le XML', () => {
    const company = seedCompany();
    const inv = (Invoice.composeStandalone({ id: 'inv-a7', companyId: company.id, customerId: 'cust1' }) as { ok: true; value: Invoice }).value;
    inv.addLine({ id: 'l1', label: 'Rénovation SDB', category: 'labor', qty: 1, unitPriceHT: 180_000, vatRate: 20 });
    issueForFacturX(inv, 11, {
      servicePeriod: { start: '2026-06-02', end: '2026-06-13' },
      deliveryAddress: 'Chantier — 8 allée des Roses, 92190 Meudon',
    });

    const data = facturXDataFromInvoice(inv, company, { name: 'M. Bernard', ...B2B_BUYER, address: { line1: '8 allée des Roses', zip: '92190', city: 'Meudon' } });
    expect(data.servicePeriod).toEqual({ start: '2026-06-02', end: '2026-06-13' });
    expect(data.deliveryAddress).toBe('Chantier — 8 allée des Roses, 92190 Meudon');
    const xml = buildFacturXBasicXml(data);
    expect(xml).toContain('<ram:BillingSpecifiedPeriod>');
    expect(xml).toContain('<ram:LineOne>Chantier — 8 allée des Roses, 92190 Meudon</ram:LineOne>');

    // Jour unique : BT-72 émis, pas de BG-14.
    const single = (Invoice.composeStandalone({ id: 'inv-a7-jour', companyId: company.id, customerId: 'cust1' }) as { ok: true; value: Invoice }).value;
    single.addLine({ id: 'l1', label: 'Dépannage fuite', category: 'labor', qty: 1, unitPriceHT: 12_000, vatRate: 20 });
    issueForFacturX(single, 12, { servicePeriod: { start: '2026-06-02', end: null } });
    const singleXml = buildFacturXBasicXml(
      facturXDataFromInvoice(single, company, { name: 'Client', ...B2B_BUYER, address: { line1: 'x', zip: '75001', city: 'Paris' } }),
    );
    expect(singleXml).toContain('<ram:ActualDeliverySupplyChainEvent>');
    expect(singleXml).not.toContain('BillingSpecifiedPeriod');

    // Sans données A7 : AUCUN élément émis (null honnête des pièces legacy).
    const bare = (Invoice.composeStandalone({ id: 'inv-a7-bare', companyId: company.id, customerId: 'cust1' }) as { ok: true; value: Invoice }).value;
    bare.addLine({ id: 'l1', label: 'Joint', category: 'supply', qty: 1, unitPriceHT: 5000, vatRate: 10 });
    issueForFacturX(bare, 13);
    const bareData = facturXDataFromInvoice(bare, company, { name: 'Client', ...B2B_BUYER, address: { line1: 'x', zip: '75001', city: 'Paris' } });
    expect(bareData.servicePeriod).toBeUndefined();
    expect(bareData.deliveryAddress).toBeUndefined();
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
        ...B2B_BUYER,
        address: { line1: 'x', zip: '75001', city: 'Paris' },
      }),
    ).toThrowError('FACTURX_ISSUED_INVOICE_REQUIRED');
  });

  it('refuse de fabriquer un Flux 2 B2C : la vente consommateur relève du e-reporting', () => {
    const company = seedCompany();
    const inv = (Invoice.composeStandalone({
      id: 'inv-b2c',
      companyId: company.id,
      customerId: 'consumer-1',
    }) as { ok: true; value: Invoice }).value;
    inv.addLine({
      id: 'l1',
      label: 'Dépannage',
      category: 'labor',
      qty: 1,
      unitPriceHT: 10_000,
      vatRate: 20,
    });
    issueForFacturX(inv, 14);

    expect(() => facturXDataFromInvoice(inv, company, {
      name: 'Mme Durand',
      type: 'b2c',
      email: 'durand@example.fr',
      isInternational: false,
      isSubcontractingBtp: false,
      address: { line1: '12 rue des Lilas', zip: '92310', city: 'Sèvres' },
    })).toThrowError('FACTURX_B2C_EREPORTING_REQUIRED');
  });

  // —— A4 : autoliquidation sous-traitance BTP (art. 283, 2 nonies du CGI ; EN 16931 BR-AE) ——
  it('A4 — facture autoliquidée (BTP, b2b sous-traitance) : catégorie AE, mention 283, 2 nonies, TVA 0', () => {
    const company = seedCompany(); // plombier (BTP), régime réel
    const inv = (Invoice.composeStandalone({ id: 'inv-ae', companyId: company.id, customerId: 'cust-do' }) as { ok: true; value: Invoice }).value;
    // Taux 0 sur les lignes : c'est ce que suggestVatRate impose à la création d'une pièce autoliquidée.
    inv.addLine({ id: 'l1', label: 'Lot plomberie — sous-traitance', category: 'labor', qty: 1, unitPriceHT: 250_000, vatRate: 0 });
    inv.addLine({ id: 'l2', label: 'Fournitures incorporées', category: 'supply', qty: 1, unitPriceHT: 50_000, vatRate: 0 });
    issueForFacturX(inv, 20, { frenchBillingMode: 'S5' });

    const data = facturXDataFromInvoice(inv, company, {
      name: 'BTP Grand Œuvre (donneur d’ordre)',
      siren: '821503646',
      tvaIntracom: 'FR37821503646',
      type: 'b2b',
      isInternational: false,
      isSubcontractingBtp: true,
      address: { line1: 'ZA des Bruyères', zip: '92140', city: 'Clamart' },
    });

    // Lignes ET ventilation en AE, taux 0 (BR-AE-5), TVA 0 (BR-AE-8/9).
    expect(data.lines.every((l) => l.vatCategory === 'AE' && l.vatRatePct === 0)).toBe(true);
    expect(data.vatBreakdown).toHaveLength(1);
    const b0 = data.vatBreakdown[0]!;
    expect(b0).toMatchObject({ category: 'AE', ratePct: 0, vatCents: 0, basisCents: 300_000 });
    // BR-AE-10 : mention obligatoire, fondée sur l'art. 283, 2 nonies du CGI.
    expect(b0.exemptionReason).toContain('Autoliquidation');
    expect(b0.exemptionReason).toContain('283, 2 nonies');
    // Total TVA 0 : la pièce ne collecte JAMAIS de TVA, le preneur autoliquide.
    expect(data.taxTotalCents).toBe(0);
    expect(data.grandTotalCents).toBe(300_000);
    expect(data.duePayableCents).toBe(300_000);
    // BR-AE-2 : identifiants TVA réels du vendeur (BT-31) et du preneur (BT-48).
    expect(data.seller.vatId).toBeDefined();
    expect(data.buyer.vatId).toBe('FR37821503646');

    const xml = buildFacturXBasicXml(data);
    expect(xml).toContain('<ram:CategoryCode>AE</ram:CategoryCode>');
    expect(xml).toContain('<ram:ExemptionReason>Autoliquidation — art. 283, 2 nonies du CGI</ram:ExemptionReason>');
    expect(xml).toContain('<ram:TaxTotalAmount currencyID="EUR">0.00</ram:TaxTotalAmount>');
  });

  it('A4 — facture normale (b2b NON sous-traitant) : inchangée — catégories S, TVA facturée, jamais d’AE', () => {
    const company = seedCompany();
    const inv = (Invoice.composeStandalone({ id: 'inv-normale', companyId: company.id, customerId: 'cust-b2b' }) as { ok: true; value: Invoice }).value;
    inv.addLine({ id: 'l1', label: 'Entretien chaudière', category: 'labor', qty: 1, unitPriceHT: 20_000, vatRate: 20 });
    issueForFacturX(inv, 21);

    const data = facturXDataFromInvoice(inv, company, {
      name: 'Boulangerie Lefèvre',
      siren: '402118558',
      type: 'b2b',
      isInternational: false,
      isSubcontractingBtp: false,
      address: { line1: '3 place du Marché', zip: '92310', city: 'Sèvres' },
    });

    expect(data.lines[0]!).toMatchObject({ vatCategory: 'S', vatRatePct: 20 });
    expect(data.vatBreakdown).toEqual([{ category: 'S', ratePct: 20, basisCents: 20_000, vatCents: 4_000 }]);
    expect(data.taxTotalCents).toBe(4_000);
    expect(data.grandTotalCents).toBe(24_000);
    // Hors autoliquidation, le BT-48 du preneur n'est pas dérivé (comportement inchangé).
    expect(data.buyer.vatId).toBeUndefined();
    expect(buildFacturXBasicXml(data)).not.toContain('<ram:CategoryCode>AE</ram:CategoryCode>');
  });

  it('A4 — franchise en base PRIME sur l’autoliquidation : catégorie E + VATEX + FC, jamais AE', () => {
    // Un sous-traitant en franchise facture sous l'art. 293 B du CGI : il n'est pas concerné
    // par le dispositif d'autoliquidation (BOI-TVA-DECLA-10-10-20) — préséance de suggestVatRate.
    const company = (Company.of({ ...MERCIER_PROPS, vatRegime: 'franchise' }) as { ok: true; value: Company }).value;
    const inv = (Invoice.composeStandalone({ id: 'inv-fr-ae', companyId: company.id, customerId: 'cust-do' }) as { ok: true; value: Invoice }).value;
    inv.addLine({ id: 'l1', label: 'Lot plomberie — sous-traitance', category: 'labor', qty: 1, unitPriceHT: 100_000, vatRate: 0 });
    issueForFacturX(inv, 22);

    const data = facturXDataFromInvoice(inv, company, {
      name: 'BTP Grand Œuvre (donneur d’ordre)',
      siren: '821503646',
      type: 'b2b',
      isInternational: false,
      isSubcontractingBtp: true,
      address: { line1: 'ZA des Bruyères', zip: '92140', city: 'Clamart' },
    });

    expect(data.vatBreakdown).toHaveLength(1);
    expect(data.vatBreakdown[0]!).toEqual({
      category: 'E',
      ratePct: 0,
      vatCents: 0,
      basisCents: 100_000,
      exemptionReasonCode: FR_VATEX_FRANCHISE,
    });
    expect(data.lines[0]!).toMatchObject({ vatCategory: 'E', vatRatePct: 0 });
    expect(data.seller.fiscalId).toBe(company.siren);
    expect(buildFacturXBasicXml(data)).not.toContain('<ram:CategoryCode>AE</ram:CategoryCode>');
  });

  // —— A4 : le régime FIGÉ à l'émission PRIME sur l'état courant (mutable) du client ——
  it('A4 — régime figé « standard » : un client flaggé sous-traitant APRÈS l’émission ne bascule jamais le XML en AE', () => {
    const company = seedCompany();
    const inv = (Invoice.composeStandalone({ id: 'inv-frozen', companyId: company.id, customerId: 'cust-do' }) as { ok: true; value: Invoice }).value;
    inv.addLine({ id: 'l1', label: 'Prestation', category: 'labor', qty: 1, unitPriceHT: 100_000, vatRate: 20 });
    issueForFacturX(inv, 30);
    // Émission sous régime standard, FIGÉ dans la pièce (IssueInvoice → Invoice.issue).
    const frozen = Invoice.rehydrate({ ...inv.toSnapshot(), vatTreatmentAtIssuance: 'standard' });
    // La fiche client est ENSUITE éditée : b2b + sous-traitance BTP. Le XML régénéré doit
    // rester identique à la pièce émise (TVA collectée), jamais AE/TVA 0.
    const data = facturXDataFromInvoice(frozen, company, {
      name: 'Client devenu sous-traitant',
      siren: '821503646',
      tvaIntracom: 'FR37821503646',
      type: 'b2b',
      isInternational: false,
      isSubcontractingBtp: true,
      address: { line1: 'x', zip: '75001', city: 'Paris' },
    });
    expect(data.lines.every((l) => l.vatCategory === 'S' && l.vatRatePct === 20)).toBe(true);
    expect(data.taxTotalCents).toBe(20_000);
    expect(buildFacturXBasicXml(data)).not.toContain('<ram:CategoryCode>AE</ram:CategoryCode>');
  });

  it('A4 — régime figé « autoliquidation » : une fiche repassée « non sous-traitant » ne réécrit pas la pièce AE', () => {
    const company = seedCompany();
    const inv = (Invoice.composeStandalone({ id: 'inv-frozen-ae', companyId: company.id, customerId: 'cust-do' }) as { ok: true; value: Invoice }).value;
    inv.addLine({ id: 'l1', label: 'Sous-traitance', category: 'labor', qty: 1, unitPriceHT: 100_000, vatRate: 0 });
    issueForFacturX(inv, 31);
    const frozen = Invoice.rehydrate({ ...inv.toSnapshot(), vatTreatmentAtIssuance: 'autoliquidation' });
    const data = facturXDataFromInvoice(frozen, company, {
      name: 'Donneur d’ordre',
      siren: '821503646',
      tvaIntracom: 'FR37821503646',
      type: 'b2b',
      isInternational: false,
      isSubcontractingBtp: false, // fiche éditée après coup
      address: { line1: 'x', zip: '75001', city: 'Paris' },
    });
    expect(data.vatBreakdown[0]!).toMatchObject({ category: 'AE', ratePct: 0, vatCents: 0 });
    expect(data.buyer.vatId).toBe('FR37821503646');
  });

  it('A4 — pièce legacy SANS régime figé : dérivation dynamique conservée (compat honnête)', () => {
    const company = seedCompany();
    const inv = (Invoice.composeStandalone({ id: 'inv-legacy', companyId: company.id, customerId: 'cust-do' }) as { ok: true; value: Invoice }).value;
    inv.addLine({ id: 'l1', label: 'Prestation', category: 'labor', qty: 1, unitPriceHT: 100_000, vatRate: 0 });
    issueForFacturX(inv, 32);
    expect(inv.vatTreatmentAtIssuance).toBeNull();
    const data = facturXDataFromInvoice(inv, company, {
      name: 'Donneur d’ordre',
      siren: '821503646',
      tvaIntracom: 'FR37821503646',
      type: 'b2b',
      isInternational: false,
      isSubcontractingBtp: true,
      address: { line1: 'x', zip: '75001', city: 'Paris' },
    });
    expect(data.vatBreakdown[0]!.category).toBe('AE');
  });
});

describe('facturXDataFromInvoice — remises B3 et situations B2', () => {
  it('facture remisée : lignes NETTES + BG-27, XML valide (BR-CO-10/13 tiennent)', () => {
    const company = seedCompany();
    const inv = (Invoice.composeStandalone({ id: 'inv-rem', companyId: company.id, customerId: 'cust1' }) as { ok: true; value: Invoice }).value;
    inv.addLine({ id: 'l1', label: 'Pose', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20, discount: { type: 'percent', value: 10 } });
    inv.addLine({ id: 'l2', label: 'Fourniture', category: 'supply', qty: 1, unitPriceHT: 50000, vatRate: 10 });
    const globalDiscount = inv.setGlobalDiscount({ type: 'amount', cents: 10000 });
    if (!globalDiscount.ok) throw new Error('remise globale de test invalide');
    issueForFacturX(inv, 90);

    const data = facturXDataFromInvoice(inv, company, { name: 'Client', ...B2B_BUYER, address: { line1: 'x', zip: '75001', city: 'Paris' } });
    // HT net : 150 000 − 10 000 (ligne) − 10 000 (globale) = 130 000, identique au domaine.
    expect(data.lineTotalHTCents).toBe(inv.totals().ht);
    const lineSum = data.lines.reduce((s, l) => s + l.netAmountCents, 0);
    expect(lineSum).toBe(data.lineTotalHTCents);
    // Chaque ligne remisée porte son allowance (remise de ligne + quote-part globale).
    const totalAllowance = data.lines.reduce((s, l) => s + (l.allowanceCents ?? 0), 0);
    expect(totalAllowance).toBe(20000);
    // Ventilation par taux = bases nettes.
    const basisSum = data.vatBreakdown.reduce((s, b) => s + b.basisCents, 0);
    expect(basisSum).toBe(data.taxBasisTotalCents);
    // Le garde-fou EN 16931 « Schematron lite » ne relève AUCUNE violation.
    const validation = validateFacturXBasic(data);
    expect(validation.violations).toEqual([]);
    // L'élément BG-27 est émis dans le XML.
    const xml = buildFacturXBasicXml(data);
    expect(xml).toContain('SpecifiedTradeAllowanceCharge');
    expect(xml).toContain('<udt:Indicator>false</udt:Indicator>');
  });
  it('situation de travaux : typeCode 380, montants d’avancement, XML valide', () => {
    const company = seedCompany();
    const q = Quote.compose({ id: 'q-fx', companyId: company.id, customerId: 'cust1', at: '2026-06-01T09:00:00Z' });
    if (!q.ok) throw new Error('quote');
    q.value.addLine({ id: 'l1', label: 'Gros œuvre', category: 'labor', qty: 1, unitPriceHT: 148000, vatRate: 10 });
    q.value.setRetenueGarantie(5);
    q.value.assignNumber(DocNumber.format('D', 2026, 90), '2026-06-01T09:00:00Z');
    q.value.send('2026-06-01T09:00:00Z');
    q.value.sign({ signerName: 'Martin', signedAt: '2026-06-01T09:00:00Z', method: 'remote_link', accepted: true }, '2026-06-01T09:00:00Z');
    const situation = Invoice.situationFromSignedQuote(q.value, 'inv-sit', { order: 1, targetHtCents: 44400 });
    if (!situation.ok) throw new Error('situation');
    issueForFacturX(situation.value, 91);

    const data = facturXDataFromInvoice(situation.value, company, { name: 'Client', ...B2B_BUYER, address: { line1: 'x', zip: '75001', city: 'Paris' } });
    expect(data.typeCode).toBe('380');
    expect(data.lineTotalHTCents).toBe(44400);
    expect(data.grandTotalCents).toBe(48840);
    // La retenue (2 442) diffère l'encaissement mais ne réduit jamais la créance BT-115.
    expect(situation.value.totals().netToPay).toBe(46398);
    expect(data.duePayableCents).toBe(48840);
    expect(data.prepaidCents).toBe(0);
    expect(data.notes).toContainEqual(expect.objectContaining({ subject: 'ABU' }));
    expect(validateFacturXBasic(data).violations).toEqual([]);
  });

  it('finale après situations : lignes résiduelles et toutes les références BG-3, sans faux BT-113', () => {
    const company = seedCompany();
    const q = Quote.compose({
      id: 'q-final-situations',
      companyId: company.id,
      customerId: 'cust-pro',
      at: '2026-06-01T09:00:00Z',
    });
    if (!q.ok) throw new Error('quote');
    q.value.addLine({
      id: 'l1',
      label: 'Marché plomberie',
      category: 'labor',
      qty: 1,
      unitPriceHT: 148_000,
      vatRate: 10,
    });
    q.value.assignNumber(DocNumber.format('D', 2026, 92), '2026-06-01T09:00:00Z');
    q.value.send('2026-06-01T09:00:00Z');
    q.value.sign(
      {
        signerName: 'Martin',
        signedAt: '2026-06-01T09:00:00Z',
        method: 'remote_link',
        accepted: true,
      },
      '2026-06-01T09:00:00Z',
    );
    const final = Invoice.fromSignedQuote(q.value, 'final', 'inv-final-situations', {
      depositDeduction: { amountCents: 48_840, invoiceId: null },
      situationDeductionCents: 48_840,
      situationBilledHtCents: 44_400,
      situationBilledByQuoteLineCents: { l1: 44_400 },
      precedingInvoices: [
        {
          invoiceId: 'sit-1',
          kind: 'situation',
          number: 'F-2026-0088',
          issuedAt: '2026-05-15',
        },
        {
          invoiceId: 'sit-2',
          kind: 'situation',
          number: 'F-2026-0090',
          issuedAt: '2026-06-15',
        },
      ],
    });
    if (!final.ok) throw new Error(`final: ${JSON.stringify(final.error)}`);
    issueForFacturX(final.value, 93, { frenchBillingMode: 'S3' });

    const data = facturXDataFromInvoice(final.value, company, {
      name: 'SARL Martin',
      ...B2B_BUYER,
      address: { line1: 'ZA des Bruyères', zip: '92140', city: 'Clamart' },
    });

    expect(data.lineTotalHTCents).toBe(103_600);
    expect(data.grandTotalCents).toBe(113_960);
    expect(data.prepaidCents).toBe(0);
    expect(data.duePayableCents).toBe(113_960);
    expect(data.precedingInvoiceReferences).toEqual([
      { number: 'F-2026-0088', issueDate: '2026-05-15' },
      { number: 'F-2026-0090', issueDate: '2026-06-15' },
    ]);
    const xml = buildFacturXBasicXml(data);
    expect(xml.match(/<ram:InvoiceReferencedDocument>/g)).toHaveLength(2);
    expect(validateFacturXBasic(data).violations).toEqual([]);
  });
});
