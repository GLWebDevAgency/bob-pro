import { describe, it, expect } from 'vitest';
import {
  FACTURX_BASIC_PROFILE,
  FACTURX_EN16931_PROFILE,
  FR_VATEX_FRANCHISE,
  buildFacturXBasicXml,
  type FacturXInvoiceData,
} from './facturx';
import { parseFacturXBasic } from './parse-facturx';
import type { DomainResult } from '../../shared-kernel/result';

/** Assert un échec VALIDATION et renvoie l'erreur restreinte (narrowing pour `.field`). */
function expectValidationError(result: DomainResult<FacturXInvoiceData>): { code: 'VALIDATION'; field: string; message: string } {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('attendu err');
  if (result.error.code !== 'VALIDATION') throw new Error(`attendu VALIDATION, obtenu ${result.error.code}`);
  return result.error;
}

/** Facture riche : 3 lignes, 2 taux (20 % + 10 %), échéance, buyerReference, vendeur SIREN+TVA. */
const richData = (): FacturXInvoiceData => ({
  number: 'F-2026-0042',
  typeCode: '380',
  issueDate: '2026-03-15',
  dueDate: '2026-04-14',
  currency: 'EUR',
  billingMode: 'M1',
  buyerReference: 'BC-2026-778',
  purchaseOrderReference: 'PO-0042',
  servicePeriod: { start: '2026-03-01', end: '2026-03-14' },
  deliveryAddress: 'Chantier 4, 2 rue des Travaux',
  notes: [
    { subject: 'PMT', content: 'Indemnité réelle' },
    { subject: 'PMD', content: 'Pénalités réelles' },
    { subject: 'AAB', content: 'Escompte réel' },
    { subject: 'BAR', content: 'B2B' },
  ],
  seller: {
    name: 'Élec & Réseaux SARL',
    legalId: '552100554',
    vatId: 'FR40552100554',
    electronicAddress: { schemeId: '0225', value: '552100554' },
    address: { line1: "8 rue de l'Église", postcode: '69003', city: 'Lyon', countryCode: 'FR' },
  },
  buyer: {
    name: 'Mairie de Sèvres',
    legalId: '217800000',
    electronicAddress: { schemeId: '0225', value: '217800000' },
    address: { line1: '54 Grande Rue', postcode: '92310', city: 'Sèvres', countryCode: 'FR' },
  },
  lines: [
    { id: '1', name: 'Prestation <installation>', qty: 3, unitCode: 'C62', unitPriceHTCents: 12000, netAmountCents: 35000, allowanceCents: 1000, vatCategory: 'S', vatRatePct: 20 },
    { id: '2', name: 'Fournitures & câbles', qty: 1.5, unitCode: 'MTK', unitPriceHTCents: 4000, netAmountCents: 6000, vatCategory: 'S', vatRatePct: 10 },
    { id: '3', name: 'Maintenance', qty: 2, unitCode: 'C62', unitPriceHTCents: 2500, netAmountCents: 5000, vatCategory: 'S', vatRatePct: 20 },
  ],
  vatBreakdown: [
    { category: 'S', ratePct: 10, basisCents: 6000, vatCents: 600 },
    { category: 'S', ratePct: 20, basisCents: 40000, vatCents: 8000 },
  ],
  lineTotalHTCents: 46000,
  taxBasisTotalCents: 46000,
  taxTotalCents: 8600,
  grandTotalCents: 54600,
  prepaidCents: 0,
  duePayableCents: 54600,
});

/** Avoir en franchise 293 B : catégorie E, motif d'exonération, acompte encaissé (prepaid > 0), sans échéance. */
const franchiseData = (): FacturXInvoiceData => ({
  number: 'A-2026-0003',
  typeCode: '381',
  issueDate: '2026-01-05',
  currency: 'EUR',
  billingMode: 'S2',
  seller: {
    name: 'Consultant Solo',
    legalId: '900123456',
    address: { line1: '2 impasse Verte', postcode: '31000', city: 'Toulouse', countryCode: 'FR' },
  },
  buyer: {
    name: 'Client Particulier',
    address: { line1: '9 bd Central', postcode: '33000', city: 'Bordeaux', countryCode: 'FR' },
  },
  lines: [
    { id: '1', name: 'Conseil', qty: 1, unitCode: 'C62', unitPriceHTCents: 50000, netAmountCents: 50000, vatCategory: 'E', vatRatePct: 0 },
  ],
  vatBreakdown: [
    {
      category: 'E',
      ratePct: 0,
      basisCents: 50000,
      vatCents: 0,
      exemptionReason: 'TVA non applicable, art. 293 B du CGI',
      exemptionReasonCode: FR_VATEX_FRANCHISE,
    },
  ],
  lineTotalHTCents: 50000,
  taxBasisTotalCents: 50000,
  taxTotalCents: 0,
  grandTotalCents: 50000,
  prepaidCents: 20000,
  duePayableCents: 30000,
});

describe('parseFacturXBasic — émission EN16931 et compatibilité BASIC historique', () => {
  it('reconstruit une facture riche (2 taux, échéance, réf. acheteur) à l’identique', () => {
    const data = richData();
    const xml = buildFacturXBasicXml(data);
    expect(xml).toContain(`<ram:ID>${FACTURX_EN16931_PROFILE}</ram:ID>`);
    expect(xml).not.toContain(FACTURX_BASIC_PROFILE);
    const result = parseFacturXBasic(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value).toEqual(data);
  });

  it('conserve toutes les références BG-3 d’une finale après situations', () => {
    const data: FacturXInvoiceData = {
      ...richData(),
      precedingInvoiceReferences: [
        { number: 'F-2026-0010', issueDate: '2026-03-01' },
        { number: 'F-2026-0018', issueDate: '2026-03-10' },
      ],
    };
    const result = parseFacturXBasic(buildFacturXBasicXml(data));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value).toEqual(data);
  });

  it('reconstruit un avoir en franchise (catégorie E, motif d’exonération, acompte, sans échéance) à l’identique', () => {
    const data = {
      ...franchiseData(),
      precedingInvoiceReference: { number: 'F-2025-0099', issueDate: '2025-12-20' },
    };
    const result = parseFacturXBasic(buildFacturXBasicXml(data));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value).toEqual(data);
  });

  it('reconstruit une pièce hors champ O sans inventer un taux de TVA', () => {
    const base = richData();
    const { vatId: _sellerVatId, ...sellerWithoutVat } = base.seller;
    const data: FacturXInvoiceData = {
      ...base,
      seller: sellerWithoutVat,
      lines: [
        {
          id: '1',
          name: 'Débours',
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
          exemptionReason: 'Hors champ de TVA',
          exemptionReasonCode: 'VATEX-EU-O',
        },
      ],
      lineTotalHTCents: 2500,
      taxBasisTotalCents: 2500,
      taxTotalCents: 0,
      grandTotalCents: 2500,
      prepaidCents: 0,
      duePayableCents: 2500,
    };

    const result = parseFacturXBasic(buildFacturXBasicXml(data));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value).toEqual(data);
    expect(result.value.lines[0]?.vatRatePct).toBeUndefined();
  });

  it('préserve l’échappement XML (caractères &, <, > et apostrophe)', () => {
    const data = richData();
    const xml = buildFacturXBasicXml(data);
    expect(xml).toContain('Prestation &lt;installation&gt;');
    expect(xml).toContain('Fournitures &amp; câbles');
    const result = parseFacturXBasic(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.lines[0]?.name).toBe('Prestation <installation>');
    expect(result.value.lines[1]?.name).toBe('Fournitures & câbles');
    expect(result.value.seller.name).toBe('Élec & Réseaux SARL');
    expect(result.value.seller.address.line1).toBe("8 rue de l'Église");
  });

  it('accepte le profil BASIC uniquement en lecture d’une pièce historique', () => {
    const historicBasic = buildFacturXBasicXml(richData()).replace(
      FACTURX_EN16931_PROFILE,
      FACTURX_BASIC_PROFILE,
    );
    const result = parseFacturXBasic(historicBasic);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.number).toBe('F-2026-0042');
  });

  it('résout les noms par URI avec des préfixes alternatifs hérités', () => {
    const data: FacturXInvoiceData = {
      ...richData(),
      precedingInvoiceReference: { number: 'F-2026-0030', issueDate: '2026-03-01' },
    };
    const aliasedXml = buildFacturXBasicXml(data)
      .replace('xmlns:rsm=', 'xmlns:cii=')
      .replace('xmlns:ram=', 'xmlns:agg=')
      .replace('xmlns:udt=', 'xmlns:date=')
      .replace('xmlns:qdt=', 'xmlns:qualified=')
      .replaceAll('rsm:', 'cii:')
      .replaceAll('ram:', 'agg:')
      .replaceAll('udt:', 'date:')
      .replaceAll('qdt:', 'qualified:');

    expect(aliasedXml).toContain('xmlns:cii=');
    expect(aliasedXml).toContain('<agg:SpecifiedTradeProduct>');
    expect(aliasedXml).toContain('<date:DateTimeString');
    expect(aliasedXml).toContain('<qualified:DateTimeString');
    const parsed = parseFacturXBasic(aliasedXml);
    expect(parsed).toEqual({ ok: true, value: data });
  });

  it('accepte le namespace CII par défaut sans confondre les éléments RAM', () => {
    const data = richData();
    const defaultNamespaceXml = buildFacturXBasicXml(data)
      .replace(
        '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"',
        '<CrossIndustryInvoice xmlns="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"',
      )
      .replaceAll('<rsm:', '<')
      .replaceAll('</rsm:', '</');

    const parsed = parseFacturXBasic(defaultNamespaceXml);
    expect(parsed).toEqual({ ok: true, value: data });
  });
});

describe('parseFacturXBasic — XML BASIC historique écrit à la main', () => {
  // XML réaliste rédigé à la main (indentation irrégulière, retours de ligne), NON généré.
  const handwritten = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
      xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
      xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
      xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>FA-2026-0100</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
        <udt:DateTimeString format="102">20260630</udt:DateTimeString>
    </ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>Dépannage plomberie</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>90.00</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="C62">2</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>S</ram:CategoryCode>
          <ram:RateApplicablePercent>20.00</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>180.00</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>SERVICE-ACHATS</ram:BuyerReference>
      <ram:SellerTradeParty>
        <ram:Name>Plomberie Durand</ram:Name>
        <ram:SpecifiedLegalOrganization>
          <ram:ID schemeID="0002">732829320</ram:ID>
        </ram:SpecifiedLegalOrganization>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>75011</ram:PostcodeCode>
          <ram:LineOne>3 rue du Faubourg</ram:LineOne>
          <ram:CityName>Paris</ram:CityName>
          <ram:CountryID>FR</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">FR32732829320</ram:ID>
        </ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>Restaurant Le Coin</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>75012</ram:PostcodeCode>
          <ram:LineOne>10 av Daumesnil</ram:LineOne>
          <ram:CityName>Paris</ram:CityName>
          <ram:CountryID>FR</ram:CountryID>
        </ram:PostalTradeAddress>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery />
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>36.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>180.00</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>20.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">20260730</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>180.00</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>180.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">36.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>216.00</ram:GrandTotalAmount>
        <ram:DuePayableAmount>216.00</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

  it('extrait tous les champs d’un XML BASIC rédigé à la main', () => {
    const result = parseFacturXBasic(handwritten);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value).toEqual({
      number: 'FA-2026-0100',
      typeCode: '380',
      issueDate: '2026-06-30',
      dueDate: '2026-07-30',
      currency: 'EUR',
      buyerReference: 'SERVICE-ACHATS',
      seller: {
        name: 'Plomberie Durand',
        legalId: '732829320',
        vatId: 'FR32732829320',
        address: { line1: '3 rue du Faubourg', postcode: '75011', city: 'Paris', countryCode: 'FR' },
      },
      buyer: {
        name: 'Restaurant Le Coin',
        address: { line1: '10 av Daumesnil', postcode: '75012', city: 'Paris', countryCode: 'FR' },
      },
      lines: [
        { id: '1', name: 'Dépannage plomberie', qty: 2, unitCode: 'C62', unitPriceHTCents: 9000, netAmountCents: 18000, vatCategory: 'S', vatRatePct: 20 },
      ],
      vatBreakdown: [{ category: 'S', ratePct: 20, basisCents: 18000, vatCents: 3600 }],
      lineTotalHTCents: 18000,
      taxBasisTotalCents: 18000,
      taxTotalCents: 3600,
      grandTotalCents: 21600,
      prepaidCents: 0,
      duePayableCents: 21600,
    });
  });

  it('n’expose PAS de vatId côté acheteur (jamais émis pour l’acheteur)', () => {
    const result = parseFacturXBasic(handwritten);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.buyer.legalId).toBeUndefined();
    expect(result.value.buyer.vatId).toBeUndefined();
  });
});

describe('parseFacturXBasic — cas d’erreur (Result err, jamais de throw ni d’objet partiel)', () => {
  it('rejette une chaîne vide', () => {
    expect(expectValidationError(parseFacturXBasic('')).field).toBe('xml');
  });

  it('rejette un espace seul', () => {
    expect(expectValidationError(parseFacturXBasic('   \n  ')).field).toBe('xml');
  });

  it('rejette un XML bien formé mais sans rsm:CrossIndustryInvoice', () => {
    expect(expectValidationError(parseFacturXBasic('<?xml version="1.0"?><foo><bar>x</bar></foo>')).field).toBe('profile');
  });

  it('rejette le bon nom local sous une mauvaise URI de namespace', () => {
    const xml = buildFacturXBasicXml(richData()).replace(
      'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
      'urn:example:spoofed:CrossIndustryInvoice:100',
    );
    const error = expectValidationError(parseFacturXBasic(xml));
    expect(error.field).toBe('profile');
    expect(error.message).toContain('urn:example:spoofed');
  });

  it('rejette un profil hors EN16931/BASIC historique', () => {
    const xml = buildFacturXBasicXml(richData()).replace(
      FACTURX_EN16931_PROFILE,
      'urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:extended',
    );
    expect(expectValidationError(parseFacturXBasic(xml)).field).toBe('profile');
  });

  it('rejette M7, absent de BR-FR-08 v1.4, sans maintenir une seconde liste locale', () => {
    const xml = buildFacturXBasicXml(richData()).replace(
      '<ram:ID>M1</ram:ID>',
      '<ram:ID>M7</ram:ID>',
    );
    expect(expectValidationError(parseFacturXBasic(xml)).field).toBe('BT-23');
  });

  it('accepte un cadre ajouté par BR-FR-08 v1.4', () => {
    const data = { ...richData(), billingMode: 'M9' as const };
    const parsed = parseFacturXBasic(buildFacturXBasicXml(data));
    expect(parsed).toEqual({ ok: true, value: data });
  });

  it('rejette un montant non numérique', () => {
    const xml = buildFacturXBasicXml(richData()).replace(
      '<ram:GrandTotalAmount>546.00</ram:GrandTotalAmount>',
      '<ram:GrandTotalAmount>abc</ram:GrandTotalAmount>',
    );
    expect(expectValidationError(parseFacturXBasic(xml)).field).toBe('BT-112');
  });

  it('rejette une date invalide (mois 13 au format 102)', () => {
    const xml = buildFacturXBasicXml(richData()).replace(
      '<udt:DateTimeString format="102">20260315</udt:DateTimeString>',
      '<udt:DateTimeString format="102">20261315</udt:DateTimeString>',
    );
    expect(expectValidationError(parseFacturXBasic(xml)).field).toBe('BT-2');
  });

  it('rejette une balise obligatoire absente (numéro de facture)', () => {
    const xml = buildFacturXBasicXml(richData()).replace('<ram:ID>F-2026-0042</ram:ID>', '');
    expect(expectValidationError(parseFacturXBasic(xml)).field).toBe('BT-1');
  });

  it('rejette un XML syntaxiquement malformé (balises non équilibrées)', () => {
    const xml = '<rsm:CrossIndustryInvoice><ram:ID>x</rsm:CrossIndustryInvoice>';
    expect(expectValidationError(parseFacturXBasic(xml)).field).toBe('xml');
  });

  it('rejette explicitement un DOCTYPE avec entité externe avant toute expansion', () => {
    const xml = buildFacturXBasicXml(richData()).replace(
      '?>',
      '?><!DOCTYPE rsm:CrossIndustryInvoice [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
    );
    const error = expectValidationError(parseFacturXBasic(xml));
    expect(error.field).toBe('xml');
    expect(error.message).toContain('DOCTYPE interdit');
  });

  it('rejette explicitement une déclaration ENTITY isolée', () => {
    const xml = buildFacturXBasicXml(richData()).replace(
      '?>',
      '?><!ENTITY xxe SYSTEM "https://example.invalid/secret">',
    );
    const error = expectValidationError(parseFacturXBasic(xml));
    expect(error.field).toBe('xml');
    expect(error.message).toContain('ENTITY interdite');
  });

  it('rejette une référence d’entité nommée inconnue sans DTD', () => {
    const xml = buildFacturXBasicXml(richData()).replace('Élec &amp; Réseaux SARL', '&xxe;');
    const error = expectValidationError(parseFacturXBasic(xml));
    expect(error.field).toBe('xml');
    expect(error.message).toContain('entité XML non autorisée');
  });

  it('rejette une catégorie de TVA inconnue', () => {
    const xml = buildFacturXBasicXml(franchiseData()).replace(
      '<ram:CategoryCode>E</ram:CategoryCode>',
      '<ram:CategoryCode>X</ram:CategoryCode>',
    );
    expect(expectValidationError(parseFacturXBasic(xml)).code).toBe('VALIDATION');
  });
});
