/**
 * BobTabBar — LOGIQUE PURE du portage de la tab bar
 * (04 § Comportement normatif de la tab bar, l. 191-641). Aucun import React / React Native /
 * Reanimated / Gesture Handler : tout se teste sans monter un arbre et sans pont natif.
 *
 * CE QUE CE FICHIER EST. La barre porte SIX comportements, et le socle écrit qu'en livrer cinq
 * ne suffit pas. Cinq d'entre eux reposent sur des NOMBRES qui se calculent avant tout pixel :
 * la géométrie du repli, la position du highlight, l'index sous le doigt, le franchissement de
 * frontière, la distance au highlight qui pilote la teinte. Ces nombres vivent ici, seuls,
 * testés séparément du rendu — patron déjà en place dans ce paquet
 * (`bob-surface.logic`, `progressive-blur-bob.logic`).
 *
 * ─── CE QU'ON REPREND DE LA RÉFÉRENCE, ET CE QU'ON REFUSE ────────────────────────────────
 * Référence de COMPORTEMENT : `davidmokos/expo-glass-tabs` (`src/glass-tab-bar.tsx` 438 l.,
 * `src/minimize-context.tsx` 88 l.). On reprend sa TECHNIQUE — progression partagée 0..1,
 * ressort reciblé qui préserve la vélocité, recentrage no-op quand on va déjà vers la cible,
 * `lastTicked` qui ne tick qu'au FRANCHISSEMENT, interpolation pilotée par la position du
 * highlight et non par le focus.
 *
 * On refuse quatre choses, et chacune est un défaut identifié, pas un goût :
 *  1. `MINIMIZED_HEIGHT = 44` (l. 34 de la référence). 44 est une valeur **iOS**. La copier
 *     poserait une cible de 44 dp sur Android, SOUS le plancher de 48 dp — c'est exactement le
 *     défaut que le socle a corrigé (§ Cibles tactiles, A28). Ici la hauteur repliée n'est pas
 *     une constante : elle se DÉDUIT de la cible, `max(CIBLE, visuel intérieur)`.
 *  2. `expo-haptics` (l. 2, l. 130) — absent du dépôt, `UX-ADR-006` encore `Proposed`. Le tick
 *     passe par un PORT INJECTÉ (`bob-tab-bar.haptics.ts`), absent par défaut.
 *  3. Le verre système. Notre pilule est un aplat opaque de `@bob/tokens` : aucune couleur n'est
 *     écrite ici en dur, toutes sortent de `surfaceTint` et de `resolveColorRole`.
 *  4. Ses manques d'accessibilité — une seule mention en 438 lignes. Reduce Motion, lecteur
 *     d'écran, Dynamic Type et fenêtre de préférence INCONNUE sont des ajouts, pas des copies.
 *
 * ─── LES DEUX RESSORTS, ET POURQUOI ILS NE SONT PAS DANS `@bob/tokens` ───────────────────
 * [03 § Ajouts nécessaires au portage de la tab bar](03-motion-interaction-system.md) les nomme
 * `motionSemantic.springMinimize` et `motionSemantic.springSlide`. Ils ne sont PAS ajoutés au
 * paquet de tokens par ce lot, et ce n'est pas un oubli : `packages/tokens/src/tokens-parity.test.ts`
 * impose la parité STRICTE avec la référence figée du handoff (contrat C01) et fait échouer
 * toute donnée ajoutée hors référence. Promouvoir ces deux ressorts amende donc le handoff —
 * un acte de gouvernance (`UX-ADR-002`), pas une décision d'auteur de composant. Ils vivent ici,
 * nommés, avec leur autorité citée, jusqu'à cette promotion.
 */
import {
  motionSemantic,
  patterns,
  resolveColorRole,
  surfaceTint,
  type SurfaceTintAppearance,
} from '@bob/tokens';
import { ASSISTANT_TAB_KEY } from './bottom-tab-bar.logic';

/** Clé réservée de l'onglet Assistant — RÉ-EXPORTÉE depuis la barre livrée, jamais redéfinie. */
export { ASSISTANT_TAB_KEY };

// ────────────────────────────────────────────────────────────────────────────────────────────
// PLATEFORME ET CIBLE TACTILE — le seul plancher absolu du fichier
// ────────────────────────────────────────────────────────────────────────────────────────────

export type TabBarPlatform = 'ios' | 'android';

/**
 * CIBLE = 44 pt (iOS) / 48 dp (Android). Plancher ABSOLU
 * ([08 § Cibles tactiles](08-accessibility-adaptive-design.md), 04 § Cibles tactiles et Dynamic
 * Type) : il ne rétrécit pas avec le visuel, il ne s'échelonne pas avec le texte, et il ne se
 * complète par AUCUN `hitSlop`.
 *
 * POURQUOI PAS UN `hitSlop` — la raison est mécanique, pas doctrinale. La recherche de cible
 * n'entre dans un enfant que si le point est DÉJÀ dans les bornes de l'ancêtre : Android
 * (`TouchTargetHelper.findTouchTargetView` n'élargit du `hitSlop` que l'enfant testé, jamais ses
 * ancêtres) comme iOS (`hitTest:` s'arrête au premier `pointInside:` faux d'une superview). Un
 * `hitSlop` qui déborde la pilule n'est donc jamais dispatché. La cible est tenue par la
 * HAUTEUR MESURÉE du `Pressable`, et par rien d'autre.
 */
export const TAB_BAR_TOUCH_TARGET: Readonly<Record<TabBarPlatform, number>> = Object.freeze({
  ios: 44,
  android: 48,
});

export function touchTargetFloor(platform: TabBarPlatform): number {
  return TAB_BAR_TOUCH_TARGET[platform];
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// GÉOMÉTRIE — 04 § 1 et § Cibles tactiles et Dynamic Type
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Visuel intérieur (capsule de highlight + bloc icône/label) à la taille de texte STANDARD. */
export const TAB_BAR_EXPANDED_VISUAL = 50;
export const TAB_BAR_MINIMIZED_VISUAL = 35;
/** Rythme EXTÉRIEUR : c'est LUI qui s'anime entre la pilule et le `Pressable`, jamais la cible. */
export const TAB_BAR_OUTER_RHYTHM = 4;
/** Bordure de la pilule — notre identité, absente de la référence, d'où l'écart de 2 pt. */
export const TAB_BAR_BORDER_WIDTH = 1;
/** Retrait latéral ANIMÉ, par côté, au repli. Grandeur horizontale : le texte ne la concerne pas. */
export const TAB_BAR_SIDE_INSET = 34;
/** Marge extérieure entre la pilule et les bords d'écran, par côté. Reprise telle quelle. */
export const TAB_BAR_MARGIN = 12;
/** Retrait intérieur entre la paroi de la capsule et les onglets. */
export const TAB_BAR_ROW_PAD_H = 4;
/** Calcul de safe area repris tel quel de la référence : `max(inset bas − 16, 12)`. */
export const TAB_BAR_SAFE_AREA_TRIM = 16;
export const TAB_BAR_MIN_BOTTOM = 12;
/** Débord de la retombée au-dessus de la pilule — token livré, jamais un chiffre libre. */
export const TAB_BAR_BLEED: number = patterns.edgeFalloff.bleed;

/**
 * MESURES D'ENTRÉE de la géométrie. Les deux hauteurs de contenu sont des PLANCHERS à la taille
 * de texte standard, jamais des hauteurs figées ([08 § Typographie](08-accessibility-adaptive-design.md),
 * règle A19) : à 200 % le contenu mesuré les dépasse et c'est lui qui gagne.
 */
export interface TabBarMetrics {
  readonly platform: TabBarPlatform;
  readonly windowWidth: number;
  readonly tabCount: number;
  /** Hauteur MESURÉE du contenu d'onglet étendu (icône + rythme + label). Plancher : 50 pt. */
  readonly expandedContentHeight?: number;
  /** Hauteur MESURÉE du contenu d'onglet replié (icône seule + rythme intérieur). Plancher : 35 pt. */
  readonly minimizedContentHeight?: number;
}

/**
 * BORNES de la géométrie : les deux extrémités de chaque grandeur interpolée, plus les
 * invariants. C'est CE QUE LE WORKLET CAPTURE — il ne calcule que la composition (`max`, `+`,
 * `/`), jamais un nombre. Aucune constante n'est donc recopiée dans un thread où personne ne
 * pourrait la relire.
 */
export interface TabBarGeometryBounds {
  /** Visuel intérieur : [étendu, replié]. */
  readonly visual: readonly [number, number];
  /** Rythme extérieur : [4, 0]. */
  readonly rhythm: readonly [number, number];
  /** Retrait latéral : [0, 34]. */
  readonly sideInset: readonly [number, number];
  readonly touchFloor: number;
  readonly borderWidth: number;
  readonly rowPadH: number;
  readonly margin: number;
  readonly windowWidth: number;
  readonly tabCount: number;
}

/** Géométrie RÉSOLUE à un `progress` donné. Toutes les valeurs sont en points. */
export interface TabBarGeometry {
  /** Hauteur du VISUEL intérieur — dessiné DANS le `Pressable`, il ne le redimensionne jamais. */
  readonly innerVisualHeight: number;
  /** Hauteur du `Pressable` : `max(CIBLE, visuel)`. C'est ELLE qui porte la cible tactile. */
  readonly pressableHeight: number;
  readonly outerRhythm: number;
  /** Boîte INTÉRIEURE de la pilule (padding-box) : `pressable + 2 × rythme`. */
  readonly pillInnerHeight: number;
  /** Rectangle MESURÉ de la pilule (border-box) : ce que rend `measure()`. */
  readonly pillMeasuredHeight: number;
  /** Écart vertical entre le bord mesuré de la pilule et celui du `Pressable`, de chaque côté. */
  readonly pillToPressableGap: number;
  readonly sideInset: number;
  /** Largeur mesurée de la pilule (border-box). */
  readonly pillWidth: number;
  /** Largeur d'un onglet — CALCULÉE, jamais mesurée : aucune frame de retard, aucun saut. */
  readonly itemWidth: number;
  /** `borderRadius = hauteur / 2`, recalculé à chaque frame : une formule, pas une constante. */
  readonly borderRadius: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * BORNES de la géométrie pour des métriques données. Les hauteurs de contenu mesurées ne
 * peuvent que POUSSER les planchers vers le haut — jamais les abaisser : une spec qui écrit
 * « 50 pt » et un composant qui écrit `height: 50` ne disent pas la même chose, et le second
 * est un défaut (08 § Typographie, A19).
 */
export function tabBarGeometryBounds(metrics: TabBarMetrics): TabBarGeometryBounds {
  const expanded = Math.max(metrics.expandedContentHeight ?? 0, TAB_BAR_EXPANDED_VISUAL);
  const minimized = Math.max(metrics.minimizedContentHeight ?? 0, TAB_BAR_MINIMIZED_VISUAL);
  return Object.freeze({
    // Le visuel replié ne dépasse jamais le visuel étendu : à 200 %, un label sur deux lignes
    // fait grandir l'étendu, pas le replié — mais rien ne garantit l'ordre des deux MESURES.
    visual: [expanded, Math.min(minimized, expanded)] as const,
    rhythm: [TAB_BAR_OUTER_RHYTHM, 0] as const,
    sideInset: [0, TAB_BAR_SIDE_INSET] as const,
    touchFloor: touchTargetFloor(metrics.platform),
    borderWidth: TAB_BAR_BORDER_WIDTH,
    rowPadH: TAB_BAR_ROW_PAD_H,
    margin: TAB_BAR_MARGIN,
    windowWidth: Math.max(metrics.windowWidth, 0),
    tabCount: Math.max(Math.floor(metrics.tabCount), 1),
  });
}

/**
 * LA GÉOMÉTRIE, à un `progress` donné (0 = étendu, 1 = replié). C'est l'implémentation
 * NORMATIVE des cinq lignes du socle :
 *
 *   CIBLE            = 44 pt (iOS) | 48 dp (Android)
 *   hauteurPressable = max(CIBLE, hauteurVisuelIntérieur)
 *   rythmeExtérieur  = interpolation de `progress`, 4 → 0 pt
 *   hauteurPilule    = hauteurPressable + 2 × rythmeExtérieur      (boîte INTÉRIEURE)
 *   hauteurMesurée   = hauteurPilule + 2 × épaisseurBordure        (ce que rend `measure()`)
 *
 * `pressableHeight` n'est PAS l'interpolation de ses deux extrémités, et c'est le piège :
 * `max` d'une droite et d'une constante est affine PAR MORCEAUX. À `progress = 0,5`,
 * `lerp(50, 44)` vaut 47 quand `max(44, lerp(50, 35))` vaut 44. Le worklet applique donc le
 * `max`, il n'interpole pas les bouts — et un test le vérifie sur toute la course.
 */
export function tabBarGeometry(progress: number, metrics: TabBarMetrics): TabBarGeometry {
  const bounds = tabBarGeometryBounds(metrics);
  const p = clamp01(progress);
  const innerVisualHeight = lerp(bounds.visual[0], bounds.visual[1], p);
  const pressableHeight = Math.max(bounds.touchFloor, innerVisualHeight);
  const outerRhythm = lerp(bounds.rhythm[0], bounds.rhythm[1], p);
  const pillInnerHeight = pressableHeight + 2 * outerRhythm;
  const pillMeasuredHeight = pillInnerHeight + 2 * bounds.borderWidth;
  const sideInset = lerp(bounds.sideInset[0], bounds.sideInset[1], p);
  const pillWidth = Math.max(bounds.windowWidth - 2 * bounds.margin - 2 * sideInset, 0);
  const contentWidth = Math.max(pillWidth - 2 * bounds.borderWidth - 2 * bounds.rowPadH, 0);
  return Object.freeze({
    innerVisualHeight,
    pressableHeight,
    outerRhythm,
    pillInnerHeight,
    pillMeasuredHeight,
    // L'écart mesuré de part et d'autre vaut `rythmeExtérieur + épaisseurBordure` — 5 pt étendu,
    // 1 pt replié. Il n'est JAMAIS nul : la bordure est comptée dans le rectangle de la pilule.
    pillToPressableGap: outerRhythm + bounds.borderWidth,
    sideInset,
    pillWidth,
    itemWidth: contentWidth / bounds.tabCount,
    borderRadius: pillMeasuredHeight / 2,
  });
}

/**
 * Hauteur d'enveloppe de la RETOMBÉE (§ 4). Dimensionnée UNE FOIS sur l'état le PLUS HAUT du
 * chrome — le repli se produit À L'INTÉRIEUR de l'enveloppe. Une enveloppe recalculée par frame
 * serait une animation de layout par frame, que la règle « jamais animée » interdit.
 */
export function tabBarBottomOffset(safeAreaBottom: number): number {
  return Math.max(safeAreaBottom - TAB_BAR_SAFE_AREA_TRIM, TAB_BAR_MIN_BOTTOM);
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// 1 · MINIMIZE-ON-SCROLL — la signature de la barre
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Ressort du repli/dépli : CRITIQUE-AMORTI, parce qu'il anime de la LAYOUT (03 § Ajouts). */
export const TAB_BAR_MINIMIZE_SPRING = Object.freeze({ duration: 380, dampingRatio: 1 });
/** Ressort du highlight : légèrement SOUS-AMORTI, sans danger car transform-only (03 § Ajouts). */
export const TAB_BAR_SLIDE_SPRING = Object.freeze({ duration: 420, dampingRatio: 0.82 });

/** Sous cette hauteur de scroll, la barre est TOUJOURS étendue — retour haut forcé. */
export const MINIMIZE_TOP_GUARD = 24;
/** Zone morte : entre −3 et +3, rien ne bouge. Sans elle la barre vibre au moindre tremblement. */
export const MINIMIZE_DEAD_ZONE = 3;

export interface MinimizeScrollInput {
  readonly contentOffsetY: number;
  readonly contentHeight: number;
  readonly layoutHeight: number;
  readonly previousY: number;
}

export interface MinimizeScrollDecision {
  /** Offset CLAMPÉ — c'est lui qu'on mémorise, jamais l'offset brut. */
  readonly y: number;
  /** Cible du ressort, ou `null` quand la zone morte dit « rien ne bouge ». */
  readonly target: 0 | 1 | null;
}

/**
 * DÉCISION DE REPLI, sur le thread UI, sans aucun `setState`.
 *
 * Le CLAMP n'est pas de la coquetterie défensive : sans lui, le rubber-band d'overscroll
 * inverse le signe de `dy` le temps d'une frame et fait CLIGNOTER la barre. C'est la raison que
 * la référence donne (`minimize-context.tsx` l. 63-66) et elle est bonne.
 */
export function minimizeDecision(input: MinimizeScrollInput): MinimizeScrollDecision {
  const maxY = Math.max(input.contentHeight - input.layoutHeight, 0);
  const raw = Number.isFinite(input.contentOffsetY) ? input.contentOffsetY : 0;
  const y = Math.min(Math.max(raw, 0), maxY);
  const dy = y - input.previousY;
  if (y < MINIMIZE_TOP_GUARD) return { y, target: 0 };
  if (dy > MINIMIZE_DEAD_ZONE) return { y, target: 1 };
  if (dy < -MINIMIZE_DEAD_ZONE) return { y, target: 0 };
  return { y, target: null };
}

/**
 * RECIBLAGE NO-OP — la seule ligne qui empêche le stutter. Sans elle, chaque frame de scroll
 * relance le ressort vers la même cible et l'animation redémarre en permanence. La référence
 * l'appelle `target` (`minimize-context.tsx` l. 54-60) ; c'est le détail qui fait la différence
 * entre « ça marche » et « c'est fluide ».
 */
export function shouldRetargetMinimize(currentTarget: number, next: 0 | 1): boolean {
  return currentTarget !== next;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// 2 · HIGHLIGHT GLISSANT · 3 · SCRUB — géométrie du doigt et de la pilule
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Seuils du pan : au-delà de 6 pt horizontaux le pan gagne ; au-delà de 14 pt verticaux il échoue. */
export const SCRUB_ACTIVE_OFFSET_X = 6;
export const SCRUB_FAIL_OFFSET_Y = 14;
/** Seuils du tap : la tolérance par défaut (~2 pt) fait échouer les taps de vrais doigts. */
export const SCRUB_TAP_MAX_DISTANCE = 16;
export const SCRUB_TAP_MAX_DURATION = 400;

/**
 * INDEX SOUS LE DOIGT, à partir d'un `x` relatif au rectangle MESURÉ de la pilule. Continu, pas
 * arrondi : le highlight suit le doigt 1:1, sans ressort pendant le drag — il doit se sentir
 * ATTACHÉ. L'arrondi n'intervient qu'au tick et au relâchement.
 *
 * ÉCART ASSUMÉ AVEC LA RÉFÉRENCE : elle retranche `ROW_PAD_H` seul (l. 154) parce que sa barre
 * n'a pas de bordure. La nôtre en a une (identité Bob) et `x` est relatif à la BORDER-BOX : on
 * retranche donc `bordure + rowPadH`. Sans ce terme, le mapping du doigt serait décalé d'un
 * point sur toute la course — invisible à l'œil, faux à la mesure.
 */
export function tabIndexAtX(x: number, geometry: TabBarGeometry, tabCount: number): number {
  const count = Math.max(Math.floor(tabCount), 1);
  if (!(geometry.itemWidth > 0)) return 0;
  const contentX = x - TAB_BAR_BORDER_WIDTH - TAB_BAR_ROW_PAD_H;
  const raw = contentX / geometry.itemWidth - 0.5;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(Math.max(raw, 0), count - 1);
}

/** Position du bloc de highlight — `translateX` TRANSFORM-ONLY : zéro travail de layout par frame. */
export function highlightTranslateX(slideIndex: number, geometry: TabBarGeometry): number {
  const index = Number.isFinite(slideIndex) ? slideIndex : 0;
  return TAB_BAR_ROW_PAD_H + geometry.itemWidth * index;
}

/**
 * FRANCHISSEMENT DE FRONTIÈRE — le tick haptique se déclenche ICI, jamais par frame.
 * Rend l'index à ticker, ou `null` si le doigt n'a franchi aucune frontière depuis le dernier.
 */
export function boundaryTick(lastTicked: number, slideIndex: number): number | null {
  const rounded = Math.round(slideIndex);
  return rounded === lastTicked ? null : rounded;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// 6 · TEINTE PILOTÉE PAR LE HIGHLIGHT — l'EFFET, celui qu'un backlog laisse tomber en dernier
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * PROXIMITÉ AU HIGHLIGHT : `1 − min(|position du highlight − index|, 1)`. Un crossfade linéaire
 * sur exactement UNE largeur d'onglet, et AUCUN booléen de focus n'y intervient.
 *
 * C'est ce qui fait VOYAGER la lumière au lieu de la commuter : pendant un scrub les icônes
 * s'allument au passage du doigt ; sur un tap, la teinte accompagne l'indicateur.
 */
export function highlightProximity(slideIndex: number, index: number): number {
  if (!Number.isFinite(slideIndex) || !Number.isFinite(index)) return 0;
  return 1 - Math.min(Math.abs(slideIndex - index), 1);
}

/**
 * PALETTE DE LA BARRE, par apparence. Aucun hex n'est écrit ici : tout sort de `@bob/tokens`.
 *
 * En apparence CLAIRE ce sont exactement les rôles livrés et certifiés de
 * `bottom-tab-bar.logic.ts` — `navigation.active`, `navigation.assistantActive`,
 * `navigation.inactive` — sur la pilule `surfaceTint.light.neutral.flat` (`#FFFFFF`, la même
 * valeur que `colors.surface`). Rien n'est revalorisé.
 *
 * LE HIGHLIGHT EST UNE CONTRAINTE DE CONTRASTE, PAS UN GOÛT (04 § 2, A23). Il passe SOUS les
 * labels, y compris sous des labels encore inactifs : il devient donc un FOND DE TEXTE, et les
 * trois rôles doivent y rester AA. `neutral.raised` est retenu parce qu'il est, parmi les tons
 * qui tiennent AA, celui qui se VOIT le plus sur la pilule (1,165:1 contre 1,075:1 pour
 * `marine.flat`) : `#EAEEF3` laisse `navigation.inactive` à 4,70:1. `marine.raised` `#E2E9F2`,
 * qu'une rédaction antérieure du socle donnait en exemple, tombe à 4,48:1 — sous AA. Le choix
 * final appartient à `UX-ADR-002`/`D07` ; ce fichier tient la contrainte, il ne tranche pas
 * l'esthétique.
 */
export interface TabTintPalette {
  readonly active: string;
  readonly assistantActive: string;
  readonly inactive: string;
  /** Fond de la pilule. */
  readonly pill: string;
  /** Fond de la capsule de highlight — aplat OPAQUE, jamais un voile translucide. */
  readonly highlight: string;
  readonly border: string;
}

export function tabTintPalette(appearance: SurfaceTintAppearance): TabTintPalette {
  const neutral = surfaceTint[appearance].neutral;
  if (appearance === 'dark') {
    // Les rôles `navigation.*` sont des primitives d'apparence CLAIRE : sur une pilule navy ils
    // seraient illisibles. En apparence sombre on prend les encres LIVRÉES du même ton, déjà
    // certifiées AA sur ces fonds — et le test d'échantillonnage le re-prouve sur la course.
    return Object.freeze({
      active: neutral.ink,
      assistantActive: surfaceTint.dark.ai.ink,
      inactive: neutral.inkMuted,
      pill: neutral.flat,
      highlight: neutral.raised,
      border: neutral.border,
    });
  }
  return Object.freeze({
    active: resolveColorRole('navigation.active'),
    assistantActive: resolveColorRole('navigation.assistantActive'),
    inactive: resolveColorRole('navigation.inactive'),
    pill: neutral.flat,
    highlight: neutral.raised,
    border: neutral.border,
  });
}

/**
 * Couleur d'ARRIVÉE de la course de teinte pour un onglet : la règle Bob propre à l'Assistant
 * (indigo IA) n'a aucun équivalent dans la référence et doit SURVIVRE à l'interpolation. La clé
 * réservée est celle de la barre LIVRÉE — on la consomme, on n'en recopie pas la valeur.
 */
export function tabActiveTint(key: string, palette: TabTintPalette): string {
  return key === ASSISTANT_TAB_KEY ? palette.assistantActive : palette.active;
}

// ── Contraste : on ÉCHANTILLONNE la course, on ne la déduit pas ─────────────────────────────

function channels(hex: string): readonly [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
  const part = (v: number): string =>
    Math.round(Math.min(Math.max(v, 0), 255))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * Mélange sRGB composante par composante — EXACTEMENT ce que fait `interpolateColor` de
 * Reanimated dans son espace par défaut (`RGB`). On échantillonne donc la couleur RÉELLEMENT
 * peinte, pas une approximation perceptuelle qui dirait autre chose.
 */
export function mixTint(from: string, to: string, t: number): string {
  const a = channels(from);
  const b = channels(to);
  const clamped = clamp01(t);
  return toHex(
    lerp(a[0], b[0], clamped),
    lerp(a[1], b[1], clamped),
    lerp(a[2], b[2], clamped),
  );
}

function linearize(component: number): number {
  const s = component / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** Rapport de contraste WCAG 2.x — mêmes bornes que `packages/tokens/src/index.test.ts`. */
export function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export interface TintCourseSample {
  readonly t: number;
  readonly color: string;
  readonly background: string;
  readonly ratio: number;
}

/**
 * ÉCHANTILLONNAGE À DEUX DIMENSIONS (04 § 6, A23) : la couleur du TEXTE le long de la course
 * ET le fond RÉELLEMENT derrière le pixel — tantôt la pilule, tantôt la capsule de highlight
 * qui passe dessous. Les bornes sont certifiées sur la pilule ; ni le CHEMIN ni le fond de
 * highlight ne le sont automatiquement. À prouver par échantillonnage, pas par raisonnement.
 */
export function sampleTintCourse(
  palette: TabTintPalette,
  activeTint: string,
  steps = 100,
): readonly TintCourseSample[] {
  const samples: TintCourseSample[] = [];
  const count = Math.max(Math.floor(steps), 1);
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const color = mixTint(palette.inactive, activeTint, t);
    for (const background of [palette.pill, palette.highlight]) {
      samples.push({ t, color, background, ratio: contrastRatio(color, background) });
    }
  }
  return samples;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// ACCESSIBILITÉ — trois états, et l'INCONNU compte comme ACTIF (08 § Préférences et premier rendu)
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Une préférence d'accessibilité a TROIS états, pas deux. `AccessibilityInfo` ne propose aucune
 * lecture synchrone : au premier rendu la valeur n'est pas revenue. Un composant qui traite
 * « pas encore connu » comme « pas de réduction » ANIME AVANT DE SAVOIR — un fail-OPEN sur une
 * préférence d'accessibilité, c'est-à-dire exactement l'effet que l'utilisateur a demandé à ne
 * pas subir.
 */
export type PreferenceState = 'unknown' | 'active' | 'inactive';

/**
 * Le mouvement n'est autorisé QUE si la préférence est connue ET inactive. Pendant la fenêtre
 * `unknown`, l'élément est rendu dans son état FINAL, sans course — et il n'est JAMAIS ré-animé
 * à la résolution : seules les interactions SUIVANTES animent.
 */
export function motionAllowed(reduceMotion: PreferenceState): boolean {
  return reduceMotion === 'inactive';
}

/**
 * Le scrub est monté QUE si le lecteur d'écran est connu ET inactif. Le détecteur de geste
 * CONSOMME les touches d'exploration : monté pendant la fenêtre inconnue, il transformerait la
 * barre en bloc opaque pour VoiceOver/TalkBack. L'état sûr est aussi l'état accessible — les
 * `Pressable` gardent la main, et ils suffisent à naviguer.
 */
export function scrubAllowed(screenReader: PreferenceState): boolean {
  return screenReader === 'inactive';
}

/** Durée effective d'une transition, une fois la préférence appliquée. */
export function effectiveDuration(duration: number, reduceMotion: PreferenceState): number {
  return motionAllowed(reduceMotion) ? duration : 0;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// DYNAMIC TYPE — le palier du label, déterministe et testable
// ────────────────────────────────────────────────────────────────────────────────────────────

export type TabLabelTier = 'one-line' | 'two-lines' | 'icon-only';

/** Nombre maximal de lignes d'un label. Au-delà, il est RETIRÉ — jamais tronqué. */
export const TAB_LABEL_MAX_LINES = 2;

export interface TabLabelMeasurement {
  /** Largeur du label sur UNE ligne, mesurée SANS contrainte de largeur. */
  readonly naturalWidth: number;
  /** Largeur du mot le plus long : un mot ne se coupe pas, il déborde. */
  readonly longestWordWidth: number;
  /** Largeur utile d'un onglet. */
  readonly availableWidth: number;
}

/**
 * PALIER DU LABEL (04 § Cibles tactiles et Dynamic Type) — trois rangs, dans cet ordre :
 *
 *   1. tant que le label tient sur UNE ligne : une ligne ;
 *   2. sinon, tant qu'il tient sur DEUX lignes : `numberOfLines={2}`, la pilule grandit
 *      d'autant. `adjustsFontSizeToFit` est INTERDIT — il annulerait silencieusement la
 *      préférence de taille de l'utilisateur au lieu de réagencer le layout ;
 *   3. sinon, icônes seules : le label est RETIRÉ, jamais tronqué. Le nom reste porté par
 *      `accessibilityLabel` et la sélection par `accessibilityState.selected` : aucune
 *      information n'est perdue, seule une redondance visuelle l'est.
 *
 * LE MOT LE PLUS LONG EST UNE CONDITION À PART, et elle n'est pas décorative : « Documents » ne
 * se coupe pas. Un label dont la LARGEUR TOTALE tient sur deux lignes mais dont un MOT dépasse
 * la largeur d'onglet serait tronqué par la plateforme — deuxième rang faux, troisième rang
 * juste.
 *
 * MESURE ABSENTE = `two-lines`, et il faut dire exactement ce que cela vaut. Ce n'est PAS un
 * fail-closed au sens des préférences d'accessibilité : c'est le rang que la plateforme rend de
 * toute façon avant la première passe de layout, et il est corrigé DANS cette même passe, avant
 * toute interaction. Ce que cela ne garantit pas : qu'aucune ellipse ne soit peinte sur la toute
 * première frame à ~200 %. On ne le déclare donc pas garanti.
 */
/**
 * Le mot le plus long d'un label — celui qui décide, à lui seul, si le rang « deux lignes » est
 * atteignable. Un mot ne se coupe pas : « Documents » déborde ou disparaît, il ne se casse pas
 * en deux. Découpage sur les blancs UNIQUEMENT ; les traits d'union ne sont pas des points de
 * coupure garantis d'une plateforme à l'autre, et supposer le contraire rendrait la mesure
 * optimiste — donc fausse dans le sens qui tronque.
 */
export function longestWord(label: string): string {
  const words = label.split(/\s+/).filter((word) => word.length > 0);
  let longest = '';
  for (const word of words) if (word.length > longest.length) longest = word;
  return longest;
}

export function resolveTabLabelTier(measurement?: TabLabelMeasurement): TabLabelTier {
  if (measurement === undefined) return 'two-lines';
  const { naturalWidth, longestWordWidth, availableWidth } = measurement;
  if (!(availableWidth > 0)) return 'icon-only';
  if (naturalWidth <= availableWidth) return 'one-line';
  if (longestWordWidth > availableWidth) return 'icon-only';
  return naturalWidth <= availableWidth * TAB_LABEL_MAX_LINES ? 'two-lines' : 'icon-only';
}

/** Palier de la BARRE : un seul label qui ne tient pas fait passer TOUTE la barre en icônes. */
export function resolveBarLabelTier(tiers: readonly TabLabelTier[]): TabLabelTier {
  if (tiers.some((tier) => tier === 'icon-only')) return 'icon-only';
  return tiers.some((tier) => tier === 'two-lines') ? 'two-lines' : 'one-line';
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// 5 · FADE-THROUGH DU SLOT D'ÉCRAN
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Échelle d'entrée : un souffle de profondeur, jamais une entrée depuis rien. */
export const TAB_SLOT_ENTER_SCALE = 0.985;

export interface FadeThroughInput {
  readonly focused: boolean;
  /** Le tout premier écran au lancement n'est pas animé. */
  readonly firstRender: boolean;
  readonly reduceMotion: PreferenceState;
}

export interface FadeThroughPlan {
  /** `false` = l'écran est posé dans son état final, sans course. */
  readonly animate: boolean;
  /** `motionSemantic.replace` — token LIVRÉ (280 ms), jamais un chiffre libre. */
  readonly duration: number;
  readonly opacityFrom: number;
  readonly scaleFrom: number;
  /** `true` quand l'écran sortant doit être masqué INSTANTANÉMENT — jamais deux écrans animés. */
  readonly hideInstantly: boolean;
}

/**
 * FADE-THROUGH (04 § 5). L'écran ENTRANT fond en `motionSemantic.replace` = 280 ms, courbe
 * `easing.enter`, avec une micro-échelle 0,985 → 1. L'écran SORTANT n'est pas animé du tout :
 * il est masqué instantanément — jamais deux écrans animés qui se croisent.
 *
 * 280 ms et non 220 : la référence écrit 220 (`fading-tab-slot.tsx` l. 28) et une rédaction
 * antérieure du socle l'avait recopié, mais un fade-through est EXACTEMENT le cas d'usage de
 * `motionSemantic.replace`, dont la valeur livrée et gelée est 280
 * (`packages/tokens/src/index.test.ts`). Le dossier CONSOMME ce token, il ne le revalorise pas.
 */
export function fadeThroughPlan(input: FadeThroughInput): FadeThroughPlan {
  const still = {
    animate: false,
    duration: 0,
    opacityFrom: 1,
    scaleFrom: 1,
  } as const;
  if (!input.focused) return { ...still, hideInstantly: true };
  if (input.firstRender || !motionAllowed(input.reduceMotion)) {
    return { ...still, hideInstantly: false };
  }
  return {
    animate: true,
    duration: motionSemantic.replace,
    opacityFrom: 0,
    scaleFrom: TAB_SLOT_ENTER_SCALE,
    hideInstantly: false,
  };
}
