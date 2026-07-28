/**
 * BobSurface — logique pure du kit « matière Bob » (P1 §1.2) : surfaces TEINTÉES OPAQUES
 * (jamais la transparence iOS — Reduce Transparency trivialement satisfait), résolues depuis
 * `surfaceTint` (@bob/tokens) selon l'apparence du thème. Le kit NAÎT avec les écrans P1
 * (parc, contrats, fiches de passage) et reste SCOPÉ aux nouveaux composants — `Card` et les
 * écrans existants ne sont jamais restylés.
 */
import {
  surfaceTint,
  type SurfaceTintAppearance,
  type SurfaceTintTone,
} from '@bob/tokens';

export type BobSurfaceTone = SurfaceTintTone;
export type BobSurfaceEmphasis = 'flat' | 'raised' | 'floating';

export interface BobSurfaceStyleInput {
  tone: BobSurfaceTone;
  emphasis: BobSurfaceEmphasis;
  appearance: SurfaceTintAppearance;
  /** Increase Contrast (a11y) : bord RENFORCÉ (2 pt, encre pleine) — jamais une info perdue. */
  highContrast?: boolean;
}

export interface BobSurfaceColors {
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
  /** Encres certifiées AA sur CE fond (index.test.ts de @bob/tokens). */
  ink: string;
  inkMuted: string;
  /** floating uniquement : la carte se détache par l'ombre e2 (posée par le composant). */
  elevated: boolean;
}

export function bobSurfaceColors(input: BobSurfaceStyleInput): BobSurfaceColors {
  const spec = surfaceTint[input.appearance][input.tone];
  const backgroundColor = input.emphasis === 'flat' ? spec.flat : spec.raised;
  return {
    backgroundColor,
    borderColor: input.highContrast === true ? spec.ink : spec.border,
    borderWidth: input.highContrast === true ? 2 : 1,
    ink: spec.ink,
    inkMuted: spec.inkMuted,
    elevated: input.emphasis === 'floating',
  };
}
