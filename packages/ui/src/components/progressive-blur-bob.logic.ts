/**
 * ProgressiveBlurBob — LOGIQUE PURE de la retombée de bord du kit « matière Bob »
 * (04 § Retombée de bord ; budget 10 § Budget de la retombée de bord). Aucun import
 * React / React Native / Expo : tout se teste sans monter un arbre.
 *
 * Ce que la retombée EST : la zone NON INTERACTIVE qui dissout le contenu défilant avant
 * qu'il n'atteigne un chrome flottant. Décorative, sans texte, sans information, et
 * JAMAIS animée — dans aucun mode, ni en Reduced Motion. Il n'y a donc aucune valeur animée
 * à recalculer par frame, donc aucun coût JS sous le scroll.
 *
 * Deux modes, UN SEUL repli :
 * · `tinted`  — le voile teinté SEUL : un `LinearGradient`, un draw call. DÉFAUT livrable.
 * · `blurred` — N couches FRÈRES (jamais imbriquées, aucun masque), chacune CLIPPÉE et
 *               recouverte de NOTRE lavis, PUIS le même voile teinté par-dessus l'ensemble.
 *
 * Le repli n'est pas un mode dégradé honteux : c'est un RANG NORMAL de l'algorithme. Dans les
 * deux modes l'utilisateur voit la MÊME géométrie, la MÊME courbe et la MÊME couleur ; seuls
 * les échantillons de flou disparaissent. Aucune information, aucune cible, aucun contraste
 * ne change — c'est pourquoi il n'y a jamais de trou visuel, jamais d'aplat gris, jamais un
 * texte sous-contraste.
 *
 * LA TEINTE N'EST PAS NÉGOCIABLE. « Je NE VEUX PAS une UI transparente à la iOS » : le verre
 * système impose SA teinte, pas la nôtre. Le kit ne demande donc pas au port d'être poli — il
 * RÉSOUT la matière depuis nos tokens, la GÈLE, et compose PAR-DESSUS l'échantillon un lavis
 * de NOTRE teinte dans chaque bande. `bobTintShareAt()` chiffre ce que cela garantit,
 * profondeur par profondeur, et un test le plancher.
 *
 * DEUX GARANTIES DE NATURES DIFFÉRENTES, à ne jamais confondre — c'est la confusion qui a fait
 * écrire ici des affirmations fausses :
 *  · CONFORMITÉ — le lavis et le voile teintent CE QUE LE PORT A PEINT, en supposant qu'il a
 *    appliqué la matière remise. Chiffrée par `bobTintShareAt`, et nulle au bord libre ;
 *  · CONSTRUCTION — la vérification de l'élément rendu (`BlurLayerSlot`, rang
 *    `material-tampered`) et le CLIP de la bande, qui ne supposent rien du port.
 */
import {
  patterns,
  surfaceVeil,
  type SurfaceTintAppearance,
  type SurfaceVeilTone,
} from '@bob/tokens';
import type { BlurLayerSpec } from './progressive-blur-bob.types';

const FALLOFF = patterns.edgeFalloff;

/** Bord ANCRÉ de la retombée : celui où le voile est OPAQUE, sous le chrome. */
export type BlurAnchor = 'top' | 'bottom';

export type EdgeFalloffMode = 'tinted' | 'blurred';

/**
 * Rang d'un port, résolu AVANT le plan (`resolveBlurPort`) :
 * · `absent`   — aucun port, ou une valeur qui n'est pas une fonction ;
 * · `unsealed` — une fonction qui n'est pas passée par `defineBlurPort` : elle n'a donc
 *                jamais déclaré qu'elle rend UNE couche et rien d'autre. Traitée comme
 *                absente — jamais à moitié ;
 * · `ready`    — scellée. Seul rang qui allume le flou.
 */
export type BlurPortStatus = 'absent' | 'unsealed' | 'ready';

/**
 * MANQUEMENT du port, constaté à l'exécution. Chacun est DÉFINITIF pour la vie du composant :
 * un port qui a manqué n'est plus rappelé, sinon on remplacerait un écran mort par une
 * boucle d'erreurs, et un port INTERMITTENT ferait clignoter l'écran.
 *
 * · `null-at-zero`   — le contrat lui-même : « si le port renvoie `null` pour `index === 0`,
 *                      `ProgressiveBlurBob` n'appelle plus le port et sert le repli » ;
 * · `partial-stack`  — TOUT OU RIEN violé : un élément à un index, `null` à un autre. Une pile
 *                      partielle produirait une courbe qui n'est ni celle du mode flouté ni
 *                      celle du repli ; le contrat l'interdit, le kit la fait échouer fermé —
 *                      et il le fait PENDANT LE RENDU, avant tout commit, faute de quoi la
 *                      pile partielle serait bel et bien peinte le temps d'une frame ;
 * · `factory-threw`  — l'APPEL à `renderBlurLayer` a levé pendant la construction ;
 * · `element-threw`  — la fabrique a rendu un élément VALIDE qui a levé pendant SON rendu ou
 *                      dans un effet. Un `try`/`catch` de l'appelant n'attrape rien de cela :
 *                      il faut une frontière d'erreur. Voir `progressive-blur-bob.tsx` ;
 * · `invalid-element` — la fabrique a rendu autre chose qu'UN ÉLÉMENT DE COUCHE : une chaîne,
 *                      un nombre, un tableau — ou un FRAGMENT, que `isValidElement()` accepte
 *                      et qui peut porter une chaîne (`<>{'texte'}</>`). Le typage ne protège
 *                      que le code typé ; au rendu, React peindrait ce texte dans une zone que
 *                      le contrat déclare sans texte ni information. Refusé, fermé ;
 * · `material-tampered` — la fabrique a rendu un élément VALIDE qui ne porte pas la matière
 *                      qu'on lui a remise : `intensity`, `tint` ou `style` réécrits, ou des
 *                      ENFANTS ajoutés (« une couche, et rien d'autre »). C'est la seule
 *                      barrière qui ferme la classe entière du matériau hostile — voir
 *                      `bobTintShareAt` pour ce que le lavis, lui, ne peut PAS garantir.
 */
export type BlurPortFailure =
  | 'null-at-zero'
  | 'partial-stack'
  | 'factory-threw'
  | 'element-threw'
  | 'invalid-element'
  | 'material-tampered';

/**
 * Ce que l'APPLICATION constate et que `@bob/ui` ne peut pas deviner : version d'Android,
 * `Modal`, budget GPU de l'appareil médian. `'unknown'` est le DÉFAUT et vaut REFUS — la
 * même règle fail-closed que les préférences d'accessibilité (08 § Préférences et premier
 * rendu) : l'ignorance ne s'arbitre pas en faveur de l'effet décoratif.
 */
export type BlurRenderCapability = 'unknown' | 'capable' | 'degraded';

/**
 * Nature du contenu SOUS la retombée. CINQUIÈME coupure du contrat : au-dessus d'une liste
 * virtualisée (`FlashList`, `FlatList`, `SectionList`, `VirtualizedList`), le flou ne se
 * rafraîchit pas — limitation officielle d'`expo-blur`. Un flou figé ne fait rougir aucun
 * test : il rend une image, simplement périmée. `'unknown'` est le DÉFAUT et vaut REFUS.
 */
export type BlurSurfaceUnder = 'unknown' | 'static' | 'virtualized-list';

/** Préférence système « réduire la transparence ». `'unknown'` = pas encore résolue. */
export type TransparencyPreference = 'unknown' | 'reduced' | 'standard';

/**
 * ASSERTION D'ENGLOBEMENT du § 4 du socle, rendue TRI-ÉTAT — et c'est une correction, pas un
 * raffinement. Le socle écrit : « Assertion de développement OBLIGATOIRE, `__DEV__` uniquement :
 * `height <= hauteur mesurée du shell` ». Une assertion obligatoire qui ne s'exécute que
 * lorsque l'appelant a bien voulu fournir la mesure n'est pas obligatoire : c'était le SEUL
 * défaut fail-OPEN du composant, et il portait sur une OBLIGATION du contrat.
 *
 * · `unverified` — la hauteur du shell n'a pas été déclarée : l'assertion N'A PAS PU être
 *                  faite. L'inconnu vaut REFUS, comme pour les trois autres tri-états ;
 * · `within`     — `height <= hauteur mesurée du shell`, l'englobement est constaté ;
 * · `overflow`   — l'enveloppe dépasse le shell : les couches ne sont plus englobées.
 *
 * En PRODUCTION aucune mesure n'est faite — le socle l'écrit, l'invariant y est structurel :
 * le composant transmet alors `within`. La conséquence est voulue et vertueuse : un écran qui
 * n'a jamais déclaré sa hauteur de shell ne voit JAMAIS de flou en développement, donc le
 * manquement se constate avant la publication, pas après.
 */
export type BlurEnvelopeAssertion = 'unverified' | 'within' | 'overflow';

/** Pourquoi le plan a atterri sur son mode. Les cinq coupures du contrat, sans zone grise. */
export type EdgeFalloffReason =
  | 'blurred'
  // COUPURE 2 — accessibilité, rang 0, fail-closed.
  | 'reduce-transparency'
  | 'preference-unresolved'
  // COUPURE 1 — le port.
  | 'no-port'
  | 'port-unsealed'
  | 'port-failed'
  // COUPURES 3 & 4 — capacité de rendu et budget.
  | 'capability-unknown'
  | 'degraded-renderer'
  // COUPURE 5 — liste virtualisée.
  | 'surface-unknown'
  | 'virtualized-list'
  // Assertion d'englobement du § 4, `__DEV__` uniquement — refus par défaut.
  | 'envelope-unverified'
  | 'envelope-overflow'
  // Demande de l'appelant : le défaut normatif est 0.
  | 'no-layer-requested';

/**
 * MATIÈRE DE BOB — résolue par le kit depuis nos tokens, GELÉE, jamais relue. C'est le cœur
 * du contrat de teinte : le port REÇOIT la géométrie et l'intensité, il ne reçoit AUCUN champ
 * par lequel proposer une autre couleur, et le kit ne consulte jamais ce qu'il a transmis —
 * il compose son lavis depuis sa propre résolution.
 */
export interface BobBlurMaterial {
  readonly appearance: SurfaceTintAppearance;
  readonly tone: SurfaceVeilTone;
  /** NOTRE teinte à alpha 0 — départ du lavis, et la SEULE transparence que le kit autorise. */
  readonly tintTransparent: string;
  /** NOTRE teinte OPAQUE — arrivée du lavis, et couleur du bord ancré. */
  readonly tintSolid: string;
  /** Part MAXIMALE du lavis composé par-dessus l'échantillon, dans chaque bande. */
  readonly washOpacity: number;
}

export interface ProgressiveBlurPlanInput {
  readonly layers: number;
  readonly anchor: BlurAnchor;
  /** Hauteur d'enveloppe en points — fixe (§ Pourquoi l'enveloppe est fixe). */
  readonly height: number;
  readonly port: BlurPortStatus;
  /** Manquement DÉFINITIF déjà constaté, s'il y en a un. */
  readonly portFailure?: BlurPortFailure | undefined;
  readonly transparency: TransparencyPreference;
  readonly material: BobBlurMaterial;
  readonly capability?: BlurRenderCapability | undefined;
  readonly surfaceUnder?: BlurSurfaceUnder | undefined;
  /**
   * Résultat de l'assertion d'englobement du § 4. ABSENT vaut `'unverified'`, donc REFUS :
   * l'omission ne peut pas ouvrir le flou, c'est tout l'objet du tri-état.
   */
  readonly envelope?: BlurEnvelopeAssertion | undefined;
}

export interface ProgressiveBlurPlan {
  readonly mode: EdgeFalloffMode;
  readonly reason: EdgeFalloffReason;
  /** VIDE en mode teinté — c'est LA garantie testable du repli. Sinon : les specs du contrat. */
  readonly layers: readonly BlurLayerSpec[];
  readonly material: BobBlurMaterial;
  /** Nombre demandé, tel quel (peut être hors bornes, non fini, fractionnaire). */
  readonly requested: number;
  /** Nombre retenu après plafonnement structurel (0 → `maxLayers`). */
  readonly granted: number;
  /** true dès que la demande a été RAMENÉE — plafonnée, tronquée ou refusée en bloc. */
  readonly capped: boolean;
  /** Intensité effective au bord ancré = `granted` × intensité uniforme (0 si teinté). */
  readonly peakIntensity: number;
  /** Couches retenues dont la contribution est encore LISIBLE (voir `visibleLayerCount`). */
  readonly visibleLayers: number;
  /**
   * Couches retenues dont la contribution passe SOUS le seuil de matérialité du voile : elles
   * coûtent un échantillonnage GPU permanent sans que l'œil puisse les distinguer.
   * Diagnostic, jamais une coupure — le plan ne réduit pas silencieusement la demande.
   */
  readonly hiddenLayers: number;
}

/** Plafond STRUCTUREL (= longueur du profil). Le plafond de PRODUCTION vient de PERF-CALIBRATION. */
export const MAX_EDGE_FALLOFF_LAYERS: number = FALLOFF.maxLayers;

/** Défaut normatif : aucune couche floutée, la retombée est teintée. */
export const DEFAULT_EDGE_FALLOFF_LAYERS: number = FALLOFF.defaultLayers;

/** Profil de hauteurs du contrat, en pour cent — propriété de `@bob/ui`, jamais du port. */
export const EDGE_FALLOFF_HEIGHT_PROFILE: readonly number[] = FALLOFF.layerHeightsPercent;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Alpha RÉEL d'une couleur de token : `rgba(r,g,b,a)` → a, tout le reste (hex) → 1. Le kit
 * lit la courbe du voile sur les couleurs LIVRÉES, jamais sur une constante recopiée : le
 * jour où un stop change, l'instrument de budget change avec lui.
 */
function alphaOf(color: string): number {
  const match = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/i.exec(color);
  if (match === null) return 1;
  const parsed = Number.parseFloat(match[1] ?? '1');
  return Number.isFinite(parsed) ? clamp01(parsed) : 1;
}

function veilAlphas(material: BobBlurMaterial): readonly [number, number, number] {
  const [free, mid, anchored] = surfaceVeil[material.appearance][material.tone].stops;
  return [alphaOf(free), alphaOf(mid), alphaOf(anchored)];
}

function ratio(value: number, from: number, to: number): number {
  return to <= from ? 1 : (value - from) / (to - from);
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * MATIÈRE DE BOB, résolue depuis nos tokens et GELÉE. Un port qui tenterait de la réécrire
 * échouerait sur l'objet figé — et, de toute façon, le kit ne relit jamais ce qu'il a
 * transmis. Ce sont DEUX barrières indépendantes, et c'est voulu.
 */
export function resolveBlurMaterial(
  tone: SurfaceVeilTone,
  appearance: SurfaceTintAppearance,
): BobBlurMaterial {
  const spec = surfaceVeil[appearance][tone];
  return Object.freeze({
    appearance,
    tone,
    tintTransparent: spec.stops[0],
    tintSolid: spec.stops[2],
    washOpacity: FALLOFF.layerWash,
  });
}

/**
 * TEINTE `expo-blur` transmise au port. `'dark'` est INTERDIT par le contrat de props : la
 * couleur perçue vient de NOTRE dégradé frère, pas du matériau système. En apparence sombre
 * on transmet donc `'default'` — le matériau neutre — et surtout pas `'light'`, qui poserait
 * une brume claire sous notre navy.
 */
export function resolveBlurTint(appearance: SurfaceTintAppearance): 'light' | 'default' {
  return appearance === 'light' ? 'light' : 'default';
}

/**
 * COURBE RÉELLE DU VOILE à la profondeur `depth` (0 = extrémité libre, 1 = bord ancré) :
 * interpolation linéaire par morceaux entre les alphas des stops LIVRÉS, aux positions
 * livrées. Avec les tokens actuels : 0 à la profondeur 0, 0,92 à 0,32, et 1,0 (OPAQUE) de
 * 0,60 jusqu'au bord ancré.
 */
export function veilOpacityAt(depth: number, material: BobBlurMaterial): number {
  const [a0, a1, a2] = veilAlphas(material);
  const [l0, l1, l2] = FALLOFF.veilLocations;
  const d = clamp01(depth);
  if (d <= l0) return a0;
  if (d <= l1) return lerp(a0, a1, ratio(d, l0, l1));
  if (d <= l2) return lerp(a1, a2, ratio(d, l1, l2));
  return a2;
}

/**
 * SEUIL DE MATÉRIALITÉ du kit — le résidu que le voile laisse passer à son stop médian (8 %
 * avec les tokens actuels). Une couche qui contribue moins que ce résidu ne peut pas être
 * distinguée du repli teinté : elle coûte sans rendre.
 */
export function veilResidual(material: BobBlurMaterial): number {
  return 1 - veilAlphas(material)[1];
}

/** Position du lavis dans la bande d'une couche de hauteur `heightRatio` : 0 au bord libre, 1 à l'ancre. */
export function washRampAt(depth: number, heightRatio: number): number {
  const d = clamp01(depth);
  const top = 1 - clamp01(heightRatio);
  if (d <= top) return 0;
  return clamp01(ratio(d, top, 1));
}

/**
 * Part de la couche `index` encore LISIBLE, au sommet de sa bande marginale — son meilleur
 * cas. Deux atténuations, toutes deux réelles et toutes deux du kit : le voile à cette
 * profondeur, et le lavis que le kit compose sur l'échantillon de cette couche même.
 */
export function layerVisibility(index: number, material: BobBlurMaterial): number {
  const percent = FALLOFF.layerHeightsPercent[index];
  if (percent === undefined) return 0;
  const transmittance = 1 - veilOpacityAt(1 - percent / 100, material);
  return transmittance * (1 - material.washOpacity);
}

/**
 * Nombre de couches du profil dont la contribution dépasse le seuil de matérialité. Avec les
 * tokens livrés : TROIS. Compter les couches « pas entièrement sous le point opaque »
 * surestimerait le budget d'un facteur 2, en comptant comme visibles des couches dont le
 * meilleur point est déjà noyé sous 93 % de voile.
 */
export function visibleLayerCount(
  material: BobBlurMaterial = resolveBlurMaterial('canvas', 'light'),
): number {
  const floor = veilResidual(material);
  return FALLOFF.layerHeightsPercent.filter((_, index) => layerVisibility(index, material) >= floor)
    .length;
}

function normalizeLayerCount(requested: number): number {
  // Une demande non finie n'est pas une demande : on n'accorde rien — et `capped` le dit.
  if (!Number.isFinite(requested)) return 0;
  return Math.min(Math.max(Math.floor(requested), 0), FALLOFF.maxLayers);
}

/** Hauteur en points d'une couche, pour une enveloppe de `envelopeHeight` points. */
export function layerHeightPoints(heightPercent: number, envelopeHeight: number): number {
  const safeHeight = Number.isFinite(envelopeHeight) ? Math.max(envelopeHeight, 0) : 0;
  const safePercent = Number.isFinite(heightPercent) ? clamp01(heightPercent / 100) : 0;
  return Math.max(Math.round(safePercent * safeHeight), 0);
}

/**
 * GÉOMÉTRIE RÉSOLUE d'une couche — le `style` que le port applique TEL QUEL. C'est la
 * frontière de responsabilité du contrat rendue exécutable : `@bob/ui` calcule le profil et
 * la position, le port choisit le MATÉRIAU. Il ne peut donc pas déformer la courbe de
 * dissolution, parce qu'il ne la calcule jamais.
 *
 * NI `zIndex`, NI `elevation`, NI token d'ombre — l'autorité de profondeur est l'ordre de
 * DÉCLARATION seul. Android trie un `ViewGroup` par `Z = elevation + translationZ` et cela
 * PRIME sur l'ordre de déclaration ; iOS ignore `elevation` et suit la déclaration. Deux
 * leviers en désaccord ne se départagent pas — ils produisent deux rendus par OS. Le
 * désaccord est interdit, pas arbitré.
 *
 * L'objet est GELÉ : un port hostile qui muterait le style qu'on lui remet ne peut pas
 * déplacer la bande dans laquelle le kit l'a enfermé.
 */
export function blurLayerStyle(
  anchor: BlurAnchor,
  heightPercent: number,
  envelopeHeight: number,
): Readonly<{
  position: 'absolute';
  left: number;
  right: number;
  top?: number;
  bottom?: number;
  height: number;
}> {
  const height = layerHeightPoints(heightPercent, envelopeHeight);
  return Object.freeze(
    anchor === 'bottom'
      ? ({ position: 'absolute', left: 0, right: 0, bottom: 0, height } as const)
      : ({ position: 'absolute', left: 0, right: 0, top: 0, height } as const),
  );
}

/**
 * Décide du mode de la retombée. L'ORDRE des rangs est normatif : ACCESSIBILITÉ D'ABORD,
 * puis le manquement définitif d'un port, puis la capacité, puis la nature du contenu, puis
 * le garde-fou d'enveloppe, puis la demande de l'appelant. Toutes les inconnues comptent
 * pour ACTIVES : c'est la règle fail-closed du socle, appliquée aux trois tri-états.
 */
export function progressiveBlurPlan(input: ProgressiveBlurPlanInput): ProgressiveBlurPlan {
  const granted = normalizeLayerCount(input.layers);
  /*
   * `capped` = « la demande a été RAMENÉE ». Écrit comme une NÉGATION, jamais comme
   * `requested > granted` : c'est la seule forme qui reste vraie pour NaN et pour l'infini,
   * les deux demandes que `normalizeLayerCount` ramène à zéro sans qu'aucune comparaison ne
   * puisse le dire. Une demande négative, elle, est remontée à 0 : ce n'est pas un plafond.
   */
  const capped = !(input.layers <= granted);
  const visibleLayers = Math.min(granted, visibleLayerCount(input.material));
  /*
   * LE PLAN EST GELÉ, comme la matière et comme chaque spec. Ce n'est pas de la coquetterie :
   * il est remis TEL QUEL au rappel `onPlan` de l'application, puis relu par
   * `progressiveBlurWarnings`, qui interpole ses nombres dans des messages. Un plan mutable
   * laisserait un rappel hostile — ou simplement maladroit — réécrire ce que le kit journalise
   * ensuite. On gèle donc l'objet ET son tableau de couches.
   */
  const tinted = (reason: EdgeFalloffReason): ProgressiveBlurPlan =>
    Object.freeze({
      mode: 'tinted' as const,
      reason,
      layers: Object.freeze([]),
      material: input.material,
      requested: input.layers,
      granted,
      capped,
      peakIntensity: 0,
      visibleLayers: 0,
      hiddenLayers: 0,
    });

  // RANG 0 — ACCESSIBILITÉ D'ABORD, avant toute autre décision. COUPURE 2 du contrat.
  //          L'inconnu compte comme actif : jamais un flash de flou avant de savoir.
  if (input.transparency === 'reduced') return tinted('reduce-transparency');
  if (input.transparency !== 'standard') return tinted('preference-unresolved');
  // RANG 1 — un manquement du port est DÉFINITIF : il précède tout le reste. COUPURE 1.
  if (input.portFailure !== undefined) return tinted('port-failed');
  if (input.port === 'absent') return tinted('no-port');
  if (input.port === 'unsealed') return tinted('port-unsealed');
  // RANG 2 — capacité de rendu et budget. COUPURES 3 et 4.
  if (input.capability === 'degraded') return tinted('degraded-renderer');
  if (input.capability !== 'capable') return tinted('capability-unknown');
  // RANG 3 — nature du contenu échantillonné. COUPURE 5.
  if (input.surfaceUnder === 'virtualized-list') return tinted('virtualized-list');
  if (input.surfaceUnder !== 'static') return tinted('surface-unknown');
  // RANG 4 — assertion d'englobement du § 4, constatée en développement uniquement. Le tri-état
  //          refuse par défaut : une assertion qu'on n'a pas pu faire n'autorise rien.
  if (input.envelope === 'overflow') return tinted('envelope-overflow');
  if (input.envelope !== 'within') return tinted('envelope-unverified');
  // RANG 5 — demande de l'appelant. Le défaut normatif est 0.
  if (granted === 0) return tinted('no-layer-requested');

  const layers: readonly BlurLayerSpec[] = Object.freeze(
    FALLOFF.layerHeightsPercent.slice(0, granted).map((heightPercent, index) =>
      Object.freeze({
        index,
        layerCount: granted,
        heightPercent,
        intensity: FALLOFF.layerIntensity,
        tint: resolveBlurTint(input.material.appearance),
        anchor: input.anchor,
        style: blurLayerStyle(input.anchor, heightPercent, input.height),
      }),
    ),
  );

  return Object.freeze({
    mode: 'blurred' as const,
    reason: 'blurred' as const,
    layers,
    material: input.material,
    requested: input.layers,
    granted,
    capped,
    peakIntensity: granted * FALLOFF.layerIntensity,
    visibleLayers,
    hiddenLayers: Math.max(granted - visibleLayers, 0),
  });
}

/**
 * AVERTISSEMENTS DE DÉVELOPPEMENT liés au MANQUEMENT d'un port. Messages STATIQUES : aucune
 * donnée n'y est interpolée, ni de l'utilisateur ni du port — c'est ce qui garantit qu'aucune
 * donnée personnelle ne peut s'y glisser. Émis exactement UNE fois par montage (le manquement
 * est définitif), jamais en production.
 *
 * `null-at-zero` est ABSENT de cette table, et c'est délibéré : le contrat en fait la bascule
 * NORMALE vers le repli — « le port n'a rien à monter », Android < 31, `Modal`, budget. Un
 * rang normal n'est pas une anomalie, et avertir dessus rendrait la table inaudible là où elle
 * signale de vraies fautes.
 */
export const BLUR_PORT_FAILURE_WARNINGS: Readonly<Partial<Record<BlurPortFailure, string>>> =
  Object.freeze({
    'partial-stack':
      'ProgressiveBlurBob : le port renderBlurLayer a rendu une pile PARTIELLE (un élément à un index, null à un autre). La règle TOUT OU RIEN est violée — repli opaque unique, définitif pour ce montage.',
    'factory-threw':
      "ProgressiveBlurBob : le port renderBlurLayer a LEVÉ pendant la construction d'une couche — repli opaque unique, définitif pour ce montage. Un effet décoratif ne fait pas tomber un écran.",
    'element-threw':
      "ProgressiveBlurBob : l'élément rendu par le port renderBlurLayer a LEVÉ pendant son rendu ou dans un effet — frontière d'erreur déclenchée, repli opaque unique, définitif pour ce montage.",
    'invalid-element':
      "ProgressiveBlurBob : le port renderBlurLayer a rendu autre chose qu'un élément de couche — chaîne, nombre, tableau ou Fragment. La retombée ne porte jamais de texte ni d'information. Repli opaque unique, définitif pour ce montage.",
    'material-tampered':
      "ProgressiveBlurBob : le port renderBlurLayer a rendu un élément qui n'applique pas la matière remise — intensity, tint ou style réécrits, ou des enfants ajoutés. Le port choisit le matériau, jamais la teinte ni la géométrie. Repli opaque unique, définitif pour ce montage.",
  });

/**
 * DIAGNOSTICS LISIBLES du plan — un plan qui se dégrade doit pouvoir se DIRE. Fonction PURE :
 * le composant se contente de les émettre en développement, et les tests les lisent sans
 * monter un arbre. Les rangs NORMAUX (préférence d'accessibilité, zéro couche demandée) ne
 * produisent rien : un repli attendu n'est pas une anomalie. Les rangs qui trahissent une
 * INTENTION NON TENUE — on a demandé du flou et on ne l'aura pas — parlent, eux.
 */
export function progressiveBlurWarnings(plan: ProgressiveBlurPlan): readonly string[] {
  const warnings: string[] = [];
  if (plan.capped) {
    warnings.push(
      `ProgressiveBlurBob : ${String(plan.requested)} couches demandées, ${String(plan.granted)} accordées (plafond structurel ${String(MAX_EDGE_FALLOFF_LAYERS)}).`,
    );
  }
  if (plan.granted > 0) {
    if (plan.reason === 'no-port') {
      warnings.push(
        'ProgressiveBlurBob : des couches sont demandées sans port renderBlurLayer — repli opaque unique.',
      );
    }
    if (plan.reason === 'port-unsealed') {
      warnings.push(
        'ProgressiveBlurBob : le port renderBlurLayer n\'est pas scellé — passez-le par defineBlurPort(). Traité comme absent, repli opaque unique.',
      );
    }
    if (plan.reason === 'capability-unknown') {
      warnings.push(
        "ProgressiveBlurBob : la capacité de rendu n'est pas déclarée (renderCapability) — l'inconnu vaut refus, repli opaque unique.",
      );
    }
    if (plan.reason === 'surface-unknown') {
      warnings.push(
        "ProgressiveBlurBob : la nature du contenu sous la retombée n'est pas déclarée (surfaceUnder) — l'inconnu vaut refus, repli opaque unique.",
      );
    }
    if (plan.reason === 'virtualized-list') {
      warnings.push(
        'ProgressiveBlurBob : retombée floutée au-dessus d\'une liste virtualisée — le flou ne s\'y rafraîchit pas (limitation expo-blur). Cinquième coupure, repli opaque unique.',
      );
    }
    if (plan.reason === 'envelope-overflow') {
      warnings.push(
        "ProgressiveBlurBob : la hauteur d'enveloppe dépasse celle du shell — les couches ne sont plus englobées par la cible de flou du shell. Repli opaque unique.",
      );
    }
    if (plan.reason === 'envelope-unverified') {
      warnings.push(
        "ProgressiveBlurBob : l'assertion d'englobement n'a pas pu être faite — la hauteur mesurée du shell n'est pas déclarée (devShellHeight). Le socle la rend obligatoire en développement : l'inconnu vaut refus, repli opaque unique.",
      );
    }
  }
  if (plan.hiddenLayers > 0) {
    warnings.push(
      `ProgressiveBlurBob : ${String(plan.hiddenLayers)} des ${String(plan.granted)} couches passent sous le seuil de matérialité du voile — elles échantillonnent le GPU sans que l'œil les distingue (${String(plan.visibleLayers)} lisibles).`,
    );
  }
  return warnings;
}

/**
 * Intensité effective à la profondeur `depth` (0 = extrémité libre, 1 = bord ancré) : somme
 * des intensités des couches qui couvrent ce point. C'est la démonstration que le progressif
 * vient du RECOUVREMENT et non d'une rampe.
 */
export function effectiveIntensityAt(depth: number, layers: readonly BlurLayerSpec[]): number {
  const clamped = clamp01(depth);
  return layers.reduce(
    (total, layer) => (layer.heightPercent / 100 >= 1 - clamped ? total + layer.intensity : total),
    0,
  );
}

/**
 * PART DE NOTRE TEINTE à la profondeur `depth` : ce que l'œil compose de NOUS, voile ET lavis
 * réunis, PAR-DESSUS tout ce que le port a bien pu peindre. C'est la doctrine rendue
 * exécutable — « surfaces teintées par NOS tokens » cesse d'être une consigne écrite dans un
 * commentaire pour devenir un nombre qu'un test peut plancher.
 *
 * ─── CE QUE CE NOMBRE VAUT VRAIMENT, ET CE QU'IL NE VAUT PAS ─────────────────────────────
 * Ce fichier a d'abord affirmé que le lavis « rend STRUCTURELLEMENT impossible qu'un port
 * impose sa teinte ». C'ÉTAIT FAUX au bord libre, et une revue adversariale l'a mesuré. Le
 * lavis est une RAMPE : il vaut 0 au bord libre de CHAQUE bande, et le voile y vaut 0 aussi.
 * Donc `bobTintShareAt(0, plan) === 0` — À LA PROFONDEUR 0, LE MATÉRIAU DU PORT EST SEUL.
 *
 * Table MESURÉE sur les tokens livrés (canvas / light, N = 10), part du PORT :
 *   0 → 1.0000 · 0,02 → 0.9368 · 0,05 → 0.8434 · 0,16 → 0.5071 · 0,32 → 0.0653 · 0,60 → 0.
 * `progressive-blur-bob.logic.test.ts` la rejoue, valeur par valeur, plutôt que de la croire.
 *
 * CE QUI EST VRAI, et qui tient : à la profondeur 0, exactement UNE couche couvre le pixel —
 * celle de 100 % —, donc l'intensité effective y vaut `layerIntensity` (5), le flou le plus
 * LÉGER du profil ; et notre part remonte à 93 % dès le stop médian (0,32) puis à 100 % dès
 * 0,60. La couleur du port n'est donc jamais dominante ailleurs qu'à l'extrême bord libre, là
 * où il n'y a presque rien à teinter.
 *
 * C'est une garantie de CONFORMITÉ : elle suppose un port qui applique la matière remise. Elle
 * NE SE DÉCLARE PAS garantie de CONSTRUCTION. Ce qui la rend structurelle est ailleurs, au
 * rendu : `BlurLayerSlot` vérifie que l'élément porte `spec.intensity`, `spec.tint` et
 * `spec.style` TELS QUELS, et ferme la pile sur `material-tampered` sinon.
 */
export function bobTintShareAt(depth: number, plan: ProgressiveBlurPlan): number {
  const through = plan.layers.reduce(
    (transmitted, layer) =>
      transmitted *
      (1 - plan.material.washOpacity * washRampAt(depth, layer.heightPercent / 100)),
    1 - veilOpacityAt(depth, plan.material),
  );
  return 1 - through;
}

export interface EdgeFalloffHeightInput {
  /** Inset de sécurité du bord ancré (safe area). */
  readonly safeAreaInset: number;
  /** Hauteur ÉTENDUE du chrome — son état le PLUS HAUT (§ Pourquoi l'enveloppe est fixe). */
  readonly chromeHeight: number;
  /** Débord au-dessus du chrome — défaut `patterns.edgeFalloff.bleed` (44 pt). */
  readonly bleed?: number;
}

/**
 * Hauteur d'enveloppe : `inset de sécurité + hauteur ÉTENDUE du chrome + 44 pt de débord`.
 * Calculée UNE FOIS, sur l'état le plus haut du chrome, et elle ne bouge plus : le repli de
 * la barre se produit À L'INTÉRIEUR de l'enveloppe. Une hauteur recalculée par frame serait
 * une animation de layout par frame, que la règle « jamais animée » interdit.
 */
export function edgeFalloffHeight(input: EdgeFalloffHeightInput): number {
  const bleed = Math.max(input.bleed ?? FALLOFF.bleed, 0);
  return Math.max(input.safeAreaInset, 0) + Math.max(input.chromeHeight, 0) + bleed;
}

interface GradientAxis {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

/** Axe libre → ancré. Le voile ET le lavis coulent dans le même sens, par construction. */
function gradientAxis(anchor: BlurAnchor): GradientAxis {
  return anchor === 'bottom'
    ? { start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } }
    : { start: { x: 0.5, y: 1 }, end: { x: 0.5, y: 0 } };
}

export interface EdgeVeilGradient extends GradientAxis {
  readonly colors: readonly [string, string, string];
  readonly locations: readonly [number, number, number];
  /** Couleur OPAQUE du bord ancré — c'est elle qui rend le repli lisible, jamais un trou. */
  readonly solid: string;
}

/**
 * LE VOILE TEINTÉ BOB — un `LinearGradient` FRÈRE, rendu par `@bob/ui` dans les DEUX modes.
 * C'est LUI qui porte notre identité. Le port ne le rend jamais. Exigence du socle et non
 * commodité : le repli doit montrer la même géométrie, la même courbe et la même couleur.
 */
export function edgeVeilGradient(
  tone: SurfaceVeilTone,
  appearance: SurfaceTintAppearance,
  anchor: BlurAnchor,
): EdgeVeilGradient {
  const spec = surfaceVeil[appearance][tone];
  return {
    colors: spec.stops,
    locations: FALLOFF.veilLocations,
    ...gradientAxis(anchor),
    solid: spec.solid,
  };
}

export interface EdgeWashGradient extends GradientAxis {
  /** NOTRE teinte, de l'alpha 0 à l'opaque — ramenée à `opacity` par le composant. */
  readonly colors: readonly [string, string];
  /** Part maximale du lavis, au bord ancré de la bande (`patterns.edgeFalloff.layerWash`). */
  readonly opacity: number;
}

/**
 * LE LAVIS — NOTRE teinte composée PAR-DESSUS l'échantillon de flou, DANS SA BANDE. Une RAMPE
 * et jamais un aplat : au bord libre de la bande le lavis vaut 0, donc aucune couture là où
 * le voile vaut encore 0 ; au bord ancré il vaut `layerWash`. Empilé par le recouvrement, il
 * épaissit notre teinte exactement au rythme où l'intensité monte.
 *
 * CE QU'IL NE FAIT PAS, et il faut le dire ici : parce que c'est une rampe qui part de ZÉRO,
 * il ne « rend pas structurellement impossible » qu'un port impose sa teinte — au bord libre
 * il ne la couvre pas du tout. Voir `bobTintShareAt` pour la table mesurée et pour la barrière
 * qui, elle, est structurelle (vérification de la matière rendue, `BlurLayerSlot`).
 */
export function edgeWashGradient(
  material: BobBlurMaterial,
  anchor: BlurAnchor,
): EdgeWashGradient {
  return {
    colors: [material.tintTransparent, material.tintSolid],
    opacity: material.washOpacity,
    ...gradientAxis(anchor),
  };
}
