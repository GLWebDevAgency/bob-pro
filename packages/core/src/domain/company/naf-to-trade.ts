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
  // Conseil de gestion / relations publiques
  '70.22Z': 'consultant',
  '70.21Z': 'consultant',
  // Informatique (dev, conseil SI, TMA, infogérance, autres) — verticale freelance IT dédiée,
  // distincte du conseil de gestion : un développeur en régie ne facture pas comme un consultant.
  '62.01Z': 'freelance_it', // programmation informatique
  '62.02A': 'freelance_it', // conseil en systèmes et logiciels informatiques
  '62.02B': 'freelance_it', // tierce maintenance de systèmes et d'applications (TMA)
  '62.03Z': 'freelance_it', // gestion d'installations informatiques (infogérance)
  '62.09Z': 'freelance_it', // autres activités informatiques
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
