import { parseIanaTimeZone } from '@bob/core';
import { IANA_TIME_ZONES } from './iana-time-zones.generated';

export interface ConversationTimeZoneOption {
  readonly timeZone: string;
  readonly suggested: boolean;
  readonly exact: boolean;
}

function searchable(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[_/+-]+/gu, ' ')
    .toLocaleLowerCase('fr-FR')
    .trim();
}

export function canonicalConversationTimeZoneSelection(
  raw: string,
): string | null {
  return parseIanaTimeZone(raw.trim());
}

/** Résultats bornés : aucune liste de centaines de lignes n'entre dans le Sheet mobile. */
export function conversationTimeZoneOptions(input: {
  readonly query: string;
  readonly suggestedTimeZone: string | null;
  readonly limit?: number;
}): readonly ConversationTimeZoneOption[] {
  const limit = Math.max(1, Math.min(50, input.limit ?? 24));
  const suggested = parseIanaTimeZone(input.suggestedTimeZone);
  const exact = canonicalConversationTimeZoneSelection(input.query);
  const normalizedQuery = searchable(input.query);
  const ordered = [
    ...(exact === null ? [] : [exact]),
    ...(suggested === null ? [] : [suggested]),
    ...IANA_TIME_ZONES,
  ];
  const seen = new Set<string>();
  const options: ConversationTimeZoneOption[] = [];
  for (const rawCandidate of ordered) {
    const candidate = parseIanaTimeZone(rawCandidate);
    if (candidate === null || seen.has(candidate)) continue;
    seen.add(candidate);
    if (
      normalizedQuery.length > 0
      && candidate !== exact
      && !searchable(candidate).includes(normalizedQuery)
    ) continue;
    options.push({
      timeZone: candidate,
      suggested: candidate === suggested,
      exact: candidate === exact,
    });
    if (options.length >= limit) break;
  }
  return Object.freeze(options);
}
