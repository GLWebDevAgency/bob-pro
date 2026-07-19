import { type Result, ok, err } from '../../shared-kernel/result';
import { buildIssuedInvoiceAccountingEntry } from '../../domain/accounting/invoice-accounting';
import { type AppError, appDomain, appNotFound } from '../result';
import { type InvoiceRepository } from '../ports/repositories';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ChartOfAccountsRepository } from '../ports/chart-of-accounts-repository';

export interface RecordIssuedInvoiceAccountingEntryInput {
  invoiceId: string;
}

export interface RecordIssuedInvoiceAccountingEntryDeps {
  invoices: InvoiceRepository;
  entries: AccountingEntryRepository;
  charts?: ChartOfAccountsRepository;
}

export interface RecordIssuedInvoiceAccountingEntryOutput {
  id: string;
  created: boolean;
  totalDebitCents: number;
  totalCreditCents: number;
}

export function issuedInvoiceAccountingEntryId(invoiceId: string): string {
  return `invoice:${invoiceId}:issued`;
}

/**
 * Poste l'ecriture comptable definitive d'une facture emise.
 *
 * Idempotent : un retry d'emission ou un appel concurrent reutilise la meme ecriture deterministe
 * au lieu de doubler le journal comptable.
 */
export class RecordIssuedInvoiceAccountingEntry {
  constructor(private readonly deps: RecordIssuedInvoiceAccountingEntryDeps) {}

  async execute(input: RecordIssuedInvoiceAccountingEntryInput): Promise<Result<RecordIssuedInvoiceAccountingEntryOutput, AppError>> {
    const invoice = await this.deps.invoices.findById(input.invoiceId);
    if (!invoice) return err(appNotFound('invoice', input.invoiceId));

    const id = issuedInvoiceAccountingEntryId(invoice.id);
    const existing = await this.deps.entries.findById(invoice.companyId, id);
    if (existing) {
      return ok({
        id,
        created: false,
        totalDebitCents: existing.totalDebitCents,
        totalCreditCents: existing.totalCreditCents,
      });
    }

    const chart = this.deps.charts ? await this.deps.charts.findByCompany(invoice.companyId) : null;
    const entry = buildIssuedInvoiceAccountingEntry({
      entryId: id,
      invoice,
      ...(chart ? { chart } : {}),
    });
    if (!entry.ok) return err(appDomain(entry.error));
    // B2 — facture FINALE à 0 entièrement couverte par les situations émises : AUCUN fait
    // comptable (CA/TVA déjà constatés situation par situation) — rien à poster, l'émission
    // continue. Jamais un rollback pour une écriture qui n'a pas lieu d'exister.
    if (entry.value === null) {
      return ok({ id, created: false, totalDebitCents: 0, totalCreditCents: 0 });
    }

    await this.deps.entries.save(entry.value);
    return ok({
      id,
      created: true,
      totalDebitCents: entry.value.totalDebitCents,
      totalCreditCents: entry.value.totalCreditCents,
    });
  }
}
