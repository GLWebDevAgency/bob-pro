import type { Personality } from './theme';

/** Voix de Bob — micro-copy indexée par personnalité (cf. VOICE_AND_TONE). À terme : packages/i18n. */
export function greeting(p: Personality, name: string): string {
  if (p === 'Pote') return `Salut ${name}`;
  if (p === 'Pro') return `Bonjour ${name}`;
  return `${name} —`;
}

export function todaySubtitle(p: Personality, n: number): string {
  if (n === 0) {
    if (p === 'Pote') return 'Rien d’urgent. Profites-en.';
    if (p === 'Pro') return 'Aucune priorité aujourd’hui.';
    return 'RAS.';
  }
  if (p === 'Pote') return `${n} truc${n > 1 ? 's' : ''} à régler, et après tu factures tranquille.`;
  if (p === 'Pro') return `Vous avez ${n} priorité${n > 1 ? 's' : ''} à traiter aujourd’hui.`;
  return `${n} priorité${n > 1 ? 's' : ''}. Go.`;
}

export function footerLine(p: Personality): string {
  if (p === 'Pote') return 'C’est tout pour aujourd’hui. Va bosser.';
  if (p === 'Pro') return 'Vous êtes à jour pour aujourd’hui.';
  return 'Fini pour aujourd’hui.';
}

export function payoutHint(p: Personality, payoutEUR: string): string {
  if (p === 'Pote') return `Tu peux te verser ${payoutEUR} sans stresser.`;
  if (p === 'Pro') return `Versement possible : ${payoutEUR}.`;
  return `Te verser : ${payoutEUR}.`;
}
