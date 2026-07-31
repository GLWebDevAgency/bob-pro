/**
 * BobTabBar — LOGIQUE PURE, verrouillée comportement par comportement.
 *
 * Le socle écrit que livrer CINQ comportements sur six ne satisfait pas `G11`. Ce fichier est
 * organisé dans cet ordre-là : un bloc par comportement, plus les quatre contraintes dures
 * (cible tactile, accessibilité fail-closed, Dynamic Type, contraste AA échantillonné).
 *
 * Chaque assertion vaut une ligne du socle, citée. Les nombres NORMATIFS du § Cibles tactiles et
 * Dynamic Type — 58/60 étendu, 44/46 iOS replié, 48/50 Android replié, 5 pt et 1 pt d'écart —
 * sont rejoués tels quels : c'est la table d'acceptation, pas une paraphrase.
 */
import { describe, expect, it } from 'vitest';
import { motionSemantic, patterns, resolveColorRole, surfaceTint } from '@bob/tokens';
import {
  ASSISTANT_TAB_KEY,
  MINIMIZE_DEAD_ZONE,
  MINIMIZE_TOP_GUARD,
  SCRUB_ACTIVE_OFFSET_X,
  SCRUB_FAIL_OFFSET_Y,
  SCRUB_TAP_MAX_DISTANCE,
  SCRUB_TAP_MAX_DURATION,
  TAB_BAR_BLEED,
  TAB_BAR_BORDER_WIDTH,
  TAB_BAR_EXPANDED_VISUAL,
  TAB_BAR_MARGIN,
  TAB_BAR_MINIMIZED_VISUAL,
  TAB_BAR_MINIMIZE_SPRING,
  TAB_BAR_OUTER_RHYTHM,
  TAB_BAR_ROW_PAD_H,
  TAB_BAR_SIDE_INSET,
  TAB_BAR_SLIDE_SPRING,
  TAB_LABEL_MAX_LINES,
  affordableSideInset,
  boundaryTick,
  contrastRatio,
  effectiveDuration,
  fadeThroughPlan,
  highlightProximity,
  highlightTranslateX,
  minimizeDecision,
  minimumWindowWidth,
  mixTint,
  motionAllowed,
  resolveBarLabelTier,
  resolveTabLabelTier,
  sampleTintCourse,
  scrubAllowed,
  shouldRetargetMinimize,
  tabActiveTint,
  tabBarBottomOffset,
  tabBarGeometry,
  tabBarGeometryBounds,
  tabIndexAtX,
  tabTintPalette,
  touchTargetFloor,
  type TabBarMetrics,
  type TabBarPlatform,
} from './bob-tab-bar.logic';

const WINDOW = 390;
const TABS = 5;
const WCAG_AA_NORMAL_TEXT = 4.5;

function metrics(platform: TabBarPlatform, extra: Partial<TabBarMetrics> = {}): TabBarMetrics {
  return { platform, windowWidth: WINDOW, tabCount: TABS, ...extra };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// CONTRAINTE DURE — CIBLE TACTILE. La première, parce qu'elle prime sur toute la géométrie.
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('cible tactile — plancher absolu, porté par le `Pressable` et par rien d’autre', () => {
  it('vaut 44 pt sur iOS et 48 dp sur Android — la valeur 44 de la référence est une valeur iOS', () => {
    expect(touchTargetFloor('ios')).toBe(44);
    expect(touchTargetFloor('android')).toBe(48);
  });

  it.each<TabBarPlatform>(['ios', 'android'])(
    'n’est jamais franchi sur %s, à AUCUN instant de l’animation',
    (platform) => {
      const floor = touchTargetFloor(platform);
      for (let i = 0; i <= 100; i += 1) {
        const geometry = tabBarGeometry(i / 100, metrics(platform));
        expect(geometry.pressableHeight).toBeGreaterThanOrEqual(floor);
      }
    },
  );

  it('reproduit la table normative du socle — étendu : visuel 50, pilule 58 intérieure, 60 mesurée', () => {
    for (const platform of ['ios', 'android'] as const) {
      const geometry = tabBarGeometry(0, metrics(platform));
      expect(geometry.innerVisualHeight).toBe(50);
      expect(geometry.pressableHeight).toBe(50);
      expect(geometry.outerRhythm).toBe(4);
      expect(geometry.pillInnerHeight).toBe(58);
      expect(geometry.pillMeasuredHeight).toBe(60);
      // A30 : l’écart mesuré vaut `rythmeExtérieur + épaisseurBordure`, soit 5 pt de chaque côté.
      expect(geometry.pillToPressableGap).toBe(5);
    }
  });

  it('reproduit la table normative du socle — replié : 44/46 sur iOS, 48/50 sur Android', () => {
    const ios = tabBarGeometry(1, metrics('ios'));
    expect(ios.innerVisualHeight).toBe(35);
    expect(ios.pressableHeight).toBe(44);
    expect(ios.pillInnerHeight).toBe(44);
    expect(ios.pillMeasuredHeight).toBe(46);

    const android = tabBarGeometry(1, metrics('android'));
    expect(android.innerVisualHeight).toBe(35);
    expect(android.pressableHeight).toBe(48);
    expect(android.pillInnerHeight).toBe(48);
    expect(android.pillMeasuredHeight).toBe(50);

    // A28 : le rythme extérieur vaut 0 au repli, mais l’écart mesuré vaut 1 pt — la bordure de
    // la pilule est comptée dans son rectangle. Sans cette distinction, la mesure n° 2 du socle
    // serait fausse d’exactement 1 pt par côté, et un build CONFORME échouerait son critère.
    expect(ios.outerRhythm).toBe(0);
    expect(ios.pillToPressableGap).toBe(1);
    expect(android.pillToPressableGap).toBe(1);
  });

  it('ne copie PAS `MINIMIZED_HEIGHT = 44` de la référence : sur Android la pilule repliée vaut 48', () => {
    expect(tabBarGeometry(1, metrics('android')).pillInnerHeight).not.toBe(44);
    expect(tabBarGeometry(1, metrics('android')).pillInnerHeight).toBe(48);
  });

  it('la hauteur du `Pressable` n’est PAS l’interpolation de ses deux bouts — c’est un `max`', () => {
    // Le piège : `lerp(50, 44, 0.5)` vaut 47, `max(44, lerp(50, 35, 0.5))` vaut 44. Interpoler
    // les extrémités donnerait une cible trop grande au milieu de la course, donc une pilule
    // qui ne se replierait jamais complètement.
    const half = tabBarGeometry(0.5, metrics('ios'));
    expect(half.innerVisualHeight).toBe(42.5);
    expect(half.pressableHeight).toBe(44);
    expect(half.pressableHeight).not.toBe(47);
  });

  it('à 200 % de taille de texte, le contenu mesuré POUSSE le plancher — il ne le remplace pas', () => {
    const big = tabBarGeometry(0, metrics('ios', { expandedContentHeight: 78 }));
    expect(big.innerVisualHeight).toBe(78);
    expect(big.pressableHeight).toBe(78);
    expect(big.pillMeasuredHeight).toBe(78 + 2 * TAB_BAR_OUTER_RHYTHM + 2 * TAB_BAR_BORDER_WIDTH);

    const small = tabBarGeometry(0, metrics('ios', { expandedContentHeight: 12 }));
    expect(small.innerVisualHeight).toBe(TAB_BAR_EXPANDED_VISUAL);
    // Symétrique au repli : le plancher du visuel replié tient lui aussi.
    expect(tabBarGeometry(1, metrics('ios', { minimizedContentHeight: 8 })).innerVisualHeight).toBe(
      TAB_BAR_MINIMIZED_VISUAL,
    );
  });

  it('deux onglets voisins ne se recouvrent pas : la largeur d’item divise EXACTEMENT le contenu', () => {
    for (const progress of [0, 0.37, 1]) {
      const geometry = tabBarGeometry(progress, metrics('ios'));
      const contentWidth =
        geometry.pillWidth - 2 * TAB_BAR_BORDER_WIDTH - 2 * TAB_BAR_ROW_PAD_H;
      expect(geometry.itemWidth * TABS).toBeCloseTo(contentWidth, 10);
      expect(geometry.itemWidth).toBeGreaterThan(0);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// CONTRAINTE DURE — LA MOITIÉ « WIDTH » DU CRITÈRE D'ACCEPTATION N° 1
// « measure() sur le Pressable de CHACUN des cinq onglets → height ≥ 44/48 ET width ≥ 44/48 »
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('cible tactile EN LARGEUR — la moitié du critère qui n’était ni tenue ni testée', () => {
  /**
   * LES LARGEURS RÉELLES DU PARC, de la plus étroite à la plus large. Rien d'inventé :
   * 280 dp = écran de couverture d'un pliable ; 320 = iPhone SE 1re gén. et petits Android ;
   * 360 = la largeur Android la plus répandue ; 375 = iPhone SE 2/3 et 13 mini ; 390 = iPhone
   * 13/14/15 ; 393 = Pixel 7/8 ; 412 = grands Android ; 430 = iPhone Pro Max.
   */
  const REAL_WIDTHS = [280, 320, 360, 375, 390, 393, 412, 430];

  it.each<TabBarPlatform>(['ios', 'android'])(
    'sur %s, `itemWidth ≥ CIBLE` sur 101 points de la course, à TOUTES les largeurs réelles',
    (platform) => {
      const floor = touchTargetFloor(platform);
      for (const windowWidth of REAL_WIDTHS) {
        for (let i = 0; i <= 100; i += 1) {
          const geometry = tabBarGeometry(i / 100, metrics(platform, { windowWidth }));
          expect(geometry.touchWidthHeld, `${platform} ${windowWidth} @ ${i}%`).toBe(true);
          // Le `Pressable` est `flex: 1` : `itemWidth` EST sa largeur mesurée.
          expect(geometry.itemWidth, `${platform} ${windowWidth} @ ${i}%`).toBeGreaterThanOrEqual(
            floor - 1e-9,
          );
          // Et l'autre moitié du critère tient en même temps.
          expect(geometry.pressableHeight).toBeGreaterThanOrEqual(floor);
        }
      }
    },
  );

  it('CE QUI CÈDE est le retrait latéral — nommément, et seulement lui', () => {
    // Écran large : rien ne cède, le retrait vaut les 34 pt du socle.
    expect(affordableSideInset('ios', 390, 5)).toBe(TAB_BAR_SIDE_INSET);
    expect(tabBarGeometry(1, metrics('ios', { windowWidth: 390 })).sideInset).toBe(34);

    // Écran étroit : il est RABOTÉ, exactement de ce qu'il faut et pas plus.
    expect(affordableSideInset('ios', 320, 5)).toBe(33);
    expect(affordableSideInset('android', 320, 5)).toBe(23);
    expect(affordableSideInset('android', 280, 5)).toBe(3);

    // Et la marge de safe area, elle, ne bouge JAMAIS : c'est l'autre grandeur horizontale, et
    // elle n'entre pas dans le troc.
    for (const windowWidth of REAL_WIDTHS) {
      expect(tabBarGeometryBounds(metrics('android', { windowWidth })).margin).toBe(TAB_BAR_MARGIN);
    }
  });

  it('le retrait clampé reste une INTERPOLATION propre : 0 au repos, son maximum au repli', () => {
    const bounds = tabBarGeometryBounds(metrics('android', { windowWidth: 320 }));
    expect(bounds.sideInset[0]).toBe(0);
    expect(bounds.sideInset[1]).toBe(23);
    expect(tabBarGeometry(0, metrics('android', { windowWidth: 320 })).sideInset).toBe(0);
    expect(tabBarGeometry(0.5, metrics('android', { windowWidth: 320 })).sideInset).toBe(11.5);
    expect(tabBarGeometry(1, metrics('android', { windowWidth: 320 })).sideInset).toBe(23);
  });

  it('DÉCLARE la limite résiduelle plutôt que de laisser la cible tomber en silence', () => {
    // Sous ce seuil, un retrait NUL ne suffit plus : la barre n'a plus rien à céder.
    expect(minimumWindowWidth('ios', 5)).toBe(254);
    expect(minimumWindowWidth('android', 5)).toBe(274);
    // Aucune largeur du parc réel ne s'y trouve — c'est plus étroit que tout écran vendu.
    for (const windowWidth of REAL_WIDTHS) {
      expect(windowWidth).toBeGreaterThanOrEqual(minimumWindowWidth('android', 5));
    }
    // En deçà, le drapeau tombe à `false` : c'est une DÉCLARATION, pas un silence.
    expect(tabBarGeometry(1, metrics('android', { windowWidth: 260 })).touchWidthHeld).toBe(false);
    expect(tabBarGeometryBounds(metrics('android', { windowWidth: 260 })).touchWidthHeld).toBe(
      false,
    );
    // Et le retrait est alors ramené à zéro : tout ce qui pouvait céder a cédé.
    expect(affordableSideInset('android', 260, 5)).toBe(0);
  });

  it('avec MOINS d’onglets, le seuil descend — le nombre d’onglets est bien le facteur', () => {
    expect(minimumWindowWidth('android', 4)).toBe(274 - 48);
    expect(minimumWindowWidth('android', 6)).toBe(274 + 48);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// COMPORTEMENT 1 — MINIMIZE-ON-SCROLL
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('1 · minimize-on-scroll — la signature de la barre', () => {
  const base = { contentHeight: 4000, layoutHeight: 800, previousY: 300 };

  it('minimise au-delà de la zone morte descendante, étend au-delà de la montante', () => {
    expect(minimizeDecision({ ...base, contentOffsetY: 300 + MINIMIZE_DEAD_ZONE + 1 }).target).toBe(1);
    expect(minimizeDecision({ ...base, contentOffsetY: 300 - MINIMIZE_DEAD_ZONE - 1 }).target).toBe(0);
  });

  it('ne bouge à RIEN dans la zone morte — sinon la barre vibre au moindre tremblement', () => {
    for (const dy of [-MINIMIZE_DEAD_ZONE, -1, 0, 1, MINIMIZE_DEAD_ZONE]) {
      expect(minimizeDecision({ ...base, contentOffsetY: 300 + dy }).target).toBeNull();
    }
  });

  it('force le dépli sous le seuil de retour haut, même en scrollant vers le bas', () => {
    const decision = minimizeDecision({
      contentHeight: 4000,
      layoutHeight: 800,
      previousY: 0,
      contentOffsetY: MINIMIZE_TOP_GUARD - 1,
    });
    expect(decision.target).toBe(0);
  });

  it('CLAMPE l’offset : le rubber-band d’overscroll ne peut pas inverser la direction une frame', () => {
    // Sans clamp, un `contentOffsetY` négatif (tirage vers le bas en haut de liste) produirait
    // un `dy` négatif puis positif au relâchement, et la barre clignoterait.
    expect(minimizeDecision({ ...base, contentOffsetY: -120 }).y).toBe(0);
    // Overscroll bas : au-delà de `contentSize − layout`, l’offset est ramené au maximum réel.
    expect(minimizeDecision({ ...base, contentOffsetY: 9999 }).y).toBe(4000 - 800);
    // Contenu plus court que la fenêtre : la plage vaut 0, pas une valeur négative.
    expect(
      minimizeDecision({ contentHeight: 100, layoutHeight: 800, previousY: 0, contentOffsetY: 50 }).y,
    ).toBe(0);
  });

  it('ne relance PAS le ressort quand on va déjà vers la cible — le recentrage est no-op', () => {
    expect(shouldRetargetMinimize(1, 1)).toBe(false);
    expect(shouldRetargetMinimize(0, 1)).toBe(true);
  });

  it('anime avec un ressort CRITIQUE-AMORTI, parce qu’il anime de la layout', () => {
    expect(TAB_BAR_MINIMIZE_SPRING).toEqual({ duration: 380, dampingRatio: 1 });
  });

  it('rétrécit dans les DEUX dimensions : hauteur ET retrait latéral animé de 0 à 34 pt par côté', () => {
    const expanded = tabBarGeometry(0, metrics('ios'));
    const collapsed = tabBarGeometry(1, metrics('ios'));
    expect(expanded.sideInset).toBe(0);
    expect(collapsed.sideInset).toBe(TAB_BAR_SIDE_INSET);
    expect(collapsed.pillWidth).toBe(expanded.pillWidth - 2 * TAB_BAR_SIDE_INSET);
    expect(collapsed.pillMeasuredHeight).toBeLessThan(expanded.pillMeasuredHeight);
  });

  it('recalcule `borderRadius = hauteur / 2` — une formule, jamais une constante', () => {
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const geometry = tabBarGeometry(progress, metrics('android'));
      expect(geometry.borderRadius).toBe(geometry.pillMeasuredHeight / 2);
    }
  });

  it('reprend le calcul de safe area de la référence : `max(inset bas − 16, 12)`', () => {
    expect(tabBarBottomOffset(34)).toBe(18);
    expect(tabBarBottomOffset(0)).toBe(12);
    expect(tabBarBottomOffset(20)).toBe(12);
  });

  it('marge latérale 12 pt et débord de retombée pris du token livré — aucun chiffre libre', () => {
    expect(TAB_BAR_MARGIN).toBe(12);
    expect(TAB_BAR_BLEED).toBe(patterns.edgeFalloff.bleed);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// COMPORTEMENT 2 — HIGHLIGHT GLISSANT À RESSORT INTERRUPTIBLE
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('2 · highlight glissant — un seul bloc, transform-only, ressort interruptible', () => {
  it('se positionne par `translateX` pur, calculé depuis la largeur d’item', () => {
    const geometry = tabBarGeometry(0, metrics('ios'));
    expect(highlightTranslateX(0, geometry)).toBe(TAB_BAR_ROW_PAD_H);
    expect(highlightTranslateX(1, geometry)).toBe(TAB_BAR_ROW_PAD_H + geometry.itemWidth);
    expect(highlightTranslateX(4, geometry)).toBe(TAB_BAR_ROW_PAD_H + 4 * geometry.itemWidth);
  });

  it('accepte une position CONTINUE — le highlight voyage, il ne saute pas d’onglet en onglet', () => {
    const geometry = tabBarGeometry(0, metrics('ios'));
    const midpoint = highlightTranslateX(1.5, geometry);
    expect(midpoint).toBeGreaterThan(highlightTranslateX(1, geometry));
    expect(midpoint).toBeLessThan(highlightTranslateX(2, geometry));
  });

  it('suit la barre PENDANT qu’elle s’ouvre : la géométrie est recalculée live sur `progress`', () => {
    const open = tabBarGeometry(0, metrics('ios'));
    const closed = tabBarGeometry(1, metrics('ios'));
    expect(highlightTranslateX(4, closed)).not.toBe(highlightTranslateX(4, open));
    expect(closed.itemWidth).toBeLessThan(open.itemWidth);
  });

  it('anime avec un ressort SOUS-AMORTI — sans danger, puisque transform-only', () => {
    expect(TAB_BAR_SLIDE_SPRING).toEqual({ duration: 420, dampingRatio: 0.82 });
    expect(TAB_BAR_SLIDE_SPRING.dampingRatio).toBeLessThan(TAB_BAR_MINIMIZE_SPRING.dampingRatio);
  });

  it('ne dépend d’AUCUNE mesure asynchrone : la largeur d’item est calculée dès le premier appel', () => {
    // Invariant A27 : aucune frame de retard, aucun saut au premier rendu. La preuve est qu’une
    // géométrie complète sort de métriques qui ne contiennent aucune valeur mesurée.
    const bounds = tabBarGeometryBounds({ platform: 'ios', windowWidth: WINDOW, tabCount: TABS });
    expect(bounds.windowWidth).toBe(WINDOW);
    expect(tabBarGeometry(0, metrics('ios')).itemWidth).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// COMPORTEMENT 3 — SCRUBBING AU DOIGT AVEC TICKS HAPTIQUES
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('3 · scrub au doigt — mapping 1:1 et ticks au FRANCHISSEMENT', () => {
  const geometry = tabBarGeometry(0, metrics('ios'));
  const contentLeft = TAB_BAR_BORDER_WIDTH + TAB_BAR_ROW_PAD_H;

  it('rend 0 au centre du premier onglet et `tabCount − 1` au centre du dernier', () => {
    expect(tabIndexAtX(contentLeft + geometry.itemWidth / 2, geometry, TABS)).toBeCloseTo(0, 10);
    expect(
      tabIndexAtX(contentLeft + geometry.itemWidth * (TABS - 0.5), geometry, TABS),
    ).toBeCloseTo(TABS - 1, 10);
  });

  it('reste BORNÉ aux onglets réels : le doigt qui sort de la pilule ne crée pas d’index fantôme', () => {
    expect(tabIndexAtX(-500, geometry, TABS)).toBe(0);
    expect(tabIndexAtX(5000, geometry, TABS)).toBe(TABS - 1);
  });

  it('retranche la BORDURE en plus du retrait intérieur — la référence n’a pas de bordure', () => {
    // Si l’on recopiait `raw = (x − ROW_PAD_H) / itemWidth − 0.5` (l. 154 de la référence), le
    // mapping serait décalé d’exactement 1 pt : invisible à l’œil, faux à la mesure.
    const naif = (contentLeft + geometry.itemWidth / 2 - TAB_BAR_ROW_PAD_H) / geometry.itemWidth - 0.5;
    expect(naif).not.toBeCloseTo(0, 10);
  });

  it('est CONTINU — mapping 1:1, aucun cran, aucun ressort pendant le drag', () => {
    const a = tabIndexAtX(contentLeft + geometry.itemWidth * 1.2, geometry, TABS);
    const b = tabIndexAtX(contentLeft + geometry.itemWidth * 1.3, geometry, TABS);
    expect(b - a).toBeCloseTo(0.1, 10);
  });

  it('ne tick QU’au franchissement de frontière, jamais par frame', () => {
    expect(boundaryTick(1, 1.2)).toBeNull();
    expect(boundaryTick(1, 1.49)).toBeNull();
    expect(boundaryTick(1, 1.51)).toBe(2);
    expect(boundaryTick(2, 2.4)).toBeNull();
    expect(boundaryTick(2, 1.4)).toBe(1);
  });

  it('porte les seuils de geste du socle — la tolérance par défaut fait échouer les vrais doigts', () => {
    expect(SCRUB_ACTIVE_OFFSET_X).toBe(6);
    expect(SCRUB_FAIL_OFFSET_Y).toBe(14);
    expect(SCRUB_TAP_MAX_DISTANCE).toBe(16);
    expect(SCRUB_TAP_MAX_DURATION).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// COMPORTEMENT 5 — FADE-THROUGH DU SLOT D'ÉCRAN
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('5 · fade-through — l’entrant fond, le sortant disparaît', () => {
  it('anime l’écran ENTRANT en `motionSemantic.replace`, avec micro-échelle 0,985 → 1', () => {
    const plan = fadeThroughPlan({ focused: true, firstRender: false, reduceMotion: 'inactive' });
    expect(plan.animate).toBe(true);
    expect(plan.duration).toBe(motionSemantic.replace);
    expect(plan.duration).toBe(280);
    expect(plan.opacityFrom).toBe(0);
    expect(plan.scaleFrom).toBe(0.985);
  });

  it('n’anime PAS l’écran sortant : il est masqué instantanément', () => {
    const plan = fadeThroughPlan({ focused: false, firstRender: false, reduceMotion: 'inactive' });
    expect(plan.animate).toBe(false);
    expect(plan.hideInstantly).toBe(true);
    expect(plan.duration).toBe(0);
  });

  it('n’anime pas le tout premier écran au lancement', () => {
    const plan = fadeThroughPlan({ focused: true, firstRender: true, reduceMotion: 'inactive' });
    expect(plan.animate).toBe(false);
    expect(plan.opacityFrom).toBe(1);
    expect(plan.scaleFrom).toBe(1);
  });

  it('ne recopie PAS le 220 ms de la référence — le token livré et gelé vaut 280', () => {
    expect(fadeThroughPlan({ focused: true, firstRender: false, reduceMotion: 'inactive' }).duration)
      .not.toBe(220);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// COMPORTEMENT 6 — TEINTE PILOTÉE PAR LE HIGHLIGHT, PAS PAR LE FOCUS
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('6 · teinte pilotée par le highlight — l’EFFET, celui qu’un backlog laisse tomber', () => {
  it('est une fonction CONTINUE de la distance au highlight, sur exactement une largeur d’onglet', () => {
    expect(highlightProximity(2, 2)).toBe(1);
    expect(highlightProximity(2.5, 2)).toBe(0.5);
    expect(highlightProximity(3, 2)).toBe(0);
    expect(highlightProximity(4, 2)).toBe(0);
    expect(highlightProximity(0, 2)).toBe(0);
  });

  it('est symétrique — la lumière voyage dans les deux sens', () => {
    expect(highlightProximity(1.75, 2)).toBe(highlightProximity(2.25, 2));
  });

  it('N’EST PAS un booléen de focus : à mi-course, DEUX onglets sont partiellement allumés', () => {
    const slide = 1.5;
    expect(highlightProximity(slide, 1)).toBe(0.5);
    expect(highlightProximity(slide, 2)).toBe(0.5);
    // Un pilotage par le focus donnerait 1 sur un seul onglet et 0 partout ailleurs.
    expect(highlightProximity(slide, 1) + highlightProximity(slide, 2)).toBe(1);
  });

  it('conserve la règle Bob de l’onglet Assistant — l’indigo IA survit à l’interpolation', () => {
    const palette = tabTintPalette('light');
    expect(tabActiveTint(ASSISTANT_TAB_KEY, palette)).toBe(
      resolveColorRole('navigation.assistantActive'),
    );
    expect(tabActiveTint('argent', palette)).toBe(resolveColorRole('navigation.active'));
    expect(tabActiveTint(ASSISTANT_TAB_KEY, palette)).not.toBe(tabActiveTint('argent', palette));
  });

  it('conserve EXACTEMENT les rôles livrés en apparence claire — rien n’est revalorisé', () => {
    const palette = tabTintPalette('light');
    expect(palette.active).toBe(resolveColorRole('navigation.active'));
    expect(palette.inactive).toBe(resolveColorRole('navigation.inactive'));
    expect(palette.pill).toBe(surfaceTint.light.neutral.flat);
    expect(palette.highlight).toBe(surfaceTint.light.neutral.raised);
  });

  it('abandonne le voile blanc translucide de la référence : le highlight est un aplat OPAQUE', () => {
    for (const appearance of ['light', 'dark'] as const) {
      expect(tabTintPalette(appearance).highlight).not.toContain('rgba');
      expect(tabTintPalette(appearance).highlight).toMatch(/^#[0-9A-F]{6}$/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// CONTRAINTE DURE — CONTRASTE AA, ÉCHANTILLONNÉ SUR LA COURSE ET SUR LES DEUX FONDS
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('contraste AA — prouvé par échantillonnage, jamais par raisonnement', () => {
  it('mélange en sRGB composante par composante, comme `interpolateColor` en espace RGB', () => {
    expect(mixTint('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(mixTint('#0C2340', '#5B6B7B', 0)).toBe('#0C2340');
    expect(mixTint('#0C2340', '#5B6B7B', 1)).toBe('#5B6B7B');
  });

  /**
   * ─── L'ÉPINGLE DE LA ROUE DÉCLARÉE n° 1 ────────────────────────────────────────────────
   *
   * `contrastRatio` est la QUATRIÈME implémentation WCAG du dépôt, et la seule exportée
   * publiquement — le fichier de logique le déclare et l'assume. C'est ICI qu'on l'empêche de
   * devenir une quatrième VÉRITÉ. Les DIX-HUIT cellules ci-dessous sont celles de la table A23
   * du socle (04 § 2), que le contrôle `C4` de `scripts/check-mobile-experience-docs.mjs`
   * recalcule indépendamment depuis `@bob/tokens`, en Node pur et avec sa propre écriture de la
   * formule. La chaîne est fermée : notre fonction → table du socle ← `C4` ← tokens.
   *
   * LA TOLÉRANCE EST CELLE DU CONTRÔLE `C4`, pas une tolérance de confort : `0,011`, exactement
   * la valeur qu'il applique à la même table (`Math.abs(actual - printed[i]) > 0.011`). Les
   * nombres du socle sont publiés arrondis au centième ; élargir au-delà laisserait passer une
   * dérive, resserrer en deçà rendrait rouge un couple parfaitement conforme. C'est assez serré
   * pour qu'une dérive d'exposant (2,4 → 2,2) ou de coefficient fasse rougir — c'est vérifié.
   */
  const C4_TOLERANCE = 0.011;

  it('ÉPINGLE les 18 cellules de la table A23 du socle, à la tolérance du contrôle `C4`', () => {
    const roles = [
      resolveColorRole('navigation.active'),
      resolveColorRole('navigation.assistantActive'),
      resolveColorRole('navigation.inactive'),
    ] as const;
    const table: readonly (readonly [string, readonly [number, number, number]])[] = [
      [surfaceTint.light.marine.flat, [14.69, 7.36, 5.1]],
      [surfaceTint.light.ai.flat, [14.49, 7.26, 5.03]],
      [surfaceTint.light.neutral.raised, [13.55, 6.78, 4.7]],
      [surfaceTint.light.marine.raised, [12.91, 6.46, 4.48]],
      [surfaceTint.light.neutral.border, [12.57, 6.29, 4.36]],
      [surfaceTint.light.marine.border, [11.6, 5.81, 4.02]],
    ];
    for (const [background, expected] of table) {
      roles.forEach((role, at) => {
        const gap = Math.abs(contrastRatio(role, background) - (expected[at] as number));
        expect(gap, `${role} sur ${background}`).toBeLessThanOrEqual(C4_TOLERANCE);
      });
    }
  });

  it('reproduit le VERDICT AA / sous-AA de la table A23, teinte par teinte', () => {
    const inactive = resolveColorRole('navigation.inactive');
    for (const tint of [
      surfaceTint.light.marine.flat,
      surfaceTint.light.ai.flat,
      surfaceTint.light.neutral.raised,
    ]) {
      expect(contrastRatio(inactive, tint), tint).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    }
    // Les trois qui tombent — dont celle que la rédaction A3 donnait en exemple.
    for (const tint of [
      surfaceTint.light.marine.raised,
      surfaceTint.light.neutral.border,
      surfaceTint.light.marine.border,
    ]) {
      expect(contrastRatio(inactive, tint), tint).toBeLessThan(WCAG_AA_NORMAL_TEXT);
    }
  });

  it.each(['light', 'dark'] as const)(
    'reste AA sur TOUTE la course et sur les DEUX fonds, en apparence %s',
    (appearance) => {
      const palette = tabTintPalette(appearance);
      for (const target of [palette.active, palette.assistantActive]) {
        for (const sample of sampleTintCourse(palette, target, 200)) {
          expect(
            sample.ratio,
            `${sample.color} sur ${sample.background} à t=${sample.t}`,
          ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
        }
      }
    },
  );

  it('le highlight se VOIT sur la pilule — un contraste AA sur un fond invisible ne prouverait rien', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const palette = tabTintPalette(appearance);
      expect(contrastRatio(palette.highlight, palette.pill)).toBeGreaterThan(1.1);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// CONTRAINTE DURE — ACCESSIBILITÉ FAIL-CLOSED (trois états, l'inconnu compte comme actif)
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('accessibilité fail-closed — l’inconnu compte comme ACTIF', () => {
  it('n’anime pas tant que Reduce Motion est INCONNU — jamais de mouvement avant de savoir', () => {
    expect(motionAllowed('unknown')).toBe(false);
    expect(motionAllowed('active')).toBe(false);
    expect(motionAllowed('inactive')).toBe(true);
  });

  it('ne monte pas le scrub tant que le lecteur d’écran est INCONNU', () => {
    expect(scrubAllowed('unknown')).toBe(false);
    expect(scrubAllowed('active')).toBe(false);
    expect(scrubAllowed('inactive')).toBe(true);
  });

  it('ramène toute durée à 0 pendant la fenêtre inconnue et sous Reduce Motion', () => {
    expect(effectiveDuration(motionSemantic.replace, 'unknown')).toBe(0);
    expect(effectiveDuration(motionSemantic.replace, 'active')).toBe(0);
    expect(effectiveDuration(motionSemantic.replace, 'inactive')).toBe(motionSemantic.replace);
  });

  it('commute la teinte à l’état final sous Reduce Motion — aucune position intermédiaire', () => {
    const plan = fadeThroughPlan({ focused: true, firstRender: false, reduceMotion: 'active' });
    expect(plan.animate).toBe(false);
    expect(plan.duration).toBe(0);
    expect(plan.opacityFrom).toBe(1);
    expect(plan.scaleFrom).toBe(1);
  });

  it('traite la fenêtre INCONNUE exactement comme Reduce Motion actif (règle A18)', () => {
    const unknown = fadeThroughPlan({ focused: true, firstRender: false, reduceMotion: 'unknown' });
    const active = fadeThroughPlan({ focused: true, firstRender: false, reduceMotion: 'active' });
    expect(unknown).toEqual(active);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// CONTRAINTE DURE — DYNAMIC TYPE : une ligne → deux lignes → icônes seules
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('Dynamic Type — le label passe sur deux lignes, puis DISPARAÎT, jamais tronqué', () => {
  it('reste sur une ligne tant qu’il tient', () => {
    expect(
      resolveTabLabelTier({ naturalWidth: 40, longestWordWidth: 40, availableWidth: 60 }),
    ).toBe('one-line');
  });

  it('passe sur deux lignes quand il ne tient plus sur une', () => {
    expect(
      resolveTabLabelTier({ naturalWidth: 90, longestWordWidth: 50, availableWidth: 60 }),
    ).toBe('two-lines');
  });

  it('bascule en icônes seules quand deux lignes ne suffisent plus', () => {
    expect(
      resolveTabLabelTier({ naturalWidth: 200, longestWordWidth: 50, availableWidth: 60 }),
    ).toBe('icon-only');
  });

  it('bascule en icônes seules dès qu’un MOT dépasse — un mot ne se coupe pas', () => {
    // Largeur totale compatible avec deux lignes (90 ≤ 2 × 60), mais « Documents » ne se coupe
    // pas : la plateforme le tronquerait, ce que l’exigence interdit.
    expect(
      resolveTabLabelTier({ naturalWidth: 90, longestWordWidth: 70, availableWidth: 60 }),
    ).toBe('icon-only');
  });

  it('n’a jamais plus de deux lignes à sa disposition', () => {
    expect(TAB_LABEL_MAX_LINES).toBe(2);
    // La frontière est exactement `2 × largeur utile` : 120 tient encore, 121 non.
    expect(
      resolveTabLabelTier({ naturalWidth: 120, longestWordWidth: 50, availableWidth: 60 }),
    ).toBe('two-lines');
    expect(
      resolveTabLabelTier({ naturalWidth: 121, longestWordWidth: 50, availableWidth: 60 }),
    ).toBe('icon-only');
  });

  it('refuse le label quand l’onglet n’a aucune largeur utile', () => {
    expect(
      resolveTabLabelTier({ naturalWidth: 10, longestWordWidth: 10, availableWidth: 0 }),
    ).toBe('icon-only');
  });

  it('un seul label qui ne tient pas fait passer TOUTE la barre en icônes', () => {
    expect(resolveBarLabelTier(['one-line', 'one-line', 'two-lines'])).toBe('two-lines');
    expect(resolveBarLabelTier(['one-line', 'icon-only', 'two-lines'])).toBe('icon-only');
    expect(resolveBarLabelTier(['one-line', 'one-line'])).toBe('one-line');
  });

  it('mesure absente = deux lignes, et ce n’est pas déclaré comme une garantie', () => {
    expect(resolveTabLabelTier(undefined)).toBe('two-lines');
  });
});
