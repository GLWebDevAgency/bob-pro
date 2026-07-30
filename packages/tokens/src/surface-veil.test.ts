/**
 * SURFACE VEIL — CERTIFICATION AA du kit « matière Bob » (04 § Retombée de bord).
 *
 * La retombée est la SEULE matière du produit qui porte un canal alpha. Ce fichier prouve
 * qu'elle ne dégrade aucun contraste, et il le prouve là où c'est VÉRIFIABLE :
 *
 * 1. le bord ANCRÉ est OPAQUE — alpha exactement 1. Le fond composé y vaut donc `solid`,
 *    exactement, sans incertitude de mélange : c'est ce qui rend la certification EXACTE et
 *    non approchée ;
 * 2. sur ce fond, les DEUX encres de chaque ton clearent AA (4,5:1), dans les DEUX apparences ;
 * 3. dans la ZONE DE FONDU, le fond dépend du contenu qui défile dessous — donc d'une image
 *    inconnue. On y prouve la borne PIRE CAS pour l'encre principale, et on constate que
 *    l'encre secondaire, elle, n'y est PAS certifiable : c'est la raison exécutable pour
 *    laquelle le contrat déclare la zone SANS TEXTE, et pour laquelle `@bob/ui` n'y rend
 *    structurellement aucun nœud de texte (`progressive-blur-bob.render.test.tsx`).
 */
import { describe, expect, it } from 'vitest';
import {
  neutrals,
  patterns,
  resolveColorRole,
  surfaceTint,
  surfaceVeil,
  type SurfaceTintAppearance,
  type SurfaceVeilTone,
} from './index';

const WCAG_AA_NORMAL_TEXT = 4.5;

const TONES: readonly SurfaceVeilTone[] = [
  'canvas',
  'neutral',
  'marine',
  'ai',
  'success',
  'warning',
  'danger',
];

function channels(hex: string): readonly [number, number, number] {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Couleur #RRGGBB attendue, reçu: ${hex}`);
  const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return [r ?? 0, g ?? 0, b ?? 0];
}

function relativeLuminance(hex: string): number {
  const linear = channels(hex)
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

/** `source` composé à `alpha` PAR-DESSUS `under` — la vraie opération du voile. */
function composite(source: string, under: string, alpha: number): string {
  const [r1, g1, b1] = channels(source);
  const [r2, g2, b2] = channels(under);
  const blend = (a: number, b: number): number => Math.round(a * alpha + b * (1 - alpha));
  return `#${[blend(r1, r2), blend(g1, g2), blend(b1, b2)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Alpha réel d'un stop de token : `rgba(...)` → a, hex → 1. */
function alphaOf(color: string): number {
  const match = /^rgba\([\d.]+,\s*[\d.]+,\s*[\d.]+,\s*([\d.]+)\)$/i.exec(color);
  return match === null ? 1 : Number.parseFloat(match[1] ?? '1');
}

/**
 * ENCRES légitimes sur un ton de voile. Les six tons du kit portent celles de leur surface ;
 * `canvas` est le FOND D'APP — en clair ce sont les rôles de texte de l'app, en sombre les
 * encres du ton `neutral`, avec lequel il partage exactement sa couleur (#0C2340).
 */
function inksOn(tone: SurfaceVeilTone, appearance: SurfaceTintAppearance): readonly [string, string] {
  if (tone !== 'canvas') {
    const spec = surfaceTint[appearance][tone];
    return [spec.ink, spec.inkMuted];
  }
  return appearance === 'light'
    ? [resolveColorRole('text.primary'), resolveColorRole('text.secondary')]
    : [surfaceTint.dark.neutral.ink, surfaceTint.dark.neutral.inkMuted];
}

describe('LE BORD ANCRÉ EST OPAQUE — la certification y est EXACTE', () => {
  it('le troisième stop a un alpha de 1 dans les 7 tons × 2 apparences', () => {
    for (const appearance of ['light', 'dark'] as const) {
      for (const tone of TONES) {
        const stops = surfaceVeil[appearance][tone].stops;
        expect(alphaOf(stops[0]), `${appearance}/${tone} bord libre`).toBe(0);
        expect(alphaOf(stops[1]), `${appearance}/${tone} stop médian`).toBe(0.92);
        expect(alphaOf(stops[2]), `${appearance}/${tone} bord ancré`).toBe(1);
      }
    }
  });

  it('la couleur du bord ancré EST `solid` : aucun mélange à estimer', () => {
    for (const appearance of ['light', 'dark'] as const) {
      for (const tone of TONES) {
        const spec = surfaceVeil[appearance][tone];
        expect(spec.solid).toBe(spec.stops[2]);
        // Composé à alpha 1 sur n'importe quoi, il rend exactement lui-même.
        expect(composite(spec.solid, '#000000', 1)).toBe(spec.solid.toLowerCase());
        expect(composite(spec.solid, '#FFFFFF', 1)).toBe(spec.solid.toLowerCase());
      }
    }
  });

  it('le fond opaque du repli est celui de la surface du même ton — jamais un aplat gris', () => {
    for (const appearance of ['light', 'dark'] as const) {
      for (const tone of TONES) {
        if (tone === 'canvas') continue;
        expect(surfaceVeil[appearance][tone].solid).toBe(surfaceTint[appearance][tone].flat);
      }
    }
    expect(surfaceVeil.light.canvas.solid).toBe(neutrals.bg);
    expect(surfaceVeil.dark.canvas.solid).toBe(surfaceTint.dark.neutral.flat);
  });
});

describe('AA SUR CHAQUE COUPLE TEXTE / FOND DU KIT', () => {
  it('certifie 4,5:1 pour les DEUX encres, sur les 7 tons × 2 apparences (14 fonds, 28 couples)', () => {
    let pairs = 0;
    for (const appearance of ['light', 'dark'] as const) {
      for (const tone of TONES) {
        const background = surfaceVeil[appearance][tone].solid;
        for (const ink of inksOn(tone, appearance)) {
          expect(
            contrastRatio(ink, background),
            `${appearance}/${tone} — ${ink} sur ${background}`,
          ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
          pairs += 1;
        }
      }
    }
    expect(pairs).toBe(28);
  });

  it('le pire couple du kit reste au-dessus du seuil, avec de la marge', () => {
    const ratios = (['light', 'dark'] as const).flatMap((appearance) =>
      TONES.flatMap((tone) =>
        inksOn(tone, appearance).map((ink) =>
          contrastRatio(ink, surfaceVeil[appearance][tone].solid),
        ),
      ),
    );
    expect(Math.min(...ratios)).toBeGreaterThan(WCAG_AA_NORMAL_TEXT);
  });
});

describe('LA ZONE DE FONDU — pourquoi elle ne porte JAMAIS de texte', () => {
  /** Le fond y est inconnu : le pire cas est le noir pur ou le blanc pur qui défile dessous. */
  const worstBackgrounds = ['#000000', '#FFFFFF'] as const;

  it("l'encre PRINCIPALE resterait AA même au stop médian, sur le pire contenu possible", () => {
    for (const appearance of ['light', 'dark'] as const) {
      for (const tone of TONES) {
        const [ink] = inksOn(tone, appearance);
        for (const under of worstBackgrounds) {
          const blended = composite(surfaceVeil[appearance][tone].solid, under, 0.92);
          expect(
            contrastRatio(ink, blended),
            `${appearance}/${tone} encre principale sur ${blended}`,
          ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
        }
      }
    }
  });

  it("l'encre SECONDAIRE n'y est PAS certifiable — d'où la règle « aucun texte » du contrat", () => {
    // Mesuré : 4,10:1 pour `light/canvas` sur un contenu noir à 92 % de voile. Ce n'est pas un
    // défaut du token, c'est la nature d'un fond inconnu — et c'est exactement pourquoi la
    // retombée est déclarée décorative, sans texte ni information, et pourquoi `@bob/ui` n'y
    // rend structurellement aucun nœud de texte. La règle n'est pas une précaution de style :
    // elle est la seule façon de tenir AA sur un fond qu'on ne choisit pas.
    const worst = Math.min(
      ...(['light', 'dark'] as const).flatMap((appearance) =>
        TONES.flatMap((tone) =>
          worstBackgrounds.map((under) =>
            contrastRatio(
              inksOn(tone, appearance)[1],
              composite(surfaceVeil[appearance][tone].solid, under, 0.92),
            ),
          ),
        ),
      ),
    );
    expect(worst).toBeLessThan(WCAG_AA_NORMAL_TEXT);
  });

  it('notre teinte pèse au moins 92 % dès le stop médian — le reste du fondu est à nous', () => {
    const [, median] = patterns.edgeFalloff.veilLocations;
    expect(median).toBe(0.32);
    for (const appearance of ['light', 'dark'] as const) {
      for (const tone of TONES) {
        expect(alphaOf(surfaceVeil[appearance][tone].stops[1])).toBeGreaterThanOrEqual(0.92);
      }
    }
  });
});

describe('CONTINUITÉ AVEC LE FONDU DÉJÀ LIVRÉ', () => {
  it('le ton `canvas` reproduit à l’identique la recette de la tab bar', () => {
    expect(surfaceVeil.light.canvas.stops).toEqual(patterns.bottomTabBar.fade);
    expect(patterns.edgeFalloff.veilLocations).toEqual(patterns.bottomTabBar.fadeLocations);
  });

  it('le profil de hauteurs est exactement celui du contrat, en pour cent', () => {
    expect(patterns.edgeFalloff.layerHeightsPercent).toEqual([100, 88, 76, 64, 54, 44, 36, 28, 22, 16]);
    expect(patterns.edgeFalloff.maxLayers).toBe(patterns.edgeFalloff.layerHeightsPercent.length);
    expect(patterns.edgeFalloff.defaultLayers).toBe(0);
    expect(patterns.edgeFalloff.layerIntensity).toBe(5);
    expect(patterns.edgeFalloff.bleed).toBe(44);
  });
});
