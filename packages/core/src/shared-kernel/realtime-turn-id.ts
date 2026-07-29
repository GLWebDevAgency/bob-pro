import { sha256Hex } from './sha256';

const REALTIME_TURN_NAMESPACE = 'bob-pro:realtime-turn:v1\u0000';

/**
 * Identité provider-neutre d'un tour Realtime.
 *
 * Les deux valeurs sources restent transitoires : seul cet UUID est autorisé à franchir les
 * frontières métier, d'idempotence et d'observabilité. L'algorithme est volontairement pur et
 * partagé par Node et React Native afin qu'aucun canal ne puisse inventer sa propre corrélation.
 */
export function deriveRealtimeTurnId(
  sessionHandle: string,
  providerInputItemId: string,
): string {
  const digest = sha256Hex(
    `${REALTIME_TURN_NAMESPACE}${sessionHandle}\u0000${providerInputItemId}`,
  ).slice(0, 32);
  const variant = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);
  const uuidHex = `${digest.slice(0, 12)}4${digest.slice(13, 16)}${variant}${digest.slice(17)}`;
  return [
    uuidHex.slice(0, 8),
    uuidHex.slice(8, 12),
    uuidHex.slice(12, 16),
    uuidHex.slice(16, 20),
    uuidHex.slice(20),
  ].join('-');
}
