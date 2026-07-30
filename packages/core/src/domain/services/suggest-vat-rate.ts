import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type VatRate, VAT_RATES } from '../billing/shared/vat-rate';
import { type LineCategory } from '../billing/shared/line-item';
import {
  isBtpTrade,
  type Company,
  type Trade,
  type VatRegime,
} from '../company/company';
import {
  type Customer,
  type CustomerType,
} from '../customer/customer';

/**
 * Faits minimaux et autoritaires nécessaires au calcul de TVA d'une ligne.
 *
 * Ce contrat purpose-specific permet aux missions Bob de relire uniquement les colonnes utiles
 * sous RLS, tout en partageant exactement le même moteur que les use cases historiques fondés sur
 * les agrégats Company/Customer.
 */
export interface VatDecisionFacts {
  readonly companyVatRegime: VatRegime;
  readonly companyTrade: Trade;
  readonly customerType: CustomerType;
  readonly customerIsSubcontractingBtp: boolean;
}

export interface SuggestVatFromFactsInput {
  readonly facts: VatDecisionFacts;
  readonly category: LineCategory;
  readonly requestedRate: number;
  readonly context?: {
    readonly housingOlderThan2y?: boolean;
    readonly energyRenovation?: boolean;
  };
}

export interface SuggestVatInput {
  company: Company;
  customer: Customer;
  category: LineCategory;
  /** Taux confirmé pour cette pièce. Requis par TypeScript ; la garde runtime protège
   * aussi les entrées JSON/non typées. */
  requestedRate: number;
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
}

export function vatDecisionFactsFromAggregates(
  company: Company,
  customer: Customer,
): VatDecisionFacts {
  return Object.freeze({
    // L'agrégat reste l'autorité de sa propre sémantique. Le getter fournit la donnée brute,
    // tandis que la méthode porte l'invariant public déjà consommé par les use cases historiques.
    companyVatRegime: company.isVatFranchise() ? 'franchise' : company.vatRegime,
    companyTrade: company.trade,
    customerType: customer.type,
    customerIsSubcontractingBtp: customer.isSubcontractingBtp,
  });
}

export function requiresVatAutoliquidation(facts: VatDecisionFacts): boolean {
  return isBtpTrade(facts.companyTrade)
    && facts.customerType === 'b2b'
    && facts.customerIsSubcontractingBtp;
}

export function suggestVatRateFromFacts(
  input: SuggestVatFromFactsInput,
): DomainResult<VatRate> {
  const {
    facts,
    category,
    context,
    requestedRate,
  } = input;

  // La frontière de persistance doit toujours transmettre le taux explicitement confirmé.
  // Ni le métier ni un contexte partiel ne valent consentement fiscal.
  if (requestedRate === undefined) {
    return err({
      code: 'VALIDATION',
      field: 'vatRate',
      message: 'Confirme le taux de TVA avant de créer la pièce.',
    });
  }

  // 1. Franchise en base : 0 obligatoire.
  if (facts.companyVatRegime === 'franchise') {
    if (requestedRate !== 0)
      return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'franchise_293B' });
    return ok(0);
  }
  // 2. B9 — DÉBOURS : remboursement de frais avancés AU NOM ET POUR LE COMPTE du client,
  // EXCLU de la base d'imposition (art. 267, II-2° du CGI) — taux 0 OBLIGATOIRE dans TOUS les
  // régimes. L'audit (item débours) a relevé l'incohérence interne : la même catégorie était
  // déjà traitée HORS base en compta (compte 467) et exclue de la nature d'opération
  // (operationNatureOf), mais le régime réel se voyait imposer un taux > 0 ici — la pièce
  // émise était fiscalement fausse. La franchise (règle 1) impose déjà 0 à tout ; cette règle
  // aligne le régime réel sur le même fait fiscal.
  if (category === 'disbursement') {
    if (requestedRate !== 0)
      return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'disbursement_267' });
    return ok(0);
  }
  // 3. Autoliquidation BTP B2B sous-traitance : 0 obligatoire.
  if (requiresVatAutoliquidation(facts)) {
    if (requestedRate !== 0)
      return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'autoliquidation' });
    return ok(0);
  }
  // 4. Taux choisi explicitement, dans l'ensemble fermé. Le taux zéro n'est autorisé
  // que par les trois règles déterministes traitées plus haut.
  if (!(VAT_RATES as readonly number[]).includes(requestedRate) || requestedRate === 0)
    return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'unknown' });

  // Les taux travaux exigent le contexte correspondant : le taux ne fabrique jamais en
  // silence l'éligibilité du logement.
  if (requestedRate === 10 && context?.housingOlderThan2y !== true)
    return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'unknown' });
  if (
    requestedRate === 5.5
    && (context?.housingOlderThan2y !== true || context.energyRenovation !== true)
  )
    return err({ code: 'VAT_RATE_NOT_APPLICABLE', rate: requestedRate, reason: 'unknown' });

  return ok(requestedRate as VatRate);
}

export function suggestVatRate(input: SuggestVatInput): DomainResult<VatRate> {
  return suggestVatRateFromFacts({
    facts: vatDecisionFactsFromAggregates(input.company, input.customer),
    category: input.category,
    requestedRate: input.requestedRate,
    ...(input.context === undefined ? {} : { context: input.context }),
  });
}
