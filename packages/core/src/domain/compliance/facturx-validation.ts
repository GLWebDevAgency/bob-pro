import {
  FR_VATEX_FRANCHISE,
  VATEX_EU_NOT_SUBJECT_TO_VAT,
  type FacturXInvoiceData,
} from './facturx';

export interface FacturXViolation {
  rule: string;
  message: string;
}

export interface FacturXValidationResult {
  valid: boolean;
  violations: FacturXViolation[];
}

/**
 * Prévalidation pure des invariants métier EN 16931 portés par `FacturXInvoiceData`.
 *
 * Cette fonction ne prétend pas remplacer les règles normatives. Le gate de publication exécute
 * en plus le XSD, le profil Factur-X EN16931 et le Schematron BR-FR strict du pack FNFE-MPE
 * versionné, puis veraPDF sur l'enveloppe PDF/A-3b.
 */
export function validateFacturXEn16931(d: FacturXInvoiceData): FacturXValidationResult {
  const violations: FacturXViolation[] = [];
  const fail = (rule: string, message: string): void => void violations.push({ rule, message });

  // Champs obligatoires
  if (!d.number) fail('BR-02', 'Numéro de facture requis.');
  if (!d.issueDate) fail('BR-03', "Date d'émission requise.");
  if (!d.currency) fail('BR-05', 'Code devise requis.');
  if (!d.seller.name) fail('BR-06', 'Nom du vendeur requis.');
  if (!d.buyer.name) fail('BR-07', "Nom de l'acheteur requis.");
  if (d.lines.length === 0) fail('BR-16', 'Au moins une ligne de facture requise.');
  if (!d.seller.legalId && !d.seller.vatId) fail('BR-CO-26', 'Identifiant vendeur requis (SIREN/SIRET ou n° TVA).');
  const precedingReferences = d.precedingInvoiceReferences
    ?? (d.precedingInvoiceReference === undefined ? [] : [d.precedingInvoiceReference]);
  if (d.precedingInvoiceReference !== undefined && d.precedingInvoiceReferences !== undefined) {
    fail('BG-3', 'Les formes singulière et plurielle des références antérieures sont exclusives.');
  }
  if ((d.typeCode === '381' || d.typeCode === '503') && !precedingReferences.some((ref) => ref.number)) {
    fail('BR-FR-CO-05', 'Un avoir doit référencer la facture rectifiée (BT-25).');
  }
  const referenceNumbers = precedingReferences.map((reference) => reference.number.trim());
  if (referenceNumbers.some((number) => number.length === 0)) {
    fail('BT-25', 'Toute référence de facture antérieure doit porter un numéro.');
  }
  if (new Set(referenceNumbers).size !== referenceNumbers.length) {
    fail('BG-3', 'Une facture antérieure ne doit être référencée qu’une fois.');
  }

  // Totaux du document (BR-CO-10/13/15/16)
  const lineSum = d.lines.reduce((s, l) => s + l.netAmountCents, 0);
  if (lineSum !== d.lineTotalHTCents) fail('BR-CO-10', 'Somme des montants de ligne ≠ total HT.');
  if (d.lineTotalHTCents !== d.taxBasisTotalCents) fail('BR-CO-13', 'Total HT ≠ base d’imposition.');
  if (d.taxBasisTotalCents + d.taxTotalCents !== d.grandTotalCents) fail('BR-CO-15', 'Base + TVA ≠ total TTC.');
  if (d.grandTotalCents - d.prepaidCents !== d.duePayableCents) fail('BR-CO-16', 'TTC − acompte ≠ net à payer.');
  if (d.prepaidCents < 0) fail('BR-CO-16', 'Acompte négatif interdit.');
  if (d.duePayableCents < 0) fail('BR-CO-16', 'Net à payer négatif interdit.');
  if (d.lineTotalHTCents < 0 || d.taxBasisTotalCents < 0 || d.grandTotalCents < 0)
    fail('BR-CO-15', 'Montant total négatif interdit.');

  // Ventilation TVA (BR-CO-10/14 niveau ventilation)
  const basisSum = d.vatBreakdown.reduce((s, b) => s + b.basisCents, 0);
  const vatSum = d.vatBreakdown.reduce((s, b) => s + b.vatCents, 0);
  if (basisSum !== d.taxBasisTotalCents) fail('BR-CO-10', 'Somme des bases de la ventilation ≠ base d’imposition.');
  if (vatSum !== d.taxTotalCents) fail('BR-CO-14', 'Somme des TVA de la ventilation ≠ total TVA.');
  if (d.vatBreakdown.length === 0) fail('BR-CO-18', 'Au moins une ventilation TVA requise.');

  for (const b of d.vatBreakdown) {
    if (b.category === 'S') {
      const rate = b.ratePct;
      if (rate === undefined) {
        fail('BR-S-05', 'Catégorie S : taux de TVA requis.');
      } else {
        if (rate <= 0) fail('BR-S-05', 'Catégorie S : taux de TVA > 0 requis.');
        const expected = Math.round((b.basisCents * rate) / 100);
        if (Math.abs(b.vatCents - expected) > 1) {
          fail('BR-CO-17', `TVA catégorie S incohérente (taux ${rate} %).`);
        }
      }
    } else if (b.category === 'E') {
      if (b.ratePct === undefined) fail('BR-E-05', 'Catégorie E : taux de TVA requis.');
      else if (b.ratePct !== 0) fail('BR-E-05', 'Catégorie E : taux 0 requis.');
      if (b.vatCents !== 0) fail('BR-E-09', 'Catégorie E : montant de TVA 0 requis.');
      if (!b.exemptionReason && !b.exemptionReasonCode)
        fail('BR-E-10', "Catégorie E : motif ou code d'exonération requis.");
    } else if (b.category === 'AE') {
      if (b.ratePct === undefined) fail('BR-AE-05', 'Catégorie AE : taux de TVA requis.');
      // Autoliquidation preneur (reverse charge) : taux 0 et TVA 0 SUR LA PIÈCE — le preneur
      // autoliquide (art. 283-2 nonies CGI) ; la mention est obligatoire (BR-AE-10).
      else if (b.ratePct !== 0) fail('BR-AE-05', 'Catégorie AE : taux 0 requis.');
      if (b.vatCents !== 0) fail('BR-AE-09', 'Catégorie AE : montant de TVA 0 requis (autoliquidation preneur).');
      if (!b.exemptionReason) fail('BR-AE-10', 'Catégorie AE : mention « Autoliquidation » requise.');
      // BR-AE-2 (EN 16931) : une pièce en autoliquidation DOIT identifier fiscalement le vendeur
      // (BT-31/BT-32) ET le preneur (BT-48). Lecture « Schematron lite » assumée : le n° TVA, à
      // défaut l'identifiant légal (SIREN, BT-30/BT-47), suffit ici — une facture ENTRANTE de
      // sous-traitance identifiée par SIREN (réception C-EXP6b) n'est pas rejetée ; le Schematron
      // officiel EN 16931 reste la référence stricte en aval (cf. en-tête). À l'ÉMISSION,
      // facturXDataFromInvoice dérive systématiquement le BT-48 du SIREN du preneur.
      if (!d.seller.vatId && !d.seller.legalId)
        fail('BR-AE-02', 'Catégorie AE : identification fiscale du vendeur requise (n° TVA BT-31, à défaut SIREN).');
      if (!d.buyer.vatId && !d.buyer.legalId)
        fail('BR-AE-02', 'Catégorie AE : identification fiscale du preneur requise (n° TVA BT-48, à défaut SIREN).');
    } else if (b.category === 'Z') {
      if (b.ratePct === undefined) fail('BR-Z-05', 'Catégorie Z : taux de TVA requis.');
      else if (b.ratePct !== 0) fail('BR-Z-05', 'Catégorie Z : taux 0 requis.');
      if (b.vatCents !== 0) fail('BR-Z-09', 'Catégorie Z : montant de TVA 0 requis.');
    } else {
      if (b.ratePct !== undefined) fail('BR-O-05', 'Catégorie O : aucun taux de TVA ne doit être émis.');
      if (b.vatCents !== 0) fail('BR-O-09', 'Catégorie O : montant de TVA 0 requis.');
      if (!b.exemptionReason && b.exemptionReasonCode !== VATEX_EU_NOT_SUBJECT_TO_VAT) {
        fail('BR-O-10', 'Catégorie O : motif hors champ ou VATEX-EU-O requis.');
      }
      if (d.seller.vatId || d.buyer.vatId) {
        fail('BR-O-02', 'Catégorie O : les identifiants TVA vendeur et acheteur sont interdits.');
      }
    }
  }
  for (const b of d.vatBreakdown) {
    if (b.exemptionReasonCode === FR_VATEX_FRANCHISE && b.category !== 'E') {
      fail('BR-FR-CO-16', 'Franchise en base : catégorie E requise avec VATEX-FR-FRANCHISE.');
    }
  }
  if (d.vatBreakdown.filter((b) => b.category === 'E').length > 1)
    fail('BR-E-01', 'Au plus une ventilation de catégorie E.');
  if (d.vatBreakdown.some((b) => b.category === 'O')) {
    if (d.vatBreakdown.length !== 1) fail('BR-O-11', 'Une pièce hors champ ne peut avoir aucune autre ventilation TVA.');
    if (d.lines.some((line) => line.vatCategory !== 'O')) {
      fail('BR-O-12', 'Une pièce hors champ ne peut contenir que des lignes de catégorie O.');
    }
  }

  // Croisement lignes <-> ventilation (BR-CO-18 / BR-S-08 / BR-E-08 / BR-Z-08) :
  // chaque couple (catégorie, taux) des lignes doit avoir exactement une ventilation de base égale.
  const lineGroups = new Map<string, number>();
  for (const l of d.lines) {
    if (l.vatCategory === 'O' && l.vatRatePct !== undefined) {
      fail('BR-O-05', 'Une ligne de catégorie O ne doit pas contenir de taux de TVA.');
    }
    if (l.vatCategory !== 'O' && l.vatRatePct === undefined) {
      fail('BR-CO-18', `Taux de TVA absent pour la ligne ${l.id}.`);
    }
    const k = `${l.vatCategory}|${l.vatRatePct ?? ''}`;
    lineGroups.set(k, (lineGroups.get(k) ?? 0) + l.netAmountCents);
  }
  const breakdownGroups = new Map<string, number>();
  for (const b of d.vatBreakdown) {
    const k = `${b.category}|${b.ratePct ?? ''}`;
    if (breakdownGroups.has(k)) fail('BR-CO-18', `Ventilation TVA en double pour (${k}).`);
    breakdownGroups.set(k, b.basisCents);
  }
  for (const [k, basis] of lineGroups) {
    if (!breakdownGroups.has(k)) fail('BR-CO-18', `Aucune ventilation TVA pour (${k}).`);
    else if (breakdownGroups.get(k) !== basis) fail('BR-CO-18', `Base de ventilation (${k}) ≠ somme des lignes.`);
  }
  for (const k of breakdownGroups.keys()) {
    if (!lineGroups.has(k)) fail('BR-CO-18', `Ventilation TVA (${k}) sans ligne correspondante.`);
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Alias de compatibilité pour les imports historiques et les pièces BASIC déjà reçues.
 * Les nouvelles émissions sont EN16931 ; aucune logique de validation distincte n'est maintenue.
 *
 * @deprecated Préférer `validateFacturXEn16931`.
 */
export const validateFacturXBasic = validateFacturXEn16931;
