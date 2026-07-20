import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appConflict, appDomain, appNotFound } from '../result';
import { Quote } from '../../domain/billing/quote/quote';
import { Invoice } from '../../domain/billing/invoice/invoice';
import {
  makePurchaseOrderRef,
  type PurchaseOrderRef,
  type PurchaseOrderRefInput,
} from '../../domain/billing/shared/purchase-order-ref';
import { type QuoteRepository, type InvoiceRepository } from '../ports/repositories';
import { type ClockPort } from '../ports/services';

/**
 * B8 — Bon de commande grands comptes (RATP, collectivités, majors du BTP) : le numéro
 * d'engagement du client est attaché AU DEVIS dès réception, repris automatiquement sur la
 * facture dérivée (Invoice.fromSignedQuote), et modifiable sur la facture tant qu'elle est
 * BROUILLON. Mêmes use cases pour l'UI et pour Bob (parité d'actions voix — pattern
 * rename-document) : tenant-scoped, révision optimiste, idempotents si référence identique.
 *
 * Concurrence : la révision est vérifiée sur l'agrégat relu puis rejouée par le domaine ;
 * l'adaptateur de persistance (API) reste responsable du compare-and-set final en base,
 * comme pour rename-document.
 */

/** Résultat commun des mutations de bon de commande — l'appelant rafraîchit sa vue avec. */
export interface PurchaseOrderMutationView {
  targetType: 'quote' | 'invoice';
  targetId: string;
  revision: number;
  purchaseOrder: PurchaseOrderRef | null;
}

function invalidRevision(): AppError {
  return {
    kind: 'validation',
    issues: [{ field: 'expectedRevision', message: 'Révision invalide.' }],
  };
}

function isValidRevision(revision: number): boolean {
  return Number.isSafeInteger(revision) && revision >= 1;
}

/**
 * « Devis déjà facturé » : dès qu'une pièce non annulée dérive du devis, la facture devient
 * la SOURCE du bon de commande (la reprise a eu lieu à la dérivation) — modifier le devis
 * n'aurait plus aucun effet sur la pièce. On dirige l'action vers la facture.
 */
async function quoteAlreadyInvoiced(
  invoices: Pick<InvoiceRepository, 'listByCompany'>,
  companyId: string,
  quoteId: string,
): Promise<boolean> {
  const companyInvoices = await invoices.listByCompany(companyId);
  return companyInvoices.some((i) => i.parentQuoteId === quoteId && i.status !== 'cancelled');
}

const QUOTE_INVOICED_MESSAGE =
  'Devis déjà facturé — attache le bon de commande directement à la facture.';
const QUOTE_STALE_MESSAGE = 'Le devis a été modifié. Recharge avant de changer le bon de commande.';
const INVOICE_STALE_MESSAGE =
  'La facture a été modifiée. Recharge avant de changer le bon de commande.';

// ── AttachPurchaseOrderToQuote ──

export interface AttachPurchaseOrderToQuoteInput {
  companyId: string;
  quoteId: string;
  purchaseOrder: PurchaseOrderRefInput;
  expectedRevision: number;
}

export interface AttachPurchaseOrderToQuoteDeps {
  quotes: Pick<QuoteRepository, 'findById' | 'save'>;
  invoices: Pick<InvoiceRepository, 'listByCompany'>;
  clock: ClockPort;
}

/** Attache (ou remplace) le bon de commande d'un devis NON FACTURÉ — saisie unique côté devis. */
export class AttachPurchaseOrderToQuote {
  constructor(private readonly deps: AttachPurchaseOrderToQuoteDeps) {}

  async execute(
    input: AttachPurchaseOrderToQuoteInput,
  ): Promise<Result<PurchaseOrderMutationView, AppError>> {
    if (!isValidRevision(input.expectedRevision)) return err(invalidRevision());
    const ref = makePurchaseOrderRef(input.purchaseOrder);
    if (!ref.ok) return err(appDomain(ref.error));

    const quote = await this.deps.quotes.findById(input.quoteId);
    // Tenant-scoped : un devis d'une autre société est INVISIBLE (not_found, pas forbidden).
    if (!quote || quote.companyId !== input.companyId)
      return err(appNotFound('quote', input.quoteId));
    if (quote.revision !== input.expectedRevision)
      return err(appConflict('quote', QUOTE_STALE_MESSAGE));
    if (await quoteAlreadyInvoiced(this.deps.invoices, input.companyId, quote.id))
      return err(appConflict('quote', QUOTE_INVOICED_MESSAGE));

    // Clone avant mutation : une tentative perdante ne mute jamais l'agrégat partagé in-memory.
    const next = Quote.rehydrate(quote.toSnapshot());
    const attached = next.attachPurchaseOrder(ref.value, this.deps.clock.now());
    if (!attached.ok) return err(appDomain(attached.error));
    if (next.revision !== quote.revision) await this.deps.quotes.save(next);
    return ok({
      targetType: 'quote',
      targetId: next.id,
      revision: next.revision,
      purchaseOrder: next.purchaseOrder,
    });
  }
}

// ── AttachPurchaseOrderToInvoice ──

export interface AttachPurchaseOrderToInvoiceInput {
  companyId: string;
  invoiceId: string;
  purchaseOrder: PurchaseOrderRefInput;
  expectedRevision: number;
}

export interface AttachPurchaseOrderToInvoiceDeps {
  invoices: Pick<InvoiceRepository, 'findById' | 'save'>;
  clock: ClockPort;
}

/** Attache (ou remplace) le bon de commande d'une facture BROUILLON — jamais après émission. */
export class AttachPurchaseOrderToInvoice {
  constructor(private readonly deps: AttachPurchaseOrderToInvoiceDeps) {}

  async execute(
    input: AttachPurchaseOrderToInvoiceInput,
  ): Promise<Result<PurchaseOrderMutationView, AppError>> {
    if (!isValidRevision(input.expectedRevision)) return err(invalidRevision());
    const ref = makePurchaseOrderRef(input.purchaseOrder);
    if (!ref.ok) return err(appDomain(ref.error));

    const invoice = await this.deps.invoices.findById(input.invoiceId);
    if (!invoice || invoice.companyId !== input.companyId)
      return err(appNotFound('invoice', input.invoiceId));
    if (invoice.revision !== input.expectedRevision)
      return err(appConflict('invoice', INVOICE_STALE_MESSAGE));

    const next = Invoice.rehydrate(invoice.toSnapshot());
    const attached = next.attachPurchaseOrder(ref.value, this.deps.clock.now());
    if (!attached.ok) return err(appDomain(attached.error));
    if (next.revision !== invoice.revision) await this.deps.invoices.save(next);
    return ok({
      targetType: 'invoice',
      targetId: next.id,
      revision: next.revision,
      purchaseOrder: next.purchaseOrder,
    });
  }
}

// ── DetachPurchaseOrder ──

export interface DetachPurchaseOrderInput {
  companyId: string;
  target: { type: 'quote'; quoteId: string } | { type: 'invoice'; invoiceId: string };
  expectedRevision: number;
}

export interface DetachPurchaseOrderDeps {
  quotes: Pick<QuoteRepository, 'findById' | 'save'>;
  invoices: Pick<InvoiceRepository, 'findById' | 'save' | 'listByCompany'>;
  clock: ClockPort;
}

/** Retrait EXPLICITE du bon de commande — devis non facturé / facture non émise seulement. */
export class DetachPurchaseOrder {
  constructor(private readonly deps: DetachPurchaseOrderDeps) {}

  async execute(
    input: DetachPurchaseOrderInput,
  ): Promise<Result<PurchaseOrderMutationView, AppError>> {
    if (!isValidRevision(input.expectedRevision)) return err(invalidRevision());
    if (input.target.type === 'quote') return this.detachFromQuote(input.target.quoteId, input);
    return this.detachFromInvoice(input.target.invoiceId, input);
  }

  private async detachFromQuote(
    quoteId: string,
    input: DetachPurchaseOrderInput,
  ): Promise<Result<PurchaseOrderMutationView, AppError>> {
    const quote = await this.deps.quotes.findById(quoteId);
    if (!quote || quote.companyId !== input.companyId) return err(appNotFound('quote', quoteId));
    if (quote.revision !== input.expectedRevision)
      return err(appConflict('quote', QUOTE_STALE_MESSAGE));
    if (await quoteAlreadyInvoiced(this.deps.invoices, input.companyId, quote.id))
      return err(appConflict('quote', QUOTE_INVOICED_MESSAGE));

    const next = Quote.rehydrate(quote.toSnapshot());
    const detached = next.detachPurchaseOrder(this.deps.clock.now());
    if (!detached.ok) return err(appDomain(detached.error));
    await this.deps.quotes.save(next);
    return ok({ targetType: 'quote', targetId: next.id, revision: next.revision, purchaseOrder: null });
  }

  private async detachFromInvoice(
    invoiceId: string,
    input: DetachPurchaseOrderInput,
  ): Promise<Result<PurchaseOrderMutationView, AppError>> {
    const invoice = await this.deps.invoices.findById(invoiceId);
    if (!invoice || invoice.companyId !== input.companyId)
      return err(appNotFound('invoice', invoiceId));
    if (invoice.revision !== input.expectedRevision)
      return err(appConflict('invoice', INVOICE_STALE_MESSAGE));

    const next = Invoice.rehydrate(invoice.toSnapshot());
    const detached = next.detachPurchaseOrder(this.deps.clock.now());
    if (!detached.ok) return err(appDomain(detached.error));
    await this.deps.invoices.save(next);
    return ok({
      targetType: 'invoice',
      targetId: next.id,
      revision: next.revision,
      purchaseOrder: null,
    });
  }
}
