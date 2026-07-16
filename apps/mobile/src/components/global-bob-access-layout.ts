export const GLOBAL_BOB_ACCESS_EDGE_GAP = 18;
export const GLOBAL_BOB_ACCESS_MAX_CARD_WIDTH = 290;
export const GLOBAL_BOB_ACCESS_SIZE = 50;
export const GLOBAL_BOB_ACCESS_TAB_BAR_HEIGHT = 62;
export const GLOBAL_BOB_ACCESS_TAB_GAP = 8;

function safeInset(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Placement horizontal unique de Bob, quelle que soit la route.
 *
 * Le bouton ne se colle jamais au bord physique : l'espace visuel de 18 dp vient après la
 * safe-area (encoche/paysage). La carte de réponse partage exactement le même axe gauche.
 */
export function deriveGlobalBobAccessHorizontalLayout(input: {
  readonly windowWidth: number;
  readonly safeAreaLeft: number;
  readonly safeAreaRight: number;
}): { readonly left: number; readonly maxCardWidth: number } {
  const safeAreaLeft = safeInset(input.safeAreaLeft);
  const safeAreaRight = safeInset(input.safeAreaRight);
  const windowWidth = Number.isFinite(input.windowWidth) ? Math.max(0, input.windowWidth) : 0;
  const availableWidth = Math.max(
    0,
    windowWidth - safeAreaLeft - safeAreaRight - (GLOBAL_BOB_ACCESS_EDGE_GAP * 2),
  );
  return Object.freeze({
    left: safeAreaLeft + GLOBAL_BOB_ACCESS_EDGE_GAP,
    maxCardWidth: Math.min(GLOBAL_BOB_ACCESS_MAX_CARD_WIDTH, availableWidth),
  });
}

/**
 * Placement vertical canonique de Bob.
 *
 * Android redimensionne explicitement la fenêtre (`softwareKeyboardLayoutMode=resize`) : son
 * chevauchement clavier vaut donc toujours zéro ici. Sur iOS, le clavier recouvre la fenêtre ;
 * on prend le maximum entre le chrome bas et son chevauchement réel, jamais leur somme.
 */
export function deriveGlobalBobAccessVerticalLayout(input: {
  readonly inTabs: boolean;
  readonly safeAreaBottom: number;
  readonly tabPaddingTop: number;
  readonly tabMinimumBottom: number;
  readonly bottomAvoidance: number;
  readonly keyboardOverlap: number;
}): { readonly bottom: number } {
  const safeAreaBottom = safeInset(input.safeAreaBottom);
  const tabPaddingTop = safeInset(input.tabPaddingTop);
  const tabMinimumBottom = safeInset(input.tabMinimumBottom);
  const bottomAvoidance = safeInset(input.bottomAvoidance);
  const keyboardOverlap = safeInset(input.keyboardOverlap);
  const baseBottom = input.inTabs
    ? tabPaddingTop
      + GLOBAL_BOB_ACCESS_TAB_BAR_HEIGHT
      + Math.max(safeAreaBottom, tabMinimumBottom)
      + GLOBAL_BOB_ACCESS_TAB_GAP
    : safeAreaBottom + GLOBAL_BOB_ACCESS_EDGE_GAP;
  const keyboardBottom = keyboardOverlap > 0
    ? keyboardOverlap + GLOBAL_BOB_ACCESS_EDGE_GAP
    : 0;
  return Object.freeze({
    bottom: Math.max(baseBottom, keyboardBottom) + bottomAvoidance,
  });
}
