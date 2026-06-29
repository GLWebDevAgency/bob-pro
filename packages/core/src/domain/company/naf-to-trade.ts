import { type Trade } from './company';

/**
 * Mappe un code NAF/APE (INSEE) vers un métier Bob Pro connu.
 * Renvoie null si non couvert (l'utilisateur choisit alors manuellement).
 * Couvre les NAF les plus fréquents des 9 métiers actuels ; à étendre avec les nouvelles verticales.
 */
const NAF_TO_TRADE: Record<string, Trade> = {
  // Plomberie / chauffage
  '43.22A': 'plombier',
  '43.22B': 'plombier',
  // Électricité
  '43.21A': 'electricien',
  // Maçonnerie / gros œuvre
  '43.99C': 'macon',
  '41.20A': 'macon',
  '41.20B': 'macon',
  // Peinture / plâtrerie / finitions
  '43.34Z': 'peintre',
  '43.31Z': 'peintre',
  // Paysagisme
  '81.30Z': 'paysagiste',
  // Conseil / dev / gestion
  '70.22Z': 'consultant',
  '70.21Z': 'consultant',
  '62.02A': 'consultant',
  '62.02B': 'consultant',
  '62.01Z': 'consultant',
  // Photographie
  '74.20Z': 'photographe',
  // Coaching / sport / bien-être
  '85.51Z': 'coach',
  '93.13Z': 'coach',
};

export function nafToTrade(naf: string | null | undefined): Trade | null {
  if (!naf) return null;
  return NAF_TO_TRADE[naf.replace(/\s/g, '').toUpperCase()] ?? null;
}
