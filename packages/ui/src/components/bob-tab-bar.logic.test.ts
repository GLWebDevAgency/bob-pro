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
  TOUCH_WIDTH_EPSILON,
  affordableSideInset,
  boundaryTick,
  contrastRatio,
  effectiveDuration,
  fadeThroughPlan,
  highlightProximity,
  highlightTranslateX,
  longestWord,
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

  /**
   * LES SEPT GRANDEURS DÉCLARÉES, ÉPINGLÉES UNE FOIS POUR TOUTES. Tout le reste du fichier
   * raisonne désormais en LITTÉRAUX calculés à la main : c'est ICI, et seulement ici, que les
   * constantes du module sont confrontées aux chiffres du socle. Sans ce bloc, un `50` devenu
   * `52` ne serait plus lu nulle part — les tests le liraient dans leurs propres attendus.
   */
  it('porte les grandeurs déclarées du socle — 50/35 de visuel, 4 de rythme, 1/34/12/4 en largeur', () => {
    expect(TAB_BAR_EXPANDED_VISUAL).toBe(50);
    expect(TAB_BAR_MINIMIZED_VISUAL).toBe(35);
    expect(TAB_BAR_OUTER_RHYTHM).toBe(4);
    expect(TAB_BAR_BORDER_WIDTH).toBe(1);
    expect(TAB_BAR_SIDE_INSET).toBe(34);
    expect(TAB_BAR_MARGIN).toBe(12);
    expect(TAB_BAR_ROW_PAD_H).toBe(4);
  });

  // LE PLANCHER EST UN LITTÉRAL, pas `touchTargetFloor(platform)` : comparer la géométrie à la
  // fonction qui lui donne son plancher, c'est comparer A à A — un plancher faux resterait vert.
  it.each<[TabBarPlatform, number]>([
    ['ios', 44],
    ['android', 48],
  ])('n’est jamais franchi sur %s, à AUCUN instant de l’animation', (platform, floor) => {
    for (let i = 0; i <= 100; i += 1) {
      const geometry = tabBarGeometry(i / 100, metrics(platform));
      expect(geometry.pressableHeight, `${platform} @ ${i}%`).toBeGreaterThanOrEqual(floor);
    }
  });

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
    // 78 + 2 × rythme extérieur (4) + 2 × bordure (1) = 88. Littéral : recomposer l'attendu avec
    // les constantes du module rendrait le test vert quelle que soit leur valeur.
    expect(big.pillMeasuredHeight).toBe(88);

    const small = tabBarGeometry(0, metrics('ios', { expandedContentHeight: 12 }));
    expect(small.innerVisualHeight).toBe(50);
    // Symétrique au repli : le plancher du visuel replié tient lui aussi.
    expect(tabBarGeometry(1, metrics('ios', { minimizedContentHeight: 8 })).innerVisualHeight).toBe(
      35,
    );
  });

  it('une mesure repliée PLUS HAUTE que l’étendue ne fait pas grandir la barre au repli', () => {
    // Rien ne garantit l'ordre d'arrivée des deux mesures `onLayout`. Sans le `Math.min` de
    // `tabBarGeometryBounds`, `visual[1]` (60) dépasserait `visual[0]` (50) et la barre
    // GRANDIRAIT en se repliant — un repli qui pousse est un repli faux.
    const bounds = tabBarGeometryBounds(
      metrics('ios', { expandedContentHeight: 50, minimizedContentHeight: 60 }),
    );
    expect(bounds.visual).toEqual([50, 50]);
    const collapsed = tabBarGeometry(
      1,
      metrics('ios', { expandedContentHeight: 50, minimizedContentHeight: 60 }),
    );
    expect(collapsed.innerVisualHeight).toBe(50);
    expect(collapsed.pillMeasuredHeight).toBe(52); // max(44, 50) + 2×0 + 2×1
  });

  it('deux onglets voisins ne se recouvrent pas : la largeur d’item divise EXACTEMENT le contenu', () => {
    /**
     * TABLE CALCULÉE À LA MAIN, fenêtre 390 pt, iOS, cinq onglets. Retrait latéral maximal
     * `min(34, (390 − 254)/2) = 34`, donc la course complète du socle :
     *   p = 0   → retrait 0  ; pilule 390 − 24 − 0  = 366 ; contenu 366 − 2 − 8 = 356 ; /5 = 71,2
     *   p = 0,5 → retrait 17 ; pilule 390 − 24 − 34 = 332 ; contenu 332 − 2 − 8 = 322 ; /5 = 64,4
     *   p = 1   → retrait 34 ; pilule 390 − 24 − 68 = 298 ; contenu 298 − 2 − 8 = 288 ; /5 = 57,6
     * L'attendu n'est plus `geometry.pillWidth − …` : c'était la fonction testée qui le
     * fabriquait, et une largeur de pilule fausse restait verte.
     */
    const table: readonly (readonly [number, number, number])[] = [
      [0, 366, 71.2],
      [0.5, 332, 64.4],
      [1, 298, 57.6],
    ];
    for (const [progress, pillWidth, itemWidth] of table) {
      const geometry = tabBarGeometry(progress, metrics('ios'));
      expect(geometry.pillWidth, `p=${progress}`).toBe(pillWidth);
      expect(geometry.itemWidth, `p=${progress}`).toBe(itemWidth);
      // Les cinq onglets pavent le contenu SANS trou ni recouvrement.
      expect(geometry.itemWidth * TABS, `p=${progress}`).toBe(pillWidth - 10);
    }
  });

  it('une progression hors [0, 1] ou NON FINIE est CLAMPÉE — jamais extrapolée', () => {
    const expanded = tabBarGeometry(0, metrics('ios'));
    const collapsed = tabBarGeometry(1, metrics('ios'));
    // Sans clamp, `p = 2` donnerait un visuel de 20 pt et un retrait de 68 pt par côté : une
    // pilule de 230 pt de large sur une fenêtre de 390.
    expect(tabBarGeometry(2, metrics('ios'))).toEqual(collapsed);
    expect(tabBarGeometry(-1, metrics('ios'))).toEqual(expanded);
    // `NaN` retombe sur 0, pas sur 1 : la barre s'ouvre, elle ne se replie pas dans le doute.
    expect(tabBarGeometry(Number.NaN, metrics('ios'))).toEqual(expanded);
    expect(tabBarGeometry(Number.POSITIVE_INFINITY, metrics('ios'))).toEqual(expanded);
  });

  it('une fenêtre ou un nombre d’onglets ABSURDES ne produisent pas de géométrie négative', () => {
    // Une largeur négative n'existe pas ; `useWindowDimensions` peut rendre 0 avant la première
    // mesure. La géométrie doit rester une géométrie, pas devenir un miroir.
    const empty = tabBarGeometry(0, metrics('ios', { windowWidth: -100 }));
    expect(empty.pillWidth).toBe(0);
    expect(empty.itemWidth).toBe(0);
    expect(empty.touchWidthHeld).toBe(false);
    // Une fenêtre trop étroite pour la bordure et le retrait de rangée : le contenu est plancheré
    // à 0, pas ramené à −6.
    expect(tabBarGeometry(0, metrics('ios', { windowWidth: 28 })).itemWidth).toBe(0);
    // Zéro onglet, c'est un onglet : jamais une division par zéro.
    const none = tabBarGeometry(0, metrics('ios', { tabCount: 0 }));
    expect(none.itemWidth).toBe(356);
    expect(Number.isFinite(none.itemWidth)).toBe(true);
    // Un nombre fractionnaire est PLANCHÉRÉ vers le bas : 5,7 onglets, c'est cinq onglets.
    expect(tabBarGeometry(0, metrics('ios', { tabCount: 5.7 })).itemWidth).toBe(71.2);
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

  // LES DEUX PLANCHERS SONT DES LITTÉRAUX. `touchTargetFloor(platform)` est la fonction qui
  // fournit ce plancher À LA GÉOMÉTRIE : s'en servir comme attendu comparerait A à A.
  it.each<[TabBarPlatform, number]>([
    ['ios', 44],
    ['android', 48],
  ])(
    'sur %s, `itemWidth ≥ CIBLE` sur 101 points de la course, à TOUTES les largeurs réelles',
    (platform, floor) => {
      for (const windowWidth of REAL_WIDTHS) {
        for (let i = 0; i <= 100; i += 1) {
          const geometry = tabBarGeometry(i / 100, metrics(platform, { windowWidth }));
          expect(geometry.touchWidthHeld, `${platform} ${windowWidth} @ ${i}%`).toBe(true);
          // Le `Pressable` est `flex: 1` : `itemWidth` EST sa largeur mesurée.
          expect(geometry.itemWidth, `${platform} ${windowWidth} @ ${i}%`).toBeGreaterThanOrEqual(
            floor,
          );
          // Et l'autre moitié du critère tient en même temps.
          expect(geometry.pressableHeight).toBeGreaterThanOrEqual(floor);
        }
      }
    },
  );

  /**
   * ─── LA TOLÉRANCE, ET CE QU'ELLE NE MASQUE PAS ────────────────────────────────────────────
   *
   * La comparaison ci-dessus n'accorde AUCUNE tolérance : sur des largeurs entières, l'arithmétique
   * est exacte, jusqu'au point exact où le clamp mord. C'est le témoin de ce que vaut réellement
   * `TOUCH_WIDTH_EPSILON` — une borne de bruit d'arrondi, pas un coussin de confort.
   */
  it('au point où le clamp MORD, la largeur d’onglet vaut EXACTEMENT la cible — pas 44 − ε', () => {
    // iOS, 280 pt : seuil 254, marge disponible 26, retrait rabotté à 13 par côté.
    // (280 − 24 − 2×13 − 2 − 8) / 5 = 220 / 5 = 44, en arithmétique exacte comme en IEEE-754.
    expect(tabBarGeometry(1, metrics('ios', { windowWidth: 280 })).itemWidth).toBe(44);
    // Android, 300 dp : seuil 274, marge 26, retrait 13. (300 − 24 − 26 − 10) / 5 = 48.
    expect(tabBarGeometry(1, metrics('android', { windowWidth: 300 })).itemWidth).toBe(48);
  });

  it('la tolérance est trop FINE pour masquer un manque réel — un millième de point le fait tomber', () => {
    // 273,995 dp : sous le seuil de 274, retrait déjà nul.
    // (273,995 − 24 − 2 − 8) / 5 = 239,995 / 5 = 47,999 — il manque UN MILLIÈME de point.
    const short = tabBarGeometry(1, metrics('android', { windowWidth: 273.995 }));
    expect(short.itemWidth).toBeCloseTo(47.999, 9);
    expect(short.touchWidthHeld).toBe(false);
    // Et la borne elle-même est mille milliards de fois sous le point : elle ne peut pas être
    // le lieu où une cible se perd.
    expect(TOUCH_WIDTH_EPSILON).toBe(1e-12);
    expect(TOUCH_WIDTH_EPSILON).toBeLessThan(0.001);
  });

  it('CE QUI CÈDE est le retrait latéral — nommément, et seulement lui', () => {
    // Écran large : rien ne cède, le retrait vaut les 34 pt du socle. Littéral, pas
    // `TAB_BAR_SIDE_INSET` : la constante est ce qu'on vérifie, pas ce avec quoi on vérifie.
    expect(affordableSideInset('ios', 390, 5)).toBe(34);
    expect(tabBarGeometry(1, metrics('ios', { windowWidth: 390 })).sideInset).toBe(34);

    // Écran étroit : il est RABOTÉ, exactement de ce qu'il faut et pas plus.
    expect(affordableSideInset('ios', 320, 5)).toBe(33);
    expect(affordableSideInset('android', 320, 5)).toBe(23);
    expect(affordableSideInset('android', 280, 5)).toBe(3);

    // Et la marge de safe area, elle, ne bouge JAMAIS : c'est l'autre grandeur horizontale, et
    // elle n'entre pas dans le troc. 12 pt à toutes les largeurs, littéral.
    for (const windowWidth of REAL_WIDTHS) {
      expect(tabBarGeometryBounds(metrics('android', { windowWidth })).margin).toBe(12);
    }
    expect(TAB_BAR_MARGIN).toBe(12);
    expect(TAB_BAR_SIDE_INSET).toBe(34);
  });

  it('une fenêtre NÉGATIVE ne fabrique pas de retrait, et un demi-onglet n’est pas un onglet', () => {
    // Sans le plancher à 0, `affordableSideInset('android', −200, 5)` rendrait un retrait
    // NÉGATIF : la pilule s'élargirait au repli au lieu de se resserrer.
    expect(affordableSideInset('android', -200, 5)).toBe(0);
    expect(affordableSideInset('android', 0, 5)).toBe(0);
    expect(tabBarGeometryBounds(metrics('android', { windowWidth: -200 })).windowWidth).toBe(0);
    // Le nombre d'onglets est plancheré à 1 et arrondi vers le bas — sinon `minimumWindowWidth`
    // rendrait un seuil sous la marge, et `itemWidth` diviserait par zéro.
    expect(minimumWindowWidth('android', 0)).toBe(274 - 4 * 48);
    expect(minimumWindowWidth('android', -3)).toBe(274 - 4 * 48);
    expect(minimumWindowWidth('android', 5.9)).toBe(274);
    expect(tabBarGeometryBounds(metrics('android', { tabCount: 0 })).tabCount).toBe(1);
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
    // Aucune largeur du parc réel ne s'y trouve — c'est plus étroit que tout écran vendu. Le
    // seuil est le LITTÉRAL 274, pas `minimumWindowWidth(…)` : un seuil faux rendrait cette
    // boucle verte en s'abaissant sous toutes les largeurs.
    for (const windowWidth of REAL_WIDTHS) {
      expect(windowWidth, `${windowWidth}`).toBeGreaterThanOrEqual(274);
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

  // LES DEUX SEUILS SONT DES LITTÉRAUX — 3 pt de zone morte, 24 pt de retour haut. Écrire
  // `300 + MINIMIZE_DEAD_ZONE + 1` déplacerait l'entrée AVEC la constante : une zone morte
  // portée à 30 pt resterait verte.
  it('minimise au-delà de la zone morte descendante, étend au-delà de la montante', () => {
    expect(MINIMIZE_DEAD_ZONE).toBe(3);
    expect(minimizeDecision({ ...base, contentOffsetY: 304 }).target).toBe(1);
    expect(minimizeDecision({ ...base, contentOffsetY: 296 }).target).toBe(0);
  });

  it('ne bouge à RIEN dans la zone morte — sinon la barre vibre au moindre tremblement', () => {
    // dy ∈ {−3, −1, 0, +1, +3} autour de `previousY = 300` : les bornes INCLUSES sont mortes.
    for (const y of [297, 299, 300, 301, 303]) {
      expect(minimizeDecision({ ...base, contentOffsetY: y }).target, `y=${y}`).toBeNull();
    }
  });

  it('force le dépli sous le seuil de retour haut, même en scrollant vers le bas', () => {
    expect(MINIMIZE_TOP_GUARD).toBe(24);
    // 23 pt : sous le seuil, et pourtant `dy = +23` — la garde prime sur la direction.
    expect(
      minimizeDecision({ contentHeight: 4000, layoutHeight: 800, previousY: 0, contentOffsetY: 23 })
        .target,
    ).toBe(0);
    // 24 pt exactement : la garde ne mord plus, et c'est la direction qui décide.
    expect(
      minimizeDecision({ contentHeight: 4000, layoutHeight: 800, previousY: 0, contentOffsetY: 24 })
        .target,
    ).toBe(1);
  });

  it('un offset NON FINI retombe sur 0 — la barre s’ouvre, elle ne se fige pas', () => {
    // `contentOffset.y` peut arriver `NaN` d'un pont natif. Sans la garde, `Math.min/max` le
    // propagerait : `y` vaudrait `NaN`, `dy` aussi, et AUCUNE des trois branches ne prendrait —
    // la barre resterait bloquée dans son dernier état, sans que rien ne le signale.
    for (const offset of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const decision = minimizeDecision({ ...base, contentOffsetY: offset });
      expect(decision.y, `${offset}`).toBe(0);
      expect(decision.target, `${offset}`).toBe(0);
    }
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
    // Fenêtre 390, iOS : pilule 366 étendue, 298 repliée (390 − 24 − 2×34), hauteurs 60 → 46.
    const expanded = tabBarGeometry(0, metrics('ios'));
    const collapsed = tabBarGeometry(1, metrics('ios'));
    expect(expanded.sideInset).toBe(0);
    expect(collapsed.sideInset).toBe(34);
    expect(expanded.pillWidth).toBe(366);
    expect(collapsed.pillWidth).toBe(298);
    expect(expanded.pillMeasuredHeight).toBe(60);
    expect(collapsed.pillMeasuredHeight).toBe(46);
  });

  it('recalcule `borderRadius = hauteur / 2` — une formule, jamais une constante', () => {
    /**
     * TABLE CALCULÉE À LA MAIN, Android (cible 48), fenêtre 390 :
     *   p      visuel = lerp(50,35,p)   Pressable = max(48, visuel)   rythme = lerp(4,0,p)
     *   0      50                        50                            4   → 60 mesurée → r 30
     *   0,25   46,25                     48                            3   → 56          → r 28
     *   0,5    42,5                      48                            2   → 54          → r 27
     *   0,75   38,75                     48                            1   → 52          → r 26
     *   1      35                        48                            0   → 50          → r 25
     * L'attendu n'est plus `geometry.pillMeasuredHeight / 2` : cette écriture-là redisait la
     * formule au lieu de la vérifier, et un rayon calculé sur la boîte INTÉRIEURE l'aurait passée.
     */
    const table: readonly (readonly [number, number, number])[] = [
      [0, 60, 30],
      [0.25, 56, 28],
      [0.5, 54, 27],
      [0.75, 52, 26],
      [1, 50, 25],
    ];
    for (const [progress, measured, radius] of table) {
      const geometry = tabBarGeometry(progress, metrics('android'));
      expect(geometry.pillMeasuredHeight, `p=${progress}`).toBe(measured);
      expect(geometry.borderRadius, `p=${progress}`).toBe(radius);
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
  /**
   * LES POSITIONS SONT DES LITTÉRAUX. Fenêtre 390, iOS, barre ÉTENDUE : largeur d'onglet 71,2
   * (voir la table du bloc « cible tactile »), retrait de rangée 4.
   *   index 0   → 4 + 0 × 71,2   = 4
   *   index 1   → 4 + 1 × 71,2   = 75,2
   *   index 1,5 → 4 + 1,5 × 71,2 = 110,8
   *   index 4   → 4 + 4 × 71,2   = 288,8
   * Écrire `TAB_BAR_ROW_PAD_H + geometry.itemWidth` faisait recalculer l'attendu PAR LA
   * GÉOMÉTRIE TESTÉE : une largeur d'onglet fausse restait verte.
   */
  it('se positionne par `translateX` pur, calculé depuis la largeur d’item', () => {
    const geometry = tabBarGeometry(0, metrics('ios'));
    expect(geometry.itemWidth).toBe(71.2);
    expect(highlightTranslateX(0, geometry)).toBe(4);
    expect(highlightTranslateX(1, geometry)).toBe(75.2);
    expect(highlightTranslateX(4, geometry)).toBe(288.8);
  });

  it('accepte une position CONTINUE — le highlight voyage, il ne saute pas d’onglet en onglet', () => {
    const geometry = tabBarGeometry(0, metrics('ios'));
    // 110,8 tombe exactement à mi-chemin entre 75,2 et 146,4 — le highlight est ENTRE deux
    // onglets, ce qu'un positionnement par index arrondi ne pourrait pas produire.
    expect(highlightTranslateX(1.5, geometry)).toBeCloseTo(110.8, 10);
    expect(highlightTranslateX(2, geometry)).toBeCloseTo(146.4, 10);
  });

  it('une position NON FINIE retombe sur l’onglet 0 — jamais un `translateX` NaN', () => {
    // Un `translateX` NaN ne lève pas : il fait DISPARAÎTRE le nœud, et l'indicateur s'évapore
    // sans un mot. La garde le ramène au premier onglet, qui est un état visible.
    const geometry = tabBarGeometry(0, metrics('ios'));
    expect(highlightTranslateX(Number.NaN, geometry)).toBe(4);
    expect(highlightTranslateX(Number.POSITIVE_INFINITY, geometry)).toBe(4);
  });

  it('suit la barre PENDANT qu’elle s’ouvre : la géométrie est recalculée live sur `progress`', () => {
    // Barre REPLIÉE : largeur d'onglet 57,6 → index 4 à 4 + 4 × 57,6 = 234,4, contre 288,8
    // étendue. Le highlight ne se contente pas de « bouger » : il bouge de 54,4 pt.
    const open = tabBarGeometry(0, metrics('ios'));
    const closed = tabBarGeometry(1, metrics('ios'));
    expect(closed.itemWidth).toBe(57.6);
    expect(highlightTranslateX(4, closed)).toBeCloseTo(234.4, 10);
    expect(highlightTranslateX(4, open)).toBe(288.8);
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
  /**
   * LES ABSCISSES SONT DES LITTÉRAUX. Barre ÉTENDUE, fenêtre 390, iOS : largeur d'onglet 71,2 ;
   * le contenu commence à `bordure + retrait de rangée` = 1 + 4 = 5 pt du bord MESURÉ.
   *   centre du 1er onglet  : 5 + 71,2/2       = 40,6   → index 0
   *   centre du 5e onglet   : 5 + 4,5 × 71,2   = 325,4  → index 4
   *   1,2 largeur d'onglet  : 5 + 1,2 × 71,2   = 90,44  → index 0,7
   *   1,3 largeur d'onglet  : 5 + 1,3 × 71,2   = 97,56  → index 0,8
   * Les entrées ne sont plus fabriquées avec `geometry.itemWidth` : une largeur d'onglet fausse
   * décalait l'ENTRÉE et l'ATTENDU en même temps, et le test restait vert.
   */
  const geometry = tabBarGeometry(0, metrics('ios'));

  it('rend 0 au centre du premier onglet et `tabCount − 1` au centre du dernier', () => {
    expect(tabIndexAtX(40.6, geometry, TABS)).toBeCloseTo(0, 10);
    expect(tabIndexAtX(325.4, geometry, TABS)).toBeCloseTo(4, 10);
  });

  it('reste BORNÉ aux onglets réels : le doigt qui sort de la pilule ne crée pas d’index fantôme', () => {
    expect(tabIndexAtX(-500, geometry, TABS)).toBe(0);
    expect(tabIndexAtX(5000, geometry, TABS)).toBe(4);
  });

  it('retranche la BORDURE en plus du retrait intérieur — la référence n’a pas de bordure', () => {
    // Si l’on recopiait `raw = (x − ROW_PAD_H) / itemWidth − 0.5` (l. 154 de la référence), le
    // mapping serait décalé d’exactement une bordure : (40,6 − 4) / 71,2 − 0,5 = 0,0140449…,
    // soit 1 pt en abscisse. Invisible à l’œil, faux à la mesure.
    const naif = (40.6 - 4) / 71.2 - 0.5;
    expect(naif).toBeCloseTo(0.0140449, 7);
    expect(tabIndexAtX(40.6, geometry, TABS)).toBeCloseTo(0, 10);
  });

  it('est CONTINU — mapping 1:1, aucun cran, aucun ressort pendant le drag', () => {
    expect(tabIndexAtX(90.44, geometry, TABS)).toBeCloseTo(0.7, 10);
    expect(tabIndexAtX(97.56, geometry, TABS)).toBeCloseTo(0.8, 10);
  });

  it('un index NON FINI retombe sur le premier onglet — jamais un index fantôme', () => {
    // Avant la première mesure de fenêtre, `itemWidth` vaut 0 et `contentX / 0` rend ±Infinity ;
    // un `x` non fini venu du pont de gestes fait de même. Sans la garde, `Math.min/max`
    // laisserait passer `NaN` (le highlight disparaît) ou le dernier onglet (il saute au bout).
    const flat = tabBarGeometry(0, metrics('ios', { windowWidth: 0 }));
    expect(flat.itemWidth).toBe(0);
    expect(tabIndexAtX(120, flat, TABS)).toBe(0);
    expect(tabIndexAtX(Number.NaN, geometry, TABS)).toBe(0);
    expect(tabIndexAtX(Number.POSITIVE_INFINITY, geometry, TABS)).toBe(0);
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

  it('en apparence SOMBRE, chaque rôle a sa source — et l’Assistant n’est pas l’encre neutre', () => {
    // Rien n'épinglait la palette sombre : n'importe lequel de ses six champs pouvait pointer
    // vers n'importe quelle autre encre du même ton sans qu'un test bouge. Les rôles
    // `navigation.*` sont des primitives d'apparence CLAIRE et n'ont RIEN à faire ici.
    const dark = tabTintPalette('dark');
    expect(dark.active).toBe(surfaceTint.dark.neutral.ink);
    expect(dark.assistantActive).toBe(surfaceTint.dark.ai.ink);
    expect(dark.inactive).toBe(surfaceTint.dark.neutral.inkMuted);
    expect(dark.pill).toBe(surfaceTint.dark.neutral.flat);
    expect(dark.highlight).toBe(surfaceTint.dark.neutral.raised);
    expect(dark.border).toBe(surfaceTint.dark.neutral.border);
    // Les trois encres sont DISTINCTES : une palette qui les confond éteint le comportement 6.
    expect(new Set([dark.active, dark.assistantActive, dark.inactive]).size).toBe(3);
    // Et aucune primitive d'apparence claire n'a fui dans la palette sombre.
    expect(dark.active).not.toBe(resolveColorRole('navigation.active'));
    expect(dark.inactive).not.toBe(resolveColorRole('navigation.inactive'));
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

  it('BORNE la position de mélange : hors [0, 1] ou non finie, la couleur reste une couleur', () => {
    // La proximité arrive d'une valeur partagée pilotée par un RESSORT sous-amorti : elle
    // dépasse 1 en fin de course, et un pont natif peut la rendre `NaN`.
    //
    // DEUX BORNES DIFFÉRENTES, et il faut les distinguer : le DÉPASSEMENT est rattrapé par le
    // clamp de composante de `toHex` (0..255), qui suffirait seul ; le NON FINI, lui, ne l'est
    // que par `clamp01`. Sans lui, `lerp(a, b, NaN)` rend `NaN`, `NaN.toString(16)` rend « NaN »
    // et la couleur peinte devient `#NANNANNAN` — une chaîne que la plateforme ne sait pas lire.
    expect(mixTint('#000000', '#FFFFFF', 1.5)).toBe('#FFFFFF');
    expect(mixTint('#000000', '#FFFFFF', -0.5)).toBe('#000000');
    expect(mixTint('#0C2340', '#5B6B7B', Number.NaN)).toBe('#0C2340');
    expect(mixTint('#0C2340', '#5B6B7B', Number.POSITIVE_INFINITY)).toBe('#0C2340');
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
   * dérive, resserrer en deçà rendrait rouge un couple parfaitement conforme.
   *
   * CE QUE CETTE TABLE ÉPINGLE, vérifié en appliquant chaque mutation : l'exposant `2,4`, les
   * trois coefficients, la paire `0,055 / 1,055`, le `+ 0,05` du rapport. CE QU'ELLE N'ÉPINGLE
   * PAS : la BRANCHE LINÉAIRE (`s / 12,92`), qu'aucune couleur de la table n'atteint — le canal
   * le plus sombre de la palette est le `0x0C` de `#0C2340`, au-dessus du genou. Le test de sonde
   * ci-dessous l'atteint ; le seuil `0,03928`, lui, reste hors de portée (voir la note du
   * fichier de logique : la fonction de transfert sRGB est CONTINUE au genou).
   */
  const C4_TOLERANCE = 0.011;

  it('ATTEINT la branche linéaire du calcul WCAG, que la table A23 ne touche jamais', () => {
    /**
     * SONDE `#0A0A0A` — canal 10, donc 10/255 = 0,039215… ≤ 0,03928 : la branche LINÉAIRE.
     *   luminance = (0,2126 + 0,7152 + 0,0722) × (10/255) / 12,92 = 0,0030352698354883…
     *   blanc     = 1 (les trois coefficients somment à 1, et (1 + 0,055)/1,055 = 1)
     *   rapport   = (1 + 0,05) / (0,0030352698354883 + 0,05) = 19,79814571052481
     * Un `/ 12,92` devenu `/ 12` rendrait 19,7116… — 0,087 d'écart, très au-dessus de la
     * tolérance ci-dessous.
     */
    expect(contrastRatio('#0A0A0A', '#FFFFFF')).toBeCloseTo(19.79814571052481, 10);
    // Le témoin des deux bouts : noir sur blanc vaut EXACTEMENT 21, la borne du barème WCAG.
    expect(contrastRatio('#000000', '#FFFFFF')).toBe(21);
    // Et le rapport est SYMÉTRIQUE : c'est le plus clair qui passe au numérateur, pas le premier
    // argument. Sans le tri, `contrastRatio(blanc, noir)` rendrait 1/21.
    expect(contrastRatio('#FFFFFF', '#000000')).toBe(21);
  });

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

  /**
   * ─── L'ÉCHANTILLONNAGE EST LA RAISON D'ÊTRE DE `sampleTintCourse` : ON LE VÉRIFIE ────────
   *
   * La boucle « tous les échantillons sont AA » ne regarde QUE les échantillons rendus. Elle
   * restait donc verte si la fonction n'en rendait que DEUX (les extrémités) ou n'en rendait
   * qu'un FOND sur deux — c'est-à-dire exactement les deux dimensions que le § 6 exige et que la
   * documentation de la fonction revendique. Les deux mutations le confirmaient : l'une et
   * l'autre survivaient. Ce test-ci les tue, et il doit passer AVANT la preuve AA.
   */
  it('échantillonne RÉELLEMENT toute la course, et sur les DEUX fonds', () => {
    const palette = tabTintPalette('light');
    const samples = sampleTintCourse(palette, palette.active, 200);
    // 201 positions × 2 fonds = 402 échantillons. Un « 200 » ignoré en rendrait 4.
    expect(samples).toHaveLength(402);
    const positions = [...new Set(samples.map((sample) => sample.t))];
    expect(positions).toHaveLength(201);
    expect(positions[0]).toBe(0);
    expect(positions[200]).toBe(1);
    expect(positions[100]).toBe(0.5);
    // LES DEUX FONDS, à CHAQUE position — pas la pilule seule.
    expect([...new Set(samples.map((sample) => sample.background))].sort()).toEqual(
      [palette.highlight, palette.pill].sort(),
    );
    for (const t of [0, 0.5, 1]) {
      const at = samples.filter((sample) => sample.t === t);
      expect(at.map((sample) => sample.background), `t=${t}`).toEqual([
        palette.pill,
        palette.highlight,
      ]);
    }
    // La COULEUR bouge le long de la course : aux deux bouts ce sont les deux teintes, au milieu
    // leur mélange sRGB — sinon « échantillonner la course » ne voudrait rien dire.
    expect(samples[0]?.color).toBe(palette.inactive);
    expect(samples[400]?.color).toBe(palette.active);
    expect(samples[200]?.color).toBe(mixTint(palette.inactive, palette.active, 0.5));
    expect(samples[200]?.color).not.toBe(palette.inactive);
    // Un nombre de pas absurde ne fabrique ni division par zéro ni tableau vide.
    expect(sampleTintCourse(palette, palette.active, 0)).toHaveLength(4);
    expect(sampleTintCourse(palette, palette.active, -7)).toHaveLength(4);
  });

  it.each(['light', 'dark'] as const)(
    'reste AA sur TOUTE la course et sur les DEUX fonds, en apparence %s',
    (appearance) => {
      const palette = tabTintPalette(appearance);
      for (const target of [palette.active, palette.assistantActive]) {
        const samples = sampleTintCourse(palette, target, 200);
        expect(samples).toHaveLength(402);
        for (const sample of samples) {
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
    // LE CAS QUI DÉMASQUE LA GARDE : un label VIDE dans un onglet de largeur nulle. Sans le
    // `!(availableWidth > 0)`, `0 ≤ 0` serait vrai et la barre annoncerait « une ligne » pour un
    // onglet qui n'a pas un point de large.
    expect(
      resolveTabLabelTier({ naturalWidth: 0, longestWordWidth: 0, availableWidth: 0 }),
    ).toBe('icon-only');
    // Une largeur NÉGATIVE (mesure aberrante) ne rouvre pas la porte non plus.
    expect(
      resolveTabLabelTier({ naturalWidth: 0, longestWordWidth: 0, availableWidth: -12 }),
    ).toBe('icon-only');
  });

  it('le MOT LE PLUS LONG est bien le plus long — et un trait d’union n’est pas une coupure', () => {
    /**
     * `longestWord` n'était appelée par AUCUN test, alors qu'elle décide seule du rang
     * « icônes seules » : c'est elle qui alimente la sonde de mesure du mot dans
     * `bob-tab-bar.tsx`. Une version qui rendrait le PREMIER mot passait inaperçue.
     */
    expect(longestWord('Aujourd’hui')).toBe('Aujourd’hui');
    expect(longestWord('Mes documents')).toBe('documents');
    expect(longestWord('Fin de mois')).toBe('mois');
    // Découpage sur les BLANCS uniquement. Les traits d'union ne sont pas des points de coupure
    // garantis d'une plateforme à l'autre : les traiter comme tels rendrait la mesure OPTIMISTE,
    // donc fausse dans le sens qui TRONQUE — « Sous-traitance » compte pour un seul mot.
    expect(longestWord('Sous-traitance TVA')).toBe('Sous-traitance');
    // Les blancs multiples, les tabulations et les bords ne fabriquent pas de mot vide.
    expect(longestWord('  Argent \t net  ')).toBe('Argent');
    expect(longestWord('')).toBe('');
    expect(longestWord('   ')).toBe('');
    // À longueur ÉGALE, le premier gagne — c'est arbitraire, mais c'est déterministe et dit.
    expect(longestWord('abc xyz')).toBe('abc');
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
