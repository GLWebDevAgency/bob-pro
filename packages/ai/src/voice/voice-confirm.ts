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
  'oui', 'je confirme', 'confirme', 'confirmer', 'valide', 'valider', 'd accord', 'ok', 'okay',
  'vas y', 'c est bon', 'fais le', 'envoie', 'envoyer', 'parfait', 'exact', 'tout a fait', 'ca marche', 'go',
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
 * Prompt parlé de confirmation, borné : reprend le libellé DÉJÀ formaté par le domaine
 * (montant réel, jamais inventé) et demande un consentement explicite.
 */
export function buildSpokenConfirmation(actionLabel: string): string {
  return `${actionLabel}. Dites « je confirme » pour valider, ou « annule » pour abandonner.`;
}
