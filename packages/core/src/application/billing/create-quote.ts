import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type LineInput } from '../../domain/billing/shared/line-item';
import { type Discount } from '../../domain/billing/shared/discount';
import { type Totals } from '../../domain/billing/shared/totals';
import { Quote } from '../../domain/billing/quote/quote';
import { suggestVatRate } from '../../domain/services/suggest-vat-rate';
import {
  type QuoteRepository,
  type CompanyRepository,
  type CustomerRepository,
} from '../ports/repositories';
import { type DocumentLinkTargetPort } from '../ports/document-link-target';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import { isValidDateOnly } from '../../shared-kernel/time';
import { validateLineInputs } from './line-input-validation';

export interface CreateQuoteInput {
  companyId: string;
  /**
   * Clé opaque possédée par l'appelant pour rejouer une création dont la réponse a pu
   * être perdue. Le domaine ne la persiste jamais : les adaptateurs n'en conservent qu'une
   * empreinte tenant-scoped avec celle de l'intention canonique.
   */
  idempotencyKey?: string | null;
  customerId: string;
  lines: LineInput[];
  depositPct?: number;
  /** B3 — remise globale du devis (% du HT net de lignes, ou montant HT en centimes). */
  globalDiscount?: Discount | null;
  /** B5 — retenue de garantie du devis-chantier (0 < taux ≤ 5, loi 71-584) ; absent = aucune. */
  retenueGarantiePct?: number | null;
  validUntil?: string;
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
  /**
   * Exception dépannage urgent (art. L221-10, al. 2 et L221-28, 8° c. conso) : travaux
   * d'entretien/réparation à réaliser EN URGENCE au domicile du client, EXPRESSÉMENT sollicités
   * par lui. Posé À LA CRÉATION du devis (question du wizard quand le client est un
   * particulier), horodaté serveur ici — JAMAIS rétroactif. Refusé pour un client
   * professionnel/public : l'exception ne protège que le régime du consommateur à domicile.
   */
  urgentRepairRequested?: boolean;
  /**
   * PR-08 — site/chantier de rattachement du devis (picker du wizard), OPTIONNEL et nullable :
   * null/absent = devis hors site. L'appartenance du chantier au tenant est PROUVÉE avant
   * toute persistance (anti-IDOR fail-closed, patron RecordExpense.chantierId).
   */
  chantierId?: string | null;
}

export interface CreateQuoteOutput {
  quoteId: string;
  totals: Totals;
}

export interface CreateQuoteDeps {
  quotes: QuoteRepository;
  companies: CompanyRepository;
  customers: CustomerRepository;
  ids: IdGeneratorPort;
  clock: ClockPort;
  /**
   * PR-08 — preuve d'existence tenant-scoped du chantier visé (anti-IDOR, même port que
   * RecordExpense). OPTIONNELLE pour la compat des câblages existants, mais REQUISE dès qu'un
   * `chantierId` est fourni : sans port, la création avec site échoue (fail-closed, jamais un
   * lien non vérifié en base).
   */
  chantierTargets?: DocumentLinkTargetPort;
}

/**
 * Intention canonique d'une création de devis.
 *
 * Les valeurs optionnelles sont ramenées aux mêmes valeurs effectives que le use case. La clé
 * technique et le tenant sont volontairement exclus : le tenant sale séparément l'empreinte de
 * clé dans l'adaptateur de persistance.
 */
export function canonicalCreateQuotePayload(input: Omit<CreateQuoteInput, 'companyId'>) {
  return {
    customerId: input.customerId,
    lines: input.lines.map((line) => ({
      label: line.label,
      category: line.category,
      qty: line.qty,
      unit: line.unit ?? null,
      unitPriceHT: line.unitPriceHT,
      vatRate: line.vatRate,
      discount: line.discount ?? null,
    })),
    depositPct: input.depositPct ?? null,
    globalDiscount: input.globalDiscount ?? null,
    retenueGarantiePct: input.retenueGarantiePct ?? null,
    validUntil: input.validUntil ?? null,
    context: {
      housingOlderThan2y: input.context?.housingOlderThan2y ?? false,
      energyRenovation: input.context?.energyRenovation ?? false,
    },
    urgentRepairRequested: input.urgentRepairRequested ?? false,
    // PR-08 — le site fait partie de l'intention : un rejeu vers un autre site est un conflit.
    chantierId: input.chantierId ?? null,
  } as const;
}

/** Compose un devis. La règle TVA (franchise/autoliquidation) est appliquée ICI via suggestVatRate. */
export class CreateQuote {
  constructor(private readonly deps: CreateQuoteDeps) {}

  async execute(input: CreateQuoteInput): Promise<Result<CreateQuoteOutput, AppError>> {
    if (input.validUntil !== undefined && !isValidDateOnly(input.validUntil)) {
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'validUntil',
          message: 'Date de validité invalide.',
        }),
      );
    }
    const lineError = validateLineInputs(input.lines);
    if (lineError) return err(lineError);
    const company = await this.deps.companies.findById(input.companyId);
    if (!company) return err(appNotFound('company', input.companyId));
    const customer = await this.deps.customers.findById(input.customerId);
    // Intégrité référentielle / anti-IDOR : le client doit appartenir au tenant (cf. CreateChantier).
    if (!customer || customer.companyId !== input.companyId)
      return err(appNotFound('customer', input.customerId));

    // Exception dépannage urgent : réservée au CONSOMMATEUR (b2c) — l'art. L221-10/L221-28 ne
    // régit que le contrat conclu avec un consommateur. La déclarer sur un devis pro serait un
    // fait légal sans objet : refus honnête plutôt qu'une trace trompeuse.
    if (input.urgentRepairRequested === true && customer.type !== 'b2c') {
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'urgentRepairRequested',
          message:
            "L'intervention urgente (art. L221-10 du code de la consommation) ne concerne qu'un client particulier.",
        }),
      );
    }

    const at = this.deps.clock.now();
    const composed = Quote.compose({
      id: this.deps.ids.newId(),
      companyId: input.companyId,
      customerId: input.customerId,
      at,
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
      // Horodaté SERVEUR à la création — la trace qui fonde l'exception L221-10, al. 2.
      urgentRepair: input.urgentRepairRequested === true ? { requestedAt: at } : null,
      chantierId: input.chantierId ?? null,
    });
    if (!composed.ok) return err(appDomain(composed.error));
    const quote = composed.value;

    // PR-08 — anti-IDOR : un chantier visé doit être PROUVÉ dans le tenant AVANT toute
    // persistance. Fail-closed : chantierId fourni sans port câblé = refus (jamais de lien
    // non vérifié) ; le port répond false pour « absent » COMME pour « autre tenant ».
    const chantierId = quote.chantierId;
    if (chantierId !== null) {
      if (!this.deps.chantierTargets) {
        return err({
          kind: 'dependency',
          port: 'DocumentLinkTargetPort',
          cause: 'chantierId fourni sans port de vérification tenant (chantierTargets) : rattachement refusé.',
        });
      }
      const exists = await this.deps.chantierTargets.exists({
        companyId: input.companyId,
        linkedEntityType: 'chantier',
        linkedEntityId: chantierId,
      });
      if (!exists) return err(appNotFound('chantier', chantierId));
    }

    for (const line of input.lines) {
      const rate = suggestVatRate({
        company,
        customer,
        category: line.category,
        requestedRate: line.vatRate,
        ...(input.context !== undefined ? { context: input.context } : {}),
      });
      if (!rate.ok) return err(appDomain(rate.error));
      const added = quote.addLine({ ...line, id: this.deps.ids.newId(), vatRate: rate.value });
      if (!added.ok) return err(appDomain(added.error));
    }

    if (input.depositPct !== undefined) {
      const dep = quote.setDeposit(input.depositPct);
      if (!dep.ok) return err(appDomain(dep.error));
    }

    // B3 — remise globale négociée (« je vous arrondis à… ») posée à la création.
    if (input.globalDiscount !== undefined && input.globalDiscount !== null) {
      const discount = quote.setGlobalDiscount(input.globalDiscount);
      if (!discount.ok) return err(appDomain(discount.error));
    }

    // B5 — retenue de garantie stipulée au devis-chantier (marché privé de travaux, loi 71-584).
    if (input.retenueGarantiePct !== undefined && input.retenueGarantiePct !== null) {
      const retenue = quote.setRetenueGarantie(input.retenueGarantiePct);
      if (!retenue.ok) return err(appDomain(retenue.error));
    }

    await this.deps.quotes.save(quote);
    return ok({ quoteId: quote.id, totals: quote.totals() });
  }
}
