import { type AssignExpenseChantierClientOutput } from './client';

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Décode la réponse d'imputation chantier sans faire confiance à un cast TypeScript.
 * Contrat volontairement EXACT ({ chantierId, changed } et rien d'autre) : un champ ajouté par
 * erreur ne traverse pas silencieusement la frontière HTTP, un identifiant non canonique est
 * refusé plutôt que réutilisé, et `changed` doit être un vrai booléen (jamais un truthy flou).
 */
export function decodeExpenseChantierAssignment(
  value: unknown,
): AssignExpenseChantierClientOutput | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(candidate, 'chantierId') ||
    !Object.hasOwn(candidate, 'changed')
  ) {
    return null;
  }
  const chantierId = candidate.chantierId;
  if (
    chantierId !== null &&
    (typeof chantierId !== 'string' ||
      chantierId.length === 0 ||
      chantierId.length > 200 ||
      chantierId !== chantierId.trim() ||
      hasControlCharacter(chantierId))
  ) {
    return null;
  }
  const changed = candidate.changed;
  if (typeof changed !== 'boolean') return null;
  return { chantierId: chantierId as string | null, changed };
}
