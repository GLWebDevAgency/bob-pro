/**
 * Minimisation PII avant envoi à un LLM cloud (RGPD/CNIL : minimisation + finalité). Masque le PII
 * INCIDENT que le classifieur d'intention n'utilise jamais : email, téléphone, IBAN, SIREN/SIRET.
 *
 * NE touche PAS aux numéros de facture/devis ni aux noms de client : ce sont la *référence* de la
 * commande, résolue par resolveInvoice / le batch — les masquer casserait la résolution. C'est de la
 * minimisation (retirer le non-nécessaire), pas de l'anonymisation totale.
 *
 * Pur, déterministe, IDEMPOTENT (les placeholders ne contiennent aucun motif PII).
 */

// Ordre d'application important : IBAN (lettres+chiffres) et email avant les motifs purement numériques.
// `\s` couvre les espaces fines/insécables (U+202F, U+00A0) — on évite tout caractère invisible en source.
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Référentiel de contrôle : registre officiel SWIFT IBAN, release 102 (juin 2026).
// Source : https://www.swift.com/swift-resource/9606/download
//
// La surface candidate accepte tout préfixe alpha-2 afin qu'un pays nouvellement ajouté — ou un
// format ISO 13616 valide non encore publié dans le registre courant — ne puisse jamais contourner
// la minimisation. Pour les pays inconnus, seul un checksum mod-97 valide déclenche la redaction.
// Les longueurs déjà vérifiées gardent une redaction structurelle fail-safe même si une dictée/OCR
// a altéré le checksum.
const IBAN_LENGTH_BY_COUNTRY: Readonly<Record<string, number>> = Object.freeze({
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  DZ: 26,
  EG: 29,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MT: 31,
  MU: 30,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  SA: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  XK: 20,
});
const IBAN_CANDIDATE = new RegExp(
  '\\b[A-Z]{2}[ \\t\\u00a0\\u202f.-]?\\d{2}'
    + '(?:[ \\t\\u00a0\\u202f.-]?[A-Z0-9]){11,60}',
  'gi',
);
// Téléphone FR : formes internationale et locale, y compris (0), parenthèses et séparateurs
// usuels. Les bornes numériques empêchent d'absorber un chiffre voisin.
const PHONE_FR_INTERNATIONAL =
  /(?<!\d)(?:\+33|\(\+33\)|00[\s./-]*33)(?:[\s./-]*(?:\(0\)|0))?[\s./-]*[1-9](?:[\s./-]?\d{2}){4}(?!\d)/g;
const PHONE_FR_LOCAL =
  /(?<!\d)\(?0[1-9]\)?(?:[\s./-]?\d{2}){4}(?!\d)/g;
// SIREN (9 chiffres) / SIRET (14), contigu ou groupé 3-3-3[-5]. N'attrape pas
// « 2026-014 » ni un montant puisque chaque groupe est de longueur fermée.
const SIREN_SIRET =
  /(?<!\d)\d{3}(?:[ \t\u00a0\u202f.-]?\d{3}){2}(?:[ \t\u00a0\u202f.-]?\d{5})?(?!\d)/g;

function validIbanChecksum(compact: string): boolean {
  if (
    compact.length < 15
    || compact.length > 34
    || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/u.test(compact)
  ) return false;
  const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const numeric = character >= 'A'
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of numeric) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

function redactIbans(text: string): string {
  let cursor = 0;
  let searchFrom = 0;
  let redacted = '';
  while (searchFrom < text.length) {
    IBAN_CANDIDATE.lastIndex = searchFrom;
    const match = IBAN_CANDIDATE.exec(text);
    if (match === null) break;
    const candidate = match[0];
    let compact = '';
    let ibanEnd = -1;
    const country = candidate.slice(0, 2).toUpperCase();
    const expectedLength = IBAN_LENGTH_BY_COUNTRY[country] ?? null;
    for (let index = 0; index < candidate.length; index += 1) {
      const character = candidate[index]!;
      if (/[A-Z0-9]/iu.test(character)) compact += character.toUpperCase();
      if (expectedLength !== null && compact.length === expectedLength) {
        // À la frontière de minimisation, un IBAN structurellement reconnaissable reste
        // sensible même si la dictée/OCR a altéré un chiffre et rendu le checksum invalide.
        ibanEnd = index + 1;
        break;
      }
      // Repli pour un pays ISO nouvellement ajouté : retenir le dernier préfixe checksum-valide.
      // Un préfixe plus court peut lui-même passer MOD-97 par hasard ; s'arrêter au premier
      // laisserait alors la fin du compte bancaire en clair.
      if (
        expectedLength === null
        && compact.length >= 15
        && validIbanChecksum(compact)
      ) {
        ibanEnd = index + 1;
      }
    }
    if (ibanEnd < 0) {
      // Un faux départ (« et 06… ») ne doit pas engloutir un vrai IBAN situé plus loin dans
      // le même candidat glouton. Reprendre un caractère après le départ autorise ce chevauchement.
      searchFrom = match.index + 1;
      continue;
    }
    redacted += `${text.slice(cursor, match.index)}[iban]`;
    cursor = match.index + ibanEnd;
    searchFrom = cursor;
  }
  return `${redacted}${text.slice(cursor)}`;
}

/** Remplace le PII incident par des marqueurs typés, en préservant les références métier. */
export function redactPII(text: string): string {
  if (!text) return text;
  return redactIbans(text.replace(EMAIL, '[email]'))
    .replace(PHONE_FR_INTERNATIONAL, '[tel]')
    .replace(PHONE_FR_LOCAL, '[tel]')
    .replace(SIREN_SIRET, '[siren]');
}
