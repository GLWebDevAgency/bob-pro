import { type DomainResult, err, ok } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { type BankBalanceSnapshot, type BankBalanceSource } from './bank-balance-snapshot';

export interface BankBalanceFreshnessPolicy {
  /** Identifiant immuable enregistré dans la télémétrie et les réponses API. */
  readonly version: string;
  readonly maximumAgeSecondsBySource: Readonly<Record<BankBalanceSource, number>>;
}

/**
 * Politique opérationnelle v1 pour un montant présenté comme « solde bancaire actuel ».
 *
 * - connecteur : une synchronisation plus vieille de 6 h n'est plus qualifiée de courante ;
 * - saisie confirmée : le propriétaire doit reconfirmer au moins chaque jour ;
 * - relevé : 36 h tolèrent le cycle de clôture nocturne sans faire passer un relevé ancien pour
 *   une donnée temps réel.
 *
 * Une nouvelle politique doit recevoir un nouvel identifiant ; cette constante ne doit jamais être
 * modifiée rétroactivement. Le use case exige explicitement une politique : il n'existe aucun repli.
 */
export const BANK_BALANCE_FRESHNESS_POLICY_V1: BankBalanceFreshnessPolicy = Object.freeze({
  version: 'bank-balance-freshness/1',
  maximumAgeSecondsBySource: Object.freeze({
    manual_confirmed: 24 * 60 * 60,
    bank_statement: 36 * 60 * 60,
    bank_connector: 6 * 60 * 60,
  }),
});

export interface BankBalanceFreshnessAssessment {
  readonly status: 'fresh' | 'stale';
  readonly ageSeconds: number;
  readonly maximumAgeSeconds: number;
  readonly evaluatedAt: Instant;
  readonly policyVersion: string;
}

function canonicalEpoch(value: string): number | null {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString() === value ? epoch : null;
}

/** Évalue la preuve temporelle sans lire l'heure système ni inventer de seuil. */
export function assessBankBalanceFreshness(
  snapshot: BankBalanceSnapshot,
  evaluatedAt: Instant,
  policy: BankBalanceFreshnessPolicy,
): DomainResult<BankBalanceFreshnessAssessment> {
  if (policy.version.trim().length === 0 || policy.version.length > 128) {
    return err({
      code: 'VALIDATION',
      field: 'freshnessPolicy.version',
      message: 'Version de politique invalide.',
    });
  }

  const maximumAgeSeconds = policy.maximumAgeSecondsBySource[snapshot.source];
  if (!Number.isSafeInteger(maximumAgeSeconds) || maximumAgeSeconds <= 0) {
    return err({
      code: 'VALIDATION',
      field: `freshnessPolicy.maximumAgeSecondsBySource.${snapshot.source}`,
      message: 'Durée maximale de fraîcheur invalide.',
    });
  }

  const evaluatedEpoch = canonicalEpoch(evaluatedAt);
  const observedEpoch = canonicalEpoch(snapshot.observedAt);
  if (evaluatedEpoch === null || observedEpoch === null || evaluatedEpoch < observedEpoch) {
    return err({
      code: 'VALIDATION',
      field: 'evaluatedAt',
      message: 'Instant d’évaluation invalide ou antérieur à l’observation.',
    });
  }

  const ageSeconds = Math.floor((evaluatedEpoch - observedEpoch) / 1_000);
  return ok({
    status: ageSeconds <= maximumAgeSeconds ? 'fresh' : 'stale',
    ageSeconds,
    maximumAgeSeconds,
    evaluatedAt,
    policyVersion: policy.version,
  });
}
