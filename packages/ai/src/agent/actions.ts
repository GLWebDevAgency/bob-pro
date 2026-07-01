import { type Result, type AppError } from '@bob/core';

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

/**
 * Surface d'actions de Bob — implémentée par l'app via le BobClient (donc le domaine/use cases).
 * INVARIANT DE PARITÉ : chaque action faisable à la main dans l'UI a ici sa méthode, et les deux
 * passent par le MÊME use case. Bob ne peut donc rien faire que l'utilisateur ne puisse faire, et
 * inversement. Les outils (registry) délèguent à ces méthodes sans logique métier propre.
 */
export interface BobActions {
  // —— Lecture ——
  computePayout(): Promise<Result<{ payoutCents: number; availableCents: number }, AppError>>;
  draftRelance(): Promise<Result<{ subject: string; body: string }, AppError>>;
  listPayableInvoices(): Promise<Result<PayableInvoice[], AppError>>;
  listSendableQuotes(): Promise<Result<SendableQuote[], AppError>>;
  listIssuableInvoices(): Promise<Result<IssuableInvoice[], AppError>>;
  listDocuments(): Promise<Result<AgentDocument[], AppError>>;
  // —— Mutation ——
  registerPayment(input: {
    invoiceId: string;
    amountCents: number;
    idempotencyKey?: string | null;
  }): Promise<Result<{ status: string }, AppError>>;
  sendQuote(input: { quoteId: string }): Promise<Result<{ number: string }, AppError>>;
  issueInvoice(input: { invoiceId: string }): Promise<Result<{ number: string }, AppError>>;
}
