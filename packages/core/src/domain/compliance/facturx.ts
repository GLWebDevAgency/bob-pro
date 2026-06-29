import { type Company } from '../company/company';
import { type Invoice, type InvoiceKind } from '../billing/invoice/invoice';

/**
 * Factur-X — facture électronique hybride (PDF/A-3 + XML CII embarqué), profil BASIC.
 * Le XML est conforme EN 16931 (urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic).
 * Construit de façon déterministe à partir des agrégats du domaine — aucune dépendance infra.
 */

export const FACTURX_BASIC_PROFILE = 'urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic';

/** Catégorie de TVA EN 16931 (UNCL5305) : S=normal, E=exonéré, Z=taux zéro. */
export type VatCategory = 'S' | 'E' | 'Z';

export interface FacturXParty {
  name: string;
  legalId?: string; // SIRET (BT-30), schemeID 0002
  vatId?: string; // n° TVA intracom (BT-31, schemeID VA) — omis en franchise
  address: { line1: string; postcode: string; city: string; countryCode: string };
}

export interface FacturXLine {
  id: string;
  name: string;
  qty: number;
  unitCode: string; // UNECE Rec 20 (C62 = unité)
  unitPriceHTCents: number;
  netAmountCents: number; // total HT de la ligne
  vatCategory: VatCategory;
  vatRatePct: number;
}

export interface FacturXVatBreakdown {
  category: VatCategory;
  ratePct: number;
  basisCents: number;
  vatCents: number;
  exemptionReason?: string;
}

export interface FacturXInvoiceData {
  number: string;
  typeCode: string; // 380 facture, 381 avoir, 386 acompte
  issueDate: string; // YYYY-MM-DD
  dueDate?: string;
  currency: string; // EUR
  buyerReference?: string;
  seller: FacturXParty;
  buyer: FacturXParty;
  lines: FacturXLine[];
  vatBreakdown: FacturXVatBreakdown[];
  lineTotalHTCents: number;
  taxBasisTotalCents: number;
  taxTotalCents: number;
  grandTotalCents: number;
  prepaidCents: number;
  duePayableCents: number;
}

const FR_293B = 'TVA non applicable, art. 293 B du CGI';

const KIND_TO_TYPECODE: Record<InvoiceKind, string> = {
  final: '380',
  deposit: '386',
  credit_note: '381',
  situation: '380',
};

// ——— Helpers de formatage (purs) ———
const eur = (cents: number): string => (cents / 100).toFixed(2);
const pct = (rate: number): string => rate.toFixed(2);
const qtyStr = (q: number): string => (Number.isInteger(q) ? String(q) : String(q));
const dateCII = (d: string): string => d.replace(/-/g, ''); // YYYY-MM-DD -> YYYYMMDD (format 102)

const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** N° de TVA intracommunautaire français : FR + clé(2) + SIREN(9). */
export function frenchVatNumber(siren: string): string {
  const n = Number(siren);
  const key = (12 + 3 * (n % 97)) % 97;
  return `FR${String(key).padStart(2, '0')}${siren}`;
}

function partyXml(tag: string, p: FacturXParty): string[] {
  const out: string[] = [`      <ram:${tag}>`, `        <ram:Name>${xmlEscape(p.name)}</ram:Name>`];
  if (p.legalId) {
    out.push(
      '        <ram:SpecifiedLegalOrganization>',
      `          <ram:ID schemeID="0002">${xmlEscape(p.legalId)}</ram:ID>`,
      '        </ram:SpecifiedLegalOrganization>',
    );
  }
  out.push(
    '        <ram:PostalTradeAddress>',
    `          <ram:PostcodeCode>${xmlEscape(p.address.postcode)}</ram:PostcodeCode>`,
    `          <ram:LineOne>${xmlEscape(p.address.line1)}</ram:LineOne>`,
    `          <ram:CityName>${xmlEscape(p.address.city)}</ram:CityName>`,
    `          <ram:CountryID>${xmlEscape(p.address.countryCode)}</ram:CountryID>`,
    '        </ram:PostalTradeAddress>',
  );
  if (p.vatId) {
    out.push(
      '        <ram:SpecifiedTaxRegistration>',
      `          <ram:ID schemeID="VA">${xmlEscape(p.vatId)}</ram:ID>`,
      '        </ram:SpecifiedTaxRegistration>',
    );
  }
  out.push(`      </ram:${tag}>`);
  return out;
}

/** Sérialise les données en XML CII (profil BASIC), bien formé et échappé. */
export function buildFacturXBasicXml(d: FacturXInvoiceData): string {
  const L: string[] = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push(
    '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">',
  );

  // Contexte : profil BASIC
  L.push('  <rsm:ExchangedDocumentContext>');
  L.push('    <ram:GuidelineSpecifiedDocumentContextParameter>');
  L.push(`      <ram:ID>${FACTURX_BASIC_PROFILE}</ram:ID>`);
  L.push('    </ram:GuidelineSpecifiedDocumentContextParameter>');
  L.push('  </rsm:ExchangedDocumentContext>');

  // En-tête du document
  L.push('  <rsm:ExchangedDocument>');
  L.push(`    <ram:ID>${xmlEscape(d.number)}</ram:ID>`);
  L.push(`    <ram:TypeCode>${d.typeCode}</ram:TypeCode>`);
  L.push('    <ram:IssueDateTime>');
  L.push(`      <udt:DateTimeString format="102">${dateCII(d.issueDate)}</udt:DateTimeString>`);
  L.push('    </ram:IssueDateTime>');
  L.push('  </rsm:ExchangedDocument>');

  L.push('  <rsm:SupplyChainTradeTransaction>');

  // Lignes (BASIC)
  for (const line of d.lines) {
    L.push('    <ram:IncludedSupplyChainTradeLineItem>');
    L.push('      <ram:AssociatedDocumentLineDocument>');
    L.push(`        <ram:LineID>${xmlEscape(line.id)}</ram:LineID>`);
    L.push('      </ram:AssociatedDocumentLineDocument>');
    L.push('      <ram:SpecifiedTradeProduct>');
    L.push(`        <ram:Name>${xmlEscape(line.name)}</ram:Name>`);
    L.push('      </ram:SpecifiedTradeProduct>');
    L.push('      <ram:SpecifiedLineTradeAgreement>');
    L.push('        <ram:NetPriceProductTradePrice>');
    L.push(`          <ram:ChargeAmount>${eur(line.unitPriceHTCents)}</ram:ChargeAmount>`);
    L.push('        </ram:NetPriceProductTradePrice>');
    L.push('      </ram:SpecifiedLineTradeAgreement>');
    L.push('      <ram:SpecifiedLineTradeDelivery>');
    L.push(`        <ram:BilledQuantity unitCode="${xmlEscape(line.unitCode)}">${qtyStr(line.qty)}</ram:BilledQuantity>`);
    L.push('      </ram:SpecifiedLineTradeDelivery>');
    L.push('      <ram:SpecifiedLineTradeSettlement>');
    L.push('        <ram:ApplicableTradeTax>');
    L.push('          <ram:TypeCode>VAT</ram:TypeCode>');
    L.push(`          <ram:CategoryCode>${line.vatCategory}</ram:CategoryCode>`);
    L.push(`          <ram:RateApplicablePercent>${pct(line.vatRatePct)}</ram:RateApplicablePercent>`);
    L.push('        </ram:ApplicableTradeTax>');
    L.push('        <ram:SpecifiedTradeSettlementLineMonetarySummation>');
    L.push(`          <ram:LineTotalAmount>${eur(line.netAmountCents)}</ram:LineTotalAmount>`);
    L.push('        </ram:SpecifiedTradeSettlementLineMonetarySummation>');
    L.push('      </ram:SpecifiedLineTradeSettlement>');
    L.push('    </ram:IncludedSupplyChainTradeLineItem>');
  }

  // Accord (vendeur / acheteur)
  L.push('    <ram:ApplicableHeaderTradeAgreement>');
  if (d.buyerReference) L.push(`      <ram:BuyerReference>${xmlEscape(d.buyerReference)}</ram:BuyerReference>`);
  L.push(...partyXml('SellerTradeParty', d.seller));
  L.push(...partyXml('BuyerTradeParty', d.buyer));
  L.push('    </ram:ApplicableHeaderTradeAgreement>');

  // Livraison (vide en BASIC)
  L.push('    <ram:ApplicableHeaderTradeDelivery />');

  // Règlement
  L.push('    <ram:ApplicableHeaderTradeSettlement>');
  L.push(`      <ram:InvoiceCurrencyCode>${d.currency}</ram:InvoiceCurrencyCode>`);
  for (const b of d.vatBreakdown) {
    L.push('      <ram:ApplicableTradeTax>');
    L.push(`        <ram:CalculatedAmount>${eur(b.vatCents)}</ram:CalculatedAmount>`);
    L.push('        <ram:TypeCode>VAT</ram:TypeCode>');
    if (b.exemptionReason) L.push(`        <ram:ExemptionReason>${xmlEscape(b.exemptionReason)}</ram:ExemptionReason>`);
    L.push(`        <ram:BasisAmount>${eur(b.basisCents)}</ram:BasisAmount>`);
    L.push(`        <ram:CategoryCode>${b.category}</ram:CategoryCode>`);
    L.push(`        <ram:RateApplicablePercent>${pct(b.ratePct)}</ram:RateApplicablePercent>`);
    L.push('      </ram:ApplicableTradeTax>');
  }
  if (d.dueDate) {
    L.push('      <ram:SpecifiedTradePaymentTerms>');
    L.push('        <ram:DueDateDateTime>');
    L.push(`          <udt:DateTimeString format="102">${dateCII(d.dueDate)}</udt:DateTimeString>`);
    L.push('        </ram:DueDateDateTime>');
    L.push('      </ram:SpecifiedTradePaymentTerms>');
  }
  L.push('      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>');
  L.push(`        <ram:LineTotalAmount>${eur(d.lineTotalHTCents)}</ram:LineTotalAmount>`);
  L.push(`        <ram:TaxBasisTotalAmount>${eur(d.taxBasisTotalCents)}</ram:TaxBasisTotalAmount>`);
  L.push(`        <ram:TaxTotalAmount currencyID="${d.currency}">${eur(d.taxTotalCents)}</ram:TaxTotalAmount>`);
  L.push(`        <ram:GrandTotalAmount>${eur(d.grandTotalCents)}</ram:GrandTotalAmount>`);
  if (d.prepaidCents > 0) L.push(`        <ram:TotalPrepaidAmount>${eur(d.prepaidCents)}</ram:TotalPrepaidAmount>`);
  L.push(`        <ram:DuePayableAmount>${eur(d.duePayableCents)}</ram:DuePayableAmount>`);
  L.push('      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>');
  L.push('    </ram:ApplicableHeaderTradeSettlement>');

  L.push('  </rsm:SupplyChainTradeTransaction>');
  L.push('</rsm:CrossIndustryInvoice>');
  return L.join('\n');
}

export interface FacturXBuyer {
  name: string;
  siren?: string;
  address: { line1: string; zip: string; city: string };
}

/**
 * Assemble les données Factur-X depuis les agrégats du domaine.
 * Arithmétique alignée au centime sur computeTotals (BR-CO-10/13/15/16 d'EN 16931).
 */
export function facturXDataFromInvoice(invoice: Invoice, company: Company, buyer: FacturXBuyer): FacturXInvoiceData {
  const totals = invoice.totals();
  const franchise = company.isVatFranchise();
  const categoryFor = (rate: number): VatCategory => (franchise ? 'E' : rate > 0 ? 'S' : 'Z');

  // Base HT par taux (somme arrondie par ligne, identique au domaine).
  const basisByRate = new Map<number, number>();
  for (const l of invoice.lines) {
    const base = Math.round(l.qty * l.unitPriceHT);
    basisByRate.set(l.vatRate, (basisByRate.get(l.vatRate) ?? 0) + base);
  }

  const lines: FacturXLine[] = invoice.lines.map((l, i) => ({
    id: l.id || String(i + 1),
    name: l.label,
    qty: l.qty,
    unitCode: 'C62',
    unitPriceHTCents: l.unitPriceHT,
    netAmountCents: Math.round(l.qty * l.unitPriceHT),
    vatCategory: categoryFor(l.vatRate),
    vatRatePct: l.vatRate,
  }));

  const vatBreakdown: FacturXVatBreakdown[] = [...basisByRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, basis]) => {
      const cat = categoryFor(rate);
      const entry: FacturXVatBreakdown = {
        category: cat,
        ratePct: rate,
        basisCents: basis,
        vatCents: totals.vatByRate[String(rate)] ?? 0,
      };
      if (cat === 'E') entry.exemptionReason = FR_293B;
      return entry;
    });

  const sellerVatId = franchise ? undefined : frenchVatNumber(company.siren);
  const seller: FacturXParty = {
    name: company.name,
    legalId: company.siret,
    ...(sellerVatId ? { vatId: sellerVatId } : {}),
    address: { line1: company.address.line1, postcode: company.address.zip, city: company.address.city, countryCode: 'FR' },
  };
  const buyerParty: FacturXParty = {
    name: buyer.name,
    ...(buyer.siren ? { legalId: buyer.siren } : {}),
    address: { line1: buyer.address.line1, postcode: buyer.address.zip, city: buyer.address.city, countryCode: 'FR' },
  };

  const prepaid = Math.max(0, totals.ttc - totals.netToPay);
  return {
    number: invoice.number ?? 'BROUILLON',
    typeCode: KIND_TO_TYPECODE[invoice.kind],
    issueDate: invoice.issuedAt ?? '1970-01-01',
    ...(invoice.dueAt ? { dueDate: invoice.dueAt } : {}),
    currency: 'EUR',
    seller,
    buyer: buyerParty,
    lines,
    vatBreakdown,
    lineTotalHTCents: totals.ht,
    taxBasisTotalCents: totals.ht,
    taxTotalCents: totals.vat,
    grandTotalCents: totals.ttc,
    prepaidCents: prepaid,
    duePayableCents: totals.netToPay,
  };
}
