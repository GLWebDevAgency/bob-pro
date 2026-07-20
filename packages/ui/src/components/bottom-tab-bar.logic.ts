/**
 * BottomTabBar — logique pure (COMPONENT_SPECS.md §14).
 * Mapping état d'onglet → couleur token. Aucun import react-native ici (testé par vitest).
 */
import { resolveColorRole } from '@bob/tokens';

/** Clé réservée de l'onglet Assistant (Bob) — actif en indigo IA, pas en ink900. */
export const ASSISTANT_TAB_KEY = 'assistant';

/**
 * Couleur d'un item de tab bar (icône + label).
 * Les trois états utilisent les rôles de navigation certifiés AA sur la surface
 * de la barre. La primitive visuelle historique `controls.tabInactive` reste
 * disponible pour le non-contenu, mais ne doit pas porter un libellé.
 */
export function tabColor(key: string, active: boolean): string {
  if (!active) return resolveColorRole('navigation.inactive');
  return key === ASSISTANT_TAB_KEY
    ? resolveColorRole('navigation.assistantActive')
    : resolveColorRole('navigation.active');
}
