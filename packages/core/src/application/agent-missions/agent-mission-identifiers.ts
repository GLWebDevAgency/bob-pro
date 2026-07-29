import { hasAsciiControlCharacter } from '../../shared-kernel/control-characters';

/**
 * Borne commune au slot, à l’ACK écran et aux décisions.
 *
 * Cette valeur reflète le contrat PostgreSQL du brouillon. Tout canal importe ce validateur afin
 * qu’une référence acceptée par le mobile ne puisse jamais être refusée plus loin par le core.
 */
export const AGENT_MISSION_OPAQUE_IDENTIFIER_MAX_LENGTH = 200;
export const AGENT_MISSION_DRAFT_SESSION_ID_MAX_LENGTH =
  AGENT_MISSION_OPAQUE_IDENTIFIER_MAX_LENGTH;

export function isCanonicalAgentMissionOpaqueIdentifier(
  value: unknown,
): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= AGENT_MISSION_OPAQUE_IDENTIFIER_MAX_LENGTH
    && value === value.trim()
    && !hasAsciiControlCharacter(value);
}

export function isCanonicalAgentMissionDraftSessionId(
  value: unknown,
): value is string {
  return isCanonicalAgentMissionOpaqueIdentifier(value);
}
