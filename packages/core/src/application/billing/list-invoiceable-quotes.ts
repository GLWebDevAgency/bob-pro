import { type Result, ok, err } from '../../shared-kernel/result';
import { type DateOnly } from '../../shared-kernel/time';
import { type AppError, appUnavailable } from '../result';
import {
  PROFESSIONAL_ADVANCE_RECOVERY_UNAVAILABLE_MESSAGE,
  professionalAdvanceRecoveryGuard,
} from '../../domain/compliance/professional-advance-recovery';
import { type PurchaseOrderRef } from '../../domain/billing/shared/purchase-order-ref';
import {
  deriveRetractation,
  retractationFreeze,
} from '../../domain/compliance/retractation';
import {
  type QuoteRepository,
  type InvoiceRepository,
  type CustomerRepository,
} from '../ports/repositories';
import { type ClockPort } from '../ports/services';

/**
 * ASK-2 / B8 — vue « devis facturables » : devis SIGNÉS sans facture finale (non annulée).
 * L'acompte déjà émis est signalé (depositInvoiced) pour que la finale devienne l'évidence,
 * et le bon de commande (numéro d'engagement grands comptes) est exposé pour que le flow
 * facturation l'affiche AVANT émission — il doit figurer sur la facture (Chorus Pro, B8).
 * Use case UNIQUE pour l'écran et pour Bob (parité d'actions humain ↔ voix).
 */
export interface InvoiceableQuoteView {
  id: string;
  number: string | null;
  customerName: string;
  totalTtcCents: number;
  depositPct: number | null;
  depositInvoiced: boolean;
  /** Faux pour B2B/B2G tant que la chaîne acompte → finale EXTENDED/PA n'est pas certifiée. */
  depositAvailable: boolean;
  /** Motif domaine affichable tel quel ; null quand l'acompte est disponible. */
  depositUnavailableReason: string | null;
  /** B8 : bon de commande attaché au devis — null si aucun (compat ascendante). */
  purchaseOrder: PurchaseOrderRef | null;
  /**
   * A3 — gel de rétractation ACTIF sur la facture finale (devis B2C signé, sans demande
   * d'exécution anticipée, délai L221-18 en cours) : premier jour où la finale devient
   * possible. Null = aucun gel (B2B/B2G, renonciation tracée, ou délai écoulé). L'écran et le
   * flow vocal l'annoncent AVANT de proposer la finale — l'acompte reste facturable.
   */
  finalBlockedUntil: DateOnly | null;
}

export interface ListInvoiceableQuotesInput {
  companyId: string;
}

export interface ListInvoiceableQuotesDeps {
  quotes: Pick<QuoteRepository, 'listByCompany'>;
  invoices: Pick<InvoiceRepository, 'listByCompany'>;
  customers: Pick<CustomerRepository, 'listByCompany'>;
  /** A3 — horloge injectée du gel de rétractation (jamais Date.now()). */
  clock: ClockPort;
}

export class ListInvoiceableQuotes {
  constructor(private readonly deps: ListInvoiceableQuotesDeps) {}

  async execute(
    input: ListInvoiceableQuotesInput,
  ): Promise<Result<InvoiceableQuoteView[], AppError>> {
    const [quotes, invoices, customers] = await Promise.all([
      this.deps.quotes.listByCompany(input.companyId),
      this.deps.invoices.listByCompany(input.companyId),
      this.deps.customers.listByCompany(input.companyId),
    ]);
    const byId = new Map(customers.map((c) => [c.id, c]));
    const now = this.deps.clock.now();
    const candidates = quotes
      .filter((q) => q.status === 'signed')
      .filter(
          (q) =>
            !invoices.some(
              (i) => i.parentQuoteId === q.id && i.kind === 'final' && i.status !== 'cancelled',
            ),
        );
    // Une option sans client réel ne peut ni nommer sa cible, ni déterminer son canal fiscal.
    // Refus global plutôt qu'un libellé vide ou une disponibilité inventée.
    if (candidates.some((quote) => !byId.has(quote.customerId)))
      return err(appUnavailable('customer-reference'));

    return ok(
      candidates
        .map((q) => {
          // A3 — même dérivation que le refus de GenerateInvoiceFromQuote (source unique du
          // domaine) : la liste ANNONCE le gel, le use case de génération le FAIT respecter.
          const customer = byId.get(q.customerId)!;
          const freeze = retractationFreeze(
            deriveRetractation({ customerType: customer.type, signature: q.signature }),
            now,
          );
          const advancePath = professionalAdvanceRecoveryGuard({
            customerType: customer.type,
            invoiceKind: 'deposit',
            advanceDeductionCents: 0,
          });
          return {
            id: q.id,
            number: q.number,
            customerName: customer.name,
            totalTtcCents: q.totals().ttc,
            depositPct: q.depositPct,
            depositInvoiced: invoices.some(
              (i) => i.parentQuoteId === q.id && i.kind === 'deposit' && i.status !== 'cancelled',
            ),
            depositAvailable: advancePath.ok,
            depositUnavailableReason: advancePath.ok
              ? null
              : PROFESSIONAL_ADVANCE_RECOVERY_UNAVAILABLE_MESSAGE,
            purchaseOrder: q.purchaseOrder,
            finalBlockedUntil: freeze.active ? freeze.availableFrom : null,
          };
        }),
    );
  }
}
