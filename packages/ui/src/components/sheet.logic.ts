export interface SheetSafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const SHEET_EDGE_GAP = 8;
export const SHEET_HORIZONTAL_PADDING = 20;
export const SHEET_MIN_BOTTOM_PADDING = 18;
export const SHEET_HEADER_HEIGHT = 48;

export interface SheetGeometry {
  readonly maxHeight: number;
  readonly contentMaxHeight: number;
  readonly paddingLeft: number;
  readonly paddingRight: number;
  readonly paddingBottom: number;
}

/**
 * Calcule l'espace réellement disponible dans une Modal plein écran.
 * Fonction pure pour certifier les cas portrait, paysage et fenêtres réduites.
 */
export function resolveSheetGeometry(
  windowHeight: number,
  insets: SheetSafeAreaInsets,
): SheetGeometry {
  const maxHeight = Math.max(0, windowHeight - insets.top - SHEET_EDGE_GAP);

  return {
    maxHeight,
    contentMaxHeight: Math.max(0, maxHeight - SHEET_HEADER_HEIGHT),
    paddingLeft: SHEET_HORIZONTAL_PADDING + insets.left,
    paddingRight: SHEET_HORIZONTAL_PADDING + insets.right,
    paddingBottom: Math.max(SHEET_MIN_BOTTOM_PADDING, insets.bottom),
  };
}
