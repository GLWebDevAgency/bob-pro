import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type LineInput } from '../../domain/billing/shared/line-item';
import { type Discount } from '../../domain/billing/shared/discount';
import { type Totals } from '../../domain/billing/shared/totals';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { suggestVatRate } from '../../domain/services/suggest-vat-rate';
import { internationalProEmissionGuard } from '../../domain/services/international-emission-guard';
import {
  type InvoiceRepository,
  type CompanyRepository,
  type CustomerRepository,
} from '../ports/repositories';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import { validateLineInputs } from './line-input-validation';

/**
 * Message HONNÊTE du refus de facture directe à un consommateur SANS intervention urgente
 * tracée — source unique API/mobile/vocal (les clients portent la même substance ×3 tons via
 * @bob/i18n, jamais reformulée à l'écran).
 */
export const STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE =
  'Client particulier : une facture directe sans devis signé n’est possible que pour une ' +
  'intervention urgente à domicile expressément demandée par le client (art. L221-10, al. 2 et ' +
  'L221-28, 8° du code de la consommation). Hors urgence, le devis signé reste le chemin — il ' +
  'porte les protections légales du client (rétractation de 14 jours, interdiction de paiement ' +
  'de 7 jours à domicile) et te protège d’un contrat annulable.';

export interface ComposeStandaloneInvoiceInput {
  companyId: string;
  customerId: string;
  /** Lignes LIBRES (dépannage sur place, régie TJM × jours, prestations syndic…), 1 à 100. */
  lines: LineInput[];
  /** B3 — remise globale (% du HT net de lignes, ou montant HT en centimes). */
  globalDiscount?: Discount | null;
  /** Taux réduits travaux : mêmes booléens d'éligibilité que CreateQuote (suggestVatRate). */
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
  /**
   * A3bis — qualification OBLIGATOIRE pour un client B2C : intervention urgente à domicile
   * expressément sollicitée par le client (exception légale au devis ET à l'interdiction de
   * paiement L221-10). `true` = fait déclaré par l'artisan, horodaté SERVEUR ici, immuable.
   * Absent/false avec un client b2c → REFUS fail-closed (le devis signé est le chemin).
   * Refusé pour un client professionnel (l'exception ne protège que le consommateur).
   */
  urgentOnSiteRepair?: boolean;
}

export interface ComposeStandaloneInvoiceOutput {
  invoiceId: string;
  totals: Totals;
}

export interface ComposeStandaloneInvoiceDeps {
  invoices: InvoiceRepository;
  companies: CompanyRepository;
  customers: CustomerRepository;
  ids: IdGeneratorPort;
  clock: ClockPort;
}

/**
 * B1 — FACTURE DIRECTE sans devis signé (brouillon `final` standalone, parentQuoteId null) :
 * couvre l'exception légale au devis en dépannage urgent (arrêté du 24/01/2017 — le devis
 * préalable n'est pas exigible quand l'urgence l'empêche), la facture mensuelle de régie
 * (TJM × jours) et la facturation syndic/B2B récurrente. La TVA de chaque ligne passe par
 * suggestVatRate (franchise, autoliquidation, débours B9, taux réduits) ; le client pro
 * étranger est BLOQUÉ (B6, fail-closed) ; un client B2C exige la qualification d'urgence
 * (A3bis). L'émission (numéro, mentions, dueAt, servicePeriod/deliveryAddress A7, régime de
 * TVA A4) suit les MÊMES conventions que toute facture : IssueInvoice, sans chemin parallèle.
 * Le bon de commande (B8) s'attache ensuite via AttachPurchaseOrder (brouillon).
 */
export class ComposeStandaloneInvoice {
  constructor(private readonly deps: ComposeStandaloneInvoiceDeps) {}

  async execute(
    input: ComposeStandaloneInvoiceInput,
  ): Promise<Result<ComposeStandaloneInvoiceOutput, AppError>> {
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'lines',
          message: 'Au moins une ligne requise pour une facture directe.',
        }),
      );
    }
    const lineError = validateLineInputs(input.lines);
    if (lineError) return err(lineError);

    const company = await this.deps.companies.findById(input.companyId);
    if (!company) return err(appNotFound('company', input.companyId));
    const customer = await this.deps.customers.findById(input.customerId);
    // Intégrité référentielle / anti-IDOR : le client doit appartenir au tenant (cf. CreateQuote).
    if (!customer || customer.companyId !== input.companyId)
      return err(appNotFound('customer', input.customerId));

    // B6 — client PROFESSIONNEL établi hors de France : émission bloquée, sans contournement
    // (TVA intracom/export pas encore gérée — une TVA française serait fiscalement fausse).
    const international = internationalProEmissionGuard(customer);
    if (!international.ok) return err(appDomain(international.error));

    // A3bis — parité de protection avec le flux devis : l'exception d'urgence ne concerne
    // qu'un CONSOMMATEUR (même règle que CreateQuote.urgentRepairRequested).
    if (input.urgentOnSiteRepair === true && customer.type !== 'b2c') {
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'urgentOnSiteRepair',
          message:
            "L'intervention urgente (art. L221-10 du code de la consommation) ne concerne qu'un client particulier.",
        }),
      );
    }
    // Fail-closed : AUCUNE facture directe à un consommateur sans intervention urgente tracée —
    // les protections L221-10/L221-18 passent par le devis signé, jamais contournées par une
    // facture sortie de nulle part.
    if (customer.type === 'b2c' && input.urgentOnSiteRepair !== true) {
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'urgentOnSiteRepair',
          message: STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE,
        }),
      );
    }

    const at = this.deps.clock.now();
    const composed = Invoice.composeStandalone({
      id: this.deps.ids.newId(),
      companyId: input.companyId,
      customerId: input.customerId,
      // Horodaté SERVEUR à la composition — la trace qui fonde l'exception L221-10, al. 2.
      urgentRepair: input.urgentOnSiteRepair === true ? { requestedAt: at } : null,
    });
    if (!composed.ok) return err(appDomain(composed.error));
    const invoice = composed.value;

    for (const line of input.lines) {
      const rate = suggestVatRate({
        company,
        customer,
        category: line.category,
        requestedRate: line.vatRate,
        ...(input.context !== undefined ? { context: input.context } : {}),
      });
      if (!rate.ok) return err(appDomain(rate.error));
      const added = invoice.addLine({ ...line, id: this.deps.ids.newId(), vatRate: rate.value });
      if (!added.ok) return err(appDomain(added.error));
    }

    if (input.globalDiscount !== undefined && input.globalDiscount !== null) {
      const discount = invoice.setGlobalDiscount(input.globalDiscount);
      if (!discount.ok) return err(appDomain(discount.error));
    }

    await this.deps.invoices.save(invoice);
    return ok({ invoiceId: invoice.id, totals: invoice.totals() });
  }
}
