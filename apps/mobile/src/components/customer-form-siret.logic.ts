import type { Address, CompanyLookupResult } from '@bob/core';

export type SiretLookupDecision =
  | { readonly kind: 'stale' }
  | { readonly kind: 'identity_mismatch' }
  | {
      readonly kind: 'apply';
      readonly siret: string;
      readonly siren: string;
      readonly denomination: string;
      readonly tvaIntracom: string;
      readonly closed: boolean;
      readonly address: Address | null;
      readonly addressLabel: string;
      readonly addressLocked: boolean;
      readonly addressMissing: boolean;
    };

/**
 * Corrèle une réponse annuaire avec la requête encore visible.
 *
 * Le résultat ne devient jamais un patch partiel : identité, TVA, statut et adresse sont décidés
 * ensemble. Cela empêche une réponse tardive A d'écraser la saisie B et empêche une adresse
 * précédente de survivre à un établissement dont l'annuaire ne publie aucune adresse.
 */
export function decideSiretLookupResult(input: {
  readonly requestId: number;
  readonly latestRequestId: number;
  readonly requestedSiret: string;
  readonly currentSiret: string;
  readonly result: CompanyLookupResult;
}): SiretLookupDecision {
  if (
    input.requestId !== input.latestRequestId ||
    input.currentSiret !== input.requestedSiret
  ) {
    return { kind: 'stale' };
  }
  if (
    input.result.siret !== input.requestedSiret ||
    !input.result.siret.startsWith(input.result.siren)
  ) {
    return { kind: 'identity_mismatch' };
  }
  const address = input.result.address ? { ...input.result.address } : null;
  return {
    kind: 'apply',
    siret: input.result.siret,
    siren: input.result.siren,
    denomination: input.result.denomination,
    tvaIntracom: input.result.tvaIntracom ?? '',
    closed: input.result.etatAdministratif === 'F',
    address,
    addressLabel: address ? `${address.line1}, ${address.zip} ${address.city}` : '',
    addressLocked: address !== null,
    addressMissing: address === null,
  };
}
