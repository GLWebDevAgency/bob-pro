import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type LineInput } from '../../domain/billing/shared/line-item';
import { type Totals } from '../../domain/billing/shared/totals';
import { type Quote } from '../../domain/billing/quote/quote';
import { type Company } from '../../domain/company/company';
import { type Customer } from '../../domain/customer/customer';
import { suggestVatRate } from '../../domain/services/suggest-vat-rate';
import {
  CreateQuote,
  type CreateQuoteDeps,
  type CreateQuoteInput,
} from './create-quote';

/**
 * PR-14 « Refaire ce devis » — trace honnête d'un taux ADAPTÉ pendant la duplication :
 * l'écran affiche « TVA recalculée au régime actuel : {label} {from} % → {to} % », jamais un
 * changement silencieux de prix.
 */
export interface QuoteDuplicationVatAdjustment {
  label: string;
  from: number;
  to: number;
  /** `regime` : taux 0 imposé par le régime courant (franchise 293 B, autoliquidation, débours) ;
   * `standard_rate_choice` : ligne 10/5,5 repassée à 20 % sur choix EXPLICITE de l'artisan. */
  reason: 'regime' | 'standard_rate_choice';
}

export interface QuoteDuplicationDraft {
  /** Entrée PRÊTE pour CreateQuote — la duplication repasse INTÉGRALEMENT par lui. */
  input: Omit<CreateQuoteInput, 'companyId'>;
  vatAdjustments: QuoteDuplicationVatAdjustment[];
}

export interface BuildQuoteDuplicationInput {
  source: Quote;
  company: Company;
  customer: Customer;
  /**
   * Éligibilité des taux réduits travaux RE-DÉCLARÉE au moment de la duplication — jamais
   * copiée du devis d'origine (le fait légal appartient à la nouvelle pièce ; le logement a pu
   * changer, la règle aussi). Absente avec des lignes 10/5,5 → refus actionnable du domaine.
   */
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
  /**
   * Choix EXPLICITE de l'artisan (« Non — TVA 20 % ») quand l'éligibilité n'est pas
   * re-déclarée : les lignes 10/5,5 repartent au taux normal, l'ajustement est tracé.
   * Jamais un défaut implicite.
   */
  standardRateForReducedLines?: boolean;
}

/**
 * Dérive l'intention de création du NOUVEAU devis depuis un devis existant — fonction PURE
 * (zéro I/O), autorité unique de ce qui se copie et de ce qui ne se copie JAMAIS :
 *
 *  • copiés : client, lignes (libellé, catégorie, quantité, unité, prix, remise de ligne),
 *    acompte, remise globale, retenue de garantie, site de rattachement ;
 *  • JAMAIS copiés : numéro, statut, signature, date d'établissement, rétractation,
 *    exception dépannage urgent (fait légal horodaté à la création de SA pièce), bon de
 *    commande, date de validité (fait temporel périmé).
 *
 * La TVA de chaque ligne est RE-SUGGÉRÉE contre le régime COURANT (suggestVatRate) : un taux
 * devenu inapplicable de façon déterministe (franchise 293 B, autoliquidation, débours) est
 * ramené à son unique valeur légale (0) avec trace ; un taux ambigu (0 hérité d'une franchise
 * quittée, taux réduit sans éligibilité re-déclarée) est un refus actionnable — jamais un
 * choix silencieux.
 */
export function buildQuoteDuplicationInput(
  input: BuildQuoteDuplicationInput,
): Result<QuoteDuplicationDraft, AppError> {
  const { source, company, customer } = input;
  if (customer.id !== source.customerId || customer.companyId !== source.companyId) {
    return err(appNotFound('customer', source.customerId));
  }

  const vatAdjustments: QuoteDuplicationVatAdjustment[] = [];
  const lines: LineInput[] = [];
  for (const line of source.lines) {
    let requestedRate: number = line.vatRate;
    if (
      input.standardRateForReducedLines === true &&
      (requestedRate === 10 || requestedRate === 5.5)
    ) {
      vatAdjustments.push({
        label: line.label,
        from: requestedRate,
        to: 20,
        reason: 'standard_rate_choice',
      });
      requestedRate = 20;
    }
    let suggested = suggestVatRate({
      company,
      customer,
      category: line.category,
      requestedRate,
      ...(input.context !== undefined ? { context: input.context } : {}),
    });
    if (
      !suggested.ok &&
      suggested.error.code === 'VAT_RATE_NOT_APPLICABLE' &&
      (suggested.error.reason === 'franchise_293B' ||
        suggested.error.reason === 'autoliquidation' ||
        suggested.error.reason === 'disbursement_267')
    ) {
      // Régime à taux UNIQUE (0 obligatoire) : la re-suggestion applique la seule valeur
      // légale possible — même geste que le pré-remplissage du wizard, tracé pour l'écran.
      suggested = suggestVatRate({
        company,
        customer,
        category: line.category,
        requestedRate: 0,
        ...(input.context !== undefined ? { context: input.context } : {}),
      });
      if (suggested.ok) {
        vatAdjustments.push({
          label: line.label,
          from: requestedRate,
          to: 0,
          reason: 'regime',
        });
      }
    }
    // Cas restants (taux 0 hérité d'un régime quitté, taux réduit sans éligibilité
    // re-déclarée…) : refus actionnable du domaine, restitué tel quel.
    if (!suggested.ok) return err(appDomain(suggested.error));
    lines.push({
      label: line.label,
      category: line.category,
      qty: line.qty,
      ...(line.unit !== undefined ? { unit: line.unit } : {}),
      unitPriceHT: line.unitPriceHT,
      vatRate: suggested.value,
      ...(line.discount !== undefined ? { discount: line.discount } : {}),
    });
  }

  const depositPct = source.depositPct;
  const globalDiscount = source.globalDiscount;
  const retenueGarantiePct = source.retenueGarantiePct;
  return ok({
    input: {
      customerId: source.customerId,
      lines,
      ...(depositPct !== null ? { depositPct } : {}),
      ...(globalDiscount !== null ? { globalDiscount } : {}),
      ...(retenueGarantiePct !== null ? { retenueGarantiePct } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      // PR-08 — le site suit la pièce ; son appartenance au tenant est RE-PROUVÉE par
      // CreateQuote (anti-IDOR fail-closed), jamais tenue pour acquise.
      chantierId: source.chantierId,
    },
    vatAdjustments,
  });
}

export interface DuplicateQuoteInput {
  companyId: string;
  quoteId: string;
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
  standardRateForReducedLines?: boolean;
  idempotencyKey?: string | null;
}

export interface DuplicateQuoteOutput {
  quoteId: string;
  totals: Totals;
  vatAdjustments: QuoteDuplicationVatAdjustment[];
}

export type DuplicateQuoteDeps = CreateQuoteDeps;

/**
 * « Refaire ce devis » (PR-14) — duplique un devis en repassant INTÉGRALEMENT par CreateQuote :
 * revalidation des lignes, TVA re-suggérée au régime courant, site re-prouvé anti-IDOR,
 * invariants d'agrégat rejoués. Le nouveau devis naît BROUILLON, sans aucun fait légal hérité.
 */
export class DuplicateQuote {
  constructor(private readonly deps: DuplicateQuoteDeps) {}

  async execute(input: DuplicateQuoteInput): Promise<Result<DuplicateQuoteOutput, AppError>> {
    const source = await this.deps.quotes.findById(input.quoteId);
    if (!source || source.companyId !== input.companyId)
      return err(appNotFound('quote', input.quoteId));
    const company = await this.deps.companies.findById(input.companyId);
    if (!company) return err(appNotFound('company', input.companyId));
    const customer = await this.deps.customers.findById(source.customerId);
    if (!customer || customer.companyId !== input.companyId)
      return err(appNotFound('customer', source.customerId));

    const draft = buildQuoteDuplicationInput({
      source,
      company,
      customer,
      ...(input.context !== undefined ? { context: input.context } : {}),
      ...(input.standardRateForReducedLines !== undefined
        ? { standardRateForReducedLines: input.standardRateForReducedLines }
        : {}),
    });
    if (!draft.ok) return draft;

    const created = await new CreateQuote(this.deps).execute({
      companyId: input.companyId,
      ...draft.value.input,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    if (!created.ok) return created;
    return ok({ ...created.value, vatAdjustments: draft.value.vatAdjustments });
  }
}
