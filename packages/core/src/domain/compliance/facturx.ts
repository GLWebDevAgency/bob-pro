import { type Company } from '../company/company';
import { type CustomerType } from '../customer/customer';
import { type Invoice, type InvoiceKind } from '../billing/invoice/invoice';
import { computeLineBases } from '../services/compute-totals';
import { billingUnitToUneceCode } from './billing-unit';
import type { FrenchBillingMode } from './french-billing-mode';

/**
 * Factur-X — facture électronique hybride (PDF/A-3 + XML CII embarqué), profil EN16931.
 * Le profil BASIC reste accepté par le parseur pour les archives historiques ; toute nouvelle
 * émission Bob porte le profil complet EN16931, cohérent avec les lignes détaillées produites.
 * Construit de façon déterministe à partir des agrégats du domaine — aucune dépendance infra.
 */

export const FACTURX_BASIC_PROFILE = 'urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic';
export const FACTURX_EN16931_PROFILE = 'urn:cen.eu:en16931:2017';

/** Catégorie de TVA EN 16931 (UNCL5305) : S=normal, E=exonéré, Z=taux zéro,
 * AE=autoliquidation preneur et O=hors champ de TVA. */
export type VatCategory = 'S' | 'E' | 'Z' | 'AE' | 'O';

/** Identifiant de routage électronique EN 16931 (BT-34 vendeur / BT-49 acheteur).
 *  `0225` = SIREN français (EAS), `EM` = adresse e-mail réelle. */
export interface FacturXElectronicAddress {
  schemeId: '0225' | 'EM';
  value: string;
}

/** Notes structurées attendues par le CIUS français 2026 (BG-1 / BT-21 / BT-22). */
export type FacturXNoteSubject = 'PMT' | 'PMD' | 'AAB' | 'BAR' | 'ABU';

export interface FacturXNote {
  /** Le générateur France utilise FacturXNoteSubject ; le parseur entrant conserve aussi les
   *  autres codes UNCL4451 sans les réinterpréter ni les perdre. */
  subject: string;
  content: string;
}

/** BT-23 — cas d'usage de facturation du CIUS France 2026. Le générateur Bob n'en
 * dérive qu'un sous-ensemble prouvé par les faits du domaine ; le parseur conserve
 * aussi les cas valides qu'il peut recevoir d'un tiers. */
export type FacturXBillingMode = FrenchBillingMode;

export interface FacturXParty {
  name: string;
  legalId?: string; // SIREN (BT-30), schemeID 0002 (registre SIRENE)
  vatId?: string; // n° TVA intracom (BT-31, schemeID VA) — omis en franchise
  /** BT-32 identifiant fiscal vendeur, schemeID FC. Utilisé en franchise avec le SIREN réel
   * pour satisfaire BR-Z-02 sans fabriquer un numéro de TVA. */
  fiscalId?: string;
  electronicAddress?: FacturXElectronicAddress;
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
  /** BT-152 est interdit pour la catégorie O (EN 16931 BR-O-05). */
  vatRatePct?: number;
}

export interface FacturXVatBreakdown {
  category: VatCategory;
  /** BT-119 est absent pour la catégorie O ; un zéro explicite serait non conforme. */
  ratePct?: number;
  basisCents: number;
  vatCents: number;
  exemptionReason?: string;
  /** BT-121 — code de motif d'exonération (liste VATEX). Le texte BT-120 ne peut pas se
   * substituer aux codes rendus obligatoires par le CIUS France. */
  exemptionReasonCode?: string;
}

export interface FacturXInvoiceData {
  number: string;
  typeCode: string; // 380 facture, 381 avoir, 386 acompte
  issueDate: string; // YYYY-MM-DD
  dueDate?: string;
  currency: string; // EUR
  /** BT-23 — mode de facturation France. Obligatoire sur toute émission Bob à
   * compter de la réforme ; optionnel ici pour pouvoir importer les archives
   * BASIC historiques qui ne le portaient pas. */
  billingMode?: FacturXBillingMode;
  /** Notes légales figées avec la pièce. Absentes uniquement pour un XML entrant/legacy qui
   *  ne les contenait pas ; le mapping d'émission français les fournit systématiquement. */
  notes?: FacturXNote[];
  buyerReference?: string;
  /** BT-13 — numéro d'engagement du bon de commande client (B8) : les grands comptes et
   * Chorus Pro lisent la donnée STRUCTURÉE (BuyerOrderReferencedDocument), jamais le PDF. */
  purchaseOrderReference?: string;
  /** BG-3 / BT-25 / BT-26 — forme historique singulière, conservée pour les avoirs/imports. */
  precedingInvoiceReference?: { number: string; issueDate?: string };
  /** BG-3 répétable — toutes les pièces antérieures d'une finale après situations, dans un
   * ordre déterministe. Exclusif de `precedingInvoiceReference`. */
  precedingInvoiceReferences?: { number: string; issueDate?: string }[];
  /**
   * A7 — date/période de la prestation figée à l'émission (art. 242 nonies A, I-8° annexe II
   * CGI). `end` null = jour unique → BT-72 (date de livraison effective,
   * ActualDeliverySupplyChainEvent) ; `end` non null = période → BG-14 (BT-73/BT-74,
   * BillingSpecifiedPeriod) ET BT-72 = date de fin réelle. Absent = la date de
   * pièce est la date d'opération contractuelle et alimente BT-72.
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

/**
 * A4 — mention d'autoliquidation portée en BT-120 (ExemptionReason) pour la catégorie AE :
 * • fondement fiscal : art. 283, 2 nonies du CGI (sous-traitance BTP — la TVA est acquittée
 *   par le preneur assujetti) ;
 * • mention « Autoliquidation » obligatoire sur la facture : art. 242 nonies A, I-13° de
 *   l'annexe II au CGI ;
 * • exigence EN 16931 : BR-AE-10 (une ventilation AE DOIT porter un motif d'exonération).
 */
const FR_AUTOLIQUIDATION_283_2_NONIES = 'Autoliquidation — art. 283, 2 nonies du CGI';
export const FR_VATEX_FRANCHISE = 'VATEX-FR-FRANCHISE';
export const VATEX_EU_NOT_SUBJECT_TO_VAT = 'VATEX-EU-O';
export const FR_DISBURSEMENT_OUTSIDE_VAT_SCOPE =
  'Hors champ de TVA — débours payés au nom et pour le compte du client (art. 267, II-2° du CGI).';

const KIND_TO_TYPECODE: Record<InvoiceKind, string> = {
  final: '380',
  deposit: '386',
  credit_note: '381',
  situation: '380',
};

/** UNTDID 1001 : un avoir annulant une facture d'acompte est un « debit note related to
 * financial adjustments » 503 dans Factur-X, et non l'avoir commercial générique 381.
 * La nature de la source est un fait figé dans l'agrégat : aucune heuristique de libellé. */
function facturXTypeCode(invoice: Invoice): string {
  if (invoice.kind === 'credit_note' && invoice.creditNoteSource?.kind === 'deposit') return '503';
  return KIND_TO_TYPECODE[invoice.kind];
}

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
  if (p.electronicAddress) {
    out.push(
      '        <ram:URIUniversalCommunication>',
      `          <ram:URIID schemeID="${p.electronicAddress.schemeId}">${xmlEscape(p.electronicAddress.value)}</ram:URIID>`,
      '        </ram:URIUniversalCommunication>',
    );
  }
  if (p.vatId) {
    out.push(
      '        <ram:SpecifiedTaxRegistration>',
      `          <ram:ID schemeID="VA">${xmlEscape(p.vatId)}</ram:ID>`,
      '        </ram:SpecifiedTaxRegistration>',
    );
  }
  if (p.fiscalId) {
    out.push(
      '        <ram:SpecifiedTaxRegistration>',
      `          <ram:ID schemeID="FC">${xmlEscape(p.fiscalId)}</ram:ID>`,
      '        </ram:SpecifiedTaxRegistration>',
    );
  }
  out.push(`      </ram:${tag}>`);
  return out;
}

/** Sérialise les données en XML CII EN16931, bien formé et échappé.
 *
 * Le nom public historique est conservé temporairement pour ne pas casser les consommateurs ;
 * son contrat d'émission est désormais EN16931. Il sera renommé lors d'un changement majeur.
 */
export function buildFacturXBasicXml(d: FacturXInvoiceData): string {
  const L: string[] = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push(
    '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100">',
  );

  // Contexte : profil EN16931 (les lignes détaillées Bob dépassent le besoin BASIC).
  L.push('  <rsm:ExchangedDocumentContext>');
  if (d.billingMode) {
    L.push('    <ram:BusinessProcessSpecifiedDocumentContextParameter>');
    L.push(`      <ram:ID>${d.billingMode}</ram:ID>`);
    L.push('    </ram:BusinessProcessSpecifiedDocumentContextParameter>');
  }
  L.push('    <ram:GuidelineSpecifiedDocumentContextParameter>');
  L.push(`      <ram:ID>${FACTURX_EN16931_PROFILE}</ram:ID>`);
  L.push('    </ram:GuidelineSpecifiedDocumentContextParameter>');
  L.push('  </rsm:ExchangedDocumentContext>');

  // En-tête du document
  L.push('  <rsm:ExchangedDocument>');
  L.push(`    <ram:ID>${xmlEscape(d.number)}</ram:ID>`);
  L.push(`    <ram:TypeCode>${d.typeCode}</ram:TypeCode>`);
  L.push('    <ram:IssueDateTime>');
  L.push(`      <udt:DateTimeString format="102">${dateCII(d.issueDate)}</udt:DateTimeString>`);
  L.push('    </ram:IssueDateTime>');
  for (const note of d.notes ?? []) {
    L.push('    <ram:IncludedNote>');
    L.push(`      <ram:Content>${xmlEscape(note.content)}</ram:Content>`);
    L.push(`      <ram:SubjectCode>${xmlEscape(note.subject)}</ram:SubjectCode>`);
    L.push('    </ram:IncludedNote>');
  }
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
    if (line.vatRatePct !== undefined) {
      L.push(`          <ram:RateApplicablePercent>${pct(line.vatRatePct)}</ram:RateApplicablePercent>`);
    }
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

  // Livraison. Le schéma CII exige ce groupe et PEPPOL-EN16931-R008 refuse un groupe vide.
  // La date portée est toujours un FAIT : fin de période confirmée, jour unique confirmé, ou
  // date d'émission lorsque le contrat métier dit explicitement « servicePeriod absente = date
  // de la pièce comme date d'opération ». Une adresse de chantier libre ne récupère JAMAIS le
  // CP/la ville de facturation : ce mélange fabriquerait une adresse qui n'a jamais été saisie.
  const period = d.servicePeriod;
  const actualDeliveryDate = period ? (period.end ?? period.start) : d.issueDate;
  L.push('    <ram:ApplicableHeaderTradeDelivery>');
  if (d.deliveryAddress) {
    L.push('      <ram:ShipToTradeParty>');
    L.push(`        <ram:Name>${xmlEscape(d.buyer.name)}</ram:Name>`);
    L.push('        <ram:PostalTradeAddress>');
    L.push(`          <ram:LineOne>${xmlEscape(d.deliveryAddress)}</ram:LineOne>`);
    L.push('          <ram:CountryID>FR</ram:CountryID>');
    L.push('        </ram:PostalTradeAddress>');
    L.push('      </ram:ShipToTradeParty>');
  }
  L.push('      <ram:ActualDeliverySupplyChainEvent>');
  L.push('        <ram:OccurrenceDateTime>');
  L.push(`          <udt:DateTimeString format="102">${dateCII(actualDeliveryDate)}</udt:DateTimeString>`);
  L.push('        </ram:OccurrenceDateTime>');
  L.push('      </ram:ActualDeliverySupplyChainEvent>');
  L.push('    </ram:ApplicableHeaderTradeDelivery>');

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
    if (b.exemptionReasonCode) {
      L.push(`        <ram:ExemptionReasonCode>${xmlEscape(b.exemptionReasonCode)}</ram:ExemptionReasonCode>`);
    }
    if (b.ratePct !== undefined) {
      L.push(`        <ram:RateApplicablePercent>${pct(b.ratePct)}</ram:RateApplicablePercent>`);
    }
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
  const precedingReferences = d.precedingInvoiceReferences
    ?? (d.precedingInvoiceReference === undefined ? [] : [d.precedingInvoiceReference]);
  for (const reference of precedingReferences) {
    L.push('      <ram:InvoiceReferencedDocument>');
    L.push(
      `        <ram:IssuerAssignedID>${xmlEscape(reference.number)}</ram:IssuerAssignedID>`,
    );
    if (reference.issueDate) {
      L.push('        <ram:FormattedIssueDateTime>');
      L.push(
        `          <qdt:DateTimeString format="102">${dateCII(reference.issueDate)}</qdt:DateTimeString>`,
      );
      L.push('        </ram:FormattedIssueDateTime>');
    }
    L.push('      </ram:InvoiceReferencedDocument>');
  }
  L.push('    </ram:ApplicableHeaderTradeSettlement>');

  L.push('  </rsm:SupplyChainTradeTransaction>');
  L.push('</rsm:CrossIndustryInvoice>');
  return L.join('\n');
}

export interface FacturXBuyer {
  name: string;
  siren?: string;
  email?: string;
  /** N° TVA réel du preneur, confirmé dans la fiche. Jamais calculé depuis le SIREN. */
  tvaIntracom?: string;
  address: { line1: string; zip: string; city: string };
  /**
   * A4 — faits fiscaux du preneur, lus de l'agrégat Customer (jamais déduits ici) : ils pilotent
   * l'autoliquidation via Company.requiresAutoliquidation (BTP + b2b + sous-traitance,
   * art. 283, 2 nonies du CGI). Champs REQUIS : chaque appelant doit énoncer l'état réel du
   * client — aucun défaut implicite qui ferait retomber en silence une pièce autoliquidée
   * dans la catégorie Z/S (TVA facturée à tort).
   */
  type: CustomerType;
  isInternational: boolean;
  isSubcontractingBtp: boolean;
}

const FR_EARLY_PAYMENT_DISCOUNT_NONE = 'Escompte pour paiement anticipé : néant.';
const FR_B2B_LATE_PAYMENT =
  'Pénalités de retard : taux BCE + 10 points (art. L441-10 du code de commerce).';
const FR_B2B_RECOVERY_FEE =
  'Indemnité forfaitaire de recouvrement : 40 € (art. D441-5 du code de commerce).';
const FR_B2B_COMBINED = `${FR_B2B_LATE_PAYMENT} ${FR_B2B_RECOVERY_FEE}`;
const FR_B2G_LATE_PAYMENT = 'Intérêts moratoires : taux BCE + 8 points.';
const FR_B2G_RECOVERY_FEE =
  'Indemnité forfaitaire de recouvrement : 40 € (art. L2192-12 et L2192-13 du code de la commande publique).';
const FR_B2G_COMBINED = `${FR_B2G_LATE_PAYMENT} ${FR_B2G_RECOVERY_FEE}`;

/**
 * Transforme les mentions FIGÉES de la facture en notes structurées du CIUS France.
 * Pour un professionnel, une mention historique absente est une donnée légale manquante : on
 * refuse le XML au lieu de la recalculer depuis une fiche client éditable. Pour un particulier,
 * le domaine ne prévoit ni pénalités professionnelles ni indemnité L441-10 ; cette
 * non-applicabilité est un fait dérivé du type de client, tandis que l'absence d'escompte est
 * vraie tant qu'aucun dispositif d'escompte n'existe dans l'agrégat Invoice.
 */
function frenchInvoiceNotes(invoice: Invoice, buyer: FacturXBuyer): FacturXNote[] {
  const bar = buyer.type === 'b2c' ? 'B2C' : buyer.isInternational ? 'B2BINT' : 'B2B';
  const retention = invoice.totals().retenueGarantieCents ?? 0;
  const retentionNote: FacturXNote[] = retention > 0
    ? [
        {
          subject: 'ABU',
          content:
            `Retenue de garantie : ${eur(retention)} EUR. Cette créance reste due ; ` +
            'son règlement est différé selon les conditions du marché.',
        },
      ]
    : [];
  if (buyer.type === 'b2c') {
    return [
      { subject: 'PMT', content: 'Frais de recouvrement professionnels : non applicables au client particulier.' },
      { subject: 'PMD', content: 'Pénalités de retard professionnelles : non applicables au client particulier.' },
      { subject: 'AAB', content: FR_EARLY_PAYMENT_DISCOUNT_NONE },
      { subject: 'BAR', content: bar },
      ...retentionNote,
    ];
  }

  const combined = buyer.type === 'b2g' ? FR_B2G_COMBINED : FR_B2B_COMBINED;
  if (!invoice.mentions.includes(FR_EARLY_PAYMENT_DISCOUNT_NONE) || !invoice.mentions.includes(combined)) {
    throw new Error('FACTURX_FROZEN_FRENCH_LEGAL_NOTES_REQUIRED');
  }
  return [
    {
      subject: 'PMT',
      content: buyer.type === 'b2g' ? FR_B2G_RECOVERY_FEE : FR_B2B_RECOVERY_FEE,
    },
    {
      subject: 'PMD',
      content: buyer.type === 'b2g' ? FR_B2G_LATE_PAYMENT : FR_B2B_LATE_PAYMENT,
    },
    { subject: 'AAB', content: FR_EARLY_PAYMENT_DISCOUNT_NONE },
    { subject: 'BAR', content: bar },
    ...retentionNote,
  ];
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
  // Les ventes aux particuliers relèvent du e-reporting et conservent un original PDF. Elles
  // ne doivent jamais être transformées en Flux 2 en inventant un endpoint acheteur BT-49.
  if (buyer.type === 'b2c') {
    throw new Error('FACTURX_B2C_EREPORTING_REQUIRED');
  }
  const number = invoice.number;
  const issueDate = invoice.issuedAt;
  const totals = invoice.totals();
  // Les anciennes finales déduisaient les pièces sœurs en pied de facture puis les déclaraient
  // comme BT-113 « déjà payé ». Tant que la reprise structurée par lignes/références n'existe
  // pas, aucun XML potentiellement faux ne sort : la facture PDF reste consultable et le cas
  // est explicitement bloqué au canal structuré.
  if (invoice.advanceDeductionCents > 0) {
    throw new Error('FACTURX_STRUCTURED_PRIOR_INVOICE_RECOVERY_REQUIRED');
  }
  if (!buyer.siren) {
    throw new Error('FACTURX_PROFESSIONAL_BUYER_SIREN_REQUIRED');
  }
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
  const allDisbursement =
    invoice.lines.length > 0 && invoice.lines.every((line) => line.category === 'disbursement');
  const hasMixedDisbursement =
    invoice.lines.some((line) => line.category === 'disbursement') && !allDisbursement;
  if (hasMixedDisbursement) throw new Error('FACTURX_MIXED_DISBURSEMENT_UNSUPPORTED');
  if (allDisbursement && invoice.lines.some((line) => line.vatRate !== 0)) {
    throw new Error('FACTURX_DISBURSEMENT_VAT_RATE_MUST_BE_ZERO');
  }

  // Lignes : en franchise France, le CIUS France impose la catégorie E, taux 0, avec le code
  // VATEX-FR-FRANCHISE en BT-121 sur la ventilation (BR-FR-CO-16). Quand le vendeur n'a pas de
  // n° TVA, son SIREN réel est répété en BT-32/FC — aucune TVA n'est fabriquée.
  // en autoliquidation -> catégorie AE, taux 0 (BR-AE-5).
  // B3 — bases NETTES par ligne (remise de ligne + quote-part de remise globale, MÊME politique
  // d'allocation que computeTotals) : le XML porte les montants réellement facturés — sans quoi
  // BR-CO-10 (somme des lignes = total HT) serait violée sur toute pièce remisée.
  const { netLineBases } = computeLineBases(invoice.lines, { globalDiscount: invoice.globalDiscount });
  const lines: FacturXLine[] = invoice.lines.map((l, i) => {
    const gross = Math.round(l.qty * l.unitPriceHT);
    const net = netLineBases[i] ?? gross;
    const unitCode = billingUnitToUneceCode(l.unit);
    if (!unitCode.ok) throw new Error(`FACTURX_UNSUPPORTED_UNIT:${l.unit ?? ''}`);
    return {
      id: l.id || String(i + 1),
      name: l.label,
      qty: l.qty,
      unitCode: unitCode.value,
      unitPriceHTCents: l.unitPriceHT,
      netAmountCents: net,
      ...(gross - net > 0 ? { allowanceCents: gross - net } : {}),
      vatCategory: allDisbursement
        ? 'O'
        : franchise
          ? 'E'
          : autoliquidation
            ? 'AE'
            : l.vatRate > 0
              ? 'S'
              : 'Z',
      ...(allDisbursement ? {} : { vatRatePct: franchise || autoliquidation ? 0 : l.vatRate }),
    };
  });

  let vatBreakdown: FacturXVatBreakdown[];
  let taxTotalCents: number;
  let grandTotalCents: number;
  let duePayableCents: number;
  const legalDueCents = totals.duePayableCents ?? totals.netToPay;
  const dueMappedToGrandTotal = (grandTotal: number): number =>
    totals.ttc > 0 ? Math.round((grandTotal * legalDueCents) / totals.ttc) : grandTotal;

  if (allDisbursement) {
    vatBreakdown = [
      {
        category: 'O',
        basisCents: totals.ht,
        vatCents: 0,
        exemptionReason: FR_DISBURSEMENT_OUTSIDE_VAT_SCOPE,
        exemptionReasonCode: VATEX_EU_NOT_SUBJECT_TO_VAT,
      },
    ];
    taxTotalCents = 0;
    grandTotalCents = totals.ht;
    duePayableCents = dueMappedToGrandTotal(grandTotalCents);
  } else if (franchise) {
    // Franchise en base : règle CIUS France BR-FR-CO-16 — E + VATEX-FR-FRANCHISE en BT-121.
    // Le texte légal 293 B reste aussi figé dans les notes/PDF ; BT-32 porte le SIREN réel.
    vatBreakdown = [
      {
        category: 'E',
        ratePct: 0,
        basisCents: totals.ht,
        vatCents: 0,
        exemptionReasonCode: FR_VATEX_FRANCHISE,
      },
    ];
    taxTotalCents = 0;
    grandTotalCents = totals.ht;
    duePayableCents = dueMappedToGrandTotal(grandTotalCents);
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
    duePayableCents = dueMappedToGrandTotal(grandTotalCents);
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
    duePayableCents = legalDueCents;
  }

  const sellerVatId = franchise || allDisbursement ? undefined : company.tvaIntracom;
  if (!franchise && !allDisbursement && !sellerVatId) {
    throw new Error('FACTURX_SELLER_VAT_ID_REQUIRED');
  }
  if (autoliquidation && !buyer.tvaIntracom) {
    throw new Error('FACTURX_BUYER_VAT_ID_REQUIRED_FOR_REVERSE_CHARGE');
  }
  const billingMode = invoice.frenchBillingModeAtIssuance;
  if (billingMode === null) throw new Error('FACTURX_FRENCH_BILLING_MODE_REQUIRED');
  const seller: FacturXParty = {
    name: company.name,
    legalId: company.siren, // BT-30 : SIREN (9 chiffres) sous schemeID 0002 (registre SIRENE)
    ...(sellerVatId ? { vatId: sellerVatId } : {}),
    ...(franchise && !allDisbursement ? { fiscalId: company.siren } : {}),
    electronicAddress: { schemeId: '0225', value: company.siren },
    address: { line1: company.address.line1, postcode: company.address.zip, city: company.address.city, countryCode: 'FR' },
  };
  const buyerParty: FacturXParty = {
    name: buyer.name,
    ...(buyer.siren ? { legalId: buyer.siren } : {}),
    // BT-48 : uniquement le numéro réellement fourni. En autoliquidation il est obligatoire ;
    // pour les autres cas, le conserver quand il est connu améliore la traçabilité sans invention.
    ...(!allDisbursement && buyer.tvaIntracom ? { vatId: buyer.tvaIntracom } : {}),
    ...(buyer.siren
      ? { electronicAddress: { schemeId: '0225' as const, value: buyer.siren } }
      : buyer.email
        ? { electronicAddress: { schemeId: 'EM' as const, value: buyer.email } }
        : {}),
    address: { line1: buyer.address.line1, postcode: buyer.address.zip, city: buyer.address.city, countryCode: 'FR' },
  };

  return {
    number,
    typeCode: facturXTypeCode(invoice),
    issueDate,
    ...(invoice.dueAt ? { dueDate: invoice.dueAt } : {}),
    currency: 'EUR',
    billingMode,
    notes: frenchInvoiceNotes(invoice, buyer),
    // B8 — BT-13 : le numéro d'engagement porté par la facture (repris du devis) est émis dans
    // le XML structuré, à l'identique de la mention PDF. Jamais inventé : absent sans BC.
    ...(invoice.purchaseOrder !== null ? { purchaseOrderReference: invoice.purchaseOrder.number } : {}),
    ...(invoice.creditNoteSource !== null
      ? {
          precedingInvoiceReference: {
            number: invoice.creditNoteSource.number,
            issueDate: invoice.creditNoteSource.issuedAt,
          },
        }
      : {}),
    ...(invoice.creditNoteSource === null && invoice.precedingInvoices.length > 0
      ? {
          precedingInvoiceReferences: invoice.precedingInvoices.map((source) => ({
            number: source.number,
            issueDate: source.issuedAt,
          })),
        }
      : {}),
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
    // BT-113 signifie exclusivement un paiement reçu AVANT l'émission. Bob n'autorise pas
    // l'encaissement d'un brouillon : toute nouvelle pièce émise porte donc zéro, jamais une
    // retenue ni une facture antérieure travestie en prépaiement.
    prepaidCents: 0,
    duePayableCents,
  };
}
