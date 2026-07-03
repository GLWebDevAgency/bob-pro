/**
 * BottomTabBar — logique pure (COMPONENT_SPECS.md §14).
 * Mapping état d'onglet → couleur token. Aucun import react-native ici (testé par vitest).
 */
import { controls, neutrals, semantic } from '@bob/tokens';

/** Clé réservée de l'onglet Assistant (Bob) — actif en indigo IA, pas en ink900. */
export const ASSISTANT_TAB_KEY = 'assistant';

/**
 * Couleur d'un item de tab bar (icône + label).
 * Actif = ink900, sauf l'onglet Assistant = semantic.ai ; inactif = controls.tabInactive.
 */
export function tabColor(key: string, active: boolean): string {
  if (!active) return controls.tabInactive;
  return key === ASSISTANT_TAB_KEY ? semantic.ai : neutrals.ink900;
}
