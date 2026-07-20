import { type Result, ok, err } from '../../shared-kernel/result';
import { type DateOnly } from '../../shared-kernel/time';
import { type AppError, appDomain, appNotFound } from '../result';
import { type InvoiceTransmissionStatus } from '../../domain/billing/invoice/invoice';
import { type InvoiceRepository } from '../ports/repositories';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';

export interface RecordInvoiceTransmissionInput {
  invoiceId: string;
  /** Date de dépôt DÉCLARÉE par l'artisan (Chorus/portail) ; null efface, absent = inchangée. */
  depositedAt?: DateOnly | null;
  /** Date d'acceptation DÉCLARÉE ; null efface, absent = inchangée. Suppose un dépôt (domaine). */
  acceptedAt?: DateOnly | null;
}

export interface RecordInvoiceTransmissionDeps {
  invoices: InvoiceRepository;
  uow: UnitOfWorkPort;
  clock: ClockPort;
}

/** Sentinelle : lever DANS runInTransaction pour annuler proprement (rollback) sur erreur applicative. */
class TxAppError extends Error {
  constructor(readonly appError: AppError) {
    super('tx-app-error');
  }
}

/**
 * Suivi MANUEL de transmission d'une facture ÉMISE vers le canal de facturation du client
 * (Customer.billingChannel) : dépôt puis acceptation, dates déclarées par l'artisan — suivi
 * honnête, additif, jamais un accusé de plateforme inventé (le raccordement PA est l'item B8).
 * Les invariants (pièce émise, acceptation ⊇ dépôt, dates valides) vivent dans l'agrégat
 * (Invoice.recordTransmission) ; relecture SOUS VERROU pour ne jamais écraser un état concurrent.
 */
export class RecordInvoiceTransmission {
  constructor(private readonly deps: RecordInvoiceTransmissionDeps) {}

  async execute(
    input: RecordInvoiceTransmissionInput,
  ): Promise<Result<{ transmission: InvoiceTransmissionStatus | null }, AppError>> {
    const pre = await this.deps.invoices.findById(input.invoiceId);
    if (!pre) return err(appNotFound('invoice', input.invoiceId));

    try {
      let transmission: InvoiceTransmissionStatus | null = null;
      await this.deps.uow.runInTransaction(async () => {
        const invoice = await this.deps.invoices.lockById(input.invoiceId);
        if (!invoice) throw new TxAppError(appNotFound('invoice', input.invoiceId));
        // Fusion SOUS VERROU avec l'état courant : champ absent = inchangé, null = effacé —
        // un patch concurrent n'est jamais écrasé silencieusement.
        const current = invoice.transmission;
        const recorded = invoice.recordTransmission(
          {
            depositedAt:
              input.depositedAt === undefined ? (current?.depositedAt ?? null) : input.depositedAt,
            acceptedAt:
              input.acceptedAt === undefined ? (current?.acceptedAt ?? null) : input.acceptedAt,
          },
          this.deps.clock.now(),
        );
        if (!recorded.ok) throw new TxAppError(appDomain(recorded.error));
        await this.deps.invoices.save(invoice);
        transmission = invoice.transmission;
      });
      return ok({ transmission });
    } catch (e) {
      if (e instanceof TxAppError) return err(e.appError);
      throw e;
    }
  }
}
