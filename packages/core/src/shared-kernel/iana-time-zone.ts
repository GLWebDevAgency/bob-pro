const IANA_TIME_ZONE_NAME_PATTERN =
  /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * Valide et canonicalise un fuseau conversationnel explicite.
 *
 * `Intl.DateTimeFormat` est l'autorité d'exécution disponible sur Node et React Native, mais
 * certaines versions acceptent aussi des offsets ISO. Le pattern garde uniquement les noms IANA,
 * y compris les zones historiques mono-segment (`CET`, `EST5EDT`), avant de demander à Intl de
 * les résoudre. Aucune valeur par défaut n'est produite.
 */
export function parseIanaTimeZone(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 64 ||
    value.trim() !== value ||
    !IANA_TIME_ZONE_NAME_PATTERN.test(value)
  ) {
    return null;
  }

  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions()
      .timeZone;
    return typeof canonical === 'string' &&
      canonical.length > 0 &&
      canonical.length <= 64 &&
      IANA_TIME_ZONE_NAME_PATTERN.test(canonical)
      ? canonical
      : null;
  } catch {
    return null;
  }
}

export function isIanaTimeZone(value: unknown): value is string {
  return parseIanaTimeZone(value) !== null;
}
