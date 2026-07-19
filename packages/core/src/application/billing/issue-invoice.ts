import { type Result, ok, err } from '../../shared-kernel/result';
import { parisDateOnly } from '../../shared-kernel/time';
import { type AppError, appDomain, appNotFound } from '../result';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { buildMentions, operationNatureOf } from '../../domain/services/build-mentions';
import { type VatTreatment } from '../../domain/billing/invoice/invoice';
import {
  deriveRetractation,
  offPremisesEmbargoOverrideRisk,
  offPremisesPaymentEmbargo,
  offPremisesPaymentEmbargoMessage,
  retractationFreeze,
  retractationFreezeMessage,
} from '../../domain/compliance/retractation';
import {
  type InvoiceRepository,
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
} from '../ports/repositories';
import {
  type SequenceCounterPort,
  type ClockPort,
  type EmbargoOverrideAuditPort,
  type UnitOfWorkPort,
} from '../ports/services';
import { TxDomainError } from './tx-error';

export interface IssueInvoiceInput {
  invoiceId: string;
  terms?: { days: number; endOfMonth: boolean; label: string };
  /** A7 — date/période de la prestation si distincte de l'émission (art. 242 nonies A, I-8°
   *  annexe II CGI ; art. L441-9 code de commerce). Absent = non renseignée (la date de la
   *  pièce vaut date d'opération). Validée et FIGÉE par Invoice.issue. */
  servicePeriod?: { start: string; end: string | null };
  /** A7 — adresse de chantier/livraison si distincte de l'adresse de facturation du client.
   *  Absent = adresse de facturation. Le client propose l'adresse du chantier lié quand elle
   *  existe — jamais un défaut serveur inventé. Validée et FIGÉE par Invoice.issue. */
  deliveryAddress?: string;
  /**
   * Override RESPONSABILISÉ de l'embargo L221-10 — flag EXPLICITE (`true` strict, jamais
   * implicite) : risque concret vu et confirmé, événement payment.embargo_overridden journalisé
   * AVANT l'émission. Sans effet sur le gel de rétractation de la finale ni sur un devis
   * rétracté (protections du CLIENT, non contournables).
   */
  embargoOverride?: boolean;
}

export interface IssueInvoiceDeps {
  invoices: InvoiceRepository;
  companies: CompanyRepository;
  customers: CustomerRepository;
  /** A3 — les gardes légales (gel de rétractation, embargo L221-10, contrat rétracté) sont
   *  REVÉRIFIÉES à l'émission pour toute pièce dérivée d'un devis : un brouillon généré avant
   *  la garde (ou avant son déploiement) ne doit jamais s'émettre pendant la fenêtre légale. */
  quotes: Pick<QuoteRepository, 'findById'>;
  counters: SequenceCounterPort;
  uow: UnitOfWorkPort;
  clock: ClockPort;
  /**
   * Journal de l'override L221-10 — FAIL-CLOSED : sans port câblé, `embargoOverride` est
   * refusé comme un embargo ordinaire (jamais d'override sans trace écrite).
   */
  audit?: EmbargoOverrideAuditPort;
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

        // A3 — REVÉRIFICATION des gardes légales à l'ÉMISSION pour toute pièce dérivée d'un
        // devis (acompte/situation/finale — l'avoir rembourse, il n'exige rien) : la génération
        // du brouillon a pu précéder la garde (déploiement) ou la fenêtre (brouillon dormant),
        // et la qualité du client est lue depuis la signature (figée à la conclusion), jamais
        // depuis la seule fiche éditable. Fail-closed : devis parent introuvable → refus.
        if (invoice.parentQuoteId !== null && invoice.kind !== 'credit_note') {
          const quote = await this.deps.quotes.findById(invoice.parentQuoteId);
          if (!quote || quote.companyId !== company.id) {
            throw new TxDomainError({
              code: 'VALIDATION',
              field: 'quote',
              message: 'Devis parent introuvable : émission refusée.',
            });
          }
          if (quote.retractedAt !== null) {
            throw new TxDomainError({
              code: 'VALIDATION',
              field: 'quote',
              message:
                'Le client a exercé son droit de rétractation sur ce devis (art. L221-18 s. du ' +
                'code de la consommation) : émission refusée.',
            });
          }
          // L221-10 — contrat hors établissement B2C : aucune pièce exigible pendant 7 jours.
          // Exception al. 2 : intervention urgente tracée à la création → pas d'embargo.
          const embargo = offPremisesPaymentEmbargo(
            {
              customerType: customer.type,
              signature: quote.signature,
              urgentRepair: quote.urgentRepair,
            },
            at,
          );
          if (embargo.active) {
            if (input.embargoOverride === true && this.deps.audit !== undefined) {
              // Override responsabilisé : journalisé DANS la transaction — si la trace échoue,
              // l'émission est annulée (aucun numéro consommé, jamais d'override silencieux ;
              // port absent → refus fail-closed dans la branche else).
              await this.deps.audit.embargoOverridden({
                type: 'payment.embargo_overridden',
                quoteId: quote.id,
                companyId: company.id,
                invoiceKind: invoice.kind,
                embargoExpiresAt: embargo.expiresAt,
                occurredAt: at,
              });
            } else {
              throw new TxAppError(
                appDomain({
                  code: 'OFF_PREMISES_PAYMENT_EMBARGO',
                  quoteId: quote.id,
                  expiresAt: embargo.expiresAt,
                  availableFrom: embargo.availableFrom,
                  message: offPremisesPaymentEmbargoMessage(embargo.availableFrom),
                  overridable: true,
                  overrideRisk: offPremisesEmbargoOverrideRisk(embargo.availableFrom),
                }),
              );
            }
          }
          // Gel de la FINALE pendant le délai de rétractation (sauf exécution anticipée L221-25).
          if (invoice.kind === 'final') {
            const freeze = retractationFreeze(
              deriveRetractation({ customerType: customer.type, signature: quote.signature }),
              at,
            );
            if (freeze.active) {
              throw new TxAppError(
                appDomain({
                  code: 'RETRACTATION_PERIOD_ACTIVE',
                  quoteId: quote.id,
                  expiresAt: freeze.expiresAt,
                  availableFrom: freeze.availableFrom,
                  message: retractationFreezeMessage(freeze.availableFrom),
                }),
              );
            }
          }
        }

        // A4 — régime de TVA CONSTATÉ à l'émission (company + customer relus dans cette même
        // transaction) puis FIGÉ dans la pièce (Invoice.issue). Préséance franchise >
        // autoliquidation (BOI-TVA-DECLA-10-10-20), même règle que facturXDataFromInvoice.
        const franchise = company.isVatFranchise();
        const autoliquidation =
          !franchise
          && company.requiresAutoliquidation({
            type: customer.type,
            isSubcontractingBtp: customer.isSubcontractingBtp,
          });
        const vatTreatment: VatTreatment = franchise
          ? 'franchise'
          : autoliquidation
            ? 'autoliquidation'
            : 'standard';
        // L'AVOIR est exclu de la garde : il rectifie sa source sous le régime FIGÉ de celle-ci
        // (creditNoteFor, art. 272 CGI) — bloquer son émission empêcherait précisément de
        // corriger une pièce fautive.
        if (autoliquidation && invoice.kind !== 'credit_note') {
          // BR-AE-5 (EN 16931) : les lignes d'une pièce autoliquidée portent un taux 0 — une
          // ligne à taux > 0 produirait un PDF « TVA collectée » contredisant le XML AE archivé.
          // Fail-closed : l'émission est refusée tant que les lignes ne sont pas à 0 %.
          if (invoice.lines.some((line) => line.vatRate > 0)) {
            throw new TxAppError({
              kind: 'validation',
              issues: [
                {
                  field: 'lines',
                  message:
                    'Sous-traitance BTP (autoliquidation, art. 283, 2 nonies du CGI) : toutes ' +
                    'les lignes doivent être à 0 % de TVA — le preneur autoliquide.',
                },
              ],
            });
          }
          // BR-AE-2 (EN 16931) : une pièce AE DOIT identifier le preneur par son n° de TVA —
          // dérivé du SIREN. Sans SIREN client, la pièce serait invalide en e-invoicing :
          // refus à l'émission (jamais un identifiant inventé, jamais une violation masquée).
          if (!customer.siren) {
            throw new TxAppError({
              kind: 'validation',
              issues: [
                {
                  field: 'customer',
                  message:
                    'Sous-traitance BTP (autoliquidation) : le SIREN du client professionnel ' +
                    'est requis pour émettre (identification du preneur, EN 16931 BR-AE-2).',
                },
              ],
            });
          }
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
          // A7 : figés à l'émission — un rejet domaine (période incohérente, adresse invalide)
          // annule la transaction, aucun numéro consommé.
          servicePeriod: input.servicePeriod ?? null,
          deliveryAddress: input.deliveryAddress ?? null,
          // A4 : régime de TVA constaté ci-dessus, figé dans la pièce (un avoir garde celui
          // repris de sa source — Invoice.issue l'ignore alors, art. 272 CGI).
          vatTreatment,
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
