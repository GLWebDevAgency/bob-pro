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
import {
  type CustomerBillingChannel,
  type CustomerPaymentTerms,
} from '../../domain/customer/customer';

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
  /** Établissement facturé (SIRET) ; null = inconnu, jamais dérivé du SIREN. */
  siret?: string | null;
  /** N° TVA français réel de la fiche ; null = jamais fourni/confirmé. */
  tvaIntracom?: string | null;
  /** Délai moyen constaté ; null signifie explicitement « non calculable ». */
  avgDelayDays: number | null;
  paidOnTimeRatio: number | null;
  paymentHistoryStatus: PaymentHistoryStatus;
  settledInvoiceCount: number;
  /** Coordonnées pour les actions device tel:/mailto: (fiche C13) — null si non renseignées. */
  email: string | null;
  phone: string | null;
  /** B4 — conditions de paiement PROPRES au client ; null = suit le défaut société.
   *  Optionnel (compat serveurs antérieurs) : les codecs normalisent absent ⇒ null. */
  paymentTerms?: CustomerPaymentTerms | null;
  /** Canal de facturation déclaré (email | chorus | portail) ; null = email par défaut.
   *  Optionnel (compat serveurs antérieurs) : les codecs normalisent absent ⇒ null. */
  billingChannel?: CustomerBillingChannel | null;
  /** B7 — client établi à l'étranger (garde-fou TVA intracom/export) ; absent ⇒ false. */
  isInternational?: boolean;
  /** Libellé décoratif historique — exposé pour que l'édition (remplacement complet) ne le
   *  perde jamais silencieusement. Absent ⇒ null. */
  paymentTermsLabel?: string | null;
  /** A4 — sous-traitance BTP (autoliquidation) ; absent ⇒ false. Même raison : un remplacement
   *  complet depuis la fiche ne doit jamais effacer un fait fiscal. */
  isSubcontractingBtp?: boolean;
  /** PR-04 — ce client exige un n° de bon de commande avant émission (garde IssueInvoice) ;
   *  absent ⇒ false (compat serveurs antérieurs — jamais une exigence inventée). */
  requiresPurchaseOrder?: boolean;
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
        siret: customer.siret ?? null,
        tvaIntracom: customer.tvaIntracom ?? null,
        avgDelayDays: metrics.avgDelayDays,
        paidOnTimeRatio: metrics.paidOnTimeRatio,
        paymentHistoryStatus: metrics.paymentHistoryStatus,
        settledInvoiceCount: metrics.settledInvoiceCount,
        email: customer.email ?? null,
        phone: customer.phone ?? null,
        // B4/B6/B7 — la fiche client mobile lit ces faits pour les afficher/éditer sans jamais
        // les perdre lors d'un remplacement complet (UpdateCustomer revalide via Customer.of).
        paymentTerms: customer.paymentTerms ?? null,
        billingChannel: customer.billingChannel ?? null,
        isInternational: customer.isInternational(),
        paymentTermsLabel: customer.toProps().paymentTermsLabel ?? null,
        isSubcontractingBtp: customer.isSubcontractingBtp,
        // PR-04 — garde « BC obligatoire » (toggle fiche client, préservé au remplacement).
        requiresPurchaseOrder: customer.requiresPurchaseOrder,
      });
    }
    return ok(items);
  }
}
