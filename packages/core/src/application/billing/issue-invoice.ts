import { type Result, ok, err } from '../../shared-kernel/result';
import { parisDateOnly } from '../../shared-kernel/time';
import { type AppError, appDomain, appNotFound } from '../result';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { buildMentions, operationNatureOf } from '../../domain/services/build-mentions';
import { internationalProEmissionGuard } from '../../domain/services/international-emission-guard';
import { professionalAdvanceRecoveryGuard } from '../../domain/compliance/professional-advance-recovery';
import { validateProPaymentTermsCeiling } from '../../domain/services/payment-terms-legal';
import { retenueGarantieMention } from '../../domain/services/retenue-garantie';
import {
  billedTtcCents,
  quoteBillingEngagement,
  validateSituationVatClosure,
} from '../../domain/services/quote-billing-engagement';
import { type VatTreatment } from '../../domain/billing/invoice/invoice';
import {
  resolveFrenchBillingModeAtIssuance,
  type FrenchBillingMode,
  type FrenchOperationCategory,
} from '../../domain/compliance/french-billing-mode';
import { billingUnitToUneceCode } from '../../domain/compliance/billing-unit';
import {
  deriveRetractation,
  offPremisesEmbargoOverrideRisk,
  offPremisesPaymentEmbargo,
  offPremisesPaymentEmbargoMessage,
  retractationFreeze,
  retractationFreezeMessage,
  urgentRepairQuoteMention,
} from '../../domain/compliance/retractation';
import { STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE } from './compose-standalone-invoice';
import {
  type InvoiceRepository,
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
} from '../ports/repositories';
import { type MaintenanceContract } from '../../domain/contract/maintenance-contract';
import { type ContractInvoicesReadPort } from '../contracts/maintenance-contract-repository';
import {
  type SequenceCounterPort,
  type ClockPort,
  type EmbargoOverrideAuditPort,
  type PurchaseOrderOverrideAuditPort,
  type UnitOfWorkPort,
} from '../ports/services';
import { TxDomainError } from './tx-error';

export interface IssueInvoiceInput {
  invoiceId: string;
  /** BT-23 — fait utilisateur demandé seulement quand l'accessorité des lignes est ambiguë. */
  operationCategory?: FrenchOperationCategory;
  /**
   * B4 — conditions de paiement CHOISIES EXPLICITEMENT pour CETTE pièce (priorité 1). Absent :
   * l'échéance est dérivée des conditions du CLIENT (Customer.paymentTerms, priorité 2), puis
   * de `defaultTerms` (priorité 3). NE PLUS y passer le défaut société : il passe par
   * `defaultTerms`, sinon il écraserait silencieusement les conditions du client.
   */
  terms?: { days: number; endOfMonth: boolean; label: string };
  /**
   * B4 — défaut SOCIÉTÉ (réglages CompanyBillingSettings, résolus par la frontière — le core ne
   * lit pas les réglages ici) : appliqué UNIQUEMENT quand ni `terms` ni les conditions du
   * client n'existent. Aucune source résolue → refus (jamais d'échéance implicite).
   */
  defaultTerms?: { days: number; endOfMonth: boolean; label: string };
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
  /**
   * PR-04 — override RESPONSABILISÉ de la garde « BC obligatoire » (`true` strict, jamais
   * implicite) : le client exige un n° de commande mais l'artisan émet SANS (BC pas encore
   * reçu, urgence) en confirmant le risque de rejet — événement
   * invoice.purchase_order_overridden JOURNALISÉ dans la transaction (fail-closed sans port).
   */
  purchaseOrderOverride?: boolean;
}

export interface IssueInvoiceDeps {
  invoices: InvoiceRepository;
  companies: CompanyRepository;
  customers: CustomerRepository;
  /** A3/B2 — les gardes légales (gel de rétractation, embargo L221-10, contrat rétracté) ET la
   *  garde de cumul « acompte + situations ≤ marché » sont REVÉRIFIÉES à l'émission pour toute
   *  pièce dérivée d'un devis : un brouillon généré avant la garde (ou dormant depuis avant la
   *  finale) ne doit jamais s'émettre. `lockById` (FOR UPDATE) sérialise les émissions des
   *  pièces sœurs d'un même devis — la garde de cumul se lit sans course. */
  quotes: Pick<QuoteRepository, 'findById' | 'lockById'>;
  counters: SequenceCounterPort;
  uow: UnitOfWorkPort;
  clock: ClockPort;
  /**
   * Journal de l'override L221-10 — FAIL-CLOSED : sans port câblé, `embargoOverride` est
   * refusé comme un embargo ordinaire (jamais d'override sans trace écrite).
   */
  audit?: EmbargoOverrideAuditPort;
  /**
   * PR-04 — journal de l'émission sans BC d'un client qui l'exige : même doctrine fail-closed
   * (port absent → `purchaseOrderOverride` refusé comme la garde ordinaire).
   */
  purchaseOrderAudit?: PurchaseOrderOverrideAuditPort;
  /**
   * PR-12b [direction 1] — verrou du CONTRAT de maintenance (FOR UPDATE) pour la garde
   * d'émission de la facture annuelle : sérialise les émissions concurrentes du même contrat.
   * FAIL-CLOSED : facture de contrat rencontrée sans ces ports → émission refusée (jamais une
   * couverture non vérifiée). Optionnels pour les appelants sans contrats (compat).
   */
  contracts?: { lockById(companyId: string, id: string): Promise<MaintenanceContract | null> };
  contractInvoices?: Pick<ContractInvoicesReadPort, 'listByMaintenanceContract'>;
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
    const explicitTermsR = input.terms === undefined ? null : PaymentTerms.of(input.terms);
    const defaultTermsR = input.defaultTerms === undefined ? null : PaymentTerms.of(input.defaultTerms);

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

        const issuerReady = company.assertCanIssue();
        if (!issuerReady.ok) throw new TxAppError(appDomain(issuerReady.error));

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

        // La création d'une fiche client reste possible avec une identité minimale, mais une
        // facture légale ne peut jamais consommer un numéro avec une adresse acheteur vide.
        // Cette garde précède toutes les allocations et protège PDF + Factur-X de la même façon.
        const customerBillingAddress = customer.assertBillingAddressComplete();
        if (!customerBillingAddress.ok) {
          throw new TxAppError(appDomain(customerBillingAddress.error));
        }

        // La pièce légale conserve chaque unité humaine. Toute unité présente doit donc avoir
        // un code UN/ECE exact avant numérotation ; un fallback C62 après émission mentirait.
        for (const line of invoice.lines) {
          const mappedUnit = billingUnitToUneceCode(line.unit);
          if (!mappedUnit.ok) throw new TxAppError(appDomain(mappedUnit.error));
        }

        // EN 16931 BR-O-11/12 interdit de mélanger une opération hors champ (débours) avec une
        // catégorie TVA dans la même facture structurée. Tant que Bob ne produit pas un profil
        // étendu certifié pour ce cas français, on refuse honnêtement et on demande deux pièces.
        const hasDisbursement = invoice.lines.some((line) => line.category === 'disbursement');
        const hasNonDisbursement = invoice.lines.some((line) => line.category !== 'disbursement');
        if (hasDisbursement && hasNonDisbursement) {
          throw new TxAppError({
            kind: 'validation',
            issues: [
              {
                field: 'lines.disbursement',
                message:
                  'Les débours hors TVA ne peuvent pas être mélangés à une prestation dans ' +
                  'cette facture électronique. Crée une pièce séparée pour les débours.',
              },
            ],
          });
        }
        if (
          hasDisbursement
          && invoice.lines.some((line) => line.category === 'disbursement' && line.vatRate !== 0)
        ) {
          throw new TxAppError({
            kind: 'validation',
            issues: [
              {
                field: 'lines.disbursement',
                message: 'Un débours hors base de TVA doit porter un taux de 0 %.',
              },
            ],
          });
        }
        // B6 — client PROFESSIONNEL établi hors de France : émission refusée AVANT le compteur
        // (aucun numéro consommé), sans contournement — TVA intracom/export pas encore gérée,
        // une TVA française serait fiscalement fausse. L'AVOIR est exempté : il rectifie une
        // pièce fautive sous le régime FIGÉ de sa source (bloquer l'avoir empêcherait
        // précisément de corriger).
        if (invoice.kind !== 'credit_note') {
          const international = internationalProEmissionGuard(customer);
          if (!international.ok) throw new TxDomainError(international.error);
        }

        // B1/A3bis — facture DIRECTE (sans devis parent) à un CONSOMMATEUR : émission refusée
        // sans qualification d'intervention urgente tracée à la composition — fail-closed, les
        // protections L221-10/L221-18 passent par le devis signé (parité avec la composition).
        if (
          invoice.parentQuoteId === null &&
          invoice.kind !== 'credit_note' &&
          customer.type === 'b2c' &&
          invoice.urgentRepair === null
        ) {
          throw new TxAppError({
            kind: 'validation',
            issues: [
              { field: 'customer', message: STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE },
            ],
          });
        }

        // PR-04 — garde « BC obligatoire » (pattern résolution B4 : le fait du CLIENT est relu
        // DANS la transaction) : ce client exige un n° de commande, la pièce n'en porte aucun →
        // refus ACTIONNABLE avant tout compteur (une facture RATP CAP sans n° d'engagement est
        // rejetée à réception : mieux vaut bloquer ici que perdre 45 jours). L'AVOIR est exempté
        // (il rectifie une pièce fautive). Override RESPONSABILISÉ : `true` strict + port
        // d'audit câblé → événement invoice.purchase_order_overridden journalisé DANS la
        // transaction (fail-closed : trace impossible = émission annulée).
        if (
          invoice.kind !== 'credit_note'
          && customer.requiresPurchaseOrder
          && invoice.purchaseOrder === null
        ) {
          if (input.purchaseOrderOverride === true && this.deps.purchaseOrderAudit !== undefined) {
            await this.deps.purchaseOrderAudit.purchaseOrderOverridden({
              type: 'invoice.purchase_order_overridden',
              invoiceId: invoice.id,
              companyId: company.id,
              customerId: customer.id,
              invoiceKind: invoice.kind,
              occurredAt: at,
            });
          } else {
            throw new TxDomainError({
              code: 'PURCHASE_ORDER_REQUIRED',
              invoiceId: invoice.id,
              customerId: customer.id,
              customerName: customer.name,
              message:
                `${customer.name} exige un n° de bon de commande : saisis-le sur la facture ` +
                'avant d’émettre — sans lui, la pièce sera rejetée par ton client. ' +
                'Tu peux aussi émettre sans BC en confirmant ce risque (tracé).',
              overridable: true,
            });
          }
        }

        // B4 — résolution de l'échéance : conditions EXPLICITES pour cette pièce (priorité 1) >
        // conditions du CLIENT relues DANS la transaction (priorité 2) > défaut société passé
        // par la frontière (priorité 3). Aucune source → refus : jamais d'échéance implicite.
        const customerTerms = customer.paymentTerms;
        const customerTermsR = customerTerms === undefined ? null : PaymentTerms.of(customerTerms);
        const termsR = explicitTermsR ?? customerTermsR ?? defaultTermsR;
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
        // B4 — plafond légal L441-10 REVALIDÉ à l'émission pour un débiteur professionnel
        // (60 j / 45 j fin de mois) : fail-closed pour toute condition antérieure au plafond —
        // une échéance illégale fausserait relances J+3/J+10/J+20/J+30 et pénalités.
        if (customer.isProfessional()) {
          const ceiling = validateProPaymentTermsCeiling(customer.type, {
            days: termsR.value.days,
            endOfMonth: termsR.value.endOfMonth,
          });
          if (!ceiling.ok) throw new TxAppError(appDomain(ceiling.error));
        }

        // A3 — REVÉRIFICATION des gardes légales à l'ÉMISSION pour toute pièce dérivée d'un
        // devis (acompte/situation/finale — l'avoir rembourse, il n'exige rien) : la génération
        // du brouillon a pu précéder la garde (déploiement) ou la fenêtre (brouillon dormant),
        // et la qualité du client est lue depuis la signature (figée à la conclusion), jamais
        // depuis la seule fiche éditable. Fail-closed : devis parent introuvable → refus.
        if (invoice.parentQuoteId !== null && invoice.kind !== 'credit_note') {
          // Verrou UPDATE du devis parent DANS la transaction — ordre global des verrous :
          // Company SHARE -> Invoice UPDATE -> Quote UPDATE -> compteur. Deux émissions de
          // pièces SŒURS du même devis se sérialisent ici : la seconde relit un engagement
          // frais (garde de cumul B2 ci-dessous) au lieu d'un instantané concurrent.
          const quote = await this.deps.quotes.lockById(invoice.parentQuoteId);
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
          // Gel de la FINALE — et des SITUATIONS (B2 : paiement de travaux exécutés, non
          // payables sans demande expresse, art. L221-25 — lecture prudente) — pendant le
          // délai de rétractation (sauf exécution anticipée L221-25).
          if (invoice.kind === 'final' || invoice.kind === 'situation') {
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

          // B2 — INVIOLABLE, revérifié à l'ÉMISSION derrière le verrou du devis : le marché
          // signé ne se facture jamais au-delà de 100 % (TVA exigible sur chaque pièce émise,
          // art. 283 du CGI). Un brouillon DORMANT (généré avant la finale ou avant cette
          // garde) ne contourne pas la génération : même lecture quoteBillingEngagement.
          const engagement = quoteBillingEngagement(
            await this.deps.invoices.listByCompany(company.id),
            quote.id,
          );
          const emittedSisters = engagement.engaged.filter(
            (sister) => sister.status !== 'draft' && sister.id !== invoice.id,
          );
          if (invoice.kind === 'deposit' || invoice.kind === 'situation') {
            // 1) Marché SOLDÉ : une finale émise (non annulée, non avoirée) ferme le devis
            //    aux pièces d'appel — un trop-perçu se rectifie par avoir, jamais par une
            //    pièce supplémentaire.
            const issuedFinal = engagement.finals.find((sister) => sister.status !== 'draft');
            if (issuedFinal !== undefined) {
              throw new TxDomainError({
                code: 'VALIDATION',
                field: 'invoice',
                message:
                  'La facture finale de ce devis est émise : le marché est soldé, ce brouillon ' +
                  'ne peut plus s’émettre — supprime-le (une rectification passe par un avoir).',
              });
            }
            // 2) CUMUL relu à l'émission : pièces sœurs ÉMISES + celle-ci ≤ marché TTC (deux
            //    brouillons nés d'une course de génération ne peuvent pas s'émettre tous les
            //    deux au-delà du marché).
            const marcheTtc = quote.totals().ttc;
            const engagedTtc = emittedSisters.reduce(
              (sum, sister) => sum + billedTtcCents(sister),
              0,
            );
            const ownTtc = billedTtcCents(invoice);
            if (engagedTtc + ownTtc > marcheTtc) {
              throw new TxDomainError({
                code: 'VALIDATION',
                field: 'invoice',
                message:
                  `Cumul acompte + situations supérieur au marché : déjà émis ${engagedTtc} c sur ` +
                  `${marcheTtc} c TTC — reste facturable ${Math.max(0, marcheTtc - engagedTtc)} c. ` +
                  'Supprime ce brouillon et régénère une pièce dans le reste facturable.',
              });
            }
          } else if (invoice.kind === 'final') {
            // 3) COHÉRENCE de la déduction de la finale : le solde émis doit déduire EXACTEMENT
            //    l'acompte et les situations émis AUJOURD'HUI. Une pièce sœur émise (ou avoirée)
            //    depuis la génération rendrait la déduction figée fausse → refus, à régénérer.
            const expectedDeduction = emittedSisters.reduce(
              (sum, sister) => sum + billedTtcCents(sister),
              0,
            );
            if (expectedDeduction !== invoice.depositDeductionCents) {
              throw new TxDomainError({
                code: 'VALIDATION',
                field: 'invoice',
                message:
                  'Les pièces facturées de ce devis ont changé depuis la préparation de cette ' +
                  'facture finale : supprime ce brouillon et régénère le solde — il doit ' +
                  'déduire exactement l’acompte et les situations émis.',
              });
            }
            const emittedSituations = emittedSisters.filter(
              (sister) => sister.kind === 'situation',
            );
            const vatClosure = validateSituationVatClosure({
              marketTotals: quote.totals(),
              emittedSituations,
              finalInvoice: invoice,
            });
            if (!vatClosure.ok) throw new TxDomainError(vatClosure.error);
          }
        }

        // PR-12b [direction 1, annexe erratum n° 2] — garde d'émission FAIL-CLOSED d'une
        // facture de CONTRAT, DANS la transaction du compteur. Ordre GLOBAL des verrous
        // ÉTENDU, jamais inversé (deadlock sinon, vigilance §7.7.3) :
        // Company SHARE → Invoice UPDATE → Quote UPDATE (si devis parent) →
        // MaintenanceContract UPDATE (lockById) → compteur.
        if (invoice.maintenanceContractId !== null && invoice.kind !== 'credit_note') {
          // (a) AUTORITÉ = colonnes du BROUILLON : une période absente est refusée AVANT tout
          // compteur ; un input divergent est refusé (Invoice.issue revérifie à l'identique).
          const draftPeriod = invoice.servicePeriod;
          if (draftPeriod === null || draftPeriod.end === null) {
            throw new TxDomainError({
              code: 'VALIDATION',
              field: 'servicePeriod',
              message:
                'Facture de contrat sans période de service : renseigne la période avant d’émettre.',
            });
          }
          if (
            input.servicePeriod !== undefined
            && (input.servicePeriod.start !== draftPeriod.start
              || (input.servicePeriod.end ?? null) !== draftPeriod.end)
          ) {
            throw new TxDomainError({
              code: 'VALIDATION',
              field: 'servicePeriod',
              message:
                'La période de service d’une facture de contrat est portée par le brouillon : ' +
                'modifie le brouillon, jamais l’émission.',
            });
          }
          if (this.deps.contracts === undefined || this.deps.contractInvoices === undefined) {
            throw new TxAppError({
              kind: 'dependency',
              port: 'MaintenanceContractRepository',
              cause:
                'Facture de contrat sans ports contrats câblés : émission refusée (couverture non vérifiable).',
            });
          }
          // (b) contrat verrouillé (FOR UPDATE) et prouvé dans le tenant.
          const contract = await this.deps.contracts.lockById(
            company.id,
            invoice.maintenanceContractId,
          );
          if (!contract || contract.companyId !== company.id) {
            throw new TxDomainError({
              code: 'VALIDATION',
              field: 'maintenanceContractId',
              message: 'Contrat de maintenance introuvable : émission refusée.',
            });
          }
          // (c) SOUS le verrou : relecture des factures ÉMISES non annulées du contrat — un
          // chevauchement de période avec CELLE-CI est refusé avec le numéro réel. Deux
          // brouillons concurrents (2 appareils, voix + UI, double tap) ne s'émettent JAMAIS
          // tous les deux : le second attend le verrou, relit, et reçoit ce refus — la
          // transaction s'annule, AUCUN numéro consommé (problème P1 clos).
          const sisters = await this.deps.contractInvoices.listByMaintenanceContract(
            company.id,
            contract.id,
          );
          for (const sister of sisters) {
            if (sister.id === invoice.id) continue;
            if (sister.kind === 'credit_note') continue;
            // Fail-closed : une projection MUETTE (statut/période non transportés) interdit de
            // prouver l'absence de chevauchement — émission refusée plutôt qu'un doublon.
            if (sister.status === undefined) {
              throw new TxAppError({
                kind: 'dependency',
                port: 'ContractInvoicesReadPort',
                cause: 'Projection de facture de contrat sans statut : émission refusée.',
              });
            }
            if (sister.status === 'draft' || sister.status === 'cancelled') continue;
            if (sister.servicePeriodStart === undefined || sister.servicePeriodEnd === undefined) {
              throw new TxAppError({
                kind: 'dependency',
                port: 'ContractInvoicesReadPort',
                cause: 'Projection de facture de contrat sans période : émission refusée.',
              });
            }
            if (sister.servicePeriodStart === null) continue;
            const sisterEnd = sister.servicePeriodEnd ?? sister.servicePeriodStart;
            // Deux périodes de service INCLUSIVES se chevauchent ssi débuts ≤ fins croisés.
            if (sister.servicePeriodStart <= draftPeriod.end && draftPeriod.start <= sisterEnd) {
              throw new TxDomainError({
                code: 'VALIDATION',
                field: 'servicePeriod',
                message:
                  `Période déjà facturée par ${sister.number ?? 'une facture émise'} — ` +
                  'annule-la (avoir) ou ajuste la période.',
              });
            }
          }
          // (d) AUCUNE écriture sur le contrat : la couverture est DÉRIVÉE, le verrou ne sert
          // qu'à sérialiser les émissions concurrentes du même contrat.
        }

        // Ferme aussi les anciens brouillons : la garde de génération empêche les nouveaux
        // acomptes professionnels, mais seule l'émission transactionnelle garantit qu'un draft
        // historique ne consomme aucun numéro. Placée après les gardes du contrat, elle ne masque
        // jamais un embargo ou une rétractation B2C. Le B2C suit son chemin PDF/e-reporting.
        const advancePath = professionalAdvanceRecoveryGuard({
          customerType: customer.type,
          invoiceKind: invoice.kind,
          advanceDeductionCents: invoice.advanceDeductionCents,
        });
        if (!advancePath.ok) throw new TxDomainError(advancePath.error);

        // France 2026 — une facture électronique doit porter un endpoint réel pour le vendeur
        // ET l'acheteur (BT-34/BT-49). Pour un professionnel français, le CIUS impose en plus
        // BAR/B2B + SIREN/0225 : un e-mail ne peut pas remplacer le SIREN. Pour un particulier,
        // l'e-mail validé par Customer.of est l'endpoint EM. Refus AVANT le compteur : jamais
        // de numéro consommé pour une pièce dont le XML réglementaire serait invalide, jamais
        // d'identifiant synthétique pour contourner le contrôle.
        if (customer.requiresSirenForEinvoice() && customer.siren === undefined) {
          throw new TxAppError({
            kind: 'validation',
            issues: [
              {
                field: 'customer.siren',
                message:
                  'Le SIREN du client professionnel est requis avant émission pour la ' +
                  'facturation électronique française (endpoint BT-49 / scheme 0225).',
              },
            ],
          });
        }
        // Un particulier sans e-mail peut recevoir une facture PDF/papier : il relève de
        // l'e-reporting, pas du routage e-invoicing B2B. Son endpoint EM reste absent, jamais
        // remplacé par une adresse synthétique. Le canal de transmission le contrôlera si un
        // envoi électronique est effectivement demandé.

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
          // BR-AE-2 (EN 16931) : une pièce AE DOIT identifier vendeur ET preneur par leurs
          // numéros de TVA réellement fournis. Un SIREN ne prouve pas qu'un numéro a été attribué.
          if (!customer.tvaIntracom) {
            throw new TxAppError({
              kind: 'validation',
              issues: [
                {
                  field: 'customer.tvaIntracom',
                  message:
                    'Sous-traitance BTP (autoliquidation) : le numéro de TVA réel du client ' +
                    'est requis pour émettre (identification du preneur, EN 16931 BR-AE-2).',
                },
              ],
            });
          }
        }

        // BT-23 France — décision AVANT allocation du numéro. L'avoir reprend strictement
        // le fait figé de sa source ; une pièce nouvelle le résout depuis les faits réels.
        let frenchBillingMode: FrenchBillingMode;
        if (invoice.kind === 'credit_note') {
          const inherited = invoice.frenchBillingModeAtIssuance;
          if (inherited === null) {
            throw new TxDomainError({
              code: 'VALIDATION',
              field: 'frenchBillingMode',
              message:
                'La facture source historique ne contient pas son cadre de facturation français : émission de l’avoir refusée.',
            });
          }
          frenchBillingMode = inherited;
        } else {
          const resolvedMode = resolveFrenchBillingModeAtIssuance({
            kind: invoice.kind,
            vatTreatment,
            lineCategories: invoice.lines.map((line) => line.category),
            ...(input.operationCategory === undefined
              ? {}
              : { operationCategory: input.operationCategory }),
            depositDeductionCents: invoice.depositDeductionCents,
            situationDeductionCents: invoice.situationDeductionCents,
          });
          if (!resolvedMode.ok) throw new TxDomainError(resolvedMode.error);
          frenchBillingMode = resolvedMode.value;
        }

        // Un avoir tire sa propre séquence sans trou (A-AAAA-XXXX) — jamais celle des factures.
        const alloc = await this.deps.counters.allocate({
          companyId: invoice.companyId,
          counterKey: invoice.kind === 'credit_note' ? 'credit' : 'invoice',
          fiscalYear,
        });
        const assigned = invoice.assignNumber(alloc.formatted, at);
        if (!assigned.ok) throw new TxDomainError(assigned.error);
        // Totaux VIVANTS avant figeage (identiques à ceux qui seront figés par issue) — portent
        // la retenue de garantie B5 pour la mention dédiée.
        const liveTotals = invoice.totals();
        const mentions = buildMentions({
          company,
          customer,
          kind: 'invoice',
          asOf: businessToday,
          operationNature: operationNatureOf(invoice.lines),
          // P11 : les taux des lignes déclenchent la mention certifiée taux réduits (10 %/5,5 %) —
          // l'éligibilité a été actée à la création (suggestVatRate), non persistée : cf. buildMentions.
          lineVatRates: invoice.lines.map((l) => l.vatRate),
          // B3 — remises de ligne/globale → mention « rabais, remises, ristournes » (L441-9).
          hasPriceReductions:
            invoice.lines.some((l) => l.discount !== undefined) || invoice.globalDiscount !== null,
        });
        if (invoice.kind !== 'credit_note') {
          // B1/A3bis — facture directe sur intervention urgente : la trace légale qui fonde
          // l'exception (L221-10, al. 2 / L221-28, 8°) est IMPRIMÉE sur la pièce, avec sa date.
          const urgent = invoice.urgentRepair;
          if (invoice.parentQuoteId === null && urgent) {
            mentions.push(urgentRepairQuoteMention(urgent.requestedAt));
          }
          // B5 — mention DÉDIÉE de la retenue de garantie (loi 71-584) figée avec la pièce.
          const retenuePct = invoice.retenueGarantiePct;
          const retenueCents = liveTotals.retenueGarantieCents ?? 0;
          if (retenuePct !== null && retenueCents > 0) {
            mentions.push(retenueGarantieMention(retenuePct, retenueCents));
          }
        }
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
          frenchBillingMode,
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
