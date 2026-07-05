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
} from '@bob/core';

/** Dépense fournisseur encore à payer (BOB-1 — ciblage de payer_depense par nom). */
export interface UnpaidExpense {
  id: string;
  supplierName: string;
  totalTtcCents: number;
  documentDate: string;
}

/** Outil payer_depense (BOB-1) : règle une dépense — même use case PayExpense que l'écran
 * Dépenses (transition to_pay→paid + décaissement 401/512 au journal de banque). */
export interface PayExpenseActionInput {
  expenseId: string;
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

export interface AgentDocument {
  id: string;
  filename: string;
  kind: string;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  createdAt: string;
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

/** Outil scan_depense (parité C15 TODO ③) — mêmes entrées que RecordExpense (l'OCR reste côté UI). */
export interface RecordExpenseActionInput {
  supplierName: string;
  totalTtcCents: number;
  category: ExpenseCategory;
  /** DateOnly (YYYY-MM-DD) — défaut : aujourd'hui, résolu par l'hôte (device/serveur). */
  documentDate?: string;
  vatRatePct?: number | null;
}

/** Outil generer_facture (parité C15 TODO ⑤) — même use case GenerateInvoiceFromQuote que l'UI. */
export interface GenerateInvoiceActionInput {
  quoteId: string;
  /** deposit = facture d'acompte (proportionnelle), final = solde. Absent : mode par défaut du use case. */
  mode?: 'deposit' | 'final';
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
  computePayout(): Promise<Result<{ payoutCents: number; availableCents: number }, AppError>>;
  /** Brouillon de relance — CIBLABLE par facture/client (C25 ①). Défaut sans cible : la plus
   * urgente. Les hôtes historiques sans paramètre restent assignables (TODO Codex apps/api :
   * porter la cible côté serveur — voir rapport C25). */
  draftRelance(input?: DraftRelanceActionInput): Promise<Result<{ subject: string; body: string }, AppError>>;
  listPayableInvoices(): Promise<Result<PayableInvoice[], AppError>>;
  listSendableQuotes(): Promise<Result<SendableQuote[], AppError>>;
  listIssuableInvoices(): Promise<Result<IssuableInvoice[], AppError>>;
  listDocuments(): Promise<Result<AgentDocument[], AppError>>;
  // —— Lecture, OPTIONNELLE (C-EXP5b) ——
  /** Échéances fiscales à venir (TVA/URSSAF/IS/CFE/comptes annuels) — MÊME use case
   * deriveFiscalCalendar (@bob/core) que GET /fiscal-calendar et l'écran : l'hôte délègue au
   * BobClient, AUCUNE logique fiscale côté ai/. Optionnelle : rétro-compatible hôtes existants. */
  listFiscalDeadlines?(): Promise<Result<FiscalDeadline[], AppError>>;
  // —— Lecture, OPTIONNELLES (BOB-1 — l'expert-comptable de poche) ——
  /** Position de TVA réelle (deriveVatPosition @bob/core : collectée sur ENCAISSEMENTS −
   * déductible mentionnée) — « combien de TVA je dois ? » lit LE chiffre du cashflow. */
  getVatPosition?(): Promise<Result<VatPosition, AppError>>;
  /** Balance âgée clients (deriveAgedBalance @bob/core) — « qui me doit quoi ? ». */
  getAgedBalance?(): Promise<Result<AgedBalance, AppError>>;
  /** Dépenses fournisseurs à payer — la cible de payer_depense (résolution par nom). */
  listUnpaidExpenses?(): Promise<Result<UnpaidExpense[], AppError>>;
  /** Balance générale + résultat provisoire (deriveTrialBalance @bob/core, CLOTURE-1) —
   * « combien je gagne ? » répond produits − charges du grand-livre réel. */
  getTrialBalance?(): Promise<Result<TrialBalance, AppError>>;
  /** Compte de résultat normé (deriveIncomeStatement @bob/core, CDR-1) — la cascade
   * exploitation/financier/exceptionnel/net enrichit la réponse « combien je gagne ? ». */
  getIncomeStatement?(): Promise<Result<IncomeStatement, AppError>>;
  /** Bilan simplifié actif/passif (deriveBalanceSheet @bob/core, BILAN-1) — « mon bilan ». */
  getBalanceSheet?(): Promise<Result<BalanceSheet, AppError>>;
  // —— Mutation ——
  registerPayment(input: {
    invoiceId: string;
    amountCents: number;
    idempotencyKey?: string | null;
  }): Promise<Result<{ status: string }, AppError>>;
  sendQuote(input: { quoteId: string }): Promise<Result<{ number: string }, AppError>>;
  issueInvoice(input: { invoiceId: string }): Promise<Result<{ number: string }, AppError>>;
  // —— Mutation, OPTIONNELLES (parité C15 TODO ③④⑤⑥, C20/C40) ——
  // Optionnelles pour rester rétro-compatibles avec les hôtes existants (apps/api) : le registre
  // n'expose l'outil que si l'hôte fournit l'action — même use case que l'UI, jamais un chemin parallèle.
  createQuote?(input: CreateQuoteActionInput): Promise<Result<{ quoteId: string }, AppError>>;
  recordExpense?(input: RecordExpenseActionInput): Promise<Result<{ id: string }, AppError>>;
  generateInvoice?(input: GenerateInvoiceActionInput): Promise<Result<{ invoiceId: string }, AppError>>;
  exportFec?(input: ExportFecActionInput): Promise<Result<FecExportSummary, AppError>>;
  createCustomer?(input: CreateCustomerActionInput): Promise<Result<{ id: string }, AppError>>;
  /** Envoi réel de relance (C25 ②) — même endpoint que le bouton « Relancer » de l'écran
   * Notifications (client.sendRelance). Sortant : plancher de confirmation dans le registre. */
  sendRelance?(input: SendRelanceActionInput): Promise<Result<SendRelanceActionOutput, AppError>>;
  /** Règlement d'une dépense fournisseur (BOB-1/E4) — écriture comptable : palier accounting. */
  payExpense?(input: PayExpenseActionInput): Promise<Result<{ status: string }, AppError>>;
}
