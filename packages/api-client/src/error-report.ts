/**
 * RAPPORT D'ÉCHEC API — face développeur embarquée (SPEC_SYSTEME_ERREUR §4).
 *
 * Chaque Result d'échec des trois chemins de requête (`req`, `reqText`, `reqRealtimeSpeech`)
 * émet un rapport vers l'observateur optionnel `onError` du client. Le rapport est SANS PII par
 * construction : le chemin est expurgé ici (query supprimée, segments identifiants remplacés) et
 * il ne transporte ni corps, ni message utilisateur — uniquement l'AppError typé qui, lui, reste
 * réservé à l'affichage écran.
 */
import type { AppError } from '@bob/core';
import type { BobErrorCode } from './error-codes';

export interface ApiErrorReport {
  /** Horodatage ISO de l'échec (fin de requête). */
  readonly at: string;
  readonly method: string;
  /** Chemin EXPURGÉ (`redactPathForDiagnostics`) — jamais l'URL brute. */
  readonly path: string;
  /** Statut HTTP si une réponse est arrivée, sinon null (réseau/timeout/annulation). */
  readonly status: number | null;
  readonly durationMs: number;
  readonly code: BobErrorCode;
  /** L'erreur rendue à l'appelant — porte code + correlationId (transport). */
  readonly error: AppError;
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d{4,}$/;
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{25,}$/;
const REDACTED_PATH_MAX_CHARS = 120;

/**
 * Expurge un chemin d'appel pour les canaux techniques (journal local, Sentry, partage) :
 * - la query string SAUTE ENTIÈREMENT (`/company/lookup?siret=…` porte un SIRET) ;
 * - un segment UUID devient `:id`, un segment numérique long `:num` (SIRET/SIREN compris),
 *   un jeton long `:token` ;
 * - longueur bornée. Le chemin reste reconnaissable (`/company/lookup`, `/quotes/:id/issue`).
 */
export function redactPathForDiagnostics(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? '';
  const redacted = withoutQuery
    .split('/')
    .map((segment) => {
      if (segment === '') return segment;
      const decoded = tryDecode(segment);
      if (UUID_SEGMENT.test(decoded)) return ':id';
      if (NUMERIC_SEGMENT.test(decoded)) return ':num';
      if (TOKEN_SEGMENT.test(decoded)) return ':token';
      return segment;
    })
    .join('/');
  return redacted.slice(0, REDACTED_PATH_MAX_CHARS);
}

function tryDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Émet le rapport sans JAMAIS jeter : un observateur défaillant (journal plein, SDK absent) ne
 * doit pas transformer un échec diagnostiqué en second échec.
 */
export function emitApiErrorReport(
  onError: ((report: ApiErrorReport) => void) | undefined,
  report: ApiErrorReport,
): void {
  if (!onError) return;
  try {
    onError(report);
  } catch {
    // Observateur best-effort — l'échec d'origine reste la seule vérité rendue à l'appelant.
  }
}
