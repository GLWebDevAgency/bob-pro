/**
 * Taille UTF-8 de la représentation JSON réellement contrôlée à la frontière applicative.
 * `null` signifie que la valeur n'est pas sérialisable (cycle, BigInt, getter hostile, undefined
 * racine). Le stockage JSONB applique en plus sa propre borne SQL.
 */
export function jsonUtf8ByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

export function jsonUtf8Fits(value: unknown, maxBytes: number): boolean {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return false;
  const bytes = jsonUtf8ByteLength(value);
  return bytes !== null && bytes <= maxBytes;
}
