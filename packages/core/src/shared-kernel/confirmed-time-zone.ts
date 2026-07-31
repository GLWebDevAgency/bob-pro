import { parseIanaTimeZone } from './iana-time-zone';

export interface ConfirmedTimeZone {
  readonly timeZone: string;
  readonly confirmedAt: string;
}

export interface ConfirmedTimeZoneCandidate {
  readonly timeZone: unknown;
  readonly confirmedAt: unknown;
  readonly boundCompanyId: unknown;
  readonly currentCompanyId: string | null;
}

/**
 * Dérive l'autorité temporelle conversationnelle depuis des claims déjà authentifiés.
 *
 * La fonction ne décide pas si la source est signée : le guard serveur lui passe les claims JWT
 * vérifiés, le mobile la session Supabase courante. Elle interdit en revanche qu'une confirmation
 * d'un autre tenant, un instant non canonique ou un fuseau invalide soit traité comme fiable.
 */
export function deriveConfirmedTimeZone(
  candidate: ConfirmedTimeZoneCandidate,
): ConfirmedTimeZone | null {
  if (
    candidate.currentCompanyId === null ||
    typeof candidate.boundCompanyId !== 'string' ||
    candidate.boundCompanyId !== candidate.currentCompanyId ||
    typeof candidate.confirmedAt !== 'string'
  ) {
    return null;
  }

  const timeZone = parseIanaTimeZone(candidate.timeZone);
  if (timeZone === null) return null;

  const parsedAt = new Date(candidate.confirmedAt);
  if (
    Number.isNaN(parsedAt.getTime()) ||
    parsedAt.toISOString() !== candidate.confirmedAt
  ) {
    return null;
  }

  return Object.freeze({
    timeZone,
    confirmedAt: candidate.confirmedAt,
  });
}
