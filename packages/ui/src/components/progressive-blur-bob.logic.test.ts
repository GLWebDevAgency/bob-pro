/**
 * ProgressiveBlurBob — CONFORMITÉ AU CONTRAT, côté logique pure.
 *
 * Chaque exigence de `docs/mobile-experience/04-navigation-scroll-surfaces.md`
 * § « Contrat exécutable du port `renderBlurLayer` » et § « Couture du port » a ici un test
 * qui la verrouille. Aucun rendu : ce fichier prouve la GÉOMÉTRIE, les RANGS et l'ARITHMÉTIQUE
 * DE TEINTE, c'est-à-dire tout ce que `apps/mobile` ne peut plus déformer.
 */
import { describe, expect, it } from 'vitest';
import { patterns, surfaceTint, surfaceVeil, type SurfaceVeilTone } from '@bob/tokens';
import {
  BLUR_PORT_FAILURE_WARNINGS,
  DEFAULT_EDGE_FALLOFF_LAYERS,
  EDGE_FALLOFF_HEIGHT_PROFILE,
  MAX_EDGE_FALLOFF_LAYERS,
  blurLayerStyle,
  bobTintShareAt,
  edgeFalloffHeight,
  edgeVeilGradient,
  effectiveIntensityAt,
  layerHeightPoints,
  progressiveBlurPlan,
  progressiveBlurWarnings,
  resolveBlurMaterial,
  resolveBlurTint,
  veilOpacityAt,
  visibleLayerCount,
  type BlurAnchor,
  type EdgeFalloffReason,
  type ProgressiveBlurPlanInput,
} from './progressive-blur-bob.logic';

const HEIGHT = 200;
const TONES: readonly SurfaceVeilTone[] = [
  'canvas',
  'neutral',
  'marine',
  'ai',
  'success',
  'warning',
  'danger',
];

/** Entrée NOMINALE : tout est ouvert. Chaque test ne ferme qu'UNE chose, pour isoler son rang. */
function nominal(overrides: Partial<ProgressiveBlurPlanInput> = {}): ProgressiveBlurPlanInput {
  return {
    layers: 3,
    anchor: 'bottom',
    height: HEIGHT,
    port: 'ready',
    transparency: 'standard',
    material: resolveBlurMaterial('canvas', 'light'),
    capability: 'capable',
    surfaceUnder: 'static',
    // L'assertion d'englobement du § 4 est un tri-état fail-CLOSED : une entrée « nominale »
    // doit la déclarer CONSTATÉE, sinon le plan refuse — et c'est bien ce qu'on veut d'elle.
    envelope: 'within',
    ...overrides,
  };
}

describe('PROFIL DE HAUTEURS — propriété de @bob/ui, jamais du port', () => {
  it('est exactement celui du contrat : 100 / 88 / 76 / 64 / 54 / 44 / 36 / 28 / 22 / 16 %', () => {
    expect(EDGE_FALLOFF_HEIGHT_PROFILE).toEqual([100, 88, 76, 64, 54, 44, 36, 28, 22, 16]);
    expect(MAX_EDGE_FALLOFF_LAYERS).toBe(EDGE_FALLOFF_HEIGHT_PROFILE.length);
  });

  it('le défaut normatif est ZÉRO couche floutée — le mode nominal est teinté', () => {
    expect(DEFAULT_EDGE_FALLOFF_LAYERS).toBe(0);
    expect(progressiveBlurPlan(nominal({ layers: 0 })).mode).toBe('tinted');
  });

  it('tronque aux N PREMIÈRES couches — on garde les plus hautes, celles qui portent la rampe', () => {
    const plan = progressiveBlurPlan(nominal({ layers: 4 }));
    expect(plan.layers.map((layer) => layer.heightPercent)).toEqual([100, 88, 76, 64]);
  });
});

describe('BlurLayerSpec — la signature du contrat, champ par champ', () => {
  const plan = progressiveBlurPlan(nominal({ layers: 5 }));

  it('porte EXACTEMENT les sept champs du contrat, et rien d’autre', () => {
    for (const layer of plan.layers) {
      expect(Object.keys(layer).sort()).toEqual(
        ['anchor', 'heightPercent', 'index', 'intensity', 'layerCount', 'style', 'tint'].sort(),
      );
    }
  });

  it('tient l’invariant `0 <= index < layerCount` et numérote 0 = la plus haute', () => {
    expect(plan.layers.map((layer) => layer.index)).toEqual([0, 1, 2, 3, 4]);
    for (const layer of plan.layers) {
      expect(layer.layerCount).toBe(5);
      expect(layer.index).toBeGreaterThanOrEqual(0);
      expect(layer.index).toBeLessThan(layer.layerCount);
    }
    expect(plan.layers[0]?.heightPercent).toBe(100);
  });

  it('donne une intensité UNIFORME et faible : le progressif vient du RECOUVREMENT', () => {
    const intensities = new Set(plan.layers.map((layer) => layer.intensity));
    expect(intensities).toEqual(new Set([patterns.edgeFalloff.layerIntensity]));
    expect(patterns.edgeFalloff.layerIntensity).toBe(5);
  });

  it("ne transmet JAMAIS la teinte 'dark' — la couleur perçue vient de NOTRE dégradé", () => {
    expect(resolveBlurTint('light')).toBe('light');
    expect(resolveBlurTint('dark')).toBe('default');
    for (const appearance of ['light', 'dark'] as const) {
      for (const tone of TONES) {
        const tinted = progressiveBlurPlan(
          nominal({ layers: 10, material: resolveBlurMaterial(tone, appearance) }),
        );
        for (const layer of tinted.layers) {
          expect(layer.tint).not.toBe('dark');
          expect(['light', 'default']).toContain(layer.tint);
        }
      }
    }
  });

  it('est GELÉ, style compris : un port hostile ne peut pas se déplacer hors de sa bande', () => {
    const layer = plan.layers[0];
    expect(Object.isFrozen(layer)).toBe(true);
    expect(Object.isFrozen(layer?.style)).toBe(true);
  });
});

describe('GÉOMÉTRIE RÉSOLUE — le port choisit le matériau, jamais la géométrie', () => {
  it('ancre en bas : position absolue, pleine largeur, collée au bord ancré', () => {
    expect(blurLayerStyle('bottom', 76, HEIGHT)).toEqual({
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: 152,
    });
  });

  it('ancre en haut : le point opaque est toujours au bord ancré', () => {
    expect(blurLayerStyle('top', 76, HEIGHT)).toEqual({
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      height: 152,
    });
  });

  it('ne porte NI zIndex, NI elevation, NI token d’ombre — l’ordre de déclaration est seul juge', () => {
    // Motif : Android trie un ViewGroup par Z = elevation + translationZ et cela PRIME sur
    // l'ordre de déclaration ; iOS ignore elevation et suit la déclaration. Deux leviers en
    // désaccord produisent deux rendus par OS. Le désaccord est interdit, pas arbitré.
    const forbidden = ['zIndex', 'elevation', 'shadowColor', 'shadowOpacity', 'shadowRadius', 'shadowOffset'];
    for (const anchor of ['top', 'bottom'] as BlurAnchor[]) {
      for (const percent of EDGE_FALLOFF_HEIGHT_PROFILE) {
        const keys = Object.keys(blurLayerStyle(anchor, percent, HEIGHT));
        for (const key of forbidden) expect(keys).not.toContain(key);
      }
    }
    for (const layer of progressiveBlurPlan(nominal({ layers: 10 })).layers) {
      for (const key of forbidden) expect(Object.keys(layer.style as object)).not.toContain(key);
    }
  });

  it('convertit le pourcentage en points sans jamais sortir de l’enveloppe', () => {
    expect(layerHeightPoints(100, HEIGHT)).toBe(HEIGHT);
    expect(layerHeightPoints(16, HEIGHT)).toBe(32);
    expect(layerHeightPoints(0, HEIGHT)).toBe(0);
    expect(layerHeightPoints(Number.NaN, HEIGHT)).toBe(0);
    expect(layerHeightPoints(100, Number.POSITIVE_INFINITY)).toBe(0);
    for (const percent of EDGE_FALLOFF_HEIGHT_PROFILE) {
      expect(layerHeightPoints(percent, HEIGHT)).toBeLessThanOrEqual(HEIGHT);
    }
  });

  it("l'enveloppe vaut `inset + hauteur ÉTENDUE du chrome + 44 pt de débord`", () => {
    expect(patterns.edgeFalloff.bleed).toBe(44);
    expect(edgeFalloffHeight({ safeAreaInset: 34, chromeHeight: 58 })).toBe(136);
    expect(edgeFalloffHeight({ safeAreaInset: -10, chromeHeight: -10, bleed: -10 })).toBe(0);
  });
});

describe('LES CINQ COUPURES — le repli opaque unique, sans exception', () => {
  const coupures: readonly (readonly [string, Partial<ProgressiveBlurPlanInput>, EdgeFalloffReason])[] = [
    // 1 — le port.
    ['1 · port absent', { port: 'absent' }, 'no-port'],
    ['1 · port non scellé', { port: 'unsealed' }, 'port-unsealed'],
    ['1 · port ayant rendu null à l’index 0', { portFailure: 'null-at-zero' }, 'port-failed'],
    ['1 · port ayant levé', { portFailure: 'factory-threw' }, 'port-failed'],
    // 2 — accessibilité.
    ['2 · Reduce Transparency actif', { transparency: 'reduced' }, 'reduce-transparency'],
    ['2 · Reduce Transparency INCONNU', { transparency: 'unknown' }, 'preference-unresolved'],
    // 3 & 4 — capacité de rendu et budget.
    ['3 · Android < 31 / Modal / rendu dégradé', { capability: 'degraded' }, 'degraded-renderer'],
    ['4 · capacité NON DÉCLARÉE', { capability: 'unknown' }, 'capability-unknown'],
    ['4 · capacité absente des props', { capability: undefined }, 'capability-unknown'],
    // 5 — liste virtualisée.
    ['5 · liste virtualisée', { surfaceUnder: 'virtualized-list' }, 'virtualized-list'],
    ['5 · nature du contenu NON DÉCLARÉE', { surfaceUnder: 'unknown' }, 'surface-unknown'],
    ['5 · nature absente des props', { surfaceUnder: undefined }, 'surface-unknown'],
    // Assertion d'englobement du § 4 — DEUX rangs, et le second est le correctif du seul
    // défaut fail-OPEN qu'avait le composant : ne pas pouvoir faire l'assertion ferme aussi.
    ['· enveloppe plus haute que le shell (__DEV__)', { envelope: 'overflow' }, 'envelope-overflow'],
    ['· hauteur de shell NON DÉCLARÉE (__DEV__)', { envelope: 'unverified' }, 'envelope-unverified'],
    ['· assertion absente de l’entrée', { envelope: undefined }, 'envelope-unverified'],
  ] as const;

  for (const [label, override, reason] of coupures) {
    it(`${label} → repli opaque unique, zéro couche`, () => {
      const plan = progressiveBlurPlan(nominal({ layers: 6, ...override }));
      expect(plan.mode).toBe('tinted');
      expect(plan.reason).toBe(reason);
      expect(plan.layers).toEqual([]);
      expect(plan.peakIntensity).toBe(0);
    });
  }

  it('sert la MÊME géométrie, la MÊME courbe et la MÊME couleur dans les deux modes', () => {
    const blurred = progressiveBlurPlan(nominal({ layers: 3 }));
    const tinted = progressiveBlurPlan(nominal({ layers: 3, transparency: 'reduced' }));
    expect(blurred.mode).toBe('blurred');
    expect(tinted.mode).toBe('tinted');
    // Le voile — celui qui porte notre identité — est identique : seuls les échantillons partent.
    expect(edgeVeilGradient('canvas', 'light', 'bottom')).toEqual(
      edgeVeilGradient('canvas', 'light', 'bottom'),
    );
    expect(tinted.material).toEqual(blurred.material);
  });
});

describe('FAIL-CLOSED — l’accessibilité passe AVANT toute autre décision', () => {
  it("Reduce Transparency l'emporte même quand tout le reste est parfait", () => {
    const plan = progressiveBlurPlan(nominal({ layers: 10, transparency: 'reduced' }));
    expect(plan.reason).toBe('reduce-transparency');
  });

  it("l'inconnu compte comme ACTIF, et il l'emporte aussi sur les autres coupures", () => {
    const plan = progressiveBlurPlan(
      nominal({ layers: 10, transparency: 'unknown', port: 'absent', capability: 'degraded' }),
    );
    // Si un autre rang gagnait ici, la préférence ne serait plus le rang 0.
    expect(plan.reason).toBe('preference-unresolved');
  });

  it('les QUATRE tri-états refusent par défaut : aucune ignorance ne s’arbitre en faveur du flou', () => {
    for (const key of ['transparency', 'capability', 'surfaceUnder'] as const) {
      const plan = progressiveBlurPlan(nominal({ layers: 3, [key]: 'unknown' }));
      expect(plan.mode, `${key} inconnu doit fermer le flou`).toBe('tinted');
    }
    // Le QUATRIÈME, ajouté après la revue : l'assertion d'englobement du § 4. Son inconnu
    // s'écrit `unverified` — « je n'ai pas pu vérifier » — et il refuse comme les autres.
    expect(progressiveBlurPlan(nominal({ layers: 3, envelope: 'unverified' })).mode).toBe('tinted');
    expect(progressiveBlurPlan(nominal({ layers: 3, envelope: undefined })).mode).toBe('tinted');
  });
});

describe('PLAFONNEMENT — `capped` ne ment pas, même sur l’infini', () => {
  it.each([
    [Number.POSITIVE_INFINITY, 0, true],
    [Number.NaN, 0, true],
    [99, MAX_EDGE_FALLOFF_LAYERS, true],
    [3.7, 3, true],
    [-4, 0, false],
    [3, 3, false],
  ])('demande %s → %s couches, capped=%s', (requested, granted, capped) => {
    const plan = progressiveBlurPlan(nominal({ layers: requested }));
    expect(plan.granted).toBe(granted);
    expect(plan.capped).toBe(capped);
  });
});

describe('RECOUVREMENT — l’intensité effective monte par marches de 5', () => {
  it('vaut 5 à l’extrémité libre et 5 × N au bord ancré', () => {
    const plan = progressiveBlurPlan(nominal({ layers: 4 }));
    expect(effectiveIntensityAt(0, plan.layers)).toBe(5);
    expect(effectiveIntensityAt(1, plan.layers)).toBe(20);
    expect(plan.peakIntensity).toBe(20);
  });

  it('progresse strictement, sans jamais redescendre', () => {
    const plan = progressiveBlurPlan(nominal({ layers: 10 }));
    let previous = 0;
    for (let depth = 0; depth <= 1.0001; depth += 0.02) {
      const intensity = effectiveIntensityAt(depth, plan.layers);
      expect(intensity).toBeGreaterThanOrEqual(previous);
      expect(intensity % 5).toBe(0);
      previous = intensity;
    }
  });
});

describe('LA TEINTE EST LA NÔTRE — courbe du voile et plancher de notre part', () => {
  it('lit la courbe sur les stops LIVRÉS : 0 → 0,92 à 0,32 → OPAQUE dès 0,60', () => {
    const material = resolveBlurMaterial('canvas', 'light');
    expect(veilOpacityAt(0, material)).toBe(0);
    expect(veilOpacityAt(0.32, material)).toBeCloseTo(0.92, 6);
    expect(veilOpacityAt(0.6, material)).toBe(1);
    expect(veilOpacityAt(1, material)).toBe(1);
  });

  it('le bord ancré est OPAQUE dans les 7 tons et les 2 apparences — jamais un trou', () => {
    for (const appearance of ['light', 'dark'] as const) {
      for (const tone of TONES) {
        const spec = surfaceVeil[appearance][tone];
        expect(spec.stops[2]).toMatch(/^#[\dA-F]{6}$/i);
        expect(spec.solid).toBe(spec.stops[2]);
      }
    }
  });

  it('notre part reste PLANCHÉE à plus de 92 % dès le stop médian, partout', () => {
    for (const appearance of ['light', 'dark'] as const) {
      for (const tone of TONES) {
        const plan = progressiveBlurPlan(
          nominal({ layers: 10, material: resolveBlurMaterial(tone, appearance) }),
        );
        expect(bobTintShareAt(0.32, plan), `${appearance}/${tone} au stop médian`).toBeGreaterThan(0.92);
        expect(bobTintShareAt(0.6, plan), `${appearance}/${tone} au point opaque`).toBe(1);
        expect(bobTintShareAt(1, plan), `${appearance}/${tone} au bord ancré`).toBe(1);
      }
    }
  });

  /**
   * LE PLANCHER RÉEL, mesuré — et il vaut ZÉRO au bord libre.
   *
   * Ce fichier et ses tokens ont affirmé que le lavis rendait « structurellement impossible
   * qu'un port impose sa teinte » et qu'« il n'a aucun moyen de la réduire ». Les deux étaient
   * faux, et aucun test ne les regardait : les tests hostiles vérifiaient l'ORDRE des nœuds et
   * les COULEURS de nos dégradés — deux propriétés vraies qui ne prouvent pas celle-là.
   *
   * Ce test-ci mesure la seule chose qui compte : la part du PORT, profondeur par profondeur.
   * Il est écrit pour ÉCHOUER le jour où l'un des deux commentaires réaffirmera l'impossible.
   */
  it('AU BORD LIBRE, le matériau du port est SEUL : notre part y vaut exactement 0', () => {
    const plan = progressiveBlurPlan(nominal({ layers: 10 }));
    // La table de la revue adversariale, rejouée valeur par valeur (canvas / light, N = 10).
    const portShareAt = (depth: number): number => Number((1 - bobTintShareAt(depth, plan)).toFixed(4));
    expect(portShareAt(0), 'à la profondeur 0 le port est seul — c’est un fait, pas un défaut').toBe(1);
    expect(portShareAt(0.02)).toBe(0.9368);
    expect(portShareAt(0.05)).toBe(0.8434);
    expect(portShareAt(0.16)).toBe(0.5071);
    expect(portShareAt(0.32)).toBe(0.0653);
    expect(portShareAt(0.6)).toBe(0);
    // Ce qui rachète le bord libre, et qui est vrai : une SEULE couche y couvre le pixel, donc
    // l'intensité effective y vaut `layerIntensity` — le flou le PLUS LÉGER du profil.
    expect(effectiveIntensityAt(0, plan.layers)).toBe(patterns.edgeFalloff.layerIntensity);
    // Et notre part devient majoritaire dès qu'on quitte l'extrême bord.
    expect(bobTintShareAt(0.2, plan)).toBeGreaterThan(0.5);
  });

  it('le voile `canvas` reproduit à l’identique le fondu déjà livré de la tab bar', () => {
    expect(surfaceVeil.light.canvas.stops).toEqual(patterns.bottomTabBar.fade);
    expect(patterns.edgeFalloff.veilLocations).toEqual(patterns.bottomTabBar.fadeLocations);
  });

  it('les six tons du kit ancrent le voile sur la couleur `flat` de leur surface', () => {
    for (const appearance of ['light', 'dark'] as const) {
      for (const [tone, spec] of Object.entries(surfaceTint[appearance])) {
        expect(surfaceVeil[appearance][tone as keyof typeof surfaceTint.light].solid).toBe(spec.flat);
      }
    }
  });
});

describe('BUDGET — trois couches lisibles, le reste coûte sans rendre', () => {
  it('compte TROIS couches au-dessus du seuil de matérialité, dans les 7 tons × 2 apparences', () => {
    for (const appearance of ['light', 'dark'] as const) {
      for (const tone of TONES) {
        expect(visibleLayerCount(resolveBlurMaterial(tone, appearance))).toBe(3);
      }
    }
  });

  it('remonte les couches muettes en diagnostic, sans jamais réduire la demande en silence', () => {
    const plan = progressiveBlurPlan(nominal({ layers: 10 }));
    expect(plan.granted).toBe(10);
    expect(plan.layers).toHaveLength(10);
    expect(plan.visibleLayers).toBe(3);
    expect(plan.hiddenLayers).toBe(7);
  });
});

describe('AVERTISSEMENTS — parler des intentions non tenues, se taire sur les rangs normaux', () => {
  it('se tait quand aucune couche n’est demandée, et quand une préférence ferme le flou', () => {
    expect(progressiveBlurWarnings(progressiveBlurPlan(nominal({ layers: 0 })))).toEqual([]);
    expect(
      progressiveBlurWarnings(progressiveBlurPlan(nominal({ layers: 0, transparency: 'reduced' }))),
    ).toEqual([]);
    expect(
      progressiveBlurWarnings(progressiveBlurPlan(nominal({ layers: 3, transparency: 'reduced' }))),
    ).toEqual([]);
  });

  it('parle quand du flou est demandé et ne sera pas rendu', () => {
    for (const override of [
      { port: 'absent' },
      { port: 'unsealed' },
      { capability: 'unknown' },
      { surfaceUnder: 'virtualized-list' },
      { surfaceUnder: 'unknown' },
      { envelope: 'overflow' },
      { envelope: 'unverified' },
    ] as Partial<ProgressiveBlurPlanInput>[]) {
      const warnings = progressiveBlurWarnings(progressiveBlurPlan(nominal({ layers: 3, ...override })));
      expect(warnings.length, JSON.stringify(override)).toBeGreaterThan(0);
    }
  });

  it("n'interpole AUCUNE donnée dans les messages de manquement du port", () => {
    for (const message of Object.values(BLUR_PORT_FAILURE_WARNINGS)) {
      expect(message).toMatch(/^ProgressiveBlurBob/);
      expect(message).not.toMatch(/\$\{|undefined|\[object/);
    }
    // `null-at-zero` est la bascule NORMALE du contrat : elle ne s'annonce pas comme une faute.
    expect(BLUR_PORT_FAILURE_WARNINGS['null-at-zero']).toBeUndefined();
  });
});
