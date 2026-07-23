import { type Result, ok, err } from '../../shared-kernel/result';
import { type DateOnly } from '../../shared-kernel/time';
import { Siren } from '../../shared-kernel/identifiers';
import { parseFacturXBasic } from '../../domain/compliance/parse-facturx';
import { validateFacturXBasic, type FacturXViolation } from '../../domain/compliance/facturx-validation';
import { type FacturXParty } from '../../domain/compliance/facturx';
import { type AfnorInboundRefusalStatus } from '../../domain/compliance/einvoice-inbound';
import { type ExpenseCategory } from '../../domain/expense/expense';
import { type RecordExpenseInput } from './record-expense';

/**
 * import-facturx-expense (C-EXP6b) — le CONTRÔLE DE RÉCEPTION d'un cabinet, pas un import naïf.
 *
 * Use case PUR (zéro port asynchrone) : XML entrant + contexte (mon SIREN, clés de factures
 * déjà en base) → soit un BROUILLON prêt à décision (approve/refuse via InboundEinvoice),
 * soit une erreur de contrôle TYPÉE. Rien n'est enregistré ici : la DÉCISION appartient à
 * l'appelant (parité humain ↔ Bob), l'enregistrement passe par RecordExpense (écritures E1).
 *
 * CONTRÔLES BLOQUANTS, dans l'ordre du contrat CLAIMS :
 *  1. XML parsable + profil BASIC (parseFacturXBasic, C-EXP6a) → `xml_invalide` (AFNOR 213) ;
 *  2. type de document : seule une FACTURE (380) devient une charge — un avoir (381) importé
 *     en positif gonflerait les charges et la TVA déductible (anti P17) → `type_non_gere` ;
 *     devise ≠ EUR : tout l'aval (Expense, compta) suppose l'euro → `devise_non_geree` ;
 *  3. DESTINATAIRE : le SIREN acheteur du XML doit être MA société — sinon proposition de
 *     refus AFNOR 210 « facture mal adressée » (les 2 SIREN dans l'erreur) → `mal_adressee` ;
 *  4. COHÉRENCE arithmétique EN 16931 : validateFacturXBasic REJOUÉ sur la facture entrante
 *     → `incoherente` avec la liste des violations ;
 *  5. AUTOLIQUIDATION (catégorie AE), pure ou mixte : import comptable bloqué tant que le
 *     moteur de TVA due/déductible, les écritures miroir et la CA3 ne sont pas certifiés ;
 *  6. DOUBLON EXACT (SIREN fournisseur + n° de facture déjà en base) : anti double-paiement /
 *     double-déduction (P17) → `doublon` avec la clé.
 *
 * MAPPING EXPERT (le piège TVA, P21) :
 *  - vatCents = SOMME EXACTE des ventilations (multi-taux au centime, jamais un taux replayé) ;
 *  - vatRatePct = taux unique si toutes les ventilations partagent le même taux, sinon null ;
 *  - AUTOLIQUIDATION preneur (catégorie AE, art. 283-2 nonies CGI) : aucun brouillon
 *    comptabilisable n'est produit en V1. Neutraliser la TVA à zéro serait fiscalement faux :
 *    le preneur doit constater la TVA due et, selon son droit à déduction, son miroir ;
 *  - exonéré/franchise (catégorie E) : zéro TVA mentionnée → zéro déductible (règle E1
 *    « TVA déductible seulement si mentionnée »), note avec le motif d'exonération.
 */

// ——————————————————————————————————————————————————————————————
// Types exportés
// ——————————————————————————————————————————————————————————————

export interface FacturXExpenseDraft {
  supplierName: string;
  /** SIREN fournisseur : BT-30 validé Luhn, sinon dérivé du n° TVA FR (BT-31), sinon null. */
  supplierSiren: string | null;
  /** N° de facture fournisseur (BT-1). */
  supplierInvoiceNumber: string;
  /** Date d'émission (BT-2). */
  documentDate: DateOnly;
  /** Échéance de paiement (BT-9), si présente. */
  dueAt: DateOnly | null;
  totalTtcCents: number;
  totalHtCents: number;
  /** TVA MENTIONNÉE sur la pièce : somme exacte des ventilations, multi-taux au centime. */
  vatCents: number;
  /** Taux unique si toutes les ventilations partagent le même taux, sinon null. */
  vatRatePct: number | null;
  /**
   * Compatibilité de contrat V1. Toujours false : une catégorie AE est refusée avant brouillon,
   * elle n'est jamais transformée en fausse « TVA non déductible ».
   */
  vatNonDeductible: false;
  /** Explication TVA lisible (exonération) — null si TVA classique. */
  vatNote: string | null;
  /** Catégorie proposée — la mémoire fournisseur PRIME via `withSupplierCategory`. */
  categoryGuess: ExpenseCategory;
  categorySource: 'memory' | 'default';
  source: 'facturx';
  /** Clé anti-doublon (SIREN fournisseur + n° normalisé) — à confronter/persister. */
  duplicateKey: string;
}

export type ImportFacturXExpenseError =
  | { code: 'xml_invalide'; field: string; message: string; suggestedAfnorStatus: AfnorInboundRefusalStatus }
  | { code: 'type_non_gere'; typeCode: string; message: string }
  | { code: 'devise_non_geree'; currency: string; message: string }
  | { code: 'autoliquidation_non_geree'; message: string }
  | {
      code: 'mal_adressee';
      buyerSiren: string | null;
      mySiren: string;
      message: string;
      suggestedAfnorStatus: AfnorInboundRefusalStatus;
    }
  | { code: 'incoherente'; violations: FacturXViolation[]; message: string; suggestedAfnorStatus: AfnorInboundRefusalStatus }
  | { code: 'doublon'; duplicateKey: string; message: string };

export interface ImportFacturXExpenseInput {
  xml: string;
  /** SIREN de MA société (le destinataire attendu). */
  mySiren: string;
  /** Clés (supplierSiren|n° normalisé) des factures fournisseurs DÉJÀ en base — cf. expenseDuplicateKey. */
  existingInvoiceKeys: Iterable<string>;
}

// ——————————————————————————————————————————————————————————————
// Clé anti-doublon (partagée import ↔ base)
// ——————————————————————————————————————————————————————————————

const normalizeInvoiceNumber = (n: string): string => n.trim().replace(/\s+/g, ' ').toUpperCase();
const normalizeSupplierKeyName = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Clé de doublon EXACT : SIREN fournisseur (sinon nom normalisé) + n° de facture normalisé. */
export function facturXExpenseKey(input: {
  supplierSiren: string | null;
  supplierName: string;
  supplierInvoiceNumber: string;
}): string {
  const left = input.supplierSiren ?? normalizeSupplierKeyName(input.supplierName);
  return `${left}|${normalizeInvoiceNumber(input.supplierInvoiceNumber)}`;
}

/** Clé de doublon d'une dépense EXISTANTE — null si elle ne porte pas de n° de facture fournisseur. */
export function expenseDuplicateKey(e: {
  supplierSiren: string | null;
  supplierName: string;
  supplierInvoiceNumber?: string | null;
}): string | null {
  const n = e.supplierInvoiceNumber?.trim();
  if (!n) return null;
  return facturXExpenseKey({ supplierSiren: e.supplierSiren, supplierName: e.supplierName, supplierInvoiceNumber: n });
}

/**
 * Clé de doublon d'une facture Factur-X PARSÉE (côté vendeur) — IDENTIQUE à `expenseDuplicateKey`
 * d'une dépense issue de cette même facture (même dérivation SIREN BT-30/BT-31, même normalisation).
 *
 * Sert au REFUS (C-EXP-FIX1, Bug 2) : on refuse une facture sans rejouer les contrôles (une facture
 * mal adressée est précisément faite pour être refusée), mais il faut d'abord confronter sa clé aux
 * dépenses DÉJÀ comptabilisées — l'Expense est le registre de l'état « approuvée » — pour interdire
 * un cycle de vie fantôme « approuvée ET refusée ».
 */
export function facturXInvoiceDuplicateKey(invoice: { seller: FacturXParty; number: string }): string {
  return facturXExpenseKey({
    supplierSiren: partySiren(invoice.seller),
    supplierName: invoice.seller.name,
    supplierInvoiceNumber: invoice.number,
  });
}

// ——————————————————————————————————————————————————————————————
// Helpers internes
// ——————————————————————————————————————————————————————————————

/** SIREN d'une partie : BT-30 (Luhn validé) sinon dérivé du n° TVA FR (BT-31 = FR + clé + SIREN). */
function partySiren(party: FacturXParty): string | null {
  if (party.legalId) {
    const s = Siren.of(party.legalId);
    if (s.ok) return s.value.value;
  }
  const vatMatch = party.vatId !== undefined ? /^FR\d{2}(\d{9})$/.exec(party.vatId.replace(/\s/g, '')) : null;
  if (vatMatch?.[1] !== undefined) {
    const s = Siren.of(vatMatch[1]);
    if (s.ok) return s.value.value;
  }
  return null;
}

// ——————————————————————————————————————————————————————————————
// Use case
// ——————————————————————————————————————————————————————————————

export function importFacturXExpense(
  input: ImportFacturXExpenseInput,
): Result<FacturXExpenseDraft, ImportFacturXExpenseError> {
  // 1. XML parsable, profil BASIC (C-EXP6a) — échec = rejet TECHNIQUE (AFNOR 213).
  const parsed = parseFacturXBasic(input.xml);
  if (!parsed.ok) {
    return err({
      code: 'xml_invalide',
      field: parsed.error.code === 'VALIDATION' ? parsed.error.field : 'xml',
      message: parsed.error.code === 'VALIDATION' ? parsed.error.message : 'XML Factur-X invalide.',
      suggestedAfnorStatus: 213,
    });
  }
  const d = parsed.value;

  // 2. Type de document + devise : seule une FACTURE (380) en EUR devient une charge.
  if (d.typeCode !== '380') {
    return err({
      code: 'type_non_gere',
      typeCode: d.typeCode,
      message: `Type de document ${d.typeCode} non importable en dépense (seule une facture 380 l'est — un avoir se traite à part, anti double-déduction).`,
    });
  }
  if (d.currency !== 'EUR') {
    return err({
      code: 'devise_non_geree',
      currency: d.currency,
      message: `Devise ${d.currency} non gérée (EUR uniquement — pas de conversion inventée).`,
    });
  }

  // 3. DESTINATAIRE : le SIREN acheteur doit être MA société (contrôle de réception cabinet).
  const buyerSiren = partySiren(d.buyer);
  if (buyerSiren !== input.mySiren) {
    return err({
      code: 'mal_adressee',
      buyerSiren,
      mySiren: input.mySiren,
      message:
        buyerSiren === null
          ? `Facture sans SIREN acheteur vérifiable — impossible de prouver qu'elle m'est adressée (mon SIREN : ${input.mySiren}).`
          : `Facture adressée au SIREN ${buyerSiren}, pas à ma société (${input.mySiren}) — proposition de refus AFNOR 210.`,
      suggestedAfnorStatus: 210,
    });
  }

  // 4. COHÉRENCE arithmétique EN 16931 rejouée sur la facture ENTRANTE.
  const validation = validateFacturXBasic(d);
  if (!validation.valid) {
    return err({
      code: 'incoherente',
      violations: validation.violations,
      message: `Facture incohérente (EN 16931) : ${validation.violations.map((v) => v.rule).join(', ')}.`,
      suggestedAfnorStatus: 210,
    });
  }

  // 5. AUTOLIQUIDATION — fail-closed AVANT tout brouillon approuvable et donc avant RecordExpense.
  // La catégorie AE peut cohabiter avec S : neutraliser toute la TVA de la pièce serait alors
  // doublement faux. Le futur moteur devra ventiler TVA due/déductible et produire le miroir CA3.
  const hasAE = d.vatBreakdown.some((breakdown) => breakdown.category === 'AE');
  if (hasAE) {
    return err({
      code: 'autoliquidation_non_geree',
      message:
        "Cette facture comporte de l'autoliquidation (catégorie AE). Son approbation comptable est bloquée tant que le calcul de TVA due et déductible, les écritures miroir et la CA3 ne sont pas certifiés. Aucune dépense n'a été créée ; ne refusez pas la facture fournisseur pour ce seul motif.",
    });
  }

  // 6. DOUBLON EXACT (SIREN fournisseur + n° de facture) — anti double-paiement/double-déduction.
  const supplierSiren = partySiren(d.seller);
  const duplicateKey = facturXExpenseKey({
    supplierSiren,
    supplierName: d.seller.name,
    supplierInvoiceNumber: d.number,
  });
  for (const key of input.existingInvoiceKeys) {
    if (key === duplicateKey) {
      return err({
        code: 'doublon',
        duplicateKey,
        message: `Facture ${d.number} du fournisseur déjà enregistrée (clé ${duplicateKey}) — import refusé (anti double-paiement).`,
      });
    }
  }

  // MAPPING EXPERT — TVA multi-taux au centime et exonération. AE a déjà été bloquée.
  const vatCents = d.vatBreakdown.reduce((sum, b) => sum + b.vatCents, 0); // = taxTotalCents (validé BR-CO-14)
  const rates = [...new Set(d.vatBreakdown.map((b) => b.ratePct))];
  const vatRatePct = rates.length === 1 && rates[0] !== undefined ? rates[0] : null;

  const exempt = d.vatBreakdown.find((b) => b.category === 'E');
  let vatNote: string | null = null;
  if (vatCents === 0 && exempt !== undefined) {
    vatNote = `TVA non applicable — fournisseur exonéré/en franchise (${exempt.exemptionReason ?? 'motif sur la pièce'}) : zéro TVA déductible (déductible seulement si mentionnée).`;
  }

  return ok({
    supplierName: d.seller.name,
    supplierSiren,
    supplierInvoiceNumber: d.number,
    documentDate: d.issueDate,
    dueAt: d.dueDate ?? null,
    totalTtcCents: d.grandTotalCents,
    totalHtCents: d.taxBasisTotalCents,
    vatCents,
    vatRatePct,
    vatNonDeductible: false,
    vatNote,
    // Défaut HONNÊTE : aucune catégorie métier devinée. La mémoire fournisseur PRIME
    // toujours via `withSupplierCategory` (habitude validée > défaut).
    categoryGuess: 'autre',
    categorySource: 'default',
    source: 'facturx',
    duplicateKey,
  });
}

/**
 * Applique la MÉMOIRE FOURNISSEUR au brouillon : la catégorie apprise sur les dépenses
 * VALIDÉES prime sur le défaut de l'import (même doctrine que suggestExpenseDefaults).
 */
export function withSupplierCategory(
  draft: FacturXExpenseDraft,
  memorizedCategory: ExpenseCategory | null,
): FacturXExpenseDraft {
  if (memorizedCategory === null) return draft;
  return { ...draft, categoryGuess: memorizedCategory, categorySource: 'memory' };
}

/**
 * Traduit le brouillon APPROUVÉ en entrée RecordExpense (écritures E1 automatiques).
 * Une facture AE n'atteint jamais ce point : `importFacturXExpense` la bloque avant brouillon.
 */
export function facturXDraftToRecordExpenseInput(
  draft: FacturXExpenseDraft,
  overrides?: { category?: ExpenseCategory },
): Omit<RecordExpenseInput, 'companyId'> {
  return {
    supplierName: draft.supplierName,
    supplierSiren: draft.supplierSiren,
    documentDate: draft.documentDate,
    totalTtcCents: draft.totalTtcCents,
    totalHtCents: draft.totalHtCents,
    vatCents: draft.vatCents,
    vatRatePct: draft.vatRatePct,
    category: overrides?.category ?? draft.categoryGuess,
    source: 'facturx',
    supplierInvoiceNumber: draft.supplierInvoiceNumber,
    dueAt: draft.dueAt,
  };
}
