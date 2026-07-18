import { type Result, ok, err } from '../../shared-kernel/result';
import { parisDateOnly } from '../../shared-kernel/time';
import { type AppError, appDomain, appNotFound } from '../result';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { buildMentions, operationNatureOf } from '../../domain/services/build-mentions';
import {
  type InvoiceRepository,
  type CompanyRepository,
  type CustomerRepository,
} from '../ports/repositories';
import { type SequenceCounterPort, type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { TxDomainError } from './tx-error';

export interface IssueInvoiceInput {
  invoiceId: string;
  terms?: { days: number; endOfMonth: boolean; label: string };
}

export interface IssueInvoiceDeps {
  invoices: InvoiceRepository;
  companies: CompanyRepository;
  customers: CustomerRepository;
  counters: SequenceCounterPort;
  uow: UnitOfWorkPort;
  clock: ClockPort;
}

/** Sentinelle applicative : force le rollback UoW tout en préservant le contrat AppError exact. */
class TxAppError extends Error {
  constructor(readonly appError: AppError) {
    super('tx-app');
  }
}

/**
 * Alloue le numéro de facture (no-gap) ET fige totaux + mentions + save dans UNE transaction.
 * Ordre global des verrous : Company SHARE -> Invoice UPDATE -> compteur. CloseAccount prend la
 * Company en UPDATE : une émission est donc entièrement commitée avant la clôture, ou la voit déjà
 * clôturée et ne consomme aucun numéro. La 2ᵉ émission du même brouillon bloque sur Invoice UPDATE,
 * relit la facture numérotée et retourne son numéro avant toute allocation.
 * Toute erreur (métier via TxDomainError, ou infra) annule la transaction -> numéro non consommé.
 */
export class IssueInvoice {
  constructor(private readonly deps: IssueInvoiceDeps) {}

  async execute(input: IssueInvoiceInput): Promise<Result<{ number: string }, AppError>> {
    // Locator uniquement : aucune décision métier ne repose sur ce snapshot hors transaction.
    // Il donne le tenant dont la ligne Company doit être verrouillée en premier.
    const pre = await this.deps.invoices.findById(input.invoiceId);
    if (!pre) return err(appNotFound('invoice', input.invoiceId));

    // Résolution pure en amont, mais verdict différé après les verrous : un appel parti sur un
    // snapshot draft peut attendre une émission concurrente, relire la facture numérotée et doit
    // alors rester idempotent même sans conditions (ou avec d'anciennes conditions invalides).
    const termsR = input.terms === undefined ? null : PaymentTerms.of(input.terms);

    const at = this.deps.clock.now();
    // Jour MÉTIER Europe/Paris (pas l'UTC brut) : la date d'émission LÉGALE, les mentions et
    // l'exercice de numérotation doivent suivre le calendrier français — sinon une facture émise
    // entre minuit et ~2 h (Paris) est datée de la veille, voire numérotée sur l'exercice N-1 au
    // passage de l'an. Une seule dérivation pour les trois usages : cohérence garantie.
    const businessToday = parisDateOnly(at);
    const fiscalYear = Number(businessToday.slice(0, 4));

    try {
      const number = await this.deps.uow.runInTransaction(async () => {
        const company = await this.deps.companies.lockForShareById(pre.companyId);
        if (!company || company.isClosed()) {
          throw new TxDomainError({
            code: 'VALIDATION',
            field: 'company',
            message: 'Société introuvable ou clôturée.',
          });
        }

        const invoice = await this.deps.invoices.lockById(input.invoiceId);
        if (!invoice || invoice.companyId !== company.id)
          throw new TxDomainError({
            code: 'VALIDATION',
            field: 'invoice',
            message: 'Facture introuvable.',
          });
        // Déjà numérotée (retry réseau ou course gagnée par une autre émission) -> réponse idempotente.
        if (invoice.number) return invoice.number;

        // Le snapshot client utilisé pour les mentions est lui aussi relu dans la transaction,
        // après la facture fraîche. Une ligne corrompue/cross-tenant est refusée avant le compteur.
        const customer = await this.deps.customers.findById(invoice.customerId);
        if (!customer || customer.companyId !== company.id) {
          throw new TxDomainError({
            code: 'VALIDATION',
            field: 'customer',
            message: 'Client introuvable.',
          });
        }
        if (!termsR) {
          throw new TxAppError({
            kind: 'validation',
            issues: [
              {
                field: 'paymentTerms',
                message: 'Conditions de paiement explicites requises avant émission.',
              },
            ],
          });
        }
        if (!termsR.ok) {
          throw new TxAppError(appDomain(termsR.error));
        }

        // Un avoir tire sa propre séquence sans trou (A-AAAA-XXXX) — jamais celle des factures.
        const alloc = await this.deps.counters.allocate({
          companyId: invoice.companyId,
          counterKey: invoice.kind === 'credit_note' ? 'credit' : 'invoice',
          fiscalYear,
        });
        const assigned = invoice.assignNumber(alloc.formatted, at);
        if (!assigned.ok) throw new TxDomainError(assigned.error);
        const mentions = buildMentions({
          company,
          customer,
          kind: 'invoice',
          asOf: businessToday,
          operationNature: operationNatureOf(invoice.lines),
          // P11 : les taux des lignes déclenchent la mention certifiée taux réduits (10 %/5,5 %) —
          // l'éligibilité a été actée à la création (suggestVatRate), non persistée : cf. buildMentions.
          lineVatRates: invoice.lines.map((l) => l.vatRate),
        });
        const issued = invoice.issue({
          mentions,
          terms: termsR.value,
          issuedAt: businessToday,
          at,
        });
        if (!issued.ok) throw new TxDomainError(issued.error);
        await this.deps.invoices.save(invoice);
        const n = invoice.number;
        if (!n)
          throw new TxDomainError({
            code: 'VALIDATION',
            field: 'number',
            message: 'Numero manquant.',
          });
        return n;
      });
      return ok({ number });
    } catch (e) {
      if (e instanceof TxAppError) return err(e.appError);
      if (e instanceof TxDomainError) return err(appDomain(e.domainError));
      throw e; // erreur d'infrastructure : la transaction a été annulée (pas de trou) -> on propage
    }
  }
}
