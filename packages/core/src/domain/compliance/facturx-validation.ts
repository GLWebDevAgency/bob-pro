import { type FacturXInvoiceData } from './facturx';

export interface FacturXViolation {
  rule: string;
  message: string;
}

export interface FacturXValidationResult {
  valid: boolean;
  violations: FacturXViolation[];
}

/**
 * Validation des règles métier EN 16931 (sous-ensemble BASIC) sur les données Factur-X.
 * Exécutable en CI comme garde-fou (« Schematron lite »). Pour une conformité légale complète,
 * brancher le Schematron officiel EN 16931 + veraPDF (PDF/A-3) — cf. docs/architecture.
 */
export function validateFacturXBasic(d: FacturXInvoiceData): FacturXValidationResult {
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

  // Totaux du document (BR-CO-10/13/15/16)
  const lineSum = d.lines.reduce((s, l) => s + l.netAmountCents, 0);
  if (lineSum !== d.lineTotalHTCents) fail('BR-CO-10', 'Somme des montants de ligne ≠ total HT.');
  if (d.lineTotalHTCents !== d.taxBasisTotalCents) fail('BR-CO-13', 'Total HT ≠ base d’imposition.');
  if (d.taxBasisTotalCents + d.taxTotalCents !== d.grandTotalCents) fail('BR-CO-15', 'Base + TVA ≠ total TTC.');
  if (d.grandTotalCents - d.prepaidCents !== d.duePayableCents) fail('BR-CO-16', 'TTC − acompte ≠ net à payer.');
  if (d.prepaidCents < 0) fail('BR-CO-16', 'Acompte négatif interdit.');

  // Ventilation TVA (BR-CO-10/14 niveau ventilation)
  const basisSum = d.vatBreakdown.reduce((s, b) => s + b.basisCents, 0);
  const vatSum = d.vatBreakdown.reduce((s, b) => s + b.vatCents, 0);
  if (basisSum !== d.taxBasisTotalCents) fail('BR-CO-10', 'Somme des bases de la ventilation ≠ base d’imposition.');
  if (vatSum !== d.taxTotalCents) fail('BR-CO-14', 'Somme des TVA de la ventilation ≠ total TVA.');
  if (d.vatBreakdown.length === 0) fail('BR-CO-18', 'Au moins une ventilation TVA requise.');

  for (const b of d.vatBreakdown) {
    if (b.category === 'S') {
      if (b.ratePct <= 0) fail('BR-S-05', 'Catégorie S : taux de TVA > 0 requis.');
      const expected = Math.round((b.basisCents * b.ratePct) / 100);
      if (b.vatCents !== expected) fail('BR-CO-17', `TVA catégorie S incohérente (taux ${b.ratePct} %).`);
    } else if (b.category === 'E') {
      if (b.ratePct !== 0) fail('BR-E-05', 'Catégorie E : taux 0 requis.');
      if (b.vatCents !== 0) fail('BR-E-09', 'Catégorie E : montant de TVA 0 requis.');
      if (!b.exemptionReason) fail('BR-E-10', "Catégorie E : motif d'exonération requis.");
    } else {
      if (b.ratePct !== 0) fail('BR-Z-05', 'Catégorie Z : taux 0 requis.');
      if (b.vatCents !== 0) fail('BR-Z-09', 'Catégorie Z : montant de TVA 0 requis.');
    }
  }
  if (d.vatBreakdown.filter((b) => b.category === 'E').length > 1)
    fail('BR-E-01', 'Au plus une ventilation de catégorie E.');

  return { valid: violations.length === 0, violations };
}
