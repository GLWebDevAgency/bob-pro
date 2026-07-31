/**
 * ProgressiveBlurBob — RETOMBÉE DE BORD du kit « matière Bob » (04 § Retombée de bord).
 * 100 % ADDITIF : aucun écran livré n'est modifié, `BottomTabBar` garde son propre fondu.
 *
 * CE QU'IL REND, toujours dans cet ordre de DÉCLARATION — qui EST la spécification de
 * profondeur, puisque le frère déclaré en dernier est peint au-dessus de ses aînés :
 *
 *   1. N BANDES FRÈRES (jamais imbriquées, aucun masque), de hauteurs décroissantes, ancrées
 *      sur le bord du chrome, chacune CLIPPÉE (`overflow: 'hidden'`) et contenant :
 *        a. l'échantillon de flou, rendu par le PORT injecté par l'application ;
 *        b. PAR-DESSUS lui, LE LAVIS — notre teinte en rampe.
 *   2. PAR-DESSUS l'ensemble, le VOILE TEINTÉ, rendu dans les DEUX modes. C'est lui qui porte
 *      NOTRE identité, là où la référence se contente d'un voile noir `rgba(0,0,0,.70)`.
 *
 * Le clip et le lavis ne sont pas décoratifs — mais ils ne SUFFISENT pas, et ce fichier a
 * d'abord affirmé le contraire : « les DEUX barrières qui rendent la teinte du système
 * inatteignable ». C'ÉTAIT FAUX, et c'est MESURÉ : le lavis est une rampe qui vaut 0 au bord
 * libre de chaque bande, là où le voile vaut 0 lui aussi. À la profondeur 0, le matériau du
 * port est SEUL — part du port 1,0000 (table complète dans `bobTintShareAt`).
 *
 * Ce que ces deux-là garantissent est donc BORNÉ, et il faut le dire ainsi : un port ne peint
 * ni hors de sa bande (clip), ni par-dessus notre teinte — au mieux dessous (ordre de
 * déclaration). Ce qui rend la teinte du SYSTÈME réellement inatteignable est ailleurs, et
 * seulement pour la matière DÉCLARÉE : la vérification de l'élément rendu (`BlurLayerSlot`).
 * Et le clip est GÉOMÉTRIQUEMENT NEUTRE : la bande a exactement le rectangle que `spec.style`
 * décrit, donc un port conforme rend les mêmes pixels avec ou sans lui. Le clip ne coûte rien
 * à l'honnête et arrête l'hostile.
 *
 * AUCUNE ANIMATION, dans aucun mode, ni en Reduced Motion. Il n'y a donc aucune valeur animée
 * à recalculer, aucun coût JS par frame sous le scroll, et rien à dégrader quand la préférence
 * « réduire les animations » est active — donc aucun chemin de rendu alternatif non testé.
 *
 * ─── UN PORT QUI JETTE N'EMPORTE PAS L'ÉCRAN ──────────────────────────────────────────────
 * Le port vient de l'APPLICATION : c'est du code que `packages/ui` ne contrôle pas. S'il lève,
 * React démonte l'arbre et l'écran entier disparaît. Un effet DÉCORATIF ne doit JAMAIS faire
 * tomber un écran où l'artisan encaisse une facture.
 *
 * Ce fichier a d'abord énuméré DEUX chemins. Il y en a TROIS, et le troisième a été démontré
 * par une revue adversariale : l'arbre valait `null` après une simple bascule d'accessibilité.
 * Un commentaire qui énumère faux est un piège pour le prochain, alors les voici, nommés :
 *
 *   (a) LA FABRIQUE JETTE — l'appel à `renderBlurLayer` lève pendant la construction.
 *       Un `try`/`catch` autour de l'APPEL l'attrape (`BlurLayerSlot`).
 *   (b) L'ÉLÉMENT RENDU JETTE — la fabrique rend un élément VALIDE qui lève pendant SON rendu
 *       ou dans un effet de MONTAGE. Un `try`/`catch` de l'appelant n'attrape RIEN de cela :
 *       il faut une FRONTIÈRE D'ERREUR (`BlurStackBoundary`, `getDerivedStateFromError` +
 *       `componentDidCatch`).
 *   (c) LE NETTOYAGE JETTE AU DÉMONTAGE DE LA PILE — l'élément du port lève dans le CLEANUP de
 *       son effet, pendant que la pile disparaît. Le déclencheur n'a rien d'exotique : c'est la
 *       transition NORMALE N → 0 (Reduce Transparency, verrou après manquement, `layers` → 0).
 *       Une frontière rendue CONDITIONNELLEMENT ne le couvre pas, pour une raison STRUCTURELLE :
 *       elle est démontée EN MÊME TEMPS que ses enfants, et une frontière supprimée ne peut pas
 *       attraper l'erreur de ses propres enfants supprimés. React ne trouve alors AUCUNE
 *       frontière et détruit la racine. `BlurStackBoundary` est donc montée INCONDITIONNELLEMENT
 *       et rend `null` quand il n'y a rien à porter : elle SURVIT au démontage de la pile.
 *
 * LA LIMITE, déclarée plutôt que tue : si c'est la RETOMBÉE ELLE-MÊME qui est démontée (l'écran
 * quitte), aucune frontière interne ne peut aider — par construction elle part avec. C'est le
 * rôle d'une frontière d'ÉCRAN, côté application ; un test le démontre et vaut recommandation.
 *
 * CES TROIS-LÀ PARLENT DU PORT. Il existe une QUATRIÈME famille, d'une autre nature, et elle a
 * fait tomber l'écran elle aussi : les PROPS HORS CONTRAT DE TYPE. Ce composant lit des
 * scalaires de l'application PENDANT SON PROPRE RENDU, donc AU-DESSUS de toute frontière
 * interne — `layers`, `devShellHeight`, `tone`. Un `valueOf` qui lève, un ton hors énumération,
 * et l'arbre valait `null`. « Le typage ne protège que le code typé », et cela vaut aussi pour
 * ses props : plus rien n'est CONVERTI ici, et un ton inconnu retombe sur le fond d'app.
 *
 * Dans les trois cas l'écran survit et l'utilisateur voit la surface teintée opaque, lisible.
 * La dégradation est DÉFINITIVE pour la vie du composant : un port qui a manqué n'est plus
 * rappelé — sinon on remplacerait un écran mort par une boucle d'erreurs, et un port
 * INTERMITTENT ferait clignoter l'écran. Enfin l'échec n'est pas silencieux pour le
 * développeur : avertissement NOMMÉ, en développement seulement, à message STATIQUE — aucune
 * donnée n'y est interpolée.
 *
 * ─── ET LE CODE D'APPLICATION QUE LE KIT A LUI-MÊME AJOUTÉ ────────────────────────────────
 * `onPlan` est une prop AJOUTÉE par le kit (diagnostic). Elle porte donc, elle aussi, du code
 * d'application — et elle était appelée dans un effet PASSIF sans protection : en React 19 une
 * erreur non rattrapée dans un effet passif DÉMONTE LA RACINE ENTIÈRE. La discipline appliquée
 * au port n'avait pas été appliquée à la prop posée à côté. Elle l'est : `try`/`catch`, un
 * avertissement `__DEV__` statique, et la télémétrie qui casse ne casse qu'elle-même.
 *
 * ─── TOUT OU RIEN : TENU AVANT LE COMMIT, PAS APRÈS ───────────────────────────────────────
 * La règle interdit la pile PARTIELLE — des bandes servies, d'autres manquantes. Elle était
 * appliquée depuis un EFFET, donc après coup : la pile partielle était commitée, puis retirée.
 * Mesuré sur ce dépôt, un observateur voyait 5 échantillons sur 6. Passer l'annonce dans un
 * effet de MISE EN PAGE ne suffit pas : un effet court toujours après le commit.
 *
 * Une bande qui constate le mélange ABANDONNE donc PENDANT SON RENDU (`BlurStackAbort`). React
 * déroule le sous-arbre jusqu'à `BlurStackBoundary` avant tout commit : la pile partielle n'est
 * jamais construite côté hôte. Reste le cas où TOUTES les bandes manquent — celui-là est annoncé
 * par effet, et c'est légitime : l'arbre commité ne porte alors aucun échantillon, il est déjà,
 * pixel pour pixel, celui du repli, puisque le voile teinté est rendu dans les deux modes.
 */
import {
  Component,
  Fragment,
  createElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { patterns, type SurfaceVeilTone } from '@bob/tokens';
import { useTheme } from '../theme';
import { useTransparencyPreference } from '../hooks/use-transparency-preference';
import {
  BLUR_PORT_FAILURE_WARNINGS,
  blurLayerStyle,
  edgeVeilGradient,
  edgeWashGradient,
  progressiveBlurPlan,
  progressiveBlurWarnings,
  resolveBlurMaterial,
  type BlurEnvelopeAssertion,
  type BlurPortFailure,
  type BlurRenderCapability,
  type BlurSurfaceUnder,
  type ProgressiveBlurPlan,
} from './progressive-blur-bob.logic';
import { resolveBlurPort } from './progressive-blur-bob.port';
import type { BlurLayerSpec, ProgressiveBlurBobProps, RenderBlurLayer } from './progressive-blur-bob.types';

/**
 * Props du composant : les QUATRE du contrat (`ProgressiveBlurBobProps`, transcrites mot pour
 * mot dans `progressive-blur-bob.types.ts`) plus les ajouts du kit, tous nommés ici. Aucun
 * ajout ne change la sémantique des quatre ; chacun ne peut que FERMER le flou, jamais
 * l'ouvrir plus grand.
 */
export interface ProgressiveBlurBobViewProps extends ProgressiveBlurBobProps {
  /** Teinte du voile ET du lavis. `canvas` = le fond d'app, qui reproduit le fondu déjà livré. */
  readonly tone?: SurfaceVeilTone;
  /**
   * AJOUT — COUPURES 3 et 4 du contrat (Android < 31, `Modal` sur Android, rendu dégradé,
   * budget non tenu sur l'appareil médian). `@bob/ui` ne peut pas les constater : l'application
   * les déclare. `'unknown'` est le DÉFAUT et vaut REFUS — fail-closed, comme les préférences.
   */
  readonly renderCapability?: BlurRenderCapability;
  /**
   * AJOUT — CINQUIÈME COUPURE du contrat. Au-dessus d'une liste virtualisée (`FlashList`,
   * `FlatList`, `SectionList`, `VirtualizedList`) le flou ne se rafraîchit pas : il rend une
   * image périmée, et un flou figé ne fait rougir aucun test. La coupure est donc portée par
   * une DÉCLARATION POSITIVE : `'unknown'` — le défaut — vaut REFUS, et seul `'static'` ouvre.
   */
  readonly surfaceUnder?: BlurSurfaceUnder;
  /**
   * AJOUT — assertion `__DEV__` d'ENGLOBEMENT (contrat § 4). Hauteur MESURÉE du shell d'écran.
   * La seule façon de casser l'invariant d'englobement est de donner à l'enveloppe une hauteur
   * supérieure à celle du shell : dans ce cas le composant sert le repli opaque et journalise
   * l'écart. AUCUNE mesure n'est faite en production — l'invariant y est structurel.
   *
   * OBLIGATOIRE EN DÉVELOPPEMENT dès qu'on demande du flou, et c'est le socle qui l'écrit :
   * « Assertion de développement OBLIGATOIRE ». L'omettre laissait l'assertion ne jamais
   * s'exécuter — le seul défaut fail-OPEN du composant, sur une OBLIGATION du contrat. Absente,
   * elle vaut désormais REFUS (`envelope-unverified`), comme `renderCapability` et
   * `surfaceUnder`. En production rien n'est mesuré et rien n'est refusé de ce chef.
   */
  readonly devShellHeight?: number;
  /**
   * AJOUT — plan RÉSOLU, remis à l'appelant quand il change. Un diagnostic que personne ne
   * peut lire n'existe pas : c'est par ici que le profilage du dossier 10 s'instrumente.
   */
  readonly onPlan?: (plan: ProgressiveBlurPlan) => void;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

/** Développement au sens du bundler natif, avec repli Node pour les tests et le web. */
function isDevelopment(): boolean {
  return typeof __DEV__ === 'boolean' ? __DEV__ : process.env['NODE_ENV'] !== 'production';
}

/** Ce qu'une bande a obtenu du port, pour CE rendu. */
type SlotOutcome = 'element' | 'null' | 'threw' | 'invalid' | 'tampered';

/** Le manquement que chaque issue non nominale fait constater. */
const SLOT_FAILURES: Readonly<Record<Exclude<SlotOutcome, 'element'>, BlurPortFailure>> =
  Object.freeze({
    null: 'partial-stack',
    threw: 'factory-threw',
    invalid: 'invalid-element',
    tampered: 'material-tampered',
  });

/**
 * REGISTRE D'UNE PASSE DE RENDU — une case par bande, remplie DANS L'ORDRE où React rend les
 * bandes. C'est ce qui permet à la bande `i` de savoir ce que les bandes `0..i-1` ont obtenu,
 * PENDANT le rendu, donc avant tout commit.
 */
type StackLedger = (SlotOutcome | undefined)[];

/**
 * La pile est-elle MIXTE, c'est-à-dire à la fois pourvue et manquante ? C'est exactement la
 * violation du TOUT OU RIEN, et c'est la SEULE configuration qui serait visible : quand TOUTES
 * les bandes manquent, l'arbre commité ne porte aucun échantillon — il est alors, pixel pour
 * pixel, celui du repli, puisque le voile teinté est rendu dans les deux modes.
 */
function ledgerIsMixed(ledger: StackLedger): boolean {
  let served = false;
  let missing = false;
  for (const outcome of ledger) {
    if (outcome === undefined) continue;
    if (outcome === 'element') served = true;
    else missing = true;
  }
  return served && missing;
}

/** Le manquement à constater pour une pile mixte : le PREMIER défaut rencontré le nomme. */
function ledgerFailure(ledger: StackLedger): BlurPortFailure {
  for (const outcome of ledger) {
    if (outcome === undefined || outcome === 'element') continue;
    // `null` mêlé à des éléments est la violation TOUT OU RIEN elle-même, à tout index.
    return SLOT_FAILURES[outcome];
  }
  return 'partial-stack';
}

/**
 * ABANDON DE PILE, levé PENDANT LE RENDU d'une bande et attrapé par `BlurStackBoundary`.
 *
 * C'est le seul mécanisme qui tienne le TOUT OU RIEN à la PREMIÈRE frame. Annoncer le
 * manquement depuis un effet — même de mise en page — arrive toujours APRÈS le commit : la pile
 * partielle est alors dans l'arbre, et il faut un second commit pour l'en retirer. Mesuré sur
 * ce dépôt, un observateur d'effet passif voyait 5 échantillons sur 6.
 *
 * Une erreur levée pendant le RENDU, elle, remonte à la frontière AVANT tout commit : React
 * déroule le sous-arbre, rend la frontière à `null`, et l'arbre partiel n'existe jamais.
 */
class BlurStackAbort extends Error {
  readonly failure: BlurPortFailure;
  constructor(failure: BlurPortFailure) {
    // Message STATIQUE : aucune donnée du port ni de l'application n'y est interpolée.
    super('ProgressiveBlurBob: pile de flou abandonnée avant commit (tout ou rien).');
    this.name = 'BlurStackAbort';
    this.failure = failure;
  }
}

interface BlurLayerSlotProps {
  readonly spec: BlurLayerSpec;
  readonly render: RenderBlurLayer;
  readonly ledger: StackLedger;
  /** Appelé UNIQUEMENT pour une issue non nominale — jamais pour `element`. */
  readonly onOutcome: (index: number, outcome: Exclude<SlotOutcome, 'element'>) => void;
}

/**
 * LA BARRIÈRE DE MATIÈRE — ajout du kit, et la seule chose qui rende la doctrine de teinte
 * STRUCTURELLE plutôt que simplement CONFORME.
 *
 * Le lavis et le voile teintent ce que le port a peint, mais la rampe du lavis vaut 0 au bord
 * libre : à la profondeur 0 le matériau du port est SEUL (table mesurée dans
 * `bobTintShareAt`). Composer par-dessus ne peut donc pas suffire — il faut refuser en amont
 * l'élément qui ne porte pas la matière remise.
 *
 * TROIS ÉGALITÉS ET UNE ABSENCE, et rien de plus :
 *  · `intensity` et `tint` — le kit les a RÉSOLUS depuis ses tokens ; les réécrire, c'est
 *    proposer une autre matière, ce que le contrat n'autorise nulle part ;
 *  · `style` par IDENTITÉ, pas par valeur : le contrat dit « à appliquer TEL QUEL, sans
 *    recalcul ». L'objet est gelé ; exiger la même RÉFÉRENCE ferme aussi la recopie modifiée ;
 *  · AUCUN enfant — « rend une couche, et rien d'autre : ni voile, ni dégradé, ni conteneur ».
 *    C'est aussi ce qui interdit à un élément par ailleurs conforme de porter du TEXTE dans une
 *    zone que le contrat déclare sans texte ni information.
 *
 * CE QUE CETTE BARRIÈRE NE PEUT PAS FAIRE, dit ici pour que personne ne s'y trompe : elle
 * contrôle les CHAMPS du contrat, pas les pixels. Un port peut toujours rendre un composant à
 * lui qui reçoit correctement `intensity`, `tint` et `style` et peint autre chose à l'intérieur
 * — une revue adversariale a monté par ce chemin du verre système à intensité 100, teinte
 * `dark`, et le même chemin passe par un HOC. Celui-là reste borné par le CLIP de sa bande, par
 * le lavis et par le voile — c'est-à-dire par la garantie de CONFORMITÉ, chiffrée par
 * `bobTintShareAt`, et nulle au bord libre. Aucune vérification de props ne fermera cette
 * classe-là : il faudrait inspecter des pixels, ce qu'un arbre React ne donne pas.
 *
 * ELLE PREND `props` ET NON L'ÉLÉMENT, et c'est un correctif, pas un détail de signature. Un
 * élément peut être FORGÉ à la main — `isValidElement()` ne regarde que `$$typeof`, dont la
 * valeur est un symbole du registre GLOBAL (`Symbol.for('react.transitional.element')`), donc
 * recopiable par n'importe qui. Un tel élément peut exposer `props` comme un ACCESSEUR qui rend
 * la matière conforme à la première lecture, la nôtre, et la matière hostile à la seconde,
 * celle de React. La revue l'a exécuté : verre système à intensité 100 ET du TEXTE peint dans
 * la zone. Le kit lit donc `type` et `props` UNE SEULE FOIS (voir `callPort`), vérifie cette
 * lecture-là, et RÉ-ÉMET l'élément à partir d'elle : React ne voit plus jamais l'objet du port.
 */
function honorsMaterial(props: unknown, spec: BlurLayerSpec): boolean {
  // Un `props` nul lève ici, et c'est voulu : `callPort` l'attrape et FERME la pile.
  const read = props as Record<string, unknown>;
  return (
    read['intensity'] === spec.intensity &&
    read['tint'] === spec.tint &&
    read['style'] === spec.style &&
    read['children'] === undefined
  );
}

/**
 * UNE bande, UN appel au port — et c'est le point d'architecture du fichier.
 *
 * Le contrat impose une RENDER-PROP : `(spec) => ReactElement | null`. Appelée depuis le rendu
 * de `ProgressiveBlurBob`, les hooks d'un port natif (mesure, capacité, cycle de vie du pont)
 * seraient comptés dans les hooks de `ProgressiveBlurBob` — et c'est lui qui fait tomber N à 0
 * (préférence d'accessibilité, capacité perdue, budget). La PREMIÈRE bascule casserait les
 * règles des hooks : « Rendered fewer hooks than during the previous render ».
 *
 * L'appel est donc isolé dans CE composant : les hooks du port appartiennent à CETTE instance,
 * le nombre d'appels par PASSE DE RENDU de cette instance est invariant — exactement UN —, et
 * passer de N à 0 démonte des instances, ce qui est légal. On obtient la propriété que donnait
 * un adaptateur-composant SANS quitter la signature render-prop du contrat.
 *
 * Le nombre de PASSES, lui, n'est pas au kit : `StrictMode` en fait deux (mesuré : 6 appels
 * pour 3 bandes), et une passe ABANDONNÉE est rejouée par React pour sa trace d'erreur. Un port
 * doit donc être une fonction PURE — c'est déjà ce que le contrat exige de lui.
 *
 * Les hooks du kit sont déclarés AVANT l'appel, à position fixe : quoi que fasse le port, le
 * préfixe de la liste de hooks de cette instance ne bouge pas.
 */
function BlurLayerSlot({ spec, render, ledger, onOutcome }: BlurLayerSlotProps): ReactElement | null {
  const outcome = useRef<SlotOutcome>('element');
  const announced = useRef<SlotOutcome | null>(null);
  /**
   * ANNONCE DU CAS INVISIBLE, dans un effet de MISE EN PAGE — le cas VISIBLE, lui, n'atteint
   * jamais un commit (voir l'abandon de pile plus bas).
   *
   * Ce qui reste à annoncer après coup, ce sont les piles ENTIÈREMENT manquantes : toutes les
   * bandes ont rendu `null`, ou toutes ont levé. L'arbre commité ne porte alors AUCUN
   * échantillon — il est déjà, pixel pour pixel, celui du repli, puisque le voile teinté est
   * rendu dans les deux modes. Le verrou qui suit ne change donc rien à ce que l'œil voit ; il
   * ne fait qu'empêcher de rappeler un port qui a manqué.
   *
   * Effet de MISE EN PAGE et non passif : il court dans la phase de commit, donc au plus tôt.
   * Son coût est nul — il ne lit aucune géométrie, il compare deux références.
   */
  useLayoutEffect(() => {
    const current = outcome.current;
    if (announced.current === current) return;
    announced.current = current;
    if (current !== 'element') onOutcome(spec.index, current);
  });

  const served = callPort(render, spec);
  outcome.current = served.outcome;

  /*
   * TOUT OU RIEN, TENU AVANT LE COMMIT. On inscrit l'issue de CETTE bande, puis on regarde la
   * passe entière : si elle est MIXTE — des bandes servies ET des bandes manquantes —, on
   * ABANDONNE ici, PENDANT le rendu. React déroule alors le sous-arbre jusqu'à
   * `BlurStackBoundary` sans jamais commiter la pile partielle. Aucune frame, aucune révision
   * intermédiaire, aucun observateur : elle n'a pas existé.
   *
   * Le registre est rempli DANS L'ORDRE des bandes, donc la bande qui découvre le mélange est
   * toujours la première à pouvoir le voir. Et il n'y a rien à réparer pour les bandes déjà
   * rendues : leur rendu est jeté avec le reste du sous-arbre.
   */
  ledger[spec.index] = served.outcome;
  if (ledgerIsMixed(ledger)) throw new BlurStackAbort(ledgerFailure(ledger));

  return served.element;
}

/**
 * (a) LA FABRIQUE JETTE — attrapé ICI, à l'appel, et converti en issue plutôt qu'en chute. La
 * bande rend alors `null`, ce qui est visuellement IDENTIQUE au repli : le voile teinté, lui,
 * est rendu par le parent dans les deux modes.
 *
 * Le `try` couvre AUSSI les vérifications : lire `type` ou `props` sur un objet fourni par
 * l'application peut lever (accesseur hostile), et cela doit FERMER, pas tomber.
 *
 * UNE SEULE LECTURE, PUIS RÉ-ÉMISSION — c'est le correctif d'un TOCTOU démontré. Vérifier
 * `element.props` puis rendre `element` laisse React RELIRE `props` : sur un élément forgé à la
 * main, un accesseur rend alors autre chose que ce qui a été vérifié. Le kit lit donc `type` et
 * `props` exactement une fois, dans des locales, puis reconstruit l'élément lui-même avec SA
 * matière — `intensity`, `tint`, `style` — et SANS enfant. Pour un port honnête l'élément
 * reconstruit est identique au sien (les trois champs valaient déjà les nôtres, et il n'avait
 * pas d'enfant) ; pour un port forgé, l'objet piégé n'atteint jamais React.
 */
function callPort(
  render: RenderBlurLayer,
  spec: BlurLayerSpec,
): { readonly outcome: SlotOutcome; readonly element: ReactElement | null } {
  try {
    const returned: unknown = render(spec);
    if (returned === null || returned === undefined) return { outcome: 'null', element: null };
    // Le typage ne protège que le code typé. Une chaîne rendue ici deviendrait du TEXTE dans
    // une zone que le contrat déclare sans texte ni information : on refuse, et on ferme.
    if (!isValidElement(returned)) return { outcome: 'invalid', element: null };
    // LES DEUX SEULES LECTURES, capturées avant tout examen : au-delà, un accesseur pourrait
    // servir une valeur au kit et une autre à React.
    const type: unknown = returned.type;
    const props: unknown = returned.props;
    // `isValidElement()` rend TRUE pour un Fragment — et un Fragment porte n'importe quoi,
    // `<>{'texte'}</>` compris. Il traversait le garde et React peignait le texte. Un Fragment
    // n'est pas une couche : c'est un passe-plat, refusé au même rang que la chaîne nue.
    if (type === Fragment) return { outcome: 'invalid', element: null };
    // La matière rendue doit être celle qu'on a remise — sinon le port impose la sienne là où
    // le lavis ne le couvre pas encore (bord libre). Voir `honorsMaterial`.
    if (!honorsMaterial(props, spec)) return { outcome: 'tampered', element: null };
    return {
      outcome: 'element',
      element: createElement(type as ElementType, {
        ...(props as Record<string, unknown>),
        intensity: spec.intensity,
        tint: spec.tint,
        style: spec.style,
        children: undefined,
      }),
    };
  } catch {
    return { outcome: 'threw', element: null };
  }
}

interface BlurStackBoundaryProps {
  readonly onFailure: (failure: BlurPortFailure) => void;
  readonly children: ReactNode;
}

/**
 * (b) ET (c) — frontière d'erreur autour de TOUTE la pile. Un `try`/`catch` de l'appelant
 * n'attrape pas ce qu'un élément lève pendant SON propre rendu, ni dans un effet, ni dans le
 * NETTOYAGE d'un effet : seule une frontière le fait.
 *
 * Elle enveloppe la pile ENTIÈRE et non chaque bande : la règle TOUT OU RIEN veut qu'une pile
 * dont une couche a manqué disparaisse en entier, jamais partiellement. Quand elle attrape,
 * React démonte le sous-arbre, la frontière rend `null`, le voile du parent reste — l'écran
 * survit et affiche la surface teintée opaque lisible.
 *
 * ELLE EST MONTÉE INCONDITIONNELLEMENT, et c'est le correctif du chemin (c). Rendue
 * `plan.mode === 'blurred' ? <BlurStackBoundary/> : null`, elle disparaissait AU MOMENT MÊME où
 * la pile disparaissait : une frontière supprimée ne peut pas attraper l'erreur de ses propres
 * enfants supprimés, React ne trouvait plus aucune frontière et détruisait la racine. Montée
 * toujours, elle SURVIT à ses enfants et attrape leur nettoyage. Le coût est d'une fibre, en
 * mode teinté comme en mode flouté ; l'écran, lui, n'est plus jouable.
 */
class BlurStackBoundary extends Component<BlurStackBoundaryProps, { failed: boolean }> {
  override state: { failed: boolean } = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    // Le parent LATCHE : ce montage ne rappellera plus le port. React a déjà journalisé
    // l'erreur et sa pile de composants en développement — on n'en recopie rien.
    // Un ABANDON DE PILE porte son propre rang : c'est le kit qui l'a levé, pas le port.
    this.props.onFailure(error instanceof BlurStackAbort ? error.failure : 'element-threw');
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Avertissement du manquement de `onPlan`. STATIQUE et NOMMÉ, comme ceux du port : aucune
 * donnée n'y est interpolée, ni de l'application ni de l'erreur reçue.
 */
const ON_PLAN_THREW_WARNING =
  'ProgressiveBlurBob : le rappel onPlan a LEVÉ. Il est ignoré pour ce changement de plan — un diagnostic décoratif ne fait pas tomber un écran. Corrigez le rappel : le kit ne le retentera pas dans ce cycle.';

/**
 * Rend le plan ATTEIGNABLE : rappel pour l'appelant, avertissements pour le développeur.
 * L'émission se fait dans un EFFET — jamais pendant le rendu — et seulement quand la SIGNATURE
 * du plan change, sinon un changement de thème rejouerait le diagnostic pour rien.
 *
 * `onPlan` EST DU CODE D'APPLICATION, exactement comme le port — et c'est une prop AJOUTÉE par
 * le kit, donc c'est le kit qui a introduit ce risque. Appelée nue dans un effet passif, une
 * erreur y DÉMONTE LA RACINE ENTIÈRE en React 19 : l'écran disparaît parce que la télémétrie
 * est cassée. Même patron que le port, donc : `try`/`catch`, et au plus un avertissement
 * `__DEV__` statique. Le plan suivant sera bien émis — on n'ampute que l'émission fautive.
 */
function usePlanDiagnostics(
  plan: ProgressiveBlurPlan,
  onPlan: ((plan: ProgressiveBlurPlan) => void) | undefined,
): void {
  const signature = [
    plan.mode,
    plan.reason,
    plan.requested,
    plan.granted,
    plan.capped,
    plan.visibleLayers,
    plan.hiddenLayers,
    plan.material.tone,
    plan.material.appearance,
  ].join('|');
  /*
   * Le plan et le rappel les plus récents, publiés dans un EFFET et jamais pendant le rendu.
   * Écrire une ref pendant le rendu retiendrait un plan issu d'une passe que React peut très
   * bien abandonner. Cet effet-ci est déclaré AVANT l'émission : dans un même commit, React
   * exécute les effets dans l'ordre de déclaration, donc l'émission lit toujours à jour.
   */
  const latest = useRef({ plan, onPlan });
  useEffect(() => {
    latest.current = { plan, onPlan };
  });

  useEffect(() => {
    const current = latest.current;
    try {
      current.onPlan?.(current.plan);
    } catch {
      // On ne recopie NI l'erreur NI le plan : message statique, aucune donnée interpolée.
      if (isDevelopment()) console.warn(ON_PLAN_THREW_WARNING);
    }
    if (!isDevelopment()) return;
    for (const warning of progressiveBlurWarnings(current.plan)) console.warn(warning);
  }, [signature]);
}

/**
 * Avertit UNE fois par montage du manquement d'un port. Message STATIQUE et NOMMÉ, jamais en
 * production. `null-at-zero` est SILENCIEUX : le contrat en fait la bascule normale vers le
 * repli (« le port n'a rien à monter », Android < 31), pas une anomalie.
 */
function usePortFailureWarning(failure: BlurPortFailure | undefined): void {
  const warned = useRef(false);
  useEffect(() => {
    if (failure === undefined || warned.current || !isDevelopment()) return;
    const message = BLUR_PORT_FAILURE_WARNINGS[failure];
    if (message === undefined) return;
    warned.current = true;
    console.warn(message);
  }, [failure]);
}

export function ProgressiveBlurBob({
  anchor,
  height,
  layers = patterns.edgeFalloff.defaultLayers,
  renderBlurLayer,
  tone = 'canvas',
  renderCapability,
  surfaceUnder,
  devShellHeight,
  onPlan,
  style,
  testID,
}: ProgressiveBlurBobViewProps): ReactElement {
  const { appearance } = useTheme();
  const transparency = useTransparencyPreference();

  /**
   * LE VERROU. Une fois posé il ne se lève plus : ni un changement de props, ni un nouveau
   * port, ni une bascule d'accessibilité ne le rouvrent. C'est ce qui rend la dégradation
   * DÉFINITIVE et ce qui empêche un port intermittent de faire clignoter l'écran.
   */
  const [portFailure, setPortFailure] = useState<BlurPortFailure | undefined>(undefined);
  const latchFailure = useCallback((failure: BlurPortFailure) => {
    // Le premier manquement gagne : l'état ne change plus, donc React ne re-rend pas en boucle.
    setPortFailure((current) => current ?? failure);
  }, []);
  /**
   * Issue d'une bande dans une pile ENTIÈREMENT manquante — le seul cas qui parvienne encore
   * ici, puisqu'une pile mixte est abandonnée AVANT le commit. `null` partout est la bascule
   * NORMALE du contrat (« le port n'a rien à monter ») : elle ne s'annonce pas comme une faute.
   */
  const handleOutcome = useCallback(
    (_index: number, outcome: Exclude<SlotOutcome, 'element'>) => {
      latchFailure(outcome === 'null' ? 'null-at-zero' : SLOT_FAILURES[outcome]);
    },
    [latchFailure],
  );

  const material = useMemo(() => resolveBlurMaterial(tone, appearance), [tone, appearance]);
  const port = useMemo(() => resolveBlurPort(renderBlurLayer), [renderBlurLayer]);
  /**
   * ASSERTION D'ENGLOBEMENT (§ 4), tri-état et fail-CLOSED. En PRODUCTION aucune mesure n'est
   * faite — le socle l'écrit, l'invariant y est structurel : on transmet `within`. En
   * DÉVELOPPEMENT, une hauteur de shell non déclarée n'est pas « pas de problème », c'est
   * « assertion impossible » : elle vaut refus, et le développeur reçoit un avertissement nommé.
   *
   * ON NE COERCE RIEN. `height > devShellHeight` sur une valeur qui n'est pas un nombre
   * appellerait son `valueOf` — un `valueOf` qui lève emporterait l'écran depuis le RENDU, au
   * -dessus de toute frontière. `Number.isFinite` ne convertit pas : il répond `false` et
   * l'assertion redevient simplement « impossible », donc refus.
   */
  const shellHeight = Number.isFinite(devShellHeight) ? Number(devShellHeight) : Number.NaN;
  const envelope: BlurEnvelopeAssertion = !isDevelopment()
    ? 'within'
    : !Number.isFinite(shellHeight) || !Number.isFinite(height)
      ? 'unverified'
      : height > shellHeight
        ? 'overflow'
        : 'within';

  const plan = progressiveBlurPlan({
    layers,
    anchor,
    height,
    port: port.status,
    portFailure,
    transparency,
    material,
    capability: renderCapability,
    surfaceUnder,
    envelope,
  });
  usePlanDiagnostics(plan, onPlan);
  usePortFailureWarning(portFailure);

  const veil = edgeVeilGradient(tone, appearance, anchor);
  const wash = edgeWashGradient(material, anchor);
  const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;
  const renderLayer = port.render;
  /*
   * REGISTRE DE LA PASSE — neuf à chaque rendu du parent, donc jamais pollué par la passe
   * précédente, et jamais un état : ce n'est pas une mémoire, c'est le brouillon d'un rendu.
   * C'est lui qui permet à une bande de constater le TOUT OU RIEN AVANT le commit.
   */
  const ledger: StackLedger = [];

  return (
    <View
      testID={testID}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          position: 'absolute',
          left: 0,
          right: 0,
          height,
          overflow: 'hidden',
          ...(anchor === 'bottom' ? { bottom: 0 } : { top: 0 }),
        },
        style,
      ]}
    >
      {/* 1 — LES BANDES, d'abord : elles passeront SOUS le voile. Ni `zIndex`, ni `elevation`,
             ni token d'ombre nulle part ici — l'ordre de déclaration est le seul arbitre.
             La FRONTIÈRE, elle, est montée dans les DEUX modes : c'est ce qui lui permet de
             survivre au démontage de la pile et d'attraper un nettoyage qui jette (chemin c). */}
      <BlurStackBoundary onFailure={latchFailure}>
        {plan.mode === 'blurred' && renderLayer !== undefined
          ? plan.layers.map((spec) => (
              <View
                key={spec.index}
                pointerEvents="none"
                // CLIP — le port ne peut pas peindre un pixel hors de sa bande. La bande a
                // EXACTEMENT le rectangle de `spec.style` : le clip est géométriquement neutre
                // pour un port conforme, et une prison pour un port hostile.
                style={{
                  ...blurLayerStyle(spec.anchor, spec.heightPercent, height),
                  overflow: 'hidden',
                }}
              >
                <BlurLayerSlot
                  spec={spec}
                  render={renderLayer}
                  ledger={ledger}
                  onOutcome={handleOutcome}
                />
                {/* LE LAVIS — notre teinte PAR-DESSUS l'échantillon, dans la bande, en dernier. */}
                <LinearGradient
                  pointerEvents="none"
                  colors={[...wash.colors] as [string, string, ...string[]]}
                  start={wash.start}
                  end={wash.end}
                  style={{ ...fill, opacity: wash.opacity }}
                />
              </View>
            ))
          : null}
      </BlurStackBoundary>

      {/* 2 — LE VOILE TEINTÉ BOB, déclaré EN DERNIER donc peint AU-DESSUS. Rendu dans les DEUX
             modes : c'est ce qui fait que le repli montre la même géométrie, la même courbe et
             la même couleur, et qu'il n'y a jamais de trou visuel ni d'aplat gris. */}
      <LinearGradient
        pointerEvents="none"
        colors={[...veil.colors] as [string, string, ...string[]]}
        locations={[...veil.locations] as [number, number, ...number[]]}
        start={veil.start}
        end={veil.end}
        style={fill}
      />
    </View>
  );
}
