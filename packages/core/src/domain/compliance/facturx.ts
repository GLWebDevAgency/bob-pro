import { type Company } from '../company/company';
import { type CustomerType } from '../customer/customer';
import { type Invoice, type InvoiceKind } from '../billing/invoice/invoice';
import { computeLineBases } from '../services/compute-totals';

/**
 * Factur-X — facture électronique hybride (PDF/A-3 + XML CII embarqué), profil BASIC.
 * Le XML est conforme EN 16931 (urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic).
 * Construit de façon déterministe à partir des agrégats du domaine — aucune dépendance infra.
 */

export const FACTURX_BASIC_PROFILE = 'urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic';

/** Catégorie de TVA EN 16931 (UNCL5305) : S=normal, E=exonéré, Z=taux zéro,
 *  AE=autoliquidation preneur (reverse charge, art. 283-2 nonies CGI — C-EXP6b réception). */
export type VatCategory = 'S' | 'E' | 'Z' | 'AE';

export interface FacturXParty {
  name: string;
  legalId?: string; // SIREN (BT-30), schemeID 0002 (registre SIRENE)
  vatId?: string; // n° TVA intracom (BT-31, schemeID VA) — omis en franchise
  address: { line1: string; postcode: string; city: string; countryCode: string };
}

export interface FacturXLine {
  id: string;
  name: string;
  qty: number;
  unitCode: string; // UNECE Rec 20 (C62 = unité)
  unitPriceHTCents: number;
  netAmountCents: number; // total HT NET de la ligne (remises B3 déduites)
  /**
   * B3 — remise de la ligne (BG-27, ChargeIndicator false) : remise de ligne + quote-part de
   * remise globale allouée (même politique que computeLineBases). BR-24 : le montant net de
   * ligne = qty × prix − allowance — sans cet élément, un XML remisé serait incohérent.
   * Absent/0 = aucune remise, aucun élément émis.
   */
  allowanceCents?: number;
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
  /** BT-13 — numéro d'engagement du bon de commande client (B8) : les grands comptes et
   * Chorus Pro lisent la donnée STRUCTURÉE (BuyerOrderReferencedDocument), jamais le PDF. */
  purchaseOrderReference?: string;
  /**
   * A7 — date/période de la prestation figée à l'émission (art. 242 nonies A, I-8° annexe II
   * CGI). `end` null = jour unique → BT-72 (date de livraison effective,
   * ActualDeliverySupplyChainEvent) ; `end` non null = période → BG-14 (BT-73/BT-74,
   * BillingSpecifiedPeriod). Absent = non renseignée, aucun élément émis.
   */
  servicePeriod?: { start: string; end: string | null };
  /**
   * A7 — adresse de chantier/livraison si distincte de la facturation → BG-13 (ShipToTradeParty)
   * avec l'adresse libre en BT-75 (LineOne) et le pays BT-80 (obligatoire dans BG-15) = FR.
   * Absent = adresse de facturation, aucun élément émis.
   */
  deliveryAddress?: string;
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

/**
 * A4 — mention d'autoliquidation portée en BT-120 (ExemptionReason) pour la catégorie AE :
 * • fondement fiscal : art. 283, 2 nonies du CGI (sous-traitance BTP — la TVA est acquittée
 *   par le preneur assujetti) ;
 * • mention « Autoliquidation » obligatoire sur la facture : art. 242 nonies A, I-13° de
 *   l'annexe II au CGI ;
 * • exigence EN 16931 : BR-AE-10 (une ventilation AE DOIT porter un motif d'exonération).
 */
const FR_AUTOLIQUIDATION_283_2_NONIES = 'Autoliquidation — art. 283, 2 nonies du CGI';

const KIND_TO_TYPECODE: Record<InvoiceKind, string> = {
  final: '380',
  deposit: '386',
  credit_note: '381',
  situation: '380',
};

// ——— Helpers de formatage (purs) ———
const eur = (cents: number): string => (cents / 100).toFixed(2);
const pct = (rate: number): string => rate.toFixed(2);
const qtyStr = (q: number): string => (Number.isInteger(q) ? String(q) : q.toFixed(4).replace(/\.?0+$/, ''));
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
    // B3 — remise de ligne (BG-27) : ChargeIndicator false + montant réel — le montant net de
    // ligne (BT-131) reste cohérent avec qty × prix (BR-24), et le total HT du document avec
    // la somme des lignes nettes (BR-CO-10).
    if (line.allowanceCents !== undefined && line.allowanceCents > 0) {
      L.push('        <ram:SpecifiedTradeAllowanceCharge>');
      L.push('          <ram:ChargeIndicator>');
      L.push('            <udt:Indicator>false</udt:Indicator>');
      L.push('          </ram:ChargeIndicator>');
      L.push(`          <ram:ActualAmount>${eur(line.allowanceCents)}</ram:ActualAmount>`);
      L.push('          <ram:Reason>Remise</ram:Reason>');
      L.push('        </ram:SpecifiedTradeAllowanceCharge>');
    }
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
  // BT-13 (BuyerOrderReferencedDocument) : le numéro d'engagement voyage dans le champ
  // structuré — sans lui, le dépôt Chorus Pro / AP grand compte rejette ou suspend la facture.
  if (d.purchaseOrderReference) {
    L.push('      <ram:BuyerOrderReferencedDocument>');
    L.push(`        <ram:IssuerAssignedID>${xmlEscape(d.purchaseOrderReference)}</ram:IssuerAssignedID>`);
    L.push('      </ram:BuyerOrderReferencedDocument>');
  }
  L.push('    </ram:ApplicableHeaderTradeAgreement>');

  // Livraison — vide par défaut (BASIC). A7 y insère, dans l'ordre CII (ShipToTradeParty puis
  // ActualDeliverySupplyChainEvent) : l'adresse de chantier/livraison (BG-13, texte libre en
  // BT-75/LineOne + pays BT-80 obligatoire) et la date de livraison/prestation effective (BT-72)
  // pour une prestation d'UN jour (end null). Une PÉRIODE va en BG-14 (règlement, plus bas).
  const period = d.servicePeriod;
  const singleDayDelivery = period && period.end === null ? period.start : null;
  if (d.deliveryAddress || singleDayDelivery) {
    L.push('    <ram:ApplicableHeaderTradeDelivery>');
    if (d.deliveryAddress) {
      L.push('      <ram:ShipToTradeParty>');
      L.push('        <ram:PostalTradeAddress>');
      L.push(`          <ram:LineOne>${xmlEscape(d.deliveryAddress)}</ram:LineOne>`);
      L.push('          <ram:CountryID>FR</ram:CountryID>');
      L.push('        </ram:PostalTradeAddress>');
      L.push('      </ram:ShipToTradeParty>');
    }
    if (singleDayDelivery) {
      L.push('      <ram:ActualDeliverySupplyChainEvent>');
      L.push('        <ram:OccurrenceDateTime>');
      L.push(`          <udt:DateTimeString format="102">${dateCII(singleDayDelivery)}</udt:DateTimeString>`);
      L.push('        </ram:OccurrenceDateTime>');
      L.push('      </ram:ActualDeliverySupplyChainEvent>');
    }
    L.push('    </ram:ApplicableHeaderTradeDelivery>');
  } else {
    L.push('    <ram:ApplicableHeaderTradeDelivery />');
  }

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
  // A7 — BG-14 (BT-73/BT-74) : période de facturation quand la prestation s'étend sur PLUSIEURS
  // jours (end non null). Un jour unique est déjà porté par BT-72 (livraison, ci-dessus).
  // Position CII : après ApplicableTradeTax, avant SpecifiedTradePaymentTerms (EN 16931, CII).
  if (period && period.end !== null) {
    L.push('      <ram:BillingSpecifiedPeriod>');
    L.push('        <ram:StartDateTime>');
    L.push(`          <udt:DateTimeString format="102">${dateCII(period.start)}</udt:DateTimeString>`);
    L.push('        </ram:StartDateTime>');
    L.push('        <ram:EndDateTime>');
    L.push(`          <udt:DateTimeString format="102">${dateCII(period.end)}</udt:DateTimeString>`);
    L.push('        </ram:EndDateTime>');
    L.push('      </ram:BillingSpecifiedPeriod>');
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
  /**
   * A4 — faits fiscaux du preneur, lus de l'agrégat Customer (jamais déduits ici) : ils pilotent
   * l'autoliquidation via Company.requiresAutoliquidation (BTP + b2b + sous-traitance,
   * art. 283, 2 nonies du CGI). Champs REQUIS : chaque appelant doit énoncer l'état réel du
   * client — aucun défaut implicite qui ferait retomber en silence une pièce autoliquidée
   * dans la catégorie Z/S (TVA facturée à tort).
   */
  type: CustomerType;
  isSubcontractingBtp: boolean;
}

/**
 * Assemble les données Factur-X depuis les agrégats du domaine.
 * Arithmétique alignée au centime sur computeTotals (BR-CO-10/13/15/16 d'EN 16931).
 */
export function facturXDataFromInvoice(invoice: Invoice, company: Company, buyer: FacturXBuyer): FacturXInvoiceData {
  // Une facture électronique est une pièce fiscale émise. Ne jamais compléter une facture
  // brouillon avec un numéro ou une date sentinelle : ces valeurs finiraient dans le XML comme
  // si elles provenaient de la comptabilité du tenant. Les appelants API contrôlent déjà cet
  // invariant ; cette seconde barrière protège aussi les futurs adapters et scripts.
  if (invoice.number === null || invoice.issuedAt === null) {
    throw new Error('FACTURX_ISSUED_INVOICE_REQUIRED');
  }
  const number = invoice.number;
  const issueDate = invoice.issuedAt;
  const totals = invoice.totals();
  // A4 — le régime de TVA est lu EN PRIORITÉ depuis le fait FIGÉ à l'émission
  // (Invoice.vatTreatmentAtIssuance, constaté par IssueInvoice dans la transaction d'émission,
  // repris de la source pour un avoir) : le XML régénéré plus tard reste identique à la pièce
  // émise même si la fiche client (type, isSubcontractingBtp) ou la société a changé depuis —
  // jamais deux représentations fiscales divergentes de la MÊME pièce. Fallback honnête pour
  // les pièces émises AVANT le figeage : dérivation dynamique historique.
  const frozenTreatment = invoice.vatTreatmentAtIssuance;
  const franchise =
    frozenTreatment !== null ? frozenTreatment === 'franchise' : company.isVatFranchise();
  // Autoliquidation de la TVA en sous-traitance BTP (art. 283, 2 nonies du CGI) : la pièce est
  // émise SANS TVA et porte la catégorie AE (EN 16931, BR-AE-1 à BR-AE-10) — le preneur
  // autoliquide. La franchise en base PRIME : le sous-traitant en franchise facture sous
  // l'art. 293 B (catégorie E), il n'est pas concerné par le dispositif d'autoliquidation
  // (BOI-TVA-DECLA-10-10-20) — même préséance que suggestVatRate et IssueInvoice.
  const autoliquidation =
    frozenTreatment !== null
      ? frozenTreatment === 'autoliquidation'
      : !franchise
        && company.requiresAutoliquidation({ type: buyer.type, isSubcontractingBtp: buyer.isSubcontractingBtp });

  // Lignes : en franchise, la TVA est inapplicable -> catégorie E, taux 0 (BR-E-5) ;
  // en autoliquidation -> catégorie AE, taux 0 (BR-AE-5).
  // B3 — bases NETTES par ligne (remise de ligne + quote-part de remise globale, MÊME politique
  // d'allocation que computeTotals) : le XML porte les montants réellement facturés — sans quoi
  // BR-CO-10 (somme des lignes = total HT) serait violée sur toute pièce remisée.
  const { netLineBases } = computeLineBases(invoice.lines, { globalDiscount: invoice.globalDiscount });
  const lines: FacturXLine[] = invoice.lines.map((l, i) => {
    const gross = Math.round(l.qty * l.unitPriceHT);
    const net = netLineBases[i] ?? gross;
    return {
      id: l.id || String(i + 1),
      name: l.label,
      qty: l.qty,
      unitCode: 'C62',
      unitPriceHTCents: l.unitPriceHT,
      netAmountCents: net,
      ...(gross - net > 0 ? { allowanceCents: gross - net } : {}),
      vatCategory: franchise ? 'E' : autoliquidation ? 'AE' : l.vatRate > 0 ? 'S' : 'Z',
      vatRatePct: franchise || autoliquidation ? 0 : l.vatRate,
    };
  });

  let vatBreakdown: FacturXVatBreakdown[];
  let taxTotalCents: number;
  let grandTotalCents: number;
  let duePayableCents: number;

  if (franchise) {
    // Franchise en base : un seul groupe E, taux 0, TVA 0 (BR-E-5/6/9). Total = HT, jamais de TVA.
    vatBreakdown = [{ category: 'E', ratePct: 0, basisCents: totals.ht, vatCents: 0, exemptionReason: FR_293B }];
    taxTotalCents = 0;
    grandTotalCents = totals.ht;
    duePayableCents = totals.ttc > 0 ? Math.round((totals.ht * totals.netToPay) / totals.ttc) : totals.ht;
  } else if (autoliquidation) {
    // A4 — autoliquidation : un seul groupe AE, taux 0, TVA 0 (BR-AE-5/8/9), mention
    // « Autoliquidation » obligatoire en BT-120 (BR-AE-10 ; art. 242 nonies A, I-13° de
    // l'annexe II au CGI). Total = HT : la TVA est déclarée par le preneur (art. 283,
    // 2 nonies du CGI), jamais collectée par l'émetteur.
    vatBreakdown = [
      { category: 'AE', ratePct: 0, basisCents: totals.ht, vatCents: 0, exemptionReason: FR_AUTOLIQUIDATION_283_2_NONIES },
    ];
    taxTotalCents = 0;
    grandTotalCents = totals.ht;
    duePayableCents = totals.ttc > 0 ? Math.round((totals.ht * totals.netToPay) / totals.ttc) : totals.ht;
  } else {
    // Base HT par taux (somme des bases NETTES par ligne, identique au domaine — B3 : l'assiette
    // de TVA est prise APRÈS remises, cf. computeTotals). VAT depuis totals().
    const basisByRate = new Map<number, number>();
    for (const [i, l] of invoice.lines.entries()) {
      const base = netLineBases[i] ?? Math.round(l.qty * l.unitPriceHT);
      basisByRate.set(l.vatRate, (basisByRate.get(l.vatRate) ?? 0) + base);
    }
    vatBreakdown = [...basisByRate.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([rate, basis]) => ({
        category: rate > 0 ? ('S' as VatCategory) : ('Z' as VatCategory),
        ratePct: rate,
        basisCents: basis,
        vatCents: totals.vatByRate[String(rate)] ?? 0,
      }));
    taxTotalCents = totals.vat;
    grandTotalCents = totals.ttc;
    duePayableCents = totals.netToPay;
  }

  const sellerVatId = franchise ? undefined : frenchVatNumber(company.siren);
  const seller: FacturXParty = {
    name: company.name,
    legalId: company.siren, // BT-30 : SIREN (9 chiffres) sous schemeID 0002 (registre SIRENE)
    ...(sellerVatId ? { vatId: sellerVatId } : {}),
    address: { line1: company.address.line1, postcode: company.address.zip, city: company.address.city, countryCode: 'FR' },
  };
  const buyerParty: FacturXParty = {
    name: buyer.name,
    ...(buyer.siren ? { legalId: buyer.siren } : {}),
    // BR-AE-2 : une pièce portant la catégorie AE DOIT identifier le preneur par son n° de TVA
    // (BT-48). Dérivation déterministe depuis le SIREN français (même algorithme que BT-31 côté
    // vendeur) — jamais inventé. Depuis la garde A4, IssueInvoice REFUSE d'émettre une pièce
    // autoliquidée sans SIREN preneur : un BT-48 absent ici ne peut venir que d'une pièce émise
    // avant la garde (legacy) ou d'un rendu dynamique — la violation reste alors visible via
    // validateFacturXBasic (exécuté à l'import), jamais masquée.
    ...(autoliquidation && buyer.siren ? { vatId: frenchVatNumber(buyer.siren) } : {}),
    address: { line1: buyer.address.line1, postcode: buyer.address.zip, city: buyer.address.city, countryCode: 'FR' },
  };

  return {
    number,
    typeCode: KIND_TO_TYPECODE[invoice.kind],
    issueDate,
    ...(invoice.dueAt ? { dueDate: invoice.dueAt } : {}),
    currency: 'EUR',
    // B8 — BT-13 : le numéro d'engagement porté par la facture (repris du devis) est émis dans
    // le XML structuré, à l'identique de la mention PDF. Jamais inventé : absent sans BC.
    ...(invoice.purchaseOrder !== null ? { purchaseOrderReference: invoice.purchaseOrder.number } : {}),
    // A7 — période de prestation (BT-72 jour unique / BG-14 période) et adresse de chantier
    // (BG-13) figées à l'émission par le domaine (Invoice.issue) — jamais complétées ici.
    ...(invoice.servicePeriod !== null ? { servicePeriod: invoice.servicePeriod } : {}),
    ...(invoice.deliveryAddress !== null ? { deliveryAddress: invoice.deliveryAddress } : {}),
    seller,
    buyer: buyerParty,
    lines,
    vatBreakdown,
    lineTotalHTCents: totals.ht,
    taxBasisTotalCents: totals.ht,
    taxTotalCents,
    grandTotalCents,
    prepaidCents: Math.max(0, grandTotalCents - duePayableCents),
    duePayableCents,
  };
}
