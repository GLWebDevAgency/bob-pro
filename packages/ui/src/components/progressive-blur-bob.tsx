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
 * Le clip et le lavis ne sont pas décoratifs : ce sont les DEUX barrières qui rendent la
 * teinte du système inatteignable. Un port ne peut peindre ni hors de sa bande, ni par-dessus
 * notre teinte — au mieux dessous. Et le clip est GÉOMÉTRIQUEMENT NEUTRE : la bande a
 * exactement le rectangle que `spec.style` décrit, donc un port conforme rend les mêmes
 * pixels avec ou sans lui. Le clip ne coûte rien à l'honnête et arrête l'hostile.
 *
 * AUCUNE ANIMATION, dans aucun mode, ni en Reduced Motion. Il n'y a donc aucune valeur animée
 * à recalculer, aucun coût JS par frame sous le scroll, et rien à dégrader quand la préférence
 * « réduire les animations » est active — donc aucun chemin de rendu alternatif non testé.
 *
 * ─── UN PORT QUI JETTE N'EMPORTE PAS L'ÉCRAN ──────────────────────────────────────────────
 * Le port vient de l'APPLICATION : c'est du code que `packages/ui` ne contrôle pas. S'il lève,
 * React démonte l'arbre et l'écran entier disparaît. Un effet DÉCORATIF ne doit JAMAIS faire
 * tomber un écran où l'artisan encaisse une facture. Il y a DEUX chemins distincts, et un seul
 * mécanisme ne les couvre pas tous les deux :
 *
 *   (a) LA FABRIQUE JETTE — l'appel à `renderBlurLayer` lève pendant la construction.
 *       Un `try`/`catch` autour de l'APPEL l'attrape (`BlurLayerSlot`).
 *   (b) L'ÉLÉMENT RENDU JETTE — la fabrique rend un élément VALIDE qui lève pendant SON rendu
 *       ou dans un effet. Un `try`/`catch` de l'appelant n'attrape RIEN de cela : il faut une
 *       FRONTIÈRE D'ERREUR (`BlurStackBoundary`, `getDerivedStateFromError` +
 *       `componentDidCatch`).
 *
 * Dans les deux cas l'écran survit et l'utilisateur voit la surface teintée opaque, lisible.
 * La dégradation est DÉFINITIVE pour la vie du composant : un port qui a manqué n'est plus
 * rappelé — sinon on remplacerait un écran mort par une boucle d'erreurs, et un port
 * INTERMITTENT ferait clignoter l'écran. Enfin l'échec n'est pas silencieux pour le
 * développeur : avertissement NOMMÉ, en développement seulement, à message STATIQUE — aucune
 * donnée n'y est interpolée.
 */
import {
  Component,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
type SlotOutcome = 'element' | 'null' | 'threw' | 'invalid';

interface BlurLayerSlotProps {
  readonly spec: BlurLayerSpec;
  readonly render: RenderBlurLayer;
  readonly onOutcome: (index: number, outcome: SlotOutcome) => void;
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
 * le nombre d'appels par instance est invariant — exactement UN —, et passer de N à 0 démonte
 * des instances, ce qui est légal. On obtient la propriété que donnait un adaptateur-composant
 * SANS quitter la signature render-prop du contrat.
 *
 * Les hooks du kit sont déclarés AVANT l'appel, à position fixe : quoi que fasse le port, le
 * préfixe de la liste de hooks de cette instance ne bouge pas.
 */
function BlurLayerSlot({ spec, render, onOutcome }: BlurLayerSlotProps): ReactElement | null {
  const outcome = useRef<SlotOutcome>('element');
  const announced = useRef<SlotOutcome | null>(null);
  useEffect(() => {
    const current = outcome.current;
    if (announced.current === current) return;
    announced.current = current;
    if (current !== 'element') onOutcome(spec.index, current);
  });

  // (a) LA FABRIQUE JETTE — attrapé ici, à l'appel. La bande rend alors `null`, ce qui est
  //     visuellement IDENTIQUE au repli : le voile teinté, lui, est rendu par le parent dans
  //     les deux modes. Il n'y a donc pas même une frame de différence à l'écran.
  try {
    const element: unknown = render(spec);
    if (element === null || element === undefined) {
      outcome.current = 'null';
      return null;
    }
    // Le typage ne protège que le code typé. Une chaîne rendue ici deviendrait du TEXTE dans
    // une zone que le contrat déclare sans texte ni information : on refuse, et on ferme.
    if (!isValidElement(element)) {
      outcome.current = 'invalid';
      return null;
    }
    outcome.current = 'element';
    return element as ReactElement;
  } catch {
    outcome.current = 'threw';
    return null;
  }
}

interface BlurStackBoundaryProps {
  readonly onFailure: (failure: BlurPortFailure) => void;
  readonly children: ReactNode;
}

/**
 * (b) L'ÉLÉMENT RENDU JETTE — frontière d'erreur autour de TOUTE la pile. Un `try`/`catch` de
 * l'appelant n'attrape pas ce qu'un élément lève pendant SON propre rendu, ni ce qu'il lève
 * dans un effet : seule une frontière le fait.
 *
 * Elle enveloppe la pile ENTIÈRE et non chaque bande : la règle TOUT OU RIEN veut qu'une pile
 * dont une couche a manqué disparaisse en entier, jamais partiellement. Quand elle attrape,
 * React démonte le sous-arbre, la frontière rend `null`, le voile du parent reste — l'écran
 * survit et affiche la surface teintée opaque lisible.
 */
class BlurStackBoundary extends Component<BlurStackBoundaryProps, { failed: boolean }> {
  override state: { failed: boolean } = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    // Le parent LATCHE : ce montage ne rappellera plus le port. React a déjà journalisé
    // l'erreur et sa pile de composants en développement — on n'en recopie rien.
    this.props.onFailure('element-threw');
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Rend le plan ATTEIGNABLE : rappel pour l'appelant, avertissements pour le développeur.
 * L'émission se fait dans un EFFET — jamais pendant le rendu — et seulement quand la SIGNATURE
 * du plan change, sinon un changement de thème rejouerait le diagnostic pour rien.
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
  const latest = useRef({ plan, onPlan });
  latest.current = { plan, onPlan };

  useEffect(() => {
    const current = latest.current;
    current.onPlan?.(current.plan);
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
  const handleOutcome = useCallback(
    (index: number, outcome: SlotOutcome) => {
      if (outcome === 'threw') return latchFailure('factory-threw');
      if (outcome === 'invalid') return latchFailure('invalid-element');
      // TOUT OU RIEN : `null` à l'index 0 est la bascule du contrat ; `null` à un autre index
      // signe une pile PARTIELLE, que le contrat interdit — les deux ferment le flou.
      return latchFailure(index === 0 ? 'null-at-zero' : 'partial-stack');
    },
    [latchFailure],
  );

  const material = useMemo(() => resolveBlurMaterial(tone, appearance), [tone, appearance]);
  const port = useMemo(() => resolveBlurPort(renderBlurLayer), [renderBlurLayer]);
  // Assertion d'englobement : mesurée en DÉVELOPPEMENT seulement, jamais en production.
  const envelopeOverflow =
    isDevelopment() && devShellHeight !== undefined && height > devShellHeight;

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
    envelopeOverflow,
  });
  usePlanDiagnostics(plan, onPlan);
  usePortFailureWarning(portFailure);

  const veil = edgeVeilGradient(tone, appearance, anchor);
  const wash = edgeWashGradient(material, anchor);
  const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;
  const renderLayer = port.render;

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
             ni token d'ombre nulle part ici — l'ordre de déclaration est le seul arbitre. */}
      {plan.mode === 'blurred' && renderLayer !== undefined ? (
        <BlurStackBoundary onFailure={latchFailure}>
          {plan.layers.map((spec) => (
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
              <BlurLayerSlot spec={spec} render={renderLayer} onOutcome={handleOutcome} />
              {/* LE LAVIS — notre teinte PAR-DESSUS l'échantillon, dans la bande, en dernier. */}
              <LinearGradient
                pointerEvents="none"
                colors={[...wash.colors] as [string, string, ...string[]]}
                start={wash.start}
                end={wash.end}
                style={{ ...fill, opacity: wash.opacity }}
              />
            </View>
          ))}
        </BlurStackBoundary>
      ) : null}

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
