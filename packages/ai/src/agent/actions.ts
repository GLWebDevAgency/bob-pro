import {
  type Result,
  type AppError,
  type LineInput,
  type ExpenseCategory,
  type FiscalDeadline,
  type VatPosition,
  type AgedBalance,
  type TrialBalance,
  type IncomeStatement,
  type BalanceSheet,
  type BusinessReview,
  type ClosingReview,
  type SubscriptionStatusView,
  type OwnerPayGuidance,
  type PaymentMethod,
} from '@bob/core';
import {
  type ContextEntitySummary,
  type ReadContextEntityInput,
} from './context';

/** Dépense fournisseur encore à payer (BOB-1 — ciblage de payer_depense par nom). */
export interface UnpaidExpense {
  id: string;
  supplierName: string;
  totalTtcCents: number;
  documentDate: string;
}

/** Dépense RÉCENTE du tenant (M3 — ciblage vocal de lier_depense_chantier) : la SEULE matière
 * de résolution par jetons fournisseur/montant/date — jamais un id inventé par le LLM. */
export interface AgentExpense {
  id: string;
  supplierName: string;
  totalTtcCents: number;
  documentDate: string;
  /** Imputation chantier courante — null : dépense hors chantier. */
  chantierId: string | null;
}

/** Outil lier_depense_chantier (M3) : MÊME use case AssignExpenseToChantier (@bob/core) que
 * PUT /expenses/:id/chantier et l'écran Dépenses — anti-IDOR fail-closed (chantier PROUVÉ dans
 * le tenant), idempotent (ré-imputer le même chantier = changed:false, aucune écriture). */
export interface AssignExpenseChantierActionInput {
  expenseId: string;
  /** Chantier cible — ou null EXPLICITE pour délier la dépense (geste légitime). */
  chantierId: string | null;
}

export interface AssignExpenseChantierActionOutput {
  /** Imputation effective après la commande (null = hors chantier). */
  chantierId: string | null;
  /** false = retry idempotent / imputation déjà en place — aucune écriture. */
  changed: boolean;
}

/**
 * Enregistre un règlement fournisseur DEJA effectué. Bob ne déclenche aucun transfert bancaire.
 * Date et moyen sont obligatoires ; la référence et le justificatif restent des preuves optionnelles.
 */
export interface RecordExpensePaymentActionInput {
  expenseId: string;
  paidOn: string;
  method: PaymentMethod;
  reference?: string | null;
  proofDocumentId?: string | null;
}

/** Instantané serveur des notifications non lues. Le cutoff est capturé AVANT le consentement :
 * une notification arrivée pendant la confirmation reste donc non lue. */
export interface NotificationUnreadPreview {
  unreadCount: number;
  throughCreatedAt: string;
}

/** Marquage atomique de toutes les notifications qui existaient au moment du preview. */
export interface NotificationReadThroughInput {
  throughCreatedAt: string;
}

export interface NotificationReadThroughOutput {
  updatedCount: number;
  readAt: string;
}

export interface PayableInvoice {
  id: string;
  number: string;
  remainingCents: number;
  customerName: string;
}

export interface SendableQuote {
  id: string;
  number: string | null;
  customerName: string;
  totalTtcCents: number;
  status: string;
}

export interface IssuableInvoice {
  id: string;
  number: string | null;
  customerName: string;
  totalTtcCents: number;
  status: string;
}

/** Devis SIGNÉ facturable (ASK-2) — matière de generer_facture : le mode (acompte/solde)
 * est une vraie décision de facturation, posée en question structurée quand elle manque. */
export interface InvoiceableQuote {
  id: string;
  number: string | null;
  customerName: string;
  totalTtcCents: number;
  /** Acompte prévu au devis (pourcentage) — null si aucun. */
  depositPct: number | null;
  /** L'acompte a déjà été facturé : la finale devient l'évidence (aucune question). */
  depositInvoiced: boolean;
  /** B8 (OPTIONNEL, rétro-compatible) : bon de commande déjà attaché au devis — null si aucun,
   * absent chez un hôte historique. Permet à lier_bon_commande d'annoncer un remplacement. */
  purchaseOrder?: { number: string; receivedAt: string | null; documentId: string | null } | null;
  /** A3 (OPTIONNEL, rétro-compatible) : gel de rétractation B2C ACTIF sur la facture finale —
   * premier jour (YYYY-MM-DD) où elle devient possible ; null/absent = aucun gel. Le flow
   * generer_facture l'annonce HONNÊTEMENT au lieu de proposer une finale vouée au refus. */
  finalBlockedUntil?: string | null;
}

/** Outil lier_bon_commande (B8) : attache le NUMÉRO d'engagement d'un bon de commande à un
 * devis — MÊME use case AttachPurchaseOrderToQuote (@bob/core) que l'écran devis. L'outil
 * vocal V1 lie le numéro seul : le document scanné se rattache ensuite via le picker manuel
 * (champ documentId de PUT /quotes/:id/purchase-order), jamais deviné à la voix. */
export interface AttachPurchaseOrderActionInput {
  quoteId: string;
  /** Numéro d'engagement, déjà assaini par makePurchaseOrderRef (autorité du domaine). */
  number: string;
}

export interface AttachPurchaseOrderActionOutput {
  quoteId: string;
  /** Numéro du devis (affichage) — null si le devis n'est pas encore numéroté. */
  quoteNumber: string | null;
  /** Révision du devis après mutation (vue rafraîchie côté hôte). */
  revision: number;
  /** Numéro d'engagement effectivement attaché (assaini par le domaine). */
  purchaseOrderNumber: string;
  /** Le devis est signé et encore facturable (ListInvoiceableQuotes) : Bob peut proposer
   * l'enchaînement naturel vers generer_facture — la facture reprendra le numéro (core). */
  invoiceable: boolean;
}

export interface AgentDocument {
  id: string;
  filename: string;
  kind: string;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  createdAt: string;
  // —— Champs OPTIONNELS (rétro-compatibles hôtes existants) — ciblage vocal du coffre ——
  /** Libellé intelligent (renommage humain > suggestion d'analyse > filename) — « le ticket Aldi ». */
  displayName?: string;
  /** Provenance (generated | uploaded | ocr) — seul un scan (ocr) entre dans « À valider ». */
  origin?: string;
  /** Dossier de rangement — null : pas encore rangé (la validation vocale exige un doc rangé). */
  folderId?: string | null;
  /** Confirmation humaine posée (latch) — null : le doc attend encore « c'est bon, je valide ». */
  reviewedAt?: string | null;
}

/** Outil valider_document (parité humain↔Bob) : pose reviewedAt via AcknowledgeDocument @bob/core
 * — même use case que le bouton « Confirmer » de la file « À valider ». Ne déplace ni ne lie rien. */
export interface AcknowledgeDocumentActionInput {
  documentId: string;
}

/** Chantier OUVERT du tenant — cible RÉELLE de classement (jamais un id inventé par le LLM). */
export interface FilingChantier {
  id: string;
  nom: string;
}

/** Dossier du coffre (racine, actif) — cible RÉELLE de classement par nom. */
export interface FilingFolder {
  id: string;
  nom: string;
  /** Clé système (purchases/sales/projects/…) — null : dossier créé par l'artisan. */
  systemKey: string | null;
}

/** Destinations de classement du tenant (outil classer_document) : les SEULES cibles que Bob
 * peut proposer — même autorité que le contexte d'analyse documentaire (anti-hallucination). */
export interface FilingDestinations {
  chantiers: FilingChantier[];
  dossiers: FilingFolder[];
}

/** Destination d'un classement vocal — chantier ouvert (lien métier) OU dossier du coffre. */
export type FileDocumentDestination =
  | { kind: 'chantier'; chantierId: string }
  | { kind: 'folder'; folderId: string };

/** Outil classer_document : MÊME séquence que le geste « Classer là » mobile —
 * MoveDocumentToFolder + ClassifyDocument (chantier) + nom intelligent (règle suggestedRenameFor :
 * jamais par-dessus un renommage humain). L'hôte exécute la séquence via les MÊMES use cases. */
export interface FileDocumentActionInput {
  documentId: string;
  destination: FileDocumentDestination;
}

export interface FileDocumentActionOutput {
  documentId: string;
  folderId: string | null;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  /** Libellé après classement (nom intelligent appliqué, ou libellé humain conservé). */
  displayName: string;
}

/** Outil renommer_document : RenameDocument (@bob/core) — le nom donné devient un renommage
 * HUMAIN prioritaire (les suggestions d'analyse ne l'écraseront plus jamais). */
export interface RenameDocumentActionInput {
  documentId: string;
  displayName: string;
}

export interface RenameDocumentActionOutput {
  documentId: string;
  displayName: string;
}

/** Outil chercher_document : recherche RÉELLE devis & factures (GET /documents/search côté API,
 * pg_trgm) — lecture pure, mêmes résultats que l'écran de recherche. */
export interface SearchDocumentsActionInput {
  query: string;
  scope?: 'quote' | 'invoice' | 'all';
  /** Bornes incluses (YYYY-MM-DD) — dérivées d'un mois dit (« de mars »), jamais devinées. */
  from?: string;
  to?: string;
}

export interface AgentSearchHit {
  source: 'quote' | 'invoice';
  id: string;
  number: string | null;
  customerName: string;
  status: string;
  date: string | null;
  totalTtcCents: number;
  /** Libellé de LIGNE ayant matché (« radiateur ») — null si le match vient du numéro/client. */
  matchedLineLabel: string | null;
}

export interface SearchDocumentsActionOutput {
  hits: AgentSearchHit[];
  totalCount: number;
}

export interface AcknowledgeDocumentActionOutput {
  documentId: string;
  /** Horodatage de validation posé (ou conservé — latch : la première validation fait foi). */
  reviewedAt: string;
}

/** Outil relance_brouillon (parité C15 TODO ① — C25) : cible optionnelle. Sans cible, l'hôte
 * prépare la relance la plus urgente (retard le plus long puis montant — plan @bob/core). */
export interface DraftRelanceActionInput {
  /** Facture précise à relancer (prioritaire sur customerId si les deux sont fournis). */
  invoiceId?: string;
  /** Client à relancer (sa facture échue la plus urgente). */
  customerId?: string;
}

/** Outil envoyer_relance (parité C15 TODO ② — C25) : envoi RÉEL de la relance d'une facture
 * échue (email au client + miroir push), ton choisi par le plan @bob/core côté hôte/serveur.
 * Sortant vers un tiers — TOUJOURS confirmé (plancher), mise en demeure incluse (régime légal
 * selon le type de client : pro L441-10, particulier code civil, acheteur public CCP — P01). */
export interface SendRelanceActionInput {
  invoiceId: string;
}

export interface SendRelanceActionOutput {
  jobId: string;
  /** done | pending | failed (échec = job en retry côté serveur, cause loggée). */
  status: string;
  /** Ton effectivement envoyé (cordial | neutre | ferme | miseendemeure). */
  tone?: string;
}

/** Outil creer_devis (parité C15 TODO ④) — mêmes entrées que le use case CreateQuote de l'UI. */
export interface CreateQuoteActionInput {
  customerId: string;
  lines: LineInput[];
  depositPct?: number;
}

/** Règlement DÉJÀ effectué déclaré à la création (M4 — dépense dictée « j'ai dépensé 89 € chez
 * Leroy Merlin en carte ») : la dépense naît PAYÉE avec sa preuve (RecordExpense.payment @bob/core),
 * au lieu d'un « à payer » absurde qu'il faudrait re-régler. */
export interface RecordExpenseSettlementDeclaration {
  /** DateOnly (YYYY-MM-DD) du règlement réel — jamais devinée. */
  paidOn: string;
  method: PaymentMethod;
  reference?: string | null;
}

/** Outil scan_depense (parité C15 TODO ③) — mêmes entrées que RecordExpense (l'OCR reste côté UI). */
export interface RecordExpenseActionInput {
  supplierName: string;
  totalTtcCents: number;
  category: ExpenseCategory;
  /** DateOnly (YYYY-MM-DD) — défaut : aujourd'hui, résolu par l'hôte (device/serveur). */
  documentDate?: string;
  vatRatePct?: number | null;
  /** M4 (additif) — dépense née imputée : chantier PROUVÉ dans le tenant par l'hôte
   * (RecordExpense.chantierId + deps.chantierTargets, anti-IDOR fail-closed du core). */
  chantierId?: string | null;
  /** M4 (additif) — dépense dictée déjà réglée : naît payée avec sa preuve ; absent → « à payer ». */
  payment?: RecordExpenseSettlementDeclaration | null;
}

/** Outil generer_facture (parité C15 TODO ⑤) — même use case GenerateInvoiceFromQuote que l'UI. */
export interface GenerateInvoiceActionInput {
  quoteId: string;
  /** Choix explicite obligatoire : une relance réseau ne doit jamais changer le type de facture. */
  mode: 'deposit' | 'final';
  /**
   * Override RESPONSABILISÉ de l'embargo L221-10 (contrat hors établissement B2C) — `true`
   * strict UNIQUEMENT, jamais implicite : Bob reformule d'abord le risque concret (le refus
   * serveur porte `overrideRisk`) et exige la même confirmation explicite que le bouton
   * (safetyFloor du tool). L'événement payment.embargo_overridden est journalisé serveur.
   */
  embargoOverride?: boolean;
}

/** Outil programmer_encaissement_embargo — DÉFAUT légal du refus d'encaissement L221-10 :
 * message client programmé au premier jour exigible (outbox serveur planifiée, annulable). */
export interface ScheduleEmbargoPaymentActionInput {
  quoteId: string;
}

export interface ScheduleEmbargoPaymentActionOutput {
  /** Instant (ISO) de la livraison planifiée du message client. */
  scheduledFor: string;
  /** Premier jour calendaire (AAAA-MM-JJ) où le paiement peut être demandé. */
  availableFrom: string;
  jobId: string;
  status: string;
}

/** Outil export_fec (parité C15 TODO ⑥) — mêmes entrées que ExportFec ; l'agent reçoit le RÉSUMÉ,
 * jamais le contenu du fichier (volume + le téléchargement reste un geste UI). */
export interface ExportFecActionInput {
  /** DateOnly (YYYY-MM-DD), période inclusive. */
  from: string;
  to: string;
}

export interface FecExportSummary {
  filename: string;
  entryCount: number;
  rowCount: number;
  warnings: string[];
}

/** Outil creer_client (TODO partagé C12/C40) — création MINIMALE (nom + type) ; l'hôte complète les
 * défauts neutres (adresse vide, score 100, encours 0) via le MÊME use case createCustomer que l'UI. */
export interface CreateCustomerActionInput {
  name: string;
  type: 'b2c' | 'b2b' | 'b2g';
}

/**
 * Surface d'actions de Bob — implémentée par l'app via le BobClient (donc le domaine/use cases).
 * INVARIANT DE PARITÉ : chaque action faisable à la main dans l'UI a ici sa méthode, et les deux
 * passent par le MÊME use case. Bob ne peut donc rien faire que l'utilisateur ne puisse faire, et
 * inversement. Les outils (registry) délèguent à ces méthodes sans logique métier propre.
 */
export interface BobActions {
  // —— Lecture ——
  /** Resume factuel de l'entite actuellement affichee. Le contexte UI n'est qu'un indice :
   * l'hote recharge obligatoirement l'entite tenant-scoped avant de construire ce resume. */
  readContextEntity?(input: ReadContextEntityInput): Promise<Result<ContextEntitySummary, AppError>>;
  computePayout(): Promise<Result<{ payoutCents: number; availableCents: number }, AppError>>;
  /** Phase 1C (SPEC_EXPERT_FISCAL §V2 pt. 1+6) : langage/montant du prélèvement adapté au profil
   * fiscal CONFIRMÉ — MÊME use case pur `deriveOwnerPayGuidance` (@bob/core) que les écrans Argent/
   * Aujourd'hui, pour que la réponse parlée de « combien je peux me verser ? » utilise les mêmes
   * kinds/montants qu'à l'écran (parité). Optionnelle : rétro-compatible — un hôte qui ne
   * l'implémente pas retombe sur `computePayout()` (le langage prudent historique, inchangé). */
  getOwnerPayGuidance?(): Promise<Result<{ guidance: OwnerPayGuidance; payoutCents: number }, AppError>>;
  /** Brouillon de relance — CIBLABLE par facture/client (C25 ①). Défaut sans cible : la plus
   * urgente. Les hôtes historiques sans paramètre restent assignables (TODO Codex apps/api :
   * porter la cible côté serveur — voir rapport C25). */
  draftRelance(input?: DraftRelanceActionInput): Promise<Result<{ subject: string; body: string }, AppError>>;
  listPayableInvoices(): Promise<Result<PayableInvoice[], AppError>>;
  listSendableQuotes(): Promise<Result<SendableQuote[], AppError>>;
  listIssuableInvoices(): Promise<Result<IssuableInvoice[], AppError>>;
  /** Devis signés facturables (ASK-2, optionnelle) — cible de generer_facture ; le handler
   * pose la question acompte/solde quand le devis prévoit un acompte non encore facturé. */
  listInvoiceableQuotes?(): Promise<Result<InvoiceableQuote[], AppError>>;
  listDocuments(): Promise<Result<AgentDocument[], AppError>>;
  // —— Lecture, OPTIONNELLE (C-EXP5b) ——
  /** Échéances fiscales à venir (TVA/URSSAF/IS/CFE/comptes annuels) — MÊME use case
   * deriveFiscalCalendar (@bob/core) que GET /fiscal-calendar et l'écran : l'hôte délègue au
   * BobClient, AUCUNE logique fiscale côté ai/. Optionnelle : rétro-compatible hôtes existants. */
  listFiscalDeadlines?(): Promise<Result<FiscalDeadline[], AppError>>;
  /** État d'abonnement/essai du tenant (pilier 2) — LECTURE SEULE : « où en est mon essai ? »
   * répond depuis GetSubscriptionStatus (@bob/core), la même vérité que l'écran Compte.
   * JAMAIS un acte d'achat vocal (SPEC décision 10) : tout engagement payant se confirme au TAP. */
  getSubscriptionStatus?(): Promise<Result<SubscriptionStatusView, AppError>>;
  // —— Lecture, OPTIONNELLES (BOB-1 — l'expert-comptable de poche) ——
  /** Position de TVA réelle (deriveVatPosition @bob/core : collectée sur ENCAISSEMENTS −
   * déductible mentionnée) — « combien de TVA je dois ? » lit LE chiffre du cashflow. */
  getVatPosition?(): Promise<Result<VatPosition, AppError>>;
  /** Balance âgée clients (deriveAgedBalance @bob/core) — « qui me doit quoi ? ». */
  getAgedBalance?(): Promise<Result<AgedBalance, AppError>>;
  /** Dépenses fournisseurs à payer — la cible de payer_depense (résolution par nom). */
  listUnpaidExpenses?(): Promise<Result<UnpaidExpense[], AppError>>;
  /** M3 — dépenses RÉCENTES du tenant (payées ou à payer), bornées par l'hôte, avec leur
   * imputation chantier courante : la matière du ciblage de lier_depense_chantier. Lecture pure. */
  listRecentExpenses?(): Promise<Result<AgentExpense[], AppError>>;
  /** Preview tenant-scoped du lot non lu. Le cutoff retourné doit être réutilisé tel quel lors
   * de la mutation afin de ne pas absorber les notifications arrivées pendant le consentement. */
  previewUnreadNotifications?(): Promise<Result<NotificationUnreadPreview, AppError>>;
  /** Balance générale + résultat provisoire (deriveTrialBalance @bob/core, CLOTURE-1) —
   * « combien je gagne ? » répond produits − charges du grand-livre réel. */
  getTrialBalance?(): Promise<Result<TrialBalance, AppError>>;
  /** Compte de résultat normé (deriveIncomeStatement @bob/core, CDR-1) — la cascade
   * exploitation/financier/exceptionnel/net enrichit la réponse « combien je gagne ? ». */
  getIncomeStatement?(): Promise<Result<IncomeStatement, AppError>>;
  /** Bilan simplifié actif/passif (deriveBalanceSheet @bob/core, BILAN-1) — « mon bilan ». */
  getBalanceSheet?(): Promise<Result<BalanceSheet, AppError>>;
  /** Revue de pilotage (deriveBusinessReview @bob/core, BA-3) — séries CA facturé/encaissé,
   * comparatifs honnêtes, DSO, top clients, SIG et ratios : « comment va mon activité ? »,
   * « on me paie en combien de temps ? », « mes plus gros clients ? » lisent LA même revue. */
  getBusinessReview?(): Promise<Result<BusinessReview, AppError>>;
  /** Revue de clôture (deriveClosingReview @bob/core, DOSSIER-2) — les diligences de l'EC
   * exécutées par Bob : « mon dossier est-il prêt pour le comptable ? » lit LE même verdict
   * que l'écran Clôture et le dossier envoyé (readyToSign / réserves / anomalies). */
  getClosingReview?(): Promise<Result<ClosingReview, AppError>>;
  // —— Mutation ——
  registerPayment(input: {
    invoiceId: string;
    amountCents: number;
    idempotencyKey?: string | null;
  }): Promise<Result<{ status: string }, AppError>>;
  sendQuote(input: { quoteId: string }): Promise<
    Result<
      { number: string; deliveryStatus?: 'queued' | 'sent' | 'skipped' },
      AppError
    >
  >;
  issueInvoice(input: {
    invoiceId: string;
    /** Override RESPONSABILISÉ de l'embargo L221-10 (émission = demande de paiement) — `true`
     * strict après confirmation dédiée (safetyFloor) ; journalisé serveur. Jamais implicite. */
    embargoOverride?: boolean;
  }): Promise<Result<{ number: string }, AppError>>;
  // —— Mutation, OPTIONNELLES (parité C15 TODO ③④⑤⑥, C20/C40) ——
  // Optionnelles pour rester rétro-compatibles avec les hôtes existants (apps/api) : le registre
  // n'expose l'outil que si l'hôte fournit l'action — même use case que l'UI, jamais un chemin parallèle.
  createQuote?(input: CreateQuoteActionInput): Promise<Result<{ quoteId: string }, AppError>>;
  recordExpense?(input: RecordExpenseActionInput): Promise<Result<{ id: string }, AppError>>;
  generateInvoice?(input: GenerateInvoiceActionInput): Promise<Result<{ invoiceId: string }, AppError>>;
  /** Embargo L221-10 — DÉFAUT légal du refus d'encaissement, exécutable à la voix (hiérarchie
   * doctrine fondateur : le chemin sûr d'ABORD ; l'override reste le second niveau). MÊME
   * endpoint que le bouton « Programmer l'encaissement » (POST …/embargo-scheduled-payment). */
  scheduleEmbargoPayment?(
    input: ScheduleEmbargoPaymentActionInput,
  ): Promise<Result<ScheduleEmbargoPaymentActionOutput, AppError>>;
  exportFec?(input: ExportFecActionInput): Promise<Result<FecExportSummary, AppError>>;
  createCustomer?(input: CreateCustomerActionInput): Promise<Result<{ id: string }, AppError>>;
  /** Envoi réel de relance (C25 ②) — même endpoint que le bouton « Relancer » de l'écran
   * Notifications (client.sendRelance). Sortant : plancher de confirmation dans le registre. */
  sendRelance?(input: SendRelanceActionInput): Promise<Result<SendRelanceActionOutput, AppError>>;
  /** Preuve d'un règlement fournisseur déjà exécuté — écriture comptable : palier accounting. */
  recordExpensePayment?(input: RecordExpensePaymentActionInput): Promise<
    Result<{ status: string; alreadyRecorded: boolean; paymentEntryId: string }, AppError>
  >;
  /** M3 — « mets la dépense Aldi sur le chantier Durand » : MÊME use case AssignExpenseToChantier
   * (@bob/core) que PUT /expenses/:id/chantier et l'écran Dépenses (parité humain↔Bob). Tenant
   * scoping strict + anti-IDOR fail-closed côté core ; idempotent (changed:false sans écriture). */
  assignExpenseChantier?(
    input: AssignExpenseChantierActionInput,
  ): Promise<Result<AssignExpenseChantierActionOutput, AppError>>;
  /**
   * Compatibilité de compilation pendant la migration des hôtes. Le registre ne l'expose plus :
   * cette action sans date/moyen ne doit jamais être appelée.
   */
  payExpense?(input: { expenseId: string }): Promise<Result<{ status: string }, AppError>>;
  /** Même commande atomique que « Tout marquer comme lu » dans l'écran Notifications. */
  markNotificationsReadThrough?(
    input: NotificationReadThroughInput,
  ): Promise<Result<NotificationReadThroughOutput, AppError>>;
  /** « C'est bon, valide le ticket » — MÊME use case AcknowledgeDocument (@bob/core) que le
   * bouton « Confirmer » de la file « À valider » (parité humain↔Bob). L'hôte résout la
   * révision courante côté serveur ; le latch garantit l'idempotence (jamais réécrit). */
  acknowledgeDocument?(
    input: AcknowledgeDocumentActionInput,
  ): Promise<Result<AcknowledgeDocumentActionOutput, AppError>>;
  /** Destinations de classement RÉELLES du tenant (chantiers ouverts + dossiers racine actifs)
   * — lecture pure, la SEULE autorité de résolution de classer_document (jamais d'id inventé). */
  listFilingDestinations?(): Promise<Result<FilingDestinations, AppError>>;
  /** « Range le ticket Aldi dans le chantier Durand » — MÊME séquence que le geste « Classer
   * là » mobile : MoveDocumentToFolder + ClassifyDocument (chantier) + nom intelligent
   * (suggestedRenameFor : un renommage humain n'est JAMAIS écrasé). L'hôte résout les révisions. */
  fileDocument?(input: FileDocumentActionInput): Promise<Result<FileDocumentActionOutput, AppError>>;
  /** « Renomme-le facture matériaux salle de bain » — MÊME use case RenameDocument que l'écran
   * détail : le nom dicté devient un renommage humain PRIORITAIRE sur toute suggestion. */
  renameDocument?(input: RenameDocumentActionInput): Promise<Result<RenameDocumentActionOutput, AppError>>;
  /** « Retrouve la facture du radiateur de mars » — MÊME recherche que GET /documents/search
   * (devis & factures, ranking serveur). Lecture pure, résultats réels uniquement. */
  searchDocuments?(input: SearchDocumentsActionInput): Promise<Result<SearchDocumentsActionOutput, AppError>>;
  /** B8 — « la RATP m'a envoyé un bon de commande n° 4500123 » : MÊME use case
   * AttachPurchaseOrderToQuote que PUT /quotes/:id/purchase-order (parité humain↔Bob).
   * L'hôte résout la révision courante (le geste vocal n'a pas de vue optimiste) ; le numéro
   * sera repris automatiquement sur la facture dérivée (Invoice.fromSignedQuote, core). */
  attachPurchaseOrderToQuote?(
    input: AttachPurchaseOrderActionInput,
  ): Promise<Result<AttachPurchaseOrderActionOutput, AppError>>;
}
