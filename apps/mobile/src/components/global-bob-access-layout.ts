export const GLOBAL_BOB_ACCESS_EDGE_GAP = 18;
export const GLOBAL_BOB_ACCESS_MAX_CARD_WIDTH = 290;

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
