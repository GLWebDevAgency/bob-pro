/**
 * Interprétation d'un consentement VOCAL (réponse parlée à une demande de confirmation de Bob).
 *
 * FAIL-SAFE par construction : le SEUL chemin vers 'confirm' est un affirmatif explicite SANS aucun
 * mot d'annulation NI négation. Toute ambiguïté -> 'unclear' (Bob re-demande ou bascule en confirmation
 * visuelle). On n'utilise JAMAIS de similarité floue oui/non : uniquement du phrase-matching explicite.
 * Protège le plancher de sécurité : une réponse ambiguë sur une action sensible ne déclenche jamais l'exécution.
 */
export type VoiceConsent = 'confirm' | 'cancel' | 'unclear';

const CONFIRM = [
  // Consentements EXPLICITES seulement. Les verbes d'action (« envoie », « valide »,
  // « fais-le ») sont volontairement exclus : ils figurent souvent dans le libelle lu par Bob
  // et ne doivent jamais permettre a son propre echo de confirmer une action.
  'oui', 'je confirme', 'd accord', 'j autorise', 'ok', 'okay', 'vas y',
];
const CANCEL = [
  'non', 'annule', 'annuler', 'annulation', 'stop', 'arrete', 'arreter', 'laisse tomber',
  'pas maintenant', 'plus tard', 'negatif', 'surtout pas', 'attends', 'attendre',
];
const NEGATION = [' ne ', ' n ', ' pas ', ' jamais ', ' aucun '];

/** minuscule + sans accents + ponctuation -> espaces + espaces compressés, encadré d'espaces (pour matcher des mots entiers). */
export function normalizeTranscript(input: string): string {
  const noAccents = input.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const cleaned = noAccents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ` ${cleaned} `;
}

export function parseVoiceConsent(transcript: string): VoiceConsent {
  const n = normalizeTranscript(transcript);
  const has = (phrase: string): boolean => n.includes(` ${phrase} `);
  // 1) Annulation explicite -> on n'agit pas (prioritaire, fail-safe).
  if (CANCEL.some(has)) return 'cancel';
  // 2) Négation (sans mot d'annulation clair) -> ambigu, ne confirme JAMAIS.
  if (NEGATION.some((neg) => n.includes(neg))) return 'unclear';
  // 3) Affirmatif explicite et non contredit -> confirm.
  if (CONFIRM.some(has)) return 'confirm';
  return 'unclear';
}

/**
 * Retire du libelle les rares consentements EXPLICITES que parseVoiceConsent accepte. Les verbes
 * metier restent intacts puisqu'ils ne sont plus des consentements (ex. « Envoyer le devis »).
 */
function consentSafeLabel(actionLabel: string): string {
  const sanitized = actionLabel
    // Le séparateur peut venir d'un nom client (« JE-CONFIRME »), pas seulement d'un espace.
    // On couvre donc toute ponctuation/symbole comme normalizeTranscript le ferait ensuite.
    .replace(/\bje[^\p{L}\p{N}]+confirme\b/giu, 'confirmation demandée')
    .replace(/\bj[^\p{L}\p{N}]+autorise\b/giu, 'autorisation demandée')
    .replace(/\bd[^\p{L}\p{N}]+accord\b/giu, 'accord demandé')
    .replace(/\boui\b/giu, 'accord')
    .replace(/\b(?:ok|okay)\b/giu, 'prêt')
    .replace(/\bvas[^\p{L}\p{N}]?y\b/giu, 'on continue')
    .replace(/\s+/g, ' ')
    .trim();
  // Ce dernier garde-fou couvre toute future évolution du parseur : un libellé métier contrôlé
  // par l'utilisateur ne doit jamais devenir, après normalisation, une réponse affirmative.
  return parseVoiceConsent(sanitized) === 'confirm' ? 'Action sensible préparée' : sanitized;
}

/**
 * Prompt parlé borné : il reprend les faits du libellé, mais ne prononce AUCUN token que
 * parseVoiceConsent accepte — ni affirmatif (plancher : l'écho ne peut jamais exécuter),
 * NI d'annulation : un résidu du prompt est au pire « unclear » (Bob redemande), jamais une
 * annulation fantôme de la proposition. La question invite naturellement « oui » / « non »,
 * qui ne sont jamais prononcés ici.
 */
export function buildSpokenConfirmation(actionLabel: string): string {
  const safeLabel = consentSafeLabel(actionLabel) || 'Action sensible préparée';
  return `${safeLabel}. Tu veux que je le fasse ?`;
}
