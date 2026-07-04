import {
  type Result,
  ok,
  err,
  type AppError,
  type LineInput,
  type LineCategory,
  type ExpenseCategory,
  type FiscalDeadline,
  isVatRate,
} from '@bob/core';
import { type AnyTool, type Tool } from './tool';
import {
  type BobActions,
  type DraftRelanceActionInput,
  type SendRelanceActionInput,
  type SendRelanceActionOutput,
  type CreateQuoteActionInput,
  type RecordExpenseActionInput,
  type GenerateInvoiceActionInput,
  type ExportFecActionInput,
  type FecExportSummary,
  type CreateCustomerActionInput,
} from '../agent/actions';

function appValidation(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

const LINE_CATEGORIES: readonly LineCategory[] = ['labor', 'supply', 'travel', 'disbursement', 'subscription'];
const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = ['fournitures', 'materiel', 'carburant', 'repas', 'sous_traitance', 'autre'];
const CUSTOMER_TYPES: readonly CreateCustomerActionInput['type'][] = ['b2c', 'b2b', 'b2g'];
const INVOICE_MODES: readonly NonNullable<GenerateInvoiceActionInput['mode']>[] = ['deposit', 'final'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

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

  const draftRelance: Tool<DraftRelanceActionInput, { subject: string; body: string }> = {
    name: 'relance_brouillon',
    description:
      'Rédige un brouillon de relance pour une facture impayée — ciblable par facture ou client (défaut : la plus urgente). N’envoie rien.',
    mutating: false,
    outbound: false,
    compliance: 'low',
    // Cible optionnelle (parité C15 TODO ① — C25) : invoiceId prime sur customerId.
    parse: (raw): Result<DraftRelanceActionInput, AppError> => {
      const r = raw as { invoiceId?: unknown; customerId?: unknown };
      if (r?.invoiceId !== undefined && (typeof r.invoiceId !== 'string' || r.invoiceId.length === 0))
        return err(appValidation('invoiceId', 'Facture ciblée invalide.'));
      if (r?.customerId !== undefined && (typeof r.customerId !== 'string' || r.customerId.length === 0))
        return err(appValidation('customerId', 'Client ciblé invalide.'));
      return ok({
        ...(typeof r?.invoiceId === 'string' ? { invoiceId: r.invoiceId } : {}),
        ...(typeof r?.customerId === 'string' ? { customerId: r.customerId } : {}),
      });
    },
    riskTier: 'read',
    run: (input) => actions.draftRelance(input),
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

  // —— Outils OPTIONNELS (parité C15 TODO ⑤⑥ + créer client, C40) — même pattern par capacités ——
  const generateInvoiceAction = actions.generateInvoice?.bind(actions);
  if (generateInvoiceAction) {
    const genererFacture: Tool<GenerateInvoiceActionInput, { invoiceId: string }> = {
      name: 'generer_facture',
      description:
        'Génère la facture (acompte « deposit » ou solde « final ») d’un devis signé — même use case GenerateInvoiceFromQuote que l’UI.',
      mutating: true,
      outbound: false,
      compliance: 'high',
      // Palier fiscal (contrat C40) : entre dans la chaîne de facturation légale -> toujours confirmer.
      safetyFloor: true,
      riskTier: 'fiscal',
      parse: (raw): Result<GenerateInvoiceActionInput, AppError> => {
        const r = raw as { quoteId?: unknown; mode?: unknown };
        if (typeof r?.quoteId !== 'string' || r.quoteId.length === 0) return err(appValidation('quoteId', 'Devis manquant.'));
        if (r.mode !== undefined && !(typeof r.mode === 'string' && (INVOICE_MODES as readonly string[]).includes(r.mode)))
          return err(appValidation('mode', 'Mode de facture invalide (deposit | final).'));
        return ok({
          quoteId: r.quoteId,
          ...(typeof r.mode === 'string' ? { mode: r.mode as NonNullable<GenerateInvoiceActionInput['mode']> } : {}),
        });
      },
      run: (input) => generateInvoiceAction(input),
    };
    tools.push(genererFacture as AnyTool);
  }

  const exportFecAction = actions.exportFec?.bind(actions);
  if (exportFecAction) {
    const exportFec: Tool<ExportFecActionInput, FecExportSummary> = {
      name: 'export_fec',
      description:
        'Prépare l’export FEC (fichier des écritures comptables) d’une période — même use case ExportFec que l’écran compta ; renvoie le résumé (fichier, nombre d’écritures), jamais le contenu.',
      mutating: false,
      outbound: false,
      compliance: 'high',
      // Palier comptable (contrat C40) : donnée réglementée, classée accounting pour la policy/l'audit.
      riskTier: 'accounting',
      parse: (raw): Result<ExportFecActionInput, AppError> => {
        const r = raw as { from?: unknown; to?: unknown };
        if (typeof r?.from !== 'string' || !DATE_ONLY.test(r.from))
          return err(appValidation('from', 'Début de période (YYYY-MM-DD) invalide.'));
        if (typeof r?.to !== 'string' || !DATE_ONLY.test(r.to))
          return err(appValidation('to', 'Fin de période (YYYY-MM-DD) invalide.'));
        if (r.to < r.from) return err(appValidation('to', 'La fin de période précède le début.'));
        return ok({ from: r.from, to: r.to });
      },
      run: (input) => exportFecAction(input),
    };
    tools.push(exportFec as AnyTool);
  }

  // —— Outil OPTIONNEL envoyer_relance (parité C15 TODO ② — C25) : ENVOI réel, même endpoint
  // que le bouton « Relancer » de l'écran Notifications (client.sendRelance → POST /invoices/:id/relance).
  const sendRelanceAction = actions.sendRelance?.bind(actions);
  if (sendRelanceAction) {
    const envoyerRelance: Tool<SendRelanceActionInput, SendRelanceActionOutput> = {
      name: 'envoyer_relance',
      description:
        'Envoie RÉELLEMENT la relance d’une facture en retard au client (email + notification) — ton choisi par le plan de relances, mise en demeure incluse au régime légal du type de client (pro L441-10, particulier code civil, public CCP).',
      mutating: true,
      outbound: true,
      compliance: 'medium',
      // Sortant vers un tiers ET mise en demeure possible → PLANCHER : toujours confirmer, même en
      // auto (promesse produit relance.medWarning : « jamais envoyée sans ta validation »).
      safetyFloor: true,
      riskTier: 'outbound',
      parse: (raw): Result<SendRelanceActionInput, AppError> => {
        const r = raw as { invoiceId?: unknown };
        if (typeof r?.invoiceId !== 'string' || r.invoiceId.length === 0)
          return err(appValidation('invoiceId', 'Facture manquante.'));
        return ok({ invoiceId: r.invoiceId });
      },
      run: (input) => sendRelanceAction(input),
    };
    tools.push(envoyerRelance as AnyTool);
  }

  // —— Outil OPTIONNEL echeances_fiscales (C-EXP5b) : lecture pure du calendrier fiscal dérivé
  // de la fiche société (deriveFiscalCalendar @bob/core, servi par GET /fiscal-calendar) — mêmes
  // dates que l'humain, aucun montant inventé (amountHint null en v1), zéro logique fiscale ici.
  const listFiscalDeadlinesAction = actions.listFiscalDeadlines?.bind(actions);
  if (listFiscalDeadlinesAction) {
    const echeancesFiscales: Tool<Record<string, never>, FiscalDeadline[]> = {
      name: 'echeances_fiscales',
      description:
        'Liste les échéances fiscales à venir (TVA, URSSAF, IS, CFE, comptes annuels) dérivées de la fiche société — dates et explications, sans montant. Les échéances « assumed » sont des hypothèses à confirmer.',
      mutating: false,
      outbound: false,
      compliance: 'medium',
      parse: () => ok({}),
      riskTier: 'read',
      run: () => listFiscalDeadlinesAction(),
    };
    tools.push(echeancesFiscales as AnyTool);
  }

  const createCustomerAction = actions.createCustomer?.bind(actions);
  if (createCustomerAction) {
    const creerClient: Tool<CreateCustomerActionInput, { id: string }> = {
      name: 'creer_client',
      description:
        'Crée une fiche client minimale (nom + type particulier/entreprise/public) — même use case createCustomer que l’écran Clients.',
      mutating: true,
      outbound: false,
      compliance: 'low',
      // Fiche interne réversible (brouillon de carnet) : pas de plancher.
      riskTier: 'draft',
      parse: (raw): Result<CreateCustomerActionInput, AppError> => {
        const r = raw as { name?: unknown; type?: unknown };
        if (typeof r?.name !== 'string' || r.name.trim().length === 0) return err(appValidation('name', 'Nom du client manquant.'));
        if (typeof r?.type !== 'string' || !(CUSTOMER_TYPES as readonly string[]).includes(r.type))
          return err(appValidation('type', 'Type de client invalide (b2c | b2b | b2g).'));
        return ok({ name: r.name.trim(), type: r.type as CreateCustomerActionInput['type'] });
      },
      run: (input) => createCustomerAction(input),
    };
    tools.push(creerClient as AnyTool);
  }

  return tools;
}
