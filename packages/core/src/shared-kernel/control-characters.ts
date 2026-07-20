/**
 * Détecte les contrôles ASCII C0 (U+0000–U+001F) et DEL (U+007F).
 *
 * L’itération explicite garde la règle lisible et évite les regex de contrôle ambiguës dans
 * les validateurs qui protègent identifiants, références de paiement et payloads persistés.
 */
export function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}
