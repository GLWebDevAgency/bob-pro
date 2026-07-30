import {
  type VatDecisionFacts,
} from '../../domain/services/suggest-vat-rate';
import { sha256Hex } from '../../shared-kernel/sha256';

export interface QuoteVatDecisionContext extends VatDecisionFacts {
  readonly customerId: string;
}

/**
 * Fence canonique des faits fiscaux relus. Elle ne remplace jamais la redérivation du taux :
 * elle prouve aussi qu'un contexte externe n'a pas changé lorsque deux contextes distincts
 * conduiraient momentanément au même montant visible.
 */
export function computeQuoteVatContextDigest(
  context: QuoteVatDecisionContext,
): string {
  const canonical = {
    customerId: context.customerId,
    companyVatRegime: context.companyVatRegime,
    companyTrade: context.companyTrade,
    customerType: context.customerType,
    customerIsSubcontractingBtp: context.customerIsSubcontractingBtp,
  } satisfies {
    readonly [Key in keyof QuoteVatDecisionContext]:
      QuoteVatDecisionContext[Key];
  };
  return sha256Hex(JSON.stringify([
    'bob.quote-vat-context.v1',
    canonical.customerId,
    canonical.companyVatRegime,
    canonical.companyTrade,
    canonical.customerType,
    canonical.customerIsSubcontractingBtp,
  ]));
}

/**
 * Lecture fiscale purpose-specific sous tenant. L'adapter doit relire la société et le client
 * confirmés dans la transaction mission ; il ne calcule jamais lui-même un taux.
 */
export interface QuoteVatContextPort {
  getForUpdate(input: {
    readonly companyId: string;
    readonly customerId: string;
  }): Promise<QuoteVatDecisionContext | null>;
}
