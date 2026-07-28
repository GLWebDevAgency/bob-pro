import {
  type Result,
  ok,
  err,
  type AppError,
  type Discount,
  type LineInput,
  type LineCategory,
  type ExpenseCategory,
  type FiscalDeadline,
  type SituationAmountInput,
  type SubscriptionStatusView,
  type FrenchOperationCategory,
  EXPENSE_PAYMENT_PROOF_DOCUMENT_ID_MAX_LENGTH,
  EXPENSE_PAYMENT_REFERENCE_MAX_LENGTH,
  PaymentTerms,
  isValidDateOnly,
  isVatRate,
  makePurchaseOrderRef,
  validateDiscount,
  validateDocumentDisplayName,
  hasAsciiControlCharacter,
} from '@bob/core';
import { type AnyTool, type Tool, type ToolPublicResult } from './tool';
import {
  type AcknowledgeDocumentActionInput,
  type AcknowledgeDocumentActionOutput,
  type AssignExpenseChantierActionInput,
  type AssignExpenseChantierActionOutput,
  type AttachPurchaseOrderActionInput,
  type AttachPurchaseOrderActionOutput,
  type CreateEquipmentActionInput,
  type EquipmentHistoryActionInput,
  type EquipmentHistoryActionOutput,
  type RetireEquipmentActionInput,
  type RetireEquipmentActionOutput,
  type FileDocumentActionInput,
  type FileDocumentActionOutput,
  type RenameDocumentActionInput,
  type RenameDocumentActionOutput,
  type SearchDocumentsActionInput,
  type SearchDocumentsActionOutput,
  type BobActions,
  type DraftRelanceActionInput,
  type DraftQuoteRelanceActionInput,
  type DraftQuoteRelanceActionOutput,
  type RecordInvoiceTransmissionActionInput,
  type RecordInvoiceTransmissionActionOutput,
  type RelanceSettingsView,
  type SetRelanceAutoActionInput,
  type SendRelanceActionInput,
  type SendRelanceActionOutput,
  type SendInvoiceActionInput,
  type SendInvoiceActionOutput,
  type CreateQuoteActionInput,
  type RecordExpenseActionInput,
  type RecordExpenseSettlementDeclaration,
  type GenerateInvoiceActionInput,
  type ComposeStandaloneInvoiceActionInput,
  type ComposeStandaloneInvoiceActionOutput,
  type GenerateSituationActionInput,
  type SetCustomerPaymentTermsActionInput,
  type SetCustomerPaymentTermsActionOutput,
  type ScheduleEmbargoPaymentActionInput,
  type ScheduleEmbargoPaymentActionOutput,
  type ExportFecActionInput,
  type FecExportSummary,
  type CreateCustomerActionInput,
  type RecordExpensePaymentActionInput,
  type NotificationReadThroughInput,
  type NotificationReadThroughOutput,
} from '../agent/actions';

function appValidation(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

const LINE_CATEGORIES: readonly LineCategory[] = ['labor', 'supply', 'travel', 'disbursement', 'subscription'];
const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = ['fournitures', 'materiel', 'carburant', 'repas', 'sous_traitance', 'autre'];
const CUSTOMER_TYPES: readonly CreateCustomerActionInput['type'][] = ['b2c', 'b2b', 'b2g'];
const INVOICE_MODES: readonly NonNullable<GenerateInvoiceActionInput['mode']>[] = ['deposit', 'final'];
const FRENCH_OPERATION_CATEGORIES: readonly FrenchOperationCategory[] = [
  'goods',
  'services',
  'mixed',
];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Remise STRUCTURELLE (B3) validée par l'AUTORITÉ du domaine (validateDiscount @bob/core) —
 * le plafond « montant ≤ base » reste jugé par l'agrégat qui connaît la base, jamais ici. */
function parseDiscount(raw: unknown, field: string): Result<Discount, AppError> {
  const d = raw as { type?: unknown; value?: unknown; cents?: unknown };
  if (typeof d !== 'object' || d === null || Array.isArray(d))
    return err(appValidation(field, 'Remise invalide.'));
  const candidate =
    d.type === 'percent'
      ? ({ type: 'percent', value: d.value as number } as Discount)
      : d.type === 'amount'
        ? ({ type: 'amount', cents: d.cents as number } as Discount)
        : null;
  if (candidate === null) return err(appValidation(field, 'Type de remise inconnu (percent | amount).'));
  const validated = validateDiscount(candidate, field);
  if (!validated.ok) {
    return err(
      appValidation(field, 'message' in validated.error ? validated.error.message : 'Remise invalide.'),
    );
  }
  return ok(validated.value);
}

/** Valide strictement une ligne de devis dictée/planifiée par l'agent (anti-hallucination d'arguments). */
function parseLine(raw: unknown, index: number): Result<LineInput, AppError> {
  const l = raw as { label?: unknown; category?: unknown; qty?: unknown; unitPriceHT?: unknown; vatRate?: unknown; discount?: unknown };
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
  // B3 (additif) — remise DE LIGNE optionnelle : structure jugée par le domaine, plafond par l'agrégat.
  let discount: Discount | undefined;
  if (l.discount !== undefined && l.discount !== null) {
    const parsed = parseDiscount(l.discount, `lines[${index}].discount`);
    if (!parsed.ok) return parsed;
    discount = parsed.value;
  }
  return ok({
    label: l.label.trim(),
    category: l.category as LineCategory,
    qty: l.qty,
    unitPriceHT: l.unitPriceHT,
    vatRate: l.vatRate,
    ...(discount !== undefined ? { discount } : {}),
  });
}

/**
 * Construit le registre d'outils de Bob à partir de la surface d'actions (parité).
 * Chaque outil DÉLÈGUE à une méthode de BobActions : aucune logique métier ici.
 */
export function buildBobTools(actions: BobActions): AnyTool[] {
  const computePayout: Tool<Record<string, never>, { payoutCents: number; availableCents: number }> = {
    name: 'tresorerie_versement',
    description:
      'Calcule la trésorerie mobilisable sans risque (réserves déjà mises de côté) — ' +
      'PAS une rémunération : celle-ci dépend du statut/régime fiscal, non modélisé ici.',
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

  const sendQuote: Tool<
    { quoteId: string },
    { number: string; deliveryStatus?: 'queued' | 'sent' | 'skipped' }
  > = {
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
    projectPublicResult: (output): ToolPublicResult => {
      if (
        output.deliveryStatus === 'queued' ||
        output.deliveryStatus === 'sent' ||
        output.deliveryStatus === 'skipped'
      ) {
        return { deliveryStatus: output.deliveryStatus };
      }
      return {};
    },
    run: (input) => actions.sendQuote(input),
  };

  const issueInvoice: Tool<
    {
      invoiceId: string;
      operationCategory?: FrenchOperationCategory;
      embargoOverride?: boolean;
      purchaseOrderOverride?: boolean;
    },
    { number: string }
  > = {
    name: 'emettre_facture',
    description:
      'Émet une facture définitive : numéro légal séquentiel, mentions et PDF/Factur-X archivés. ' +
      'Si le serveur demande operationCategory, pose une question avec les trois choix réels : services ' +
      '(prestation avec fournitures intégrées), goods (vente avec prestation accessoire), mixed ' +
      '(biens et prestations indépendants), puis rejoue avec le choix explicite. Ne choisis jamais seul. ' +
      'Si le serveur refuse pour embargo L221-10 (signature à domicile, 7 jours), explique le refus honnête et propose le DÉFAUT ' +
      '(programmer_encaissement_embargo) ; « embargoOverride: true » n’est permis qu’après avoir reformulé le risque concret ' +
      '(contrat annulable, remboursement exigible) et obtenu une confirmation explicite dédiée — l’action est tracée. ' +
      'Si le serveur refuse pour bon de commande manquant (PURCHASE_ORDER_REQUIRED : ce client exige un n° de commande), ' +
      'propose D’ABORD lier_bon_commande (saisir le BC) ; « purchaseOrderOverride: true » n’est permis qu’après avoir énoncé ' +
      'le risque réel (facture rejetée par le client) et obtenu une confirmation explicite — l’action est tracée.',
    mutating: true,
    outbound: false,
    compliance: 'high',
    safetyFloor: true,
    parse: (raw): Result<{
      invoiceId: string;
      operationCategory?: FrenchOperationCategory;
      embargoOverride?: boolean;
      purchaseOrderOverride?: boolean;
    }, AppError> => {
      const r = raw as {
        invoiceId?: unknown;
        operationCategory?: unknown;
        embargoOverride?: unknown;
        purchaseOrderOverride?: unknown;
      };
      if (typeof r?.invoiceId !== 'string' || r.invoiceId.length === 0)
        return err(appValidation('invoiceId', 'Facture manquante.'));
      if (
        r.operationCategory !== undefined
        && !FRENCH_OPERATION_CATEGORIES.includes(r.operationCategory as FrenchOperationCategory)
      )
        return err(appValidation('operationCategory', 'Nature de l’opération invalide.'));
      // Override L221-10 : booléen strict — seul `true` traverse (jamais par truthiness).
      if (r.embargoOverride !== undefined && typeof r.embargoOverride !== 'boolean')
        return err(appValidation('embargoOverride', 'Booléen attendu.'));
      // PR-04 — override de la garde « BC obligatoire » : même discipline stricte.
      if (r.purchaseOrderOverride !== undefined && typeof r.purchaseOrderOverride !== 'boolean')
        return err(appValidation('purchaseOrderOverride', 'Booléen attendu.'));
      return ok({
        invoiceId: r.invoiceId,
        ...(r.operationCategory === undefined
          ? {}
          : { operationCategory: r.operationCategory as FrenchOperationCategory }),
        ...(r.embargoOverride === true ? { embargoOverride: true } : {}),
        ...(r.purchaseOrderOverride === true ? { purchaseOrderOverride: true } : {}),
      });
    },
    riskTier: 'fiscal',
    // PR-01 — le numéro LÉGAL attribué traverse la projection publique : l'enchaînement
    // « je l'envoie au client ? » (local ET /ai/confirm HTTP) se propose avec la commande
    // canonique « Envoie la facture {numéro} » — identifiant de pièce, jamais un PII.
    projectPublicResult: (output): ToolPublicResult => ({ number: output.number }),
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
        const r = raw as {
          customerId?: unknown;
          lines?: unknown;
          depositPct?: unknown;
          globalDiscount?: unknown;
          chantierId?: unknown;
        };
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
        // B3 (additif) — remise globale dictée : structure jugée par le domaine (validateDiscount).
        let globalDiscount: Discount | undefined;
        if (r.globalDiscount !== undefined && r.globalDiscount !== null) {
          const parsed = parseDiscount(r.globalDiscount, 'globalDiscount');
          if (!parsed.ok) return parsed;
          globalDiscount = parsed.value;
        }
        // PR-08 (additif) — site de rattachement : id canonique résolu contre la liste réelle
        // (l'existence tenant est prouvée par l'hôte via le core, anti-IDOR — jamais ici).
        if (r.chantierId !== undefined && r.chantierId !== null) {
          if (
            typeof r.chantierId !== 'string' ||
            r.chantierId.length === 0 ||
            r.chantierId.length > 200 ||
            r.chantierId !== r.chantierId.trim() ||
            hasAsciiControlCharacter(r.chantierId)
          )
            return err(appValidation('chantierId', 'Site de rattachement invalide.'));
        }
        return ok({
          customerId: r.customerId,
          lines,
          ...(typeof r.depositPct === 'number' ? { depositPct: r.depositPct } : {}),
          ...(globalDiscount !== undefined ? { globalDiscount } : {}),
          ...(typeof r.chantierId === 'string' ? { chantierId: r.chantierId } : {}),
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
          chantierId?: unknown;
          payment?: unknown;
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
        // M4 (additif) — chantier d'imputation : id canonique (l'existence tenant est prouvée
        // par l'hôte via le core, anti-IDOR — jamais validée ici).
        if (r.chantierId !== undefined && r.chantierId !== null) {
          if (
            typeof r.chantierId !== 'string' ||
            r.chantierId.length === 0 ||
            r.chantierId.length > 200 ||
            r.chantierId !== r.chantierId.trim() ||
            hasAsciiControlCharacter(r.chantierId)
          )
            return err(appValidation('chantierId', 'Chantier d’imputation invalide.'));
        }
        // M4 (additif) — règlement déjà effectué déclaré à la création : la dépense naît payée
        // avec sa preuve (mêmes exigences que enregistrer_reglement_depense : date + moyen réels).
        let payment: RecordExpenseSettlementDeclaration | null = null;
        if (r.payment !== undefined && r.payment !== null) {
          if (typeof r.payment !== 'object' || Array.isArray(r.payment))
            return err(appValidation('payment', 'Règlement déclaré invalide.'));
          const p = r.payment as Record<string, unknown>;
          const allowed = new Set(['paidOn', 'method', 'reference']);
          if (Object.keys(p).some((key) => !allowed.has(key)))
            return err(appValidation('payment', 'Champ de règlement inconnu.'));
          if (typeof p.paidOn !== 'string' || !isValidDateOnly(p.paidOn))
            return err(appValidation('payment.paidOn', 'Date réelle du règlement requise.'));
          if (p.method !== 'card' && p.method !== 'transfer' && p.method !== 'cash')
            return err(appValidation('payment.method', 'Moyen de règlement requis.'));
          if (p.reference !== undefined && p.reference !== null) {
            if (
              typeof p.reference !== 'string' ||
              !p.reference.trim() ||
              p.reference.length > EXPENSE_PAYMENT_REFERENCE_MAX_LENGTH ||
              hasAsciiControlCharacter(p.reference)
            )
              return err(appValidation('payment.reference', 'Référence de règlement invalide.'));
          }
          payment = {
            paidOn: p.paidOn,
            method: p.method,
            ...(typeof p.reference === 'string' ? { reference: p.reference.trim() } : {}),
          };
        }
        return ok({
          supplierName: r.supplierName.trim(),
          totalTtcCents: r.totalTtcCents,
          category: r.category as ExpenseCategory,
          ...(typeof r.documentDate === 'string' ? { documentDate: r.documentDate } : {}),
          ...(r.vatRatePct !== undefined ? { vatRatePct: r.vatRatePct as number | null } : {}),
          ...(r.chantierId !== undefined ? { chantierId: r.chantierId as string | null } : {}),
          ...(payment !== null ? { payment } : {}),
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
        'Génère la facture (acompte « deposit » ou solde « final ») d’un devis signé — même use case GenerateInvoiceFromQuote que l’UI. Si le serveur refuse pour embargo L221-10 (signature à domicile, 7 jours), explique le refus honnête et propose le DÉFAUT : programmer_encaissement_embargo (message client planifié au premier jour légal) ; « embargoOverride: true » n’est permis qu’après avoir reformulé le risque concret (contrat annulable, remboursement exigible) et obtenu une confirmation explicite dédiée — l’action est tracée.',
      mutating: true,
      outbound: false,
      compliance: 'high',
      // Palier fiscal (contrat C40) : entre dans la chaîne de facturation légale -> toujours confirmer.
      safetyFloor: true,
      riskTier: 'fiscal',
      parse: (raw): Result<GenerateInvoiceActionInput, AppError> => {
        const r = raw as { quoteId?: unknown; mode?: unknown; embargoOverride?: unknown };
        if (typeof r?.quoteId !== 'string' || r.quoteId.length === 0) return err(appValidation('quoteId', 'Devis manquant.'));
        if (!(typeof r.mode === 'string' && (INVOICE_MODES as readonly string[]).includes(r.mode)))
          return err(appValidation('mode', 'Mode de facture requis (deposit | final).'));
        // Override L221-10 : booléen strict — seul `true` traverse (jamais par truthiness) ;
        // le safetyFloor du tool impose la confirmation explicite, le serveur journalise.
        if (r.embargoOverride !== undefined && typeof r.embargoOverride !== 'boolean')
          return err(appValidation('embargoOverride', 'Booléen attendu.'));
        return ok({
          quoteId: r.quoteId,
          mode: r.mode as GenerateInvoiceActionInput['mode'],
          ...(r.embargoOverride === true ? { embargoOverride: true } : {}),
        });
      },
      run: (input) => generateInvoiceAction(input),
    };
    tools.push(genererFacture as AnyTool);
  }

  // —— Outil OPTIONNEL facturer_situation (B2) : « facture une situation de 40 % sur le chantier
  // Durand » — MÊME use case GenerateInvoiceFromQuote (mode 'situation') que l'UI, via la MÊME
  // action generateInvoice. Le montant est TOUJOURS le choix de l'artisan ; la garde de CUMUL
  // (acompte + situations ≤ marché), le gel de rétractation A3 et la retenue de garantie B5
  // vivent au domaine — leurs refus sont restitués VERBATIM (mêmes messages que l'UI).
  if (generateInvoiceAction) {
    const facturerSituation: Tool<GenerateSituationActionInput, { invoiceId: string }> = {
      name: 'facturer_situation',
      description:
        'Génère une SITUATION DE TRAVAUX (facture d’avancement) d’un devis signé : % du marché ou montant HT en centimes — la pratique des marchés privés stipule les situations en HT. Même use case GenerateInvoiceFromQuote que l’UI ; cumul acompte + situations plafonné au marché (garde du domaine) ; la retenue de garantie stipulée au devis est déduite du net à payer. Si le serveur refuse pour embargo L221-10 ou gel de rétractation, explique le refus honnête (mêmes messages que l’écran).',
      mutating: true,
      outbound: false,
      compliance: 'high',
      // Palier fiscal : la situation entre dans la chaîne de facturation légale -> toujours confirmer.
      safetyFloor: true,
      riskTier: 'fiscal',
      parse: (raw): Result<GenerateSituationActionInput, AppError> => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
          return err(appValidation('situation', 'Situation invalide.'));
        const r = raw as Record<string, unknown>;
        const allowed = new Set(['quoteId', 'situation', 'embargoOverride']);
        if (Object.keys(r).some((key) => !allowed.has(key)))
          return err(appValidation('situation', 'Champ de situation inconnu.'));
        if (typeof r.quoteId !== 'string' || r.quoteId.length === 0 || r.quoteId.length > 200)
          return err(appValidation('quoteId', 'Devis manquant.'));
        const s = r.situation as { percent?: unknown; amountHtCents?: unknown } | null | undefined;
        if (typeof s !== 'object' || s === null || Array.isArray(s))
          return err(appValidation('situation', 'Montant de situation requis ({ percent } | { amountHtCents }).'));
        // Formes EXCLUSIVES — la cohérence fine (0 < % ≤ 100, cumul) reste jugée par le domaine.
        let situation: SituationAmountInput;
        if (s.percent !== undefined && s.amountHtCents === undefined) {
          if (typeof s.percent !== 'number' || !Number.isFinite(s.percent) || s.percent <= 0 || s.percent > 100)
            return err(appValidation('situation.percent', "Pourcentage d'avancement invalide (0 < % ≤ 100)."));
          situation = { percent: s.percent };
        } else if (s.amountHtCents !== undefined && s.percent === undefined) {
          if (typeof s.amountHtCents !== 'number' || !Number.isSafeInteger(s.amountHtCents) || s.amountHtCents <= 0)
            return err(appValidation('situation.amountHtCents', 'Montant HT de situation invalide (centimes entiers > 0).'));
          situation = { amountHtCents: s.amountHtCents };
        } else {
          return err(appValidation('situation', 'Montant de situation requis ({ percent } OU { amountHtCents }, exclusifs).'));
        }
        // Override L221-10 : booléen strict — seul `true` traverse (jamais par truthiness).
        if (r.embargoOverride !== undefined && typeof r.embargoOverride !== 'boolean')
          return err(appValidation('embargoOverride', 'Booléen attendu.'));
        return ok({
          quoteId: r.quoteId,
          situation,
          ...(r.embargoOverride === true ? { embargoOverride: true } : {}),
        });
      },
      run: (input) =>
        generateInvoiceAction({
          quoteId: input.quoteId,
          mode: 'situation',
          situation: input.situation,
          ...(input.embargoOverride === true ? { embargoOverride: true } : {}),
        }),
    };
    tools.push(facturerSituation as AnyTool);
  }

  // —— Outil OPTIONNEL facture_directe (B1) : « facture 380 € à Mme Girard pour le dépannage »
  // — MÊME use case ComposeStandaloneInvoice (@bob/core) que POST /invoices. Brouillon `final`
  // standalone (parentQuoteId null) ; l'émission suit ensuite le MÊME IssueInvoice que toute
  // facture. Les gardes fail-closed du domaine (B6 pro étranger, A3bis urgence b2c) sont
  // restituées VERBATIM — jamais contournées, jamais reformulées.
  const composeStandaloneAction = actions.composeStandaloneInvoice?.bind(actions);
  if (composeStandaloneAction) {
    const factureDirecte: Tool<ComposeStandaloneInvoiceActionInput, ComposeStandaloneInvoiceActionOutput> = {
      name: 'facture_directe',
      description:
        'Crée une FACTURE DIRECTE sans devis signé (brouillon) : dépannage urgent facturé sur place, régie (TJM × jours), facturation syndic/B2B récurrente. Client particulier (b2c) : UNIQUEMENT pour une intervention urgente à domicile expressément demandée par le client (art. L221-10, al. 2 c. conso) — « urgentOnSiteRepair: true » strict après confirmation du fait ; sans urgence, le devis signé reste le chemin (refus honnête du domaine, à restituer tel quel). Client pro étranger : émission bloquée (B6, fail-closed). La TVA de chaque ligne est re-jugée par le domaine (franchise, débours, autoliquidation, taux réduits travaux).',
      mutating: true,
      outbound: false,
      compliance: 'high',
      // Palier fiscal (mission B1) : entre dans la chaîne de facturation légale -> toujours confirmer.
      safetyFloor: true,
      riskTier: 'fiscal',
      parse: (raw): Result<ComposeStandaloneInvoiceActionInput, AppError> => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
          return err(appValidation('invoice', 'Facture directe invalide.'));
        const r = raw as Record<string, unknown>;
        const allowed = new Set(['customerId', 'lines', 'globalDiscount', 'context', 'urgentOnSiteRepair', 'chantierId']);
        if (Object.keys(r).some((key) => !allowed.has(key)))
          return err(appValidation('invoice', 'Champ de facture directe inconnu.'));
        if (typeof r.customerId !== 'string' || r.customerId.length === 0 || r.customerId.length > 200)
          return err(appValidation('customerId', 'Client manquant.'));
        if (!Array.isArray(r.lines) || r.lines.length === 0)
          return err(appValidation('lines', 'Au moins une ligne chiffrée est requise.'));
        const lines: LineInput[] = [];
        for (let i = 0; i < r.lines.length; i += 1) {
          const parsed = parseLine(r.lines[i], i);
          if (!parsed.ok) return parsed;
          lines.push(parsed.value);
        }
        let globalDiscount: Discount | undefined;
        if (r.globalDiscount !== undefined && r.globalDiscount !== null) {
          const parsed = parseDiscount(r.globalDiscount, 'globalDiscount');
          if (!parsed.ok) return parsed;
          globalDiscount = parsed.value;
        }
        // Éligibilité taux réduits travaux : booléens STRICTS, jamais déduits d'un truthy.
        let context: { housingOlderThan2y?: boolean; energyRenovation?: boolean } | undefined;
        if (r.context !== undefined && r.context !== null) {
          const c = r.context as { housingOlderThan2y?: unknown; energyRenovation?: unknown };
          if (typeof c !== 'object' || Array.isArray(c))
            return err(appValidation('context', 'Contexte travaux invalide.'));
          if (c.housingOlderThan2y !== undefined && typeof c.housingOlderThan2y !== 'boolean')
            return err(appValidation('context.housingOlderThan2y', 'Booléen attendu.'));
          if (c.energyRenovation !== undefined && typeof c.energyRenovation !== 'boolean')
            return err(appValidation('context.energyRenovation', 'Booléen attendu.'));
          context = {
            ...(c.housingOlderThan2y === true ? { housingOlderThan2y: true } : {}),
            ...(c.energyRenovation === true ? { energyRenovation: true } : {}),
          };
        }
        // A3bis : booléen strict — seul `true` (fait confirmé par l'artisan) traverse.
        if (r.urgentOnSiteRepair !== undefined && typeof r.urgentOnSiteRepair !== 'boolean')
          return err(appValidation('urgentOnSiteRepair', 'Booléen attendu.'));
        // PR-08 (additif) — site de rattachement : id canonique résolu contre la liste réelle
        // (l'existence tenant est prouvée par l'hôte via le core, anti-IDOR — jamais ici).
        if (r.chantierId !== undefined && r.chantierId !== null) {
          if (
            typeof r.chantierId !== 'string' ||
            r.chantierId.length === 0 ||
            r.chantierId.length > 200 ||
            r.chantierId !== r.chantierId.trim() ||
            hasAsciiControlCharacter(r.chantierId)
          )
            return err(appValidation('chantierId', 'Site de rattachement invalide.'));
        }
        return ok({
          customerId: r.customerId,
          lines,
          ...(globalDiscount !== undefined ? { globalDiscount } : {}),
          ...(context !== undefined ? { context } : {}),
          ...(r.urgentOnSiteRepair === true ? { urgentOnSiteRepair: true } : {}),
          ...(typeof r.chantierId === 'string' ? { chantierId: r.chantierId } : {}),
        });
      },
      projectPublicResult: (output): ToolPublicResult => ({
        invoiceId: output.invoiceId,
        totalTtcCents: output.totalTtcCents,
        netToPayCents: output.netToPayCents,
      }),
      run: (input) => composeStandaloneAction(input),
    };
    tools.push(factureDirecte as AnyTool);
  }

  // —— Outil OPTIONNEL definir_conditions_paiement (B4) : « Durand paie à 45 jours fin de
  // mois » — pose les conditions PROPRES au client (Customer.paymentTerms), MÊME chemin
  // UpdateCustomer que la fiche client. La structure est jugée par PaymentTerms.of (@bob/core)
  // et le plafond légal L441-10 (pro : 60 j / 45 j fin de mois) par le domaine à
  // l'enregistrement — son refus est restitué VERBATIM (même message que l'UI).
  const setCustomerPaymentTermsAction = actions.setCustomerPaymentTerms?.bind(actions);
  if (setCustomerPaymentTermsAction) {
    const definirConditions: Tool<SetCustomerPaymentTermsActionInput, SetCustomerPaymentTermsActionOutput> = {
      name: 'definir_conditions_paiement',
      description:
        'Enregistre les conditions de paiement PROPRES à un client (« Durand paie à 45 jours fin de mois ») : elles pilotent l’échéance des prochaines factures émises pour ce client. Plafond légal entre professionnels : 60 jours, ou 45 jours fin de mois (art. L441-10 du code de commerce) — jugé par le domaine, refus à restituer tel quel. Ne modifie aucune facture déjà émise.',
      mutating: true,
      outbound: false,
      compliance: 'medium',
      // Fait DÉCLARÉ par l'artisan qui conditionne les échéances légales des prochaines pièces,
      // sans commande d'annulation vocale : plancher de consentement, même en autonomie 'auto'.
      safetyFloor: true,
      riskTier: 'reversible',
      parse: (raw): Result<SetCustomerPaymentTermsActionInput, AppError> => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
          return err(appValidation('paymentTerms', 'Conditions de paiement invalides.'));
        const r = raw as Record<string, unknown>;
        const allowed = new Set(['customerId', 'days', 'endOfMonth', 'label']);
        if (Object.keys(r).some((key) => !allowed.has(key)))
          return err(appValidation('paymentTerms', 'Champ de conditions inconnu.'));
        if (typeof r.customerId !== 'string' || r.customerId.length === 0 || r.customerId.length > 200)
          return err(appValidation('customerId', 'Client manquant.'));
        if (typeof r.days !== 'number' || !Number.isInteger(r.days) || r.days < 0 || r.days > 365)
          return err(appValidation('days', 'Délai en jours invalide (entier 0..365).'));
        if (typeof r.endOfMonth !== 'boolean')
          return err(appValidation('endOfMonth', 'Booléen « fin de mois » requis.'));
        // Libellé imprimable : celui fourni, sinon la forme canonique — VALIDÉ par l'autorité
        // du domaine (PaymentTerms.of), jamais par une règle locale divergente.
        const label =
          typeof r.label === 'string' && r.label.trim().length > 0
            ? r.label.trim()
            : r.endOfMonth
              ? `${r.days} jours fin de mois`
              : `Paiement à ${r.days} jours`;
        if (r.label !== undefined && typeof r.label !== 'string')
          return err(appValidation('label', 'Libellé invalide.'));
        if (label.length > 120)
          return err(appValidation('label', 'Libellé des conditions limité à 120 caractères.'));
        const structural = PaymentTerms.of({ days: r.days, endOfMonth: r.endOfMonth, label });
        if (!structural.ok) {
          return err(
            appValidation(
              'paymentTerms',
              'message' in structural.error ? structural.error.message : 'Conditions de paiement invalides.',
            ),
          );
        }
        return ok({ customerId: r.customerId, days: r.days, endOfMonth: r.endOfMonth, label });
      },
      projectPublicResult: (output): ToolPublicResult => ({
        customerId: output.customerId,
        customerName: output.customerName,
        days: output.days,
        endOfMonth: output.endOfMonth,
        label: output.label,
      }),
      run: (input) => setCustomerPaymentTermsAction(input),
    };
    tools.push(definirConditions as AnyTool);
  }

  // —— Outil OPTIONNEL programmer_encaissement_embargo : le DÉFAUT LÉGAL du refus L221-10 est
  // exécutable À LA VOIX (hiérarchie doctrine fondateur : le chemin sûr d'abord, l'override en
  // second niveau — jamais l'inverse). MÊME endpoint que le bouton « Programmer l'encaissement »
  // (POST /quotes/:id/embargo-scheduled-payment) : message client planifié au premier jour
  // exigible, annulable si le client se rétracte, revalidé à la livraison.
  const scheduleEmbargoPaymentAction = actions.scheduleEmbargoPayment?.bind(actions);
  if (scheduleEmbargoPaymentAction) {
    const programmerEncaissement: Tool<
      ScheduleEmbargoPaymentActionInput,
      ScheduleEmbargoPaymentActionOutput
    > = {
      name: 'programmer_encaissement_embargo',
      description:
        'DÉFAUT légal quand l’encaissement est refusé pour embargo L221-10 (devis B2C signé à domicile) : programme le message au client au premier jour où le paiement peut être demandé — l’artisan est prévenu ce jour-là pour envoyer le lien de paiement. À proposer AVANT tout embargoOverride. Idempotent par devis ; annulé seul si le client se rétracte.',
      mutating: true,
      // Sortant DIFFÉRÉ vers le client (email planifié) : même palier de consentement que les
      // envois immédiats — la promesse produit reste « rien ne part sans ta validation ».
      outbound: true,
      compliance: 'high',
      safetyFloor: true,
      riskTier: 'outbound',
      parse: (raw): Result<ScheduleEmbargoPaymentActionInput, AppError> => {
        const r = raw as { quoteId?: unknown };
        if (typeof r?.quoteId !== 'string' || r.quoteId.length === 0)
          return err(appValidation('quoteId', 'Devis manquant.'));
        return ok({ quoteId: r.quoteId });
      },
      projectPublicResult: (output): ToolPublicResult => ({
        scheduledFor: output.scheduledFor,
        availableFrom: output.availableFrom,
        status: output.status,
      }),
      run: (input) => scheduleEmbargoPaymentAction(input),
    };
    tools.push(programmerEncaissement as AnyTool);
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

  // —— Outil OPTIONNEL envoyer_facture (PR-01 « Encaisser ») : envoi EMAIL réel de la facture
  // ÉMISE — MÊME endpoint POST /invoices/:id/send que le bouton mobile (philosophie papa vocal :
  // « envoie la facture » réussit à la voix). Gardes fail-closed du use case restituées.
  const sendInvoiceAction = actions.sendInvoice?.bind(actions);
  if (sendInvoiceAction) {
    const envoyerFacture: Tool<SendInvoiceActionInput, SendInvoiceActionOutput> = {
      name: 'envoyer_facture',
      description:
        'Envoie RÉELLEMENT la facture ÉMISE au client par e-mail (lien de consultation + PDF joint, expéditeur = la société). Destinataire optionnel : un contact du client résolu contre son carnet réel — sinon l’e-mail de la fiche client. Refus honnête si la pièce est un brouillon ou si aucune adresse n’existe.',
      mutating: true,
      outbound: true,
      compliance: 'medium',
      riskTier: 'outbound',
      parse: (raw): Result<SendInvoiceActionInput, AppError> => {
        const r = raw as { invoiceId?: unknown; recipientEmail?: unknown };
        if (typeof r?.invoiceId !== 'string' || r.invoiceId.length === 0)
          return err(appValidation('invoiceId', 'Facture manquante.'));
        // PR-09 — destinataire choisi : forme d'adresse minimale ici, la normalisation et le
        // refus font autorité au use case (resolveExplicitRecipientEmail @bob/core).
        if (r.recipientEmail !== undefined) {
          if (
            typeof r.recipientEmail !== 'string' ||
            r.recipientEmail.trim().length === 0 ||
            r.recipientEmail.length > 320 ||
            !r.recipientEmail.includes('@') ||
            hasAsciiControlCharacter(r.recipientEmail)
          )
            return err(appValidation('recipientEmail', 'Adresse du destinataire invalide.'));
        }
        return ok({
          invoiceId: r.invoiceId,
          ...(typeof r.recipientEmail === 'string' ? { recipientEmail: r.recipientEmail } : {}),
        });
      },
      projectPublicResult: (output): ToolPublicResult => {
        if (output.deliveryStatus === 'queued' || output.deliveryStatus === 'sent') {
          return { deliveryStatus: output.deliveryStatus };
        }
        return {};
      },
      run: (input) => sendInvoiceAction(input),
    };
    tools.push(envoyerFacture as AnyTool);
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

  // —— Outil OPTIONNEL relance_devis (PR-05) : brouillon LISIBLE de la relance d'un devis
  // envoyé resté sans réponse — MÊME palier J+15/J+30 et MÊME message buildQuoteRelance que la
  // carte Aujourd'hui/fiche devis. Lecture PURE : rien ne part (le partage reste un geste).
  const draftQuoteRelanceAction = actions.draftQuoteRelance?.bind(actions);
  if (draftQuoteRelanceAction) {
    const relanceDevis: Tool<DraftQuoteRelanceActionInput, DraftQuoteRelanceActionOutput> = {
      name: 'relance_devis',
      description:
        'Prépare le message de relance d’un DEVIS envoyé resté sans réponse (« relance le devis Durand ») : même palier J+15/J+30 et même message pré-rédigé que la carte Aujourd’hui. N’envoie rien — l’envoi du devis (lien de signature renouvelé) reste un geste séparé.',
      mutating: false,
      outbound: false,
      compliance: 'low',
      riskTier: 'read',
      parse: (raw): Result<DraftQuoteRelanceActionInput, AppError> => {
        const r = raw as { quoteId?: unknown };
        if (typeof r?.quoteId !== 'string' || r.quoteId.length === 0)
          return err(appValidation('quoteId', 'Devis manquant.'));
        return ok({ quoteId: r.quoteId });
      },
      run: (input) => draftQuoteRelanceAction(input),
    };
    tools.push(relanceDevis as AnyTool);
  }

  // —— Outil OPTIONNEL marquer_facture_transmise (PR-02) : dates de dépôt/acceptation DÉCLARÉES
  // d'une pièce ÉMISE — MÊME use case RecordInvoiceTransmission que PATCH /invoices/:id/
  // transmission. Fait déclaré datant un suivi légal (rappel J+2 soldable à la voix) : plancher
  // de consentement, comme lier_bon_commande. Jamais un accusé de plateforme inventé.
  const recordInvoiceTransmissionAction = actions.recordInvoiceTransmission?.bind(actions);
  if (recordInvoiceTransmissionAction) {
    const marquerTransmise: Tool<
      RecordInvoiceTransmissionActionInput,
      RecordInvoiceTransmissionActionOutput
    > = {
      name: 'marquer_facture_transmise',
      description:
        'Note la transmission DÉCLARÉE d’une facture émise vers le canal de facturation du client : date d’envoi/de dépôt (depositedAt — email, Chorus Pro, portail) et/ou date d’acceptation (acceptedAt). Dates réelles dites par l’artisan, jamais devinées ; l’acceptation suppose un dépôt (garde du domaine, refus restitué tel quel). Ne renvoie aucun email.',
      mutating: true,
      outbound: false,
      compliance: 'medium',
      // Fait DÉCLARÉ par l'artisan qui date un suivi légal (rappels J+2, carte Encaissement) :
      // plancher de consentement — même doctrine que lier_bon_commande.
      safetyFloor: true,
      riskTier: 'reversible',
      parse: (raw): Result<RecordInvoiceTransmissionActionInput, AppError> => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
          return err(appValidation('transmission', 'Transmission invalide.'));
        const r = raw as Record<string, unknown>;
        const allowed = new Set(['invoiceId', 'depositedAt', 'acceptedAt']);
        if (Object.keys(r).some((key) => !allowed.has(key)))
          return err(appValidation('transmission', 'Champ de transmission inconnu.'));
        if (typeof r.invoiceId !== 'string' || r.invoiceId.length === 0 || r.invoiceId.length > 200)
          return err(appValidation('invoiceId', 'Facture manquante.'));
        const parseDate = (field: 'depositedAt' | 'acceptedAt'): Result<string | null | undefined, AppError> => {
          if (!(field in r)) return ok(undefined);
          const value = r[field];
          if (value === null) return ok(null);
          if (typeof value !== 'string' || !isValidDateOnly(value))
            return err(appValidation(field, 'Date déclarée invalide (AAAA-MM-JJ ou null).'));
          return ok(value);
        };
        const depositedAt = parseDate('depositedAt');
        if (!depositedAt.ok) return depositedAt;
        const acceptedAt = parseDate('acceptedAt');
        if (!acceptedAt.ok) return acceptedAt;
        if (depositedAt.value === undefined && acceptedAt.value === undefined)
          return err(appValidation('transmission', 'Au moins une date déclarée est requise (depositedAt | acceptedAt).'));
        return ok({
          invoiceId: r.invoiceId,
          ...(depositedAt.value !== undefined ? { depositedAt: depositedAt.value } : {}),
          ...(acceptedAt.value !== undefined ? { acceptedAt: acceptedAt.value } : {}),
        });
      },
      projectPublicResult: (output): ToolPublicResult => ({
        depositedAt: output.transmission?.depositedAt ?? null,
        acceptedAt: output.transmission?.acceptedAt ?? null,
      }),
      run: (input) => recordInvoiceTransmissionAction(input),
    };
    tools.push(marquerTransmise as AnyTool);
  }

  // —— Outils OPTIONNELS cadence de relances (PR-06) : lecture de la politique en vigueur et
  // bascule CONFIRMÉE des relances automatiques — MÊME source CompanyBillingSettings que
  // l'écran Réglages facturation. La cadence fine (4 paliers) reste réglée à l'écran.
  const getRelanceSettingsAction = actions.getRelanceSettings?.bind(actions);
  if (getRelanceSettingsAction) {
    const cadenceRelances: Tool<Record<string, never>, RelanceSettingsView> = {
      name: 'cadence_relances',
      description:
        'Lit la politique de relances de la société : cadence (J+n après échéance pour chaque palier cordial/neutre/ferme/mise en demeure) et état des relances automatiques. Lecture seule.',
      mutating: false,
      outbound: false,
      compliance: 'low',
      riskTier: 'read',
      parse: () => ok({}),
      run: () => getRelanceSettingsAction(),
    };
    tools.push(cadenceRelances as AnyTool);
  }

  const setRelanceAutoEnabledAction = actions.setRelanceAutoEnabled?.bind(actions);
  if (setRelanceAutoEnabledAction) {
    const reglerRelancesAuto: Tool<SetRelanceAutoActionInput, RelanceSettingsView> = {
      name: 'regler_relances_auto',
      description:
        'Active ou coupe les relances AUTOMATIQUES de la société (« coupe les relances automatiques ») — même réglage que l’écran Réglages facturation. La relance manuelle reste toujours possible. Ne déclenche aucun envoi immédiat.',
      mutating: true,
      outbound: false,
      compliance: 'medium',
      // Ce réglage conditionne des EMAILS CLIENTS récurrents (cron) : plancher de consentement —
      // jamais basculé sans confirmation, même en autonomie 'auto'.
      safetyFloor: true,
      riskTier: 'reversible',
      parse: (raw): Result<SetRelanceAutoActionInput, AppError> => {
        const r = raw as { enabled?: unknown };
        if (typeof r?.enabled !== 'boolean')
          return err(appValidation('enabled', 'Booléen « relances automatiques » requis.'));
        return ok({ enabled: r.enabled });
      },
      projectPublicResult: (output): ToolPublicResult => ({
        relanceAutoEnabled: output.relanceAutoEnabled,
      }),
      run: (input) => setRelanceAutoEnabledAction(input),
    };
    tools.push(reglerRelancesAuto as AnyTool);
  }

  // —— Enregistrement d'un règlement fournisseur déjà effectué : ce tool ne déclenche JAMAIS
  // de transfert. Date et moyen explicites sont requis avant la proposition comptable.
  const recordExpensePaymentAction = actions.recordExpensePayment?.bind(actions);
  if (recordExpensePaymentAction) {
    const enregistrerReglement: Tool<
      RecordExpensePaymentActionInput,
      { status: string; alreadyRecorded: boolean; paymentEntryId: string }
    > = {
      name: 'enregistrer_reglement_depense',
      description:
        'Enregistre la preuve d’un règlement fournisseur déjà effectué hors de Bob, puis écrit 401/512 ou 401/530 selon le moyen. N’initie aucun virement. Date et moyen obligatoires.',
      mutating: true,
      outbound: false,
      compliance: 'high',
      riskTier: 'accounting',
      parse: (raw): Result<RecordExpensePaymentActionInput, AppError> => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
          return err(appValidation('payment', 'Preuve de règlement invalide.'));
        const r = raw as Record<string, unknown>;
        const allowed = new Set(['expenseId', 'paidOn', 'method', 'reference', 'proofDocumentId']);
        if (Object.keys(r).some((key) => !allowed.has(key)))
          return err(appValidation('payment', 'Champ de règlement inconnu.'));
        if (typeof r.expenseId !== 'string' || r.expenseId.length === 0 || r.expenseId.length > 200)
          return err(appValidation('expenseId', 'Dépense manquante.'));
        if (typeof r.paidOn !== 'string' || !isValidDateOnly(r.paidOn))
          return err(appValidation('paidOn', 'Date réelle du règlement requise.'));
        if (r.method !== 'card' && r.method !== 'transfer' && r.method !== 'cash')
          return err(appValidation('method', 'Moyen de règlement requis.'));
        const optionalBounded = (
          value: unknown,
          field: string,
          max: number,
        ): Result<string | null, AppError> => {
          if (value === undefined || value === null) return ok(null);
          if (typeof value !== 'string' || !value.trim() || value.length > max || hasAsciiControlCharacter(value))
            return err(appValidation(field, `Valeur invalide (${max} caractères maximum).`));
          return ok(value.trim());
        };
        const reference = optionalBounded(r.reference, 'reference', EXPENSE_PAYMENT_REFERENCE_MAX_LENGTH);
        if (!reference.ok) return reference;
        const proof = optionalBounded(
          r.proofDocumentId,
          'proofDocumentId',
          EXPENSE_PAYMENT_PROOF_DOCUMENT_ID_MAX_LENGTH,
        );
        if (!proof.ok) return proof;
        return ok({
          expenseId: r.expenseId,
          paidOn: r.paidOn,
          method: r.method,
          ...(reference.value !== null ? { reference: reference.value } : {}),
          ...(proof.value !== null ? { proofDocumentId: proof.value } : {}),
        });
      },
      run: (input) => recordExpensePaymentAction(input),
    };
    tools.push(enregistrerReglement as AnyTool);
  }

  // —— Outil OPTIONNEL lier_depense_chantier (M3) : « mets la dépense Aldi sur le chantier
  // Durand » — MÊME use case AssignExpenseToChantier (@bob/core) que PUT /expenses/:id/chantier
  // et l'écran Dépenses. Anti-IDOR fail-closed côté core (chantier PROUVÉ dans le tenant),
  // idempotent (changed:false sans écriture). Aucune écriture comptable, aucune dépense créée.
  const assignExpenseChantierAction = actions.assignExpenseChantier?.bind(actions);
  if (assignExpenseChantierAction) {
    const lierDepenseChantier: Tool<AssignExpenseChantierActionInput, AssignExpenseChantierActionOutput> = {
      name: 'lier_depense_chantier',
      description:
        'Impute une dépense existante à un chantier ouvert du tenant (rentabilité par chantier) — ou la délie (chantierId null). Même use case que l’écran Dépenses. Ne crée aucune dépense, ne touche pas aux livres.',
      mutating: true,
      outbound: false,
      compliance: 'medium',
      // Imputation analytique remplaçable, MAIS sans vue d'annulation vocale et elle change la
      // rentabilité affichée par chantier : plancher de consentement — jamais liée sans
      // confirmation, même en autonomie 'auto' (décision M3).
      safetyFloor: true,
      riskTier: 'reversible',
      parse: (raw): Result<AssignExpenseChantierActionInput, AppError> => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
          return err(appValidation('assignment', 'Imputation invalide.'));
        const r = raw as Record<string, unknown>;
        const allowed = new Set(['expenseId', 'chantierId']);
        if (Object.keys(r).some((key) => !allowed.has(key)))
          return err(appValidation('assignment', 'Champ d’imputation inconnu.'));
        if (typeof r.expenseId !== 'string' || r.expenseId.length === 0 || r.expenseId.length > 200)
          return err(appValidation('expenseId', 'Dépense manquante.'));
        // null EXPLICITE = délier ; clé absente ≠ null (même contrat que PUT /expenses/:id/chantier).
        if (!('chantierId' in r))
          return err(appValidation('chantierId', 'Chantier requis (ou null explicite pour délier).'));
        if (r.chantierId !== null) {
          if (
            typeof r.chantierId !== 'string' ||
            r.chantierId.length === 0 ||
            r.chantierId.length > 200 ||
            r.chantierId !== r.chantierId.trim() ||
            hasAsciiControlCharacter(r.chantierId)
          )
            return err(appValidation('chantierId', 'Chantier d’imputation invalide.'));
        }
        return ok({ expenseId: r.expenseId, chantierId: r.chantierId as string | null });
      },
      projectPublicResult: (output): ToolPublicResult => ({
        chantierId: output.chantierId,
        changed: output.changed,
      }),
      run: (input) => assignExpenseChantierAction(input),
    };
    tools.push(lierDepenseChantier as AnyTool);
  }

  // —— Outil OPTIONNEL marquer_notifications_lues : même commande atomique que l'écran.
  // Le cutoff provient exclusivement du preview serveur et fige le lot avant le consentement :
  // une notification reçue pendant la confirmation reste non lue.
  const markNotificationsReadThroughAction = actions.markNotificationsReadThrough?.bind(actions);
  if (markNotificationsReadThroughAction) {
    const marquerNotificationsLues: Tool<NotificationReadThroughInput, NotificationReadThroughOutput> = {
      name: 'marquer_notifications_lues',
      description:
        'Marque comme lues toutes les notifications qui existaient lors de l’aperçu serveur, sans inclure celles arrivées pendant la confirmation.',
      mutating: true,
      outbound: false,
      compliance: 'low',
      // Pas encore de commande « remettre en non lu » : consentement obligatoire même en auto.
      safetyFloor: true,
      riskTier: 'reversible',
      parse: (raw): Result<NotificationReadThroughInput, AppError> => {
        const r = raw as { throughCreatedAt?: unknown };
        if (
          typeof r?.throughCreatedAt !== 'string' ||
          !ISO_INSTANT.test(r.throughCreatedAt) ||
          Number.isNaN(Date.parse(r.throughCreatedAt))
        ) {
          return err(appValidation('throughCreatedAt', 'Aperçu des notifications invalide ou expiré.'));
        }
        return ok({ throughCreatedAt: r.throughCreatedAt });
      },
      projectPublicResult: (output): ToolPublicResult => ({ updatedCount: output.updatedCount }),
      run: (input) => markNotificationsReadThroughAction(input),
    };
    tools.push(marquerNotificationsLues as AnyTool);
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

  // —— Outil OPTIONNEL etat_abonnement (pilier 2) : lecture SEULE de l'abonnement/essai du
  // tenant (GetSubscriptionStatus @bob/core — la même vérité que l'écran Compte). Jamais un
  // acte d'achat vocal (SPEC décision 10) : l'outil informe, l'engagement se confirme au tap.
  const getSubscriptionStatusAction = actions.getSubscriptionStatus?.bind(actions);
  if (getSubscriptionStatusAction) {
    const etatAbonnement: Tool<Record<string, never>, SubscriptionStatusView> = {
      name: 'etat_abonnement',
      description:
        'Lit l’état d’abonnement du compte : offre en cours, essai (jours restants, échéance), statut de paiement. Lecture seule — aucun achat ni changement d’offre par la voix.',
      mutating: false,
      outbound: false,
      compliance: 'low',
      parse: () => ok({}),
      riskTier: 'read',
      run: () => getSubscriptionStatusAction(),
    };
    tools.push(etatAbonnement as AnyTool);
  }

  // —— Outil OPTIONNEL valider_document (parité « papa vocal ») : « c'est bon, valide le
  // ticket » pose reviewedAt via AcknowledgeDocument @bob/core — MÊME use case que le bouton
  // « Confirmer » de la file « À valider ». Latch idempotent : jamais de validation réécrite.
  const acknowledgeDocumentAction = actions.acknowledgeDocument?.bind(actions);
  if (acknowledgeDocumentAction) {
    const validerDocument: Tool<AcknowledgeDocumentActionInput, AcknowledgeDocumentActionOutput> = {
      name: 'valider_document',
      description:
        'Confirme la lecture d’un document scanné déjà rangé (« c’est bon, je valide ») : le document sort de la file « À valider ». Ne déplace rien, ne lie rien, n’écrit rien dans les livres.',
      mutating: true,
      outbound: false,
      compliance: 'medium',
      // Marqueur de lecture interne (palier descriptif reversible), MAIS latch sans commande
      // d'annulation (reviewedAt n'est jamais réécrit) : plancher de consentement — la
      // validation reste un geste de l'artisan, même en autonomie 'auto'.
      safetyFloor: true,
      riskTier: 'reversible',
      parse: (raw): Result<AcknowledgeDocumentActionInput, AppError> => {
        const r = raw as { documentId?: unknown };
        if (typeof r?.documentId !== 'string' || r.documentId.length === 0)
          return err(appValidation('documentId', 'Document manquant.'));
        return ok({ documentId: r.documentId });
      },
      projectPublicResult: (output): ToolPublicResult => ({
        documentId: output.documentId,
        reviewedAt: output.reviewedAt,
      }),
      run: (input) => acknowledgeDocumentAction(input),
    };
    tools.push(validerDocument as AnyTool);
  }

  // —— Outil OPTIONNEL classer_document (parité « papa vocal ») : « range le ticket Aldi dans
  // le chantier Durand » — MÊME séquence que le geste « Classer là » mobile (MoveDocumentToFolder
  // + ClassifyDocument + nom intelligent, règle suggestedRenameFor côté hôte). Les destinations
  // sont résolues par le handler contre les listes RÉELLES du tenant — jamais un id inventé.
  const fileDocumentAction = actions.fileDocument?.bind(actions);
  if (fileDocumentAction) {
    const classerDocument: Tool<FileDocumentActionInput, FileDocumentActionOutput> = {
      name: 'classer_document',
      description:
        'Classe un document du coffre — même geste que « Classer là » : déplacement vers un dossier réel OU lien à un chantier ouvert (avec rangement dans « Chantiers » si le document n’a pas encore de dossier), puis nom intelligent (jamais par-dessus un renommage humain).',
      mutating: true,
      outbound: false,
      compliance: 'medium',
      // Le rangement POSE la validation humaine (reviewedAt, latch sans annulation) et un lien
      // métier : plancher de consentement — le classement reste un geste de l'artisan, même en 'auto'.
      safetyFloor: true,
      riskTier: 'reversible',
      parse: (raw): Result<FileDocumentActionInput, AppError> => {
        const r = raw as { documentId?: unknown; destination?: unknown };
        if (typeof r?.documentId !== 'string' || r.documentId.length === 0)
          return err(appValidation('documentId', 'Document manquant.'));
        const d = r.destination as { kind?: unknown; chantierId?: unknown; folderId?: unknown } | null | undefined;
        if (typeof d !== 'object' || d === null || Array.isArray(d))
          return err(appValidation('destination', 'Destination manquante.'));
        if (d.kind === 'chantier') {
          if (typeof d.chantierId !== 'string' || d.chantierId.length === 0)
            return err(appValidation('destination.chantierId', 'Chantier manquant.'));
          return ok({ documentId: r.documentId, destination: { kind: 'chantier', chantierId: d.chantierId } });
        }
        if (d.kind === 'folder') {
          if (typeof d.folderId !== 'string' || d.folderId.length === 0)
            return err(appValidation('destination.folderId', 'Dossier manquant.'));
          return ok({ documentId: r.documentId, destination: { kind: 'folder', folderId: d.folderId } });
        }
        return err(appValidation('destination.kind', 'Destination invalide (chantier | folder).'));
      },
      projectPublicResult: (output): ToolPublicResult => ({
        documentId: output.documentId,
        folderId: output.folderId,
        displayName: output.displayName,
      }),
      run: (input) => fileDocumentAction(input),
    };
    tools.push(classerDocument as AnyTool);
  }

  // —— Outil OPTIONNEL renommer_document : « renomme-le facture matériaux salle de bain » —
  // MÊME use case RenameDocument que l'écran détail. Le nom dicté devient un renommage HUMAIN :
  // prioritaire, plus jamais écrasé par une suggestion d'analyse (d'où le plancher de consentement).
  const renameDocumentAction = actions.renameDocument?.bind(actions);
  if (renameDocumentAction) {
    const renommerDocument: Tool<RenameDocumentActionInput, RenameDocumentActionOutput> = {
      name: 'renommer_document',
      description:
        'Renomme le libellé d’affichage d’un document du coffre. Le nom donné devient prioritaire : les suggestions automatiques ne l’écraseront plus. Ne déplace rien, ne lie rien.',
      mutating: true,
      outbound: false,
      compliance: 'low',
      // Promotion en renommage humain SANS commande d'annulation de cette priorité : plancher
      // de consentement — même en autonomie 'auto', le nom reste un choix de l'artisan.
      safetyFloor: true,
      riskTier: 'reversible',
      parse: (raw): Result<RenameDocumentActionInput, AppError> => {
        const r = raw as { documentId?: unknown; displayName?: unknown };
        if (typeof r?.documentId !== 'string' || r.documentId.length === 0)
          return err(appValidation('documentId', 'Document manquant.'));
        // MÊME règle de domaine que l'écran (validateDocumentDisplayName @bob/core) : espaces
        // réduits, borné, sans caractère de contrôle — jamais deux validations à faire dériver.
        const validated = validateDocumentDisplayName(r.displayName);
        if (!validated.ok) {
          return err(
            appValidation(
              'displayName',
              'message' in validated.error ? validated.error.message : 'Nom d’affichage invalide.',
            ),
          );
        }
        return ok({ documentId: r.documentId, displayName: validated.value });
      },
      projectPublicResult: (output): ToolPublicResult => ({
        documentId: output.documentId,
        displayName: output.displayName,
      }),
      run: (input) => renameDocumentAction(input),
    };
    tools.push(renommerDocument as AnyTool);
  }

  // —— Outil OPTIONNEL chercher_document : lecture pure de la recherche devis & factures
  // (GET /documents/search — ranking serveur pg_trgm). Aucun résultat inventé, aucune mutation.
  const searchDocumentsAction = actions.searchDocuments?.bind(actions);
  if (searchDocumentsAction) {
    const chercherDocument: Tool<SearchDocumentsActionInput, SearchDocumentsActionOutput> = {
      name: 'chercher_document',
      description:
        'Retrouve des devis et factures réels par mots-clés (objet, client, numéro) et période — même recherche que l’écran (« retrouve la facture du radiateur de mars »). Lecture seule.',
      mutating: false,
      outbound: false,
      compliance: 'medium',
      riskTier: 'read',
      parse: (raw): Result<SearchDocumentsActionInput, AppError> => {
        const r = raw as { query?: unknown; scope?: unknown; from?: unknown; to?: unknown };
        if (typeof r?.query !== 'string' || r.query.length > 200)
          return err(appValidation('query', 'Requête de recherche invalide.'));
        const query = r.query.replace(/\s+/g, ' ').trim();
        if (r.scope !== undefined && r.scope !== 'quote' && r.scope !== 'invoice' && r.scope !== 'all')
          return err(appValidation('scope', 'Portée invalide (quote | invoice | all).'));
        if (r.from !== undefined && !(typeof r.from === 'string' && DATE_ONLY.test(r.from)))
          return err(appValidation('from', 'Début de période (YYYY-MM-DD) invalide.'));
        if (r.to !== undefined && !(typeof r.to === 'string' && DATE_ONLY.test(r.to)))
          return err(appValidation('to', 'Fin de période (YYYY-MM-DD) invalide.'));
        if (typeof r.from === 'string' && typeof r.to === 'string' && r.to < r.from)
          return err(appValidation('to', 'La fin de période précède le début.'));
        // Sans mot-clé, une période est requise : jamais un ratissage vide non demandé.
        if (query.length === 0 && r.from === undefined && r.to === undefined)
          return err(appValidation('query', 'Mots-clés ou période requis.'));
        return ok({
          query,
          ...(r.scope !== undefined ? { scope: r.scope as NonNullable<SearchDocumentsActionInput['scope']> } : {}),
          ...(typeof r.from === 'string' ? { from: r.from } : {}),
          ...(typeof r.to === 'string' ? { to: r.to } : {}),
        });
      },
      run: (input) => searchDocumentsAction(input),
    };
    tools.push(chercherDocument as AnyTool);
  }

  // —— Outil OPTIONNEL lier_bon_commande (B8) : « la RATP m'a envoyé un bon de commande
  // n° 4500123 » — MÊME use case AttachPurchaseOrderToQuote que l'écran devis. Le numéro
  // d'engagement conditionne le PAIEMENT de la facture (grands comptes, Chorus Pro) : il est
  // assaini par l'AUTORITÉ du domaine (makePurchaseOrderRef), jamais par une règle locale.
  const attachPurchaseOrderAction = actions.attachPurchaseOrderToQuote?.bind(actions);
  if (attachPurchaseOrderAction) {
    const lierBonCommande: Tool<AttachPurchaseOrderActionInput, AttachPurchaseOrderActionOutput> = {
      name: 'lier_bon_commande',
      description:
        'Attache le numéro d’engagement d’un bon de commande client (grands comptes, secteur public/Chorus Pro) à un devis. Le numéro sera repris automatiquement sur la facture dérivée. Ne crée ni devis ni facture, ne touche pas aux documents du coffre.',
      mutating: true,
      outbound: false,
      compliance: 'medium',
      // Mutation interne remplaçable (re-attache/retrait possibles tant que non facturé), MAIS
      // le numéro est un FAIT déclaré par l'artisan et conditionne le paiement de la facture :
      // plancher de consentement — jamais lié sans confirmation, même en autonomie 'auto'.
      safetyFloor: true,
      riskTier: 'reversible',
      parse: (raw): Result<AttachPurchaseOrderActionInput, AppError> => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
          return err(appValidation('purchaseOrder', 'Bon de commande invalide.'));
        const r = raw as Record<string, unknown>;
        const allowed = new Set(['quoteId', 'number']);
        if (Object.keys(r).some((key) => !allowed.has(key)))
          return err(appValidation('purchaseOrder', 'Champ de bon de commande inconnu.'));
        if (typeof r.quoteId !== 'string' || r.quoteId.length === 0 || r.quoteId.length > 200)
          return err(appValidation('quoteId', 'Devis manquant.'));
        if (typeof r.number !== 'string')
          return err(appValidation('number', 'Numéro de bon de commande requis.'));
        // AUTORITÉ du domaine : assainissement (espaces), longueur (1..60) et caractères de
        // contrôle sont jugés par makePurchaseOrderRef — une seule vérité, jamais dupliquée.
        const ref = makePurchaseOrderRef({ number: r.number });
        if (!ref.ok) {
          return err(
            appValidation(
              'number',
              'message' in ref.error ? ref.error.message : 'Numéro de bon de commande invalide.',
            ),
          );
        }
        return ok({ quoteId: r.quoteId, number: ref.value.number });
      },
      projectPublicResult: (output): ToolPublicResult => ({
        quoteId: output.quoteId,
        quoteNumber: output.quoteNumber,
        purchaseOrderNumber: output.purchaseOrderNumber,
        invoiceable: output.invoiceable,
      }),
      run: (input) => attachPurchaseOrderAction(input),
    };
    tools.push(lierBonCommande as AnyTool);
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

  // —— PR-11 — parc d'équipements d'un site : MÊMES use cases que l'écran parc (parité). ——
  const listEquipmentsAction = actions.listEquipments?.bind(actions);
  if (listEquipmentsAction) {
    const parcDuSite: Tool<{ chantierId?: string }, unknown> = {
      name: 'parc_du_site',
      description:
        'Liste les équipements du parc (par site, ou tout le tenant) — lecture pure, jamais un équipement inventé.',
      mutating: false,
      outbound: false,
      compliance: 'low',
      riskTier: 'read',
      parse: (raw): Result<{ chantierId?: string }, AppError> => {
        const r = raw as { chantierId?: unknown };
        if (r?.chantierId !== undefined && (typeof r.chantierId !== 'string' || r.chantierId.length === 0))
          return err(appValidation('chantierId', 'Site ciblé invalide.'));
        return ok({ ...(typeof r?.chantierId === 'string' ? { chantierId: r.chantierId } : {}) });
      },
      run: async (input) => {
        const all = await listEquipmentsAction();
        if (!all.ok) return all;
        return ok(
          input.chantierId === undefined
            ? all.value
            : all.value.filter((equipment) => equipment.chantierId === input.chantierId),
        );
      },
    };
    tools.push(parcDuSite as AnyTool);
  }

  const createEquipmentAction = actions.createEquipment?.bind(actions);
  if (createEquipmentAction) {
    const ajouterEquipement: Tool<CreateEquipmentActionInput, { id: string }> = {
      name: 'ajouter_equipement',
      description:
        'Ajoute un équipement au parc d’un site (« ajoute la clim du local serveur chez Carrefour ») — même use case CreateEquipment que l’écran ; le site doit être ouvert.',
      mutating: true,
      outbound: false,
      compliance: 'low',
      // Conception vocale P1 (§1.6) : UNE confirmation groupée avant la SEULE mutation — et
      // pas de vue d'annulation vocale : plancher de consentement (décision M3 transposée).
      safetyFloor: true,
      riskTier: 'reversible',
      parse: (raw): Result<CreateEquipmentActionInput, AppError> => {
        const r = raw as {
          chantierId?: unknown;
          label?: unknown;
          kind?: unknown;
          brand?: unknown;
          serialNumber?: unknown;
          location?: unknown;
          installedAt?: unknown;
          warrantyUntil?: unknown;
        };
        if (typeof r?.chantierId !== 'string' || r.chantierId.trim().length === 0)
          return err(appValidation('chantierId', 'Site de rattachement manquant.'));
        if (typeof r?.label !== 'string' || r.label.trim().length === 0 || r.label.length > 200)
          return err(appValidation('label', 'Nom d’équipement manquant (200 caractères maximum).'));
        const freeField = (value: unknown, field: string): Result<string | undefined, AppError> => {
          if (value === undefined || value === null) return ok(undefined);
          if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200)
            return err(appValidation(field, 'Champ invalide (200 caractères maximum).'));
          return ok(value.trim());
        };
        const dateField = (value: unknown, field: string): Result<string | undefined, AppError> => {
          if (value === undefined || value === null) return ok(undefined);
          if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
            return err(appValidation(field, 'Date attendue (AAAA-MM-JJ).'));
          return ok(value);
        };
        const kind = freeField(r.kind, 'kind');
        if (!kind.ok) return kind;
        const brand = freeField(r.brand, 'brand');
        if (!brand.ok) return brand;
        const serialNumber = freeField(r.serialNumber, 'serialNumber');
        if (!serialNumber.ok) return serialNumber;
        const location = freeField(r.location, 'location');
        if (!location.ok) return location;
        const installedAt = dateField(r.installedAt, 'installedAt');
        if (!installedAt.ok) return installedAt;
        const warrantyUntil = dateField(r.warrantyUntil, 'warrantyUntil');
        if (!warrantyUntil.ok) return warrantyUntil;
        return ok({
          chantierId: r.chantierId.trim(),
          label: r.label.trim(),
          ...(kind.value !== undefined ? { kind: kind.value } : {}),
          ...(brand.value !== undefined ? { brand: brand.value } : {}),
          ...(serialNumber.value !== undefined ? { serialNumber: serialNumber.value } : {}),
          ...(location.value !== undefined ? { location: location.value } : {}),
          ...(installedAt.value !== undefined ? { installedAt: installedAt.value } : {}),
          ...(warrantyUntil.value !== undefined ? { warrantyUntil: warrantyUntil.value } : {}),
        });
      },
      run: (input) => createEquipmentAction(input),
    };
    tools.push(ajouterEquipement as AnyTool);
  }

  const retireEquipmentAction = actions.retireEquipment?.bind(actions);
  if (retireEquipmentAction) {
    const retirerEquipement: Tool<RetireEquipmentActionInput, RetireEquipmentActionOutput> = {
      name: 'retirer_equipement',
      description:
        'Retire un équipement du parc (retrait LOGIQUE réversible — l’historique reste intégral) — même use case RetireEquipment que l’écran.',
      mutating: true,
      outbound: false,
      compliance: 'low',
      // Même plancher : le retrait change la vue du parc et l'avertissement contrat doit être
      // DIT — jamais un retrait silencieux, même en autonomie 'auto'.
      safetyFloor: true,
      riskTier: 'reversible',
      parse: (raw): Result<RetireEquipmentActionInput, AppError> => {
        const r = raw as { equipmentId?: unknown };
        if (typeof r?.equipmentId !== 'string' || r.equipmentId.length === 0)
          return err(appValidation('equipmentId', 'Équipement ciblé invalide.'));
        return ok({ equipmentId: r.equipmentId });
      },
      run: (input) => retireEquipmentAction(input),
    };
    tools.push(retirerEquipement as AnyTool);
  }

  const equipmentHistoryAction = actions.getEquipmentHistory?.bind(actions);
  if (equipmentHistoryAction) {
    const historiqueEquipement: Tool<EquipmentHistoryActionInput, EquipmentHistoryActionOutput> = {
      name: 'historique_equipement',
      description:
        'Historique RÉEL d’un équipement (notes, photos, passages tagués) — même dérivation que GET /equipments/:id/history. Lecture pure.',
      mutating: false,
      outbound: false,
      compliance: 'low',
      riskTier: 'read',
      parse: (raw): Result<EquipmentHistoryActionInput, AppError> => {
        const r = raw as { equipmentId?: unknown };
        if (typeof r?.equipmentId !== 'string' || r.equipmentId.length === 0)
          return err(appValidation('equipmentId', 'Équipement ciblé invalide.'));
        return ok({ equipmentId: r.equipmentId });
      },
      run: (input) => equipmentHistoryAction(input),
    };
    tools.push(historiqueEquipement as AnyTool);
  }

  return tools;
}
