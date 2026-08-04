/**
 * Politique de retry UNIQUE des queries react-query (fix « tunnel » écran Argent).
 *
 * Doctrine :
 * · erreurs DÉFINITIVES (4xx métier : forbidden — dont NO_COMPANY —, not_found, conflict,
 *   validation, domain, rate_limited) → ZÉRO retry automatique : rejouer la même requête ne
 *   changera jamais la réponse, et c'est précisément ce qui fabriquait la boucle « on réessaie
 *   dans un instant » sur un compte sans company ;
 * · erreurs TRANSITOIRES (réseau, 5xx : unavailable, dependency hors 4xx) → retry BORNÉ
 *   (2 tentatives max) avec backoff exponentiel plafonné — jamais un martèlement ;
 * · le retry MANUEL (ErrorRetry, pull-to-refresh) reste toujours possible : cette politique ne
 *   gouverne que l'automatique.
 */

import { isNoCompanyError } from './no-company-state';
import { isExpectedMissingBankingInput } from './cashflow-banking-state';

/** Nombre maximal de retrys AUTOMATIQUES après l'échec initial (transitoires uniquement). */
export const MAX_TRANSIENT_QUERY_RETRIES = 2;

/** Backoff : 1 s, 2 s, 4 s… plafonné à 5 s — assez patient pour un réseau mobile qui revient. */
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 5_000;

const HTTP_4XX_CAUSE = /^HTTP 4\d\d$/;

/**
 * Vrai si l'erreur peut raisonnablement disparaître en la rejouant (réseau/5xx).
 * Un AppError « métier » (4xx) est définitif : seul un changement d'état côté serveur ou une
 * action utilisateur (onboarding, correction de saisie…) le résoudra.
 */
export function isTransientQueryError(error: unknown): boolean {
  // NO_COMPANY/PROVISIONING_REQUIRED : jamais de retry — la réponse est un routage, pas une panne.
  if (isNoCompanyError(error)) return false;
  // Solde/source bancaire à (re)confirmer : état STABLE jusqu'à une action utilisateur — le
  // 503 « unavailable » du serveur n'est pas une panne, le rejouer fabriquait des rafales.
  if (isExpectedMissingBankingInput(error)) return false;
  // Erreur non structurée (fetch qui throw, timeout, JSON invalide) → transitoire.
  if (error === null || typeof error !== 'object') return true;
  const candidate = error as { kind?: unknown; cause?: unknown };
  if (typeof candidate.kind !== 'string') return true;
  if (candidate.kind === 'unavailable') return true;
  if (candidate.kind === 'dependency') {
    // Un 4xx sans enveloppe AppError arrive mappé { kind:'dependency', cause:'HTTP 4xx' }
    // (http-client) : c'est un refus définitif, pas une dépendance en panne.
    return !(typeof candidate.cause === 'string' && HTTP_4XX_CAUSE.test(candidate.cause));
  }
  // domain / not_found / conflict / forbidden / rate_limited / validation : définitifs.
  return false;
}

/** Signature attendue par `retry:` de react-query — bornage + transitoire uniquement. */
export function shouldRetryQueryFailure(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_TRANSIENT_QUERY_RETRIES && isTransientQueryError(error);
}

/** Signature attendue par `retryDelay:` de react-query — backoff exponentiel plafonné. */
export function queryRetryDelayMs(failureCount: number): number {
  const exponent = Math.max(0, failureCount);
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS);
}
