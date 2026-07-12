/**
 * Barge-in (LIVE-3) — pendant que Bob PARLE, le micro reste ouvert : l'utilisateur peut le
 * couper à la voix. Le piège : sans annulation d'écho parfaite, le micro capte la propre
 * voix de Bob (TTS) — l'echo-guard distingue les trois cas, en FAIL-SAFE :
 * · 'interrupt' : mot d'arrêt EXPLICITE (« stop », « attends ») → couper, ré-écouter ;
 * · 'echo'      : ce qu'on entend ressemble à ce que Bob est en train de dire → IGNORER
 *                 (ne jamais s'auto-interrompre) ;
 * · 'speech'    : parole nouvelle et substantielle → couper Bob et traiter la demande.
 * Au doute (court, vide, mélangé) : 'echo' — l'inaction est le choix sûr, le TAP reste
 * l'interruption garantie.
 */
import { normalizeTranscript } from './voice-confirm';

const INTERRUPT_WORDS = [
  'stop', 'attends', 'attend', 'chut', 'tais toi', 'pause', 'arrete', 'arrete toi', 'une seconde', 'deux secondes',
];

/** Mots outils trop fréquents pour peser dans la comparaison écho/parole. */
const FILLER = new Set(['les', 'des', 'une', 'pour', 'avec', 'est', 'sont', 'ton', 'tes', 'mon', 'mes', 'que', 'qui', 'pas', 'sur']);

function contentWords(text: string): string[] {
  return normalizeTranscript(text)
    .split(' ')
    .filter((w) => w.length >= 3 && !FILLER.has(w));
}

/** Part des mots entendus qui appartiennent au texte que Bob prononce (0..1). */
export function echoOverlap(heard: string, spoken: string): number {
  const heardWords = contentWords(heard);
  if (heardWords.length === 0) return 1; // rien de substantiel : traiter comme écho (sûr)
  const spokenSet = new Set(contentWords(spoken));
  const inSpoken = heardWords.filter((w) => spokenSet.has(w)).length;
  return inSpoken / heardWords.length;
}

export type BargeInVerdict = 'interrupt' | 'echo' | 'speech';

/** Seuil : au-delà, ce qu'on entend est considéré comme l'écho du TTS. */
const ECHO_THRESHOLD = 0.6;
/** En-deçà de ce nombre de mots pleins, une parole ne coupe pas Bob (bruit, borborygme). */
const MIN_SPEECH_WORDS = 2;

/** Nombre de mots pleins d'un énoncé — départage réponse humaine courte vs écho long. */
export function speechWordCount(text: string): number {
  return contentWords(text).length;
}

export function parseBargeIn(heard: string, spokenByBob: string): BargeInVerdict {
  const n = normalizeTranscript(heard);
  if (INTERRUPT_WORDS.some((w) => n.includes(` ${w} `))) return 'interrupt';
  const words = contentWords(heard);
  if (words.length < MIN_SPEECH_WORDS) return 'echo'; // trop court pour couper — le tap reste roi
  return echoOverlap(heard, spokenByBob) >= ECHO_THRESHOLD ? 'echo' : 'speech';
}
