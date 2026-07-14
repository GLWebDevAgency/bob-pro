import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type LineInput } from '../../domain/billing/shared/line-item';
import { type Totals } from '../../domain/billing/shared/totals';
import { Quote } from '../../domain/billing/quote/quote';
import { suggestVatRate } from '../../domain/services/suggest-vat-rate';
import { type QuoteRepository, type CompanyRepository, type CustomerRepository } from '../ports/repositories';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import { isValidDateOnly } from '../../shared-kernel/time';

const MAX_QUOTE_LINES = 100;
const MAX_QUOTE_HT_CENTS = 1_500_000_000;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

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
  validUntil?: string;
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
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
    })),
    depositPct: input.depositPct ?? null,
    validUntil: input.validUntil ?? null,
    context: {
      housingOlderThan2y: input.context?.housingOlderThan2y ?? false,
      energyRenovation: input.context?.energyRenovation ?? false,
    },
  } as const;
}

/** Compose un devis. La règle TVA (franchise/autoliquidation) est appliquée ICI via suggestVatRate. */
export class CreateQuote {
  constructor(private readonly deps: CreateQuoteDeps) {}

  async execute(input: CreateQuoteInput): Promise<Result<CreateQuoteOutput, AppError>> {
    if (input.validUntil !== undefined && !isValidDateOnly(input.validUntil)) {
      return err(appDomain({ code: 'VALIDATION', field: 'validUntil', message: 'Date de validité invalide.' }));
    }
    if (!Array.isArray(input.lines) || input.lines.length > MAX_QUOTE_LINES) {
      return err(appDomain({ code: 'VALIDATION', field: 'lines', message: 'Nombre de lignes invalide.' }));
    }
    let totalHtCents = 0;
    for (const line of input.lines) {
      if (
        typeof line.label !== 'string'
        || line.label.trim().length === 0
        || line.label.length > 500
        || hasControlCharacter(line.label)
      ) {
        return err(appDomain({ code: 'VALIDATION', field: 'label', message: 'Libellé de ligne invalide.' }));
      }
      if (
        line.unit !== undefined
        && (
          typeof line.unit !== 'string'
          || line.unit.trim().length === 0
          || line.unit.length > 80
          || hasControlCharacter(line.unit)
        )
      ) {
        return err(appDomain({ code: 'VALIDATION', field: 'unit', message: 'Unité de ligne invalide.' }));
      }
      if (!Number.isSafeInteger(line.unitPriceHT) || line.unitPriceHT < 0 || line.unitPriceHT > MAX_QUOTE_HT_CENTS) {
        return err(appDomain({ code: 'VALIDATION', field: 'unitPriceHT', message: 'Prix HT invalide.' }));
      }
      if (!Number.isFinite(line.qty) || line.qty <= 0 || Math.round(line.qty * 1_000) !== line.qty * 1_000) {
        return err(appDomain({ code: 'VALIDATION', field: 'qty', message: 'Quantité invalide.' }));
      }
      totalHtCents += Math.round(line.qty * line.unitPriceHT);
      if (!Number.isSafeInteger(totalHtCents) || totalHtCents > MAX_QUOTE_HT_CENTS) {
        return err(appDomain({ code: 'VALIDATION', field: 'lines', message: 'Montant total HT hors limite.' }));
      }
    }
    const company = await this.deps.companies.findById(input.companyId);
    if (!company) return err(appNotFound('company', input.companyId));
    const customer = await this.deps.customers.findById(input.customerId);
    // Intégrité référentielle / anti-IDOR : le client doit appartenir au tenant (cf. CreateChantier).
    if (!customer || customer.companyId !== input.companyId) return err(appNotFound('customer', input.customerId));

    const composed = Quote.compose({
      id: this.deps.ids.newId(),
      companyId: input.companyId,
      customerId: input.customerId,
      at: this.deps.clock.now(),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
    });
    if (!composed.ok) return err(appDomain(composed.error));
    const quote = composed.value;

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

    await this.deps.quotes.save(quote);
    return ok({ quoteId: quote.id, totals: quote.totals() });
  }
}
