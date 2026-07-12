/**
 * Réponse VOCALE à une question structurée (LIVE-1) — le pendant parlé de la QuestionSheet :
 * Bob lit la question et ses options, l'utilisateur répond à la voix (« le deuxième »,
 * « Lefèvre », « l'acompte ») OU touche l'écran — même résultat, synchro totale.
 *
 * FAIL-SAFE comme parseVoiceConsent : le SEUL chemin vers une option est un match SANS
 * ambiguïté (ordinal explicite, ou mots significatifs d'UNE SEULE option). Deux options
 * plausibles → null (Bob re-demande ou laisse l'écran trancher). Jamais de similarité floue.
 */
import { normalizeTranscript } from './voice-confirm';
import { type AgentQuestion, type AgentQuestionOption } from '../agent/bob-agent';

/** Ordinaux/nombres parlés français → index (0-based). « dernier » est résolu à part. */
const ORDINALS: readonly { phrases: readonly string[]; index: number }[] = [
  { phrases: ['premier', 'premiere', 'la une', 'option un', 'option une', 'numero un', 'le un', '1'], index: 0 },
  { phrases: ['deuxieme', 'second', 'seconde', 'option deux', 'numero deux', 'le deux', 'la deux', '2'], index: 1 },
  { phrases: ['troisieme', 'option trois', 'numero trois', 'le trois', 'la trois', '3'], index: 2 },
  { phrases: ['quatrieme', 'option quatre', 'numero quatre', 'le quatre', 'la quatre', '4'], index: 3 },
];
const LAST = ['dernier', 'derniere'];

/** Mots non discriminants — jamais utilisés pour matcher une option. */
const STOPWORDS = new Set([
  'les', 'des', 'une', 'aux', 'pour', 'avec', 'sans', 'chez', 'dans', 'sur', 'est', 'sont',
  'facture', 'factures', 'devis', 'client', 'option', 'celle', 'celui', 'euros', 'euro',
  'sarl', 'sas', 'sasu', 'eurl', 'mme', 'monsieur', 'madame',
]);

function significantWords(text: string): string[] {
  return normalizeTranscript(text)
    .split(' ')
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/** Chiffres du texte (≥ 3 chiffres : numéros de pièces « 2026-0005 », montants exclus par contexte). */
function pieceNumbers(text: string): string[] {
  return (text.match(/\d{3,}/g) ?? []).map((n) => n.replace(/^0+/, ''));
}

/**
 * Résout la réponse parlée vers l'INDEX de l'option choisie — null si rien d'univoque.
 * Ordre de résolution : ordinal explicite → « dernier » → numéro de pièce → mots
 * significatifs du label/value/description (une SEULE option doit matcher).
 */
export function parseVoiceChoice(transcript: string, options: readonly AgentQuestionOption[]): number | null {
  if (options.length === 0) return null;
  const n = normalizeTranscript(transcript);
  const has = (phrase: string): boolean => n.includes(` ${phrase} `);

  for (const { phrases, index } of ORDINALS) {
    if (index < options.length && phrases.some(has)) return index;
  }
  if (LAST.some(has)) return options.length - 1;

  // Numéro de pièce dit à la voix (« le 0005 », « 2026-0005 ») — zéros de tête ignorés,
  // et les nombres PARTAGÉS par plusieurs options (l'année d'un numéro de pièce) sont
  // non discriminants : ils ne matchent jamais.
  const numbersByOption = options.map((option) => pieceNumbers(`${option.value} ${option.label}`));
  const shared = new Set(
    [...new Set(numbersByOption.flat())].filter((n) => numbersByOption.filter((list) => list.includes(n)).length > 1),
  );
  const spokenNumbers = pieceNumbers(transcript).filter((n) => !shared.has(n));
  if (spokenNumbers.length > 0) {
    const byNumber = numbersByOption
      .map((numbers, index) => ({ index, numbers: numbers.filter((n) => !shared.has(n)) }))
      .filter(({ numbers }) => spokenNumbers.some((sn) => numbers.some((on) => on === sn || on.endsWith(sn))));
    if (byNumber.length === 1) return byNumber[0]!.index;
    if (byNumber.length > 1) return null; // deux pièces plausibles : jamais deviner
  }

  // Mots DISCRIMINANTS : les mots d'une option retranchés de ceux des autres — un mot
  // partagé (« Dupont » sur deux pièces du même client) ne départage jamais.
  const wordsByOption = options.map((option) => new Set(significantWords(`${option.label} ${option.value} ${option.description ?? ''}`)));
  const matches = wordsByOption
    .map((words, index) => {
      const discriminant = [...words].filter((w) => wordsByOption.every((other, j) => j === index || !other.has(w)));
      return { index, hit: discriminant.some((w) => has(w)) };
    })
    .filter((m) => m.hit);
  if (matches.length === 1) return matches[0]!.index;
  return null;
}

/**
 * Vocalisation d'une question structurée : la question puis les options numérotées, courtes
 * (labels seuls — les descriptions restent à l'écran, la voix ne fait pas de littérature).
 */
export function speakableQuestion(question: AgentQuestion): string {
  const opts = question.options.map((option, index) => `${index + 1} : ${option.label}`).join('. ');
  return `${question.question} ${opts}. Dites le numéro ou le nom — ou touchez l’écran.`;
}
