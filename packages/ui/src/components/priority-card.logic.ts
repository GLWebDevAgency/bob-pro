/**
 * PriorityCard — logique pure (mapping statut → tokens, dérivation des couleurs d'état).
 * Aucune dépendance react-native : testable par vitest (priority-card.test.ts).
 * Zéro littéral de couleur : les valeurs arrivent via la palette (useTheme côté composant).
 */

/** Statut d'une tâche « À régler » (COMPONENT_SPECS.md §4). */
export type PriorityStatus = 'retard' | 'marine' | 'conformite';

/** Nom du token de couleur d'accent associé à chaque statut. */
export type PriorityAccentToken = 'dangerVivid' | 'ink600' | 'b2g';

const ACCENT_BY_STATUS: Record<PriorityStatus, PriorityAccentToken> = {
  retard: 'dangerVivid',
  marine: 'ink600',
  conformite: 'b2g',
};

/** Barre d'accent gauche : 'retard' → dangerVivid · 'marine' → ink600 · 'conformite' → b2g. */
export function priorityAccentToken(status: PriorityStatus): PriorityAccentToken {
  return ACCENT_BY_STATUS[status];
}

/** Interpole deux couleurs #RRGGBB (t borné à [0,1]). Sortie en minuscules. */
export function mixHex(from: string, to: string, ratio: number): string {
  const t = Math.min(1, Math.max(0, ratio));
  const parse = (hex: string): [number, number, number] => {
    const raw = hex.startsWith('#') ? hex.slice(1) : hex;
    return [
      Number.parseInt(raw.slice(0, 2), 16),
      Number.parseInt(raw.slice(2, 4), 16),
      Number.parseInt(raw.slice(4, 6), 16),
    ];
  };
  const [r1, g1, b1] = parse(from);
  const [r2, g2, b2] = parse(to);
  const channel = (a: number, b: number): string =>
    Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r1, r2)}${channel(g1, g2)}${channel(b1, b2)}`;
}

/** Part de success mélangée à successBg pour dériver le bord de l'état « fait ». */
export const DONE_BORDER_MIX = 0.12;

/** Couleurs nécessaires au rendu — fournies par useTheme() côté composant. */
export interface PriorityCardPalette {
  accents: Record<PriorityAccentToken, string>;
  surface: string;
  cardBorder: string;
  ink800: string;
  success: string;
  successBg: string;
}

export interface PriorityCardColors {
  accent: string;
  background: string;
  border: string;
  title: string;
}

/**
 * Résout les couleurs de la carte selon le statut et l'état « fait ».
 * Fait : fond successBg, bord dérivé (successBg assombri vers success), titre + accent success.
 */
export function resolvePriorityCardColors(
  status: PriorityStatus,
  done: boolean,
  palette: PriorityCardPalette,
): PriorityCardColors {
  if (done) {
    return {
      accent: palette.success,
      background: palette.successBg,
      border: mixHex(palette.successBg, palette.success, DONE_BORDER_MIX),
      title: palette.success,
    };
  }
  return {
    accent: palette.accents[priorityAccentToken(status)],
    background: palette.surface,
    border: palette.cardBorder,
    title: palette.ink800,
  };
}
