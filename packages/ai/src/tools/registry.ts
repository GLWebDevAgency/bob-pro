import {
  type Result,
  ok,
  err,
  type AppError,
  type LineInput,
  type LineCategory,
  type ExpenseCategory,
  isVatRate,
} from '@bob/core';
import { type AnyTool, type Tool } from './tool';
import {
  type BobActions,
  type CreateQuoteActionInput,
  type RecordExpenseActionInput,
} from '../agent/actions';

function appValidation(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

const LINE_CATEGORIES: readonly LineCategory[] = ['labor', 'supply', 'travel', 'disbursement', 'subscription'];
const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = ['fournitures', 'materiel', 'carburant', 'repas', 'sous_traitance', 'autre'];

/** Valide strictement une ligne de devis dictée/planifiée par l'agent (anti-hallucination d'arguments). */
function parseLine(raw: unknown, index: number): Result<LineInput, AppError> {
  const l = raw as { label?: unknown; category?: unknown; qty?: unknown; unitPriceHT?: unknown; vatRate?: unknown };
  if (typeof l?.label !== 'string' || l.label.trim().length === 0)
    return err(appValidation(`lines[${index}].label`, 'Libellé manquant.'));
  if (typeof l.category !== 'string' || !(LINE_CATEGORIES as readonly string[]).includes(l.category))
    return err(appValidation(`lines[${index}].category`, 'Catégorie de ligne invalide.'));
  if (typeof l.qty !== 'number' || !Number.isFinite(l.qty) || l.qty <= 0)
    return err(appValidation(`lines[${index}].qty`, 'Quantité invalide.'));
  if (typeof l.unitPriceHT !== 'number' || !Number.isInteger(l.unitPriceHT) || l.unitPriceHT <= 0)
    return err(appValidation(`lines[${index}].unitPriceHT`, 'Prix unitaire HT (centimes) invalide.'));
  if (typeof l.vatRate !== 'number' || !isVatRate(l.vatRate))
    return err(appValidation(`lines[${index}].vatRate`, 'Taux de TVA invalide.'));
  return ok({
    label: l.label.trim(),
    category: l.category as LineCategory,
    qty: l.qty,
    unitPriceHT: l.unitPriceHT,
    vatRate: l.vatRate,
  });
}

/**
 * Construit le registre d'outils de Bob à partir de la surface d'actions (parité).
 * Chaque outil DÉLÈGUE à une méthode de BobActions : aucune logique métier ici.
 */
export function buildBobTools(actions: BobActions): AnyTool[] {
  const computePayout: Tool<Record<string, never>, { payoutCents: number; availableCents: number }> = {
    name: 'tresorerie_versement',
    description: 'Calcule combien l’artisan peut se verser sans risque (trésorerie réelle).',
    mutating: false,
    outbound: false,
    compliance: 'low',
    parse: () => ok({}),
    riskTier: 'read',
    run: () => actions.computePayout(),
  };

  const draftRelance: Tool<Record<string, never>, { subject: string; body: string }> = {
    name: 'relance_brouillon',
    description: 'Rédige un brouillon de relance pour la facture impayée la plus urgente (n’envoie rien).',
    mutating: false,
    outbound: false,
    compliance: 'low',
    parse: () => ok({}),
    riskTier: 'read',
    run: () => actions.draftRelance(),
  };

  const listPayable: Tool<Record<string, never>, unknown> = {
    name: 'factures_impayees',
    description: 'Liste les factures encore à encaisser (numéro, client, reste dû).',
    mutating: false,
    outbound: false,
    compliance: 'low',
    parse: () => ok({}),
    riskTier: 'read',
    run: () => actions.listPayableInvoices(),
  };

  const listDocuments: Tool<Record<string, never>, unknown> = {
    name: 'documents_liste',
    description: 'Liste les derniers documents archivés de la société (PDF, XML Factur-X, reçus, justificatifs).',
    mutating: false,
    outbound: false,
    compliance: 'medium',
    parse: () => ok({}),
    riskTier: 'read',
    run: () => actions.listDocuments(),
  };

  const sendQuote: Tool<{ quoteId: string }, { number: string }> = {
    name: 'envoyer_devis',
    description: 'Envoie un devis au client et crée/renouvelle son lien de signature.',
    mutating: true,
    outbound: true,
    compliance: 'medium',
    parse: (raw): Result<{ quoteId: string }, AppError> => {
      const r = raw as { quoteId?: unknown };
      if (typeof r?.quoteId !== 'string' || r.quoteId.length === 0) return err(appValidation('quoteId', 'Devis manquant.'));
      return ok({ quoteId: r.quoteId });
    },
    riskTier: 'outbound',
    run: (input) => actions.sendQuote(input),
  };

  const issueInvoice: Tool<{ invoiceId: string }, { number: string }> = {
    name: 'emettre_facture',
    description: 'Émet une facture définitive : numéro légal séquentiel, mentions et PDF/Factur-X archivés.',
    mutating: true,
    outbound: false,
    compliance: 'high',
    safetyFloor: true,
    parse: (raw): Result<{ invoiceId: string }, AppError> => {
      const r = raw as { invoiceId?: unknown };
      if (typeof r?.invoiceId !== 'string' || r.invoiceId.length === 0)
        return err(appValidation('invoiceId', 'Facture manquante.'));
      return ok({ invoiceId: r.invoiceId });
    },
    riskTier: 'fiscal',
    run: (input) => actions.issueInvoice(input),
  };

  const registerPayment: Tool<
    { invoiceId: string; amountCents: number; idempotencyKey?: string | null },
    { status: string }
  > = {
    name: 'encaisser_facture',
    description: 'Marque une facture comme encaissée (paiement reçu). Réversible, mais impacte les livres (CA/TVA/relances).',
    mutating: true,
    outbound: false, // pas un envoi vers un tiers…
    compliance: 'medium',
    // …mais PLANCHER de sécurité : le POSTING d'un paiement modifie les livres (CA, TVA, statut client,
    // relances, rapprochement) -> toujours confirmer (même en auto), via un OK voix/tap rapide (décision Claude+Codex).
    safetyFloor: true,
    parse: (raw): Result<{ invoiceId: string; amountCents: number; idempotencyKey?: string | null }, AppError> => {
      const r = raw as { invoiceId?: unknown; amountCents?: unknown; idempotencyKey?: unknown };
      if (typeof r?.invoiceId !== 'string' || r.invoiceId.length === 0)
        return err(appValidation('invoiceId', 'Facture manquante.'));
      if (typeof r?.amountCents !== 'number' || !Number.isInteger(r.amountCents) || r.amountCents <= 0)
        return err(appValidation('amountCents', 'Montant invalide.'));
      if (r.idempotencyKey !== undefined && r.idempotencyKey !== null && typeof r.idempotencyKey !== 'string')
        return err(appValidation('idempotencyKey', 'Clé d’idempotence invalide.'));
      return ok({ invoiceId: r.invoiceId, amountCents: r.amountCents, idempotencyKey: r.idempotencyKey ?? null });
    },
    riskTier: 'accounting',
    run: (input) => actions.registerPayment(input),
  };

  const tools = [computePayout, draftRelance, listPayable, listDocuments, sendQuote, issueInvoice, registerPayment] as AnyTool[];

  // —— Outils OPTIONNELS (parité C15 TODO ③④) : exposés seulement si l'hôte fournit l'action ——
  // Les hôtes existants (apps/api) restent inchangés ; le mobile branche ces actions sur le BobClient.
  const createQuoteAction = actions.createQuote?.bind(actions);
  if (createQuoteAction) {
    const creerDevis: Tool<CreateQuoteActionInput, { quoteId: string }> = {
      name: 'creer_devis',
      description: 'Crée un devis brouillon (client + lignes chiffrées) — même use case que l’écran devis.',
      mutating: true,
      outbound: false,
      compliance: 'medium',
      // Brouillon interne réversible : pas de plancher — la sortie vers le client reste envoyer_devis.
      riskTier: 'draft',
      parse: (raw): Result<CreateQuoteActionInput, AppError> => {
        const r = raw as { customerId?: unknown; lines?: unknown; depositPct?: unknown };
        if (typeof r?.customerId !== 'string' || r.customerId.length === 0)
          return err(appValidation('customerId', 'Client manquant.'));
        if (!Array.isArray(r.lines) || r.lines.length === 0)
          return err(appValidation('lines', 'Au moins une ligne chiffrée est requise.'));
        const lines: LineInput[] = [];
        for (let i = 0; i < r.lines.length; i += 1) {
          const parsed = parseLine(r.lines[i], i);
          if (!parsed.ok) return parsed;
          lines.push(parsed.value);
        }
        if (r.depositPct !== undefined && (typeof r.depositPct !== 'number' || r.depositPct <= 0 || r.depositPct >= 100))
          return err(appValidation('depositPct', 'Pourcentage d’acompte invalide.'));
        return ok({
          customerId: r.customerId,
          lines,
          ...(typeof r.depositPct === 'number' ? { depositPct: r.depositPct } : {}),
        });
      },
      run: (input) => createQuoteAction(input),
    };
    tools.push(creerDevis as AnyTool);
  }

  const recordExpenseAction = actions.recordExpense?.bind(actions);
  if (recordExpenseAction) {
    const scanDepense: Tool<RecordExpenseActionInput, { id: string }> = {
      name: 'scan_depense',
      description:
        'Enregistre une dépense justifiée (fournisseur, TTC, catégorie) dans les livres — même use case que le scan OCR de l’écran Documents.',
      mutating: true,
      outbound: false,
      compliance: 'medium',
      // Poster une dépense modifie les livres (charges, TVA déductible) -> plancher comptable.
      safetyFloor: true,
      riskTier: 'accounting',
      parse: (raw): Result<RecordExpenseActionInput, AppError> => {
        const r = raw as {
          supplierName?: unknown;
          totalTtcCents?: unknown;
          category?: unknown;
          documentDate?: unknown;
          vatRatePct?: unknown;
        };
        if (typeof r?.supplierName !== 'string' || r.supplierName.trim().length === 0)
          return err(appValidation('supplierName', 'Fournisseur manquant.'));
        if (typeof r.totalTtcCents !== 'number' || !Number.isInteger(r.totalTtcCents) || r.totalTtcCents <= 0)
          return err(appValidation('totalTtcCents', 'Montant TTC (centimes) invalide.'));
        if (typeof r.category !== 'string' || !(EXPENSE_CATEGORIES as readonly string[]).includes(r.category))
          return err(appValidation('category', 'Catégorie de dépense invalide.'));
        if (r.documentDate !== undefined && !(typeof r.documentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.documentDate)))
          return err(appValidation('documentDate', 'Date (YYYY-MM-DD) invalide.'));
        if (r.vatRatePct !== undefined && r.vatRatePct !== null && typeof r.vatRatePct !== 'number')
          return err(appValidation('vatRatePct', 'Taux de TVA invalide.'));
        return ok({
          supplierName: r.supplierName.trim(),
          totalTtcCents: r.totalTtcCents,
          category: r.category as ExpenseCategory,
          ...(typeof r.documentDate === 'string' ? { documentDate: r.documentDate } : {}),
          ...(r.vatRatePct !== undefined ? { vatRatePct: r.vatRatePct as number | null } : {}),
        });
      },
      run: (input) => recordExpenseAction(input),
    };
    tools.push(scanDepense as AnyTool);
  }

  return tools;
}
