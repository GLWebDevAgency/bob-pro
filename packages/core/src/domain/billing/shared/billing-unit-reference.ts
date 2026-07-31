/**
 * Longueur maximale commune aux unités des pièces commerciales et du catalogue.
 *
 * Les missions vocales gardent leur borne N-1 plus stricte (40 caractères) à leur frontière.
 */
export const MAX_BILLING_UNIT_REFERENCE_LENGTH = 80;

export type StandardBillingUnitReference =
  | 'unité'
  | 'pièce'
  | 'heure'
  | 'jour'
  | 'mètre'
  | 'kilomètre'
  | 'm²'
  | 'm³'
  | 'kilogramme'
  | 'litre'
  | 'forfait'
  | 'lot';

export interface ResolvedBillingUnitReference {
  /**
   * Singulier canonique pour une unité standard ; saisie trimée inchangée pour une unité métier
   * libre. Aucune singularisation générique n'est autorisée.
   */
  readonly value: string;
  readonly standard: StandardBillingUnitReference | null;
}

const STANDARD_ALIASES: Readonly<Record<string, StandardBillingUnitReference>> = Object.freeze({
  u: 'unité',
  unit: 'unité',
  units: 'unité',
  unite: 'unité',
  unites: 'unité',
  piece: 'pièce',
  pieces: 'pièce',
  h: 'heure',
  heure: 'heure',
  heures: 'heure',
  hr: 'heure',
  hrs: 'heure',
  j: 'jour',
  jour: 'jour',
  jours: 'jour',
  m: 'mètre',
  metre: 'mètre',
  metres: 'mètre',
  km: 'kilomètre',
  kilometre: 'kilomètre',
  kilometres: 'kilomètre',
  m2: 'm²',
  'm 2': 'm²',
  'metre carre': 'm²',
  'metre carres': 'm²',
  'metres carre': 'm²',
  'metres carres': 'm²',
  m3: 'm³',
  'm 3': 'm³',
  'metre cube': 'm³',
  'metre cubes': 'm³',
  'metres cube': 'm³',
  'metres cubes': 'm³',
  kg: 'kilogramme',
  kilogramme: 'kilogramme',
  kilogrammes: 'kilogramme',
  l: 'litre',
  litre: 'litre',
  litres: 'litre',
  forfait: 'forfait',
  forfaits: 'forfait',
  lot: 'lot',
  lots: 'lot',
});

function hasDisallowedCharacter(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function aliasKey(value: string): string {
  return value
    .normalize('NFKD')
    .toLocaleLowerCase('fr-FR')
    .replace(/\p{M}+/gu, '')
    .replace(/[._]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Résout uniquement des alias fermés dont l'équivalence métier est certaine.
 *
 * Une unité libre reste utilisable telle quelle après trim ; `machine` et `machines` restent donc
 * distinctes. De même, `unité` et `pièce` ne sont jamais fusionnées ici, même si leur projection
 * Factur-X utilise le même code UN/ECE C62.
 */
export function resolveBillingUnitReference(
  value: unknown,
): ResolvedBillingUnitReference | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0
    || trimmed.length > MAX_BILLING_UNIT_REFERENCE_LENGTH
    || hasDisallowedCharacter(trimmed)
  ) {
    return null;
  }
  const key = aliasKey(trimmed);
  if (key.length === 0) return null;
  const withoutCount = key.startsWith('1 ') ? key.slice(2).trim() : key;
  const standard = Object.hasOwn(STANDARD_ALIASES, withoutCount)
    ? STANDARD_ALIASES[withoutCount] ?? null
    : null;
  return Object.freeze({
    value: standard ?? trimmed,
    standard,
  });
}

/**
 * Compare deux références présentes selon le canonique métier partagé.
 *
 * Deux absences ne constituent pas une unité équivalente. Cette règle empêche notamment la valeur
 * par défaut C62 de la projection légale de masquer une unité manquante dans une mission.
 */
export function equivalentBillingUnitReferences(
  left: unknown,
  right: unknown,
): boolean {
  const resolvedLeft = resolveBillingUnitReference(left);
  const resolvedRight = resolveBillingUnitReference(right);
  return resolvedLeft !== null
    && resolvedRight !== null
    && resolvedLeft.value === resolvedRight.value;
}
