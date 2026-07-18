/**
 * SANITIZE TTS (S6) — prépare un gabarit pour l'OREILLE sans jamais toucher l'affichage.
 *
 * Les gabarits de Bob (impayés, compte de résultat, top clients…) sont typographiés pour
 * l'ÉCRAN : puces `•`, tirets décoratifs `—`, flèches, emojis, montants `formatEUR`
 * (« 1 386,50 € », espaces fines U+202F). Lus tels quels, les moteurs TTS ânonnent
 * (« point médian », « tiret cadratin », symboles avalés, décimales illisibles).
 *
 * `sanitizeForSpeech` est PUR (aucune horloge, aucun I/O) et s'applique UNIQUEMENT au texte
 * envoyé à la bouche — l'écran garde le gabarit intact :
 * · puces et marqueurs de liste en tête de ligne → supprimés ;
 * · tirets décoratifs en incise ( — ) → une respiration (virgule), jamais un « tiret » lu ;
 * · symboles visuels muets (→ ⚠ ✓ emojis) → supprimés ;
 * · montants pour l'oreille : « 1 386,50 € » → « 1386 euros 50 », « 415,00 € » → « 415 euros »,
 *   signes typographiques (+/− devant un montant) → « plus »/« moins » en toutes lettres.
 * Les traits d'union porteurs de sens (numéros de pièce « 2026-014 ») ne sont JAMAIS touchés.
 */

import { splitSpokenSentences } from './streaming';

/** Partie entière d'un montant : groupes de 3 (espace fine/insécable/simple) ou suite nue. */
const INT_PATTERN = '\\d{1,3}(?:[\\u202F\\u00A0 ]\\d{3})+|\\d+';
const AMOUNT_WITH_CENTS = new RegExp(`(${INT_PATTERN}),(\\d{2})\\s*€`, 'gu');
const AMOUNT_WHOLE = new RegExp(`(${INT_PATTERN})\\s*€`, 'gu');
/** Symboles visuels muets : flèches, coches, avertissements, emojis — rien à prononcer. */
const VISUAL_SYMBOLS = /[→⇒←↔✓✗\u{FE0F}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F300}-\u{1FAFF}]/gu;

function joinDigits(integer: string): string {
  return integer.replace(/[\u202F\u00A0 ]/g, '');
}

/** Rend un texte de gabarit prononçable — l'affichage écran reste STRICTEMENT intact. */
export function sanitizeForSpeech(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        // Puces en tête de ligne : décoratives à l'écran, muettes à l'oreille.
        .replace(/^\s*[•·▪‣◦]\s*/u, '')
        // Marqueur de liste « — item » / « - item » (le tiret d'un « 2026-014 » reste intact).
        .replace(/^\s*[—–-]\s+/u, '')
        // Tiret décoratif en incise : une respiration, pas un symbole lu.
        .replace(/\s+[—–]\s+/gu, ', ')
        .replace(VISUAL_SYMBOLS, ' ')
        // Montants formatEUR : « 1 386,50 € » → « 1386 euros 50 » ; « 415,00 € » → « 415 euros ».
        .replace(AMOUNT_WITH_CENTS, (_match: string, integer: string, cents: string) =>
          cents === '00'
            ? `${joinDigits(integer)} euros`
            : `${joinDigits(integer)} euros ${cents}`)
        .replace(AMOUNT_WHOLE, (_match: string, integer: string) => `${joinDigits(integer)} euros`)
        // Signes typographiques devant un nombre : prononcés en toutes lettres.
        .replace(/(^|[\s:(])−\s*(?=\d)/gu, '$1moins ')
        .replace(/(^|[\s:(])\+(?=\d)/gu, '$1plus ')
        .replace(/\s{2,}/g, ' ')
        .trim())
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Plan de prononciation d'un tour (S6) — la MÊME bouche pour l'overlay et l'onglet Assistant :
 * `text` est la référence de l'echo-guard (ce qui sera réellement entendu par l'oreille) ;
 * `sentences` est la file à prononcer phrase par phrase (Bob parle dès la première, le tap ou
 * le barge-in coupe entre deux). `sentences === null` = énoncé MONOBLOC : réservé aux
 * consentements (bargeIn:false) — un prompt de confirmation ne se coupe jamais en deux.
 */
export interface SpokenDeliveryPlan {
  /** Texte réellement prononcé — la référence de l'echo-guard, phrase par phrase incluse. */
  readonly text: string;
  /** File de phrases à prononcer ; null = monobloc (consentement). */
  readonly sentences: readonly string[] | null;
}

export function planSpokenDelivery(
  raw: string,
  options: { readonly monolithic?: boolean } = {},
): SpokenDeliveryPlan {
  const text = sanitizeForSpeech(raw);
  if (options.monolithic === true) return Object.freeze({ text, sentences: null });
  return Object.freeze({ text, sentences: Object.freeze(splitSpokenSentences(text)) });
}
