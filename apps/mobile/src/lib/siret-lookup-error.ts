/**
 * Discrimination PURE des échecs du lookup SIRET (SPEC_SYSTEME_ERREUR §8 — patron de
 * référence). Généralise l'îlot dupliqué `lookupErrorKey` de LoginScreen/ProvisioningScreen :
 * UN module partagé rend les motifs, chaque écran mappe motif → clé i18n de SON contexte.
 *
 * Motifs (vérité serveur — AutofillCompanyFromSiret, @bob/core) :
 *  · `invalid`       — SIRET refusé par le domaine (format/Luhn) : kind domain|validation (422) ;
 *  · `not_found`     — l'annuaire ne connaît pas ce SIRET : kind not_found (404) ;
 *  · `rate_limited`  — NOTRE throttle, avec le délai à afficher : kind rate_limited (429) ;
 *  · `contract`      — réponse 200 illisible côté client (`dependency/api-contract`) : le
 *                      chemin exact du bug terrain « SIRET servi en 200 mais vu non trouvé » —
 *                      c'est CHEZ NOUS, pas l'annuaire en panne ;
 *  · `lookup_down`   — annuaire/amont réellement indisponible : kind dependency|unavailable ;
 *  · `unknown`       — tout le reste (y compris une valeur jetée non typée).
 */
import type { AppError } from '@bob/core';

export type SiretLookupFailureReason =
  | 'invalid'
  | 'not_found'
  | 'rate_limited'
  | 'contract'
  | 'lookup_down'
  | 'unknown';

export interface SiretLookupFailure {
  readonly reason: SiretLookupFailureReason;
  /** Renseigné pour `rate_limited` uniquement — à interpoler dans la copy ({seconds}). */
  readonly retryAfterSeconds: number | null;
  /** L'erreur d'origine (porte code + correlationId quand elle vient du fil). */
  readonly error: AppError;
}

function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof (value as { kind: unknown }).kind === 'string'
  );
}

export function discriminateSiretLookupError(error: unknown): SiretLookupFailure {
  if (!isAppError(error)) {
    return {
      reason: 'unknown',
      retryAfterSeconds: null,
      error: { kind: 'dependency', port: 'client', cause: 'échec non typé du lookup SIRET.' },
    };
  }
  switch (error.kind) {
    case 'domain':
    case 'validation':
      return { reason: 'invalid', retryAfterSeconds: null, error };
    case 'not_found':
      return { reason: 'not_found', retryAfterSeconds: null, error };
    case 'rate_limited':
      return { reason: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds, error };
    case 'dependency':
      return error.port === 'api-contract'
        ? { reason: 'contract', retryAfterSeconds: null, error }
        : { reason: 'lookup_down', retryAfterSeconds: null, error };
    case 'unavailable':
      return { reason: 'lookup_down', retryAfterSeconds: null, error };
    default:
      return { reason: 'unknown', retryAfterSeconds: null, error };
  }
}
