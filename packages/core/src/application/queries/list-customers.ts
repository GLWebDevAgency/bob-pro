import { type Result, err, ok } from '../../shared-kernel/result';
import { type AppError } from '../result';
import { type Address } from '../../shared-kernel/contact';
import {
  type CustomerRepository,
  type InvoiceRepository,
  type PaymentRepository,
} from '../ports/repositories';
import {
  deriveCustomerFinancialMetrics,
  type PaymentHistoryStatus,
} from '../clients/derive-customer-financial-metrics';

export interface CustomerListItem {
  id: string;
  name: string;
  type: 'b2c' | 'b2b' | 'b2g';
  /** Édition post-création (C13/C40 TODO partagé) — la fiche a besoin de l'état complet pour
   * préremplir le formulaire de correction (CustomerForm), pas seulement l'affichage. */
  address: Address;
  contactName: string | null;
  /** Aucun score n'est exposé avant ratification d'un modèle explicable et versionné. */
  score: null;
  scoreBand: null;
  scoreStatus: 'model_not_ratified';
  /** Projections dérivées exclusivement des factures et paiements persistés (centimes). */
  grossReceivableCents: number;
  issuedCreditCents: number;
  outstandingCents: number;
  customerCreditCents: number;
  /** SIREN si personne morale (b2b/b2g) — null pour un particulier (fiche C13 : partyLine adaptatif). */
  siren: string | null;
  /** Délai moyen constaté ; null signifie explicitement « non calculable ». */
  avgDelayDays: number | null;
  paidOnTimeRatio: number | null;
  paymentHistoryStatus: PaymentHistoryStatus;
  settledInvoiceCount: number;
  /** Coordonnées pour les actions device tel:/mailto: (fiche C13) — null si non renseignées. */
  email: string | null;
  phone: string | null;
}

export class ListCustomers {
  constructor(
    private readonly deps: {
      customers: CustomerRepository;
      invoices: InvoiceRepository;
      payments: PaymentRepository;
    },
  ) {}

  async execute(input: { companyId: string }): Promise<Result<CustomerListItem[], AppError>> {
    const [list, invoices, payments] = await Promise.all([
      this.deps.customers.listByCompany(input.companyId),
      this.deps.invoices.listByCompany(input.companyId),
      this.deps.payments.listByCompany(input.companyId),
    ]);
    const invoiceData = invoices.map((invoice) => ({
      id: invoice.id,
      companyId: invoice.companyId,
      customerId: invoice.customerId,
      kind: invoice.kind,
      status: invoice.status,
      totals: { netToPay: invoice.totals().netToPay },
      paid: invoice.paid,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      sourceInvoiceId: invoice.creditNoteSource?.invoiceId ?? null,
    }));
    const paymentData = payments.map((payment) => ({
      id: payment.id,
      companyId: payment.companyId,
      invoiceId: payment.invoiceId,
      amount: payment.amount,
      receivedAt: payment.receivedAt,
    }));

    const items: CustomerListItem[] = [];
    for (const customer of list) {
      const derived = deriveCustomerFinancialMetrics({
        companyId: input.companyId,
        customerId: customer.id,
        invoices: invoiceData,
        payments: paymentData,
      });
      if (!derived.ok) {
        return err({
          kind: 'dependency',
          port: 'customer-financial-metrics',
          cause: JSON.stringify(derived.error),
        });
      }
      const metrics = derived.value;
      items.push({
        id: customer.id,
        name: customer.name,
        type: customer.type,
        address: customer.address,
        contactName: customer.contactName ?? null,
        score: null,
        scoreBand: null,
        scoreStatus: metrics.scoreStatus,
        grossReceivableCents: metrics.grossReceivableCents,
        issuedCreditCents: metrics.issuedCreditCents,
        outstandingCents: metrics.outstandingCents,
        customerCreditCents: metrics.customerCreditCents,
        siren: customer.siren ?? null,
        avgDelayDays: metrics.avgDelayDays,
        paidOnTimeRatio: metrics.paidOnTimeRatio,
        paymentHistoryStatus: metrics.paymentHistoryStatus,
        settledInvoiceCount: metrics.settledInvoiceCount,
        email: customer.email ?? null,
        phone: customer.phone ?? null,
      });
    }
    return ok(items);
  }
}
