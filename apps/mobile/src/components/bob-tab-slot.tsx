/**
 * COMPORTEMENT 5 — LE SLOT D'ÉCRAN QUI S'EFFACE (04 § 5).
 *
 * L'écran ENTRANT fond de 0 à 1 avec une micro-échelle 0,985 → 1, en `motionSemantic.replace`
 * (280 ms, token LIVRÉ et gelé), courbe `easing.enter`. L'écran SORTANT n'est pas animé du
 * tout : sa progression est REMISE À 0 dans la frame — jamais deux écrans animés qui se
 * croisent. Le tout premier écran au lancement n'est pas animé non plus.
 *
 * ─── CE QU'ON N'A PAS RECOPIÉ DE LA RÉFÉRENCE ───────────────────────────────────────────
 *  · sa durée de 220 ms (`fading-tab-slot.tsx` l. 28) : un fade-through est EXACTEMENT le cas
 *    d'usage de `motionSemantic.replace`, dont la valeur livrée vaut 280. Le dossier CONSOMME
 *    ce token, il ne le revalorise pas ;
 *  · sa bézier écrite inline : la courbe est `easing.enter` du kit ;
 *  · son silence sur Reduce Motion : elle ne l'écoute nulle part. Ici, durée 0 — et la fenêtre
 *    où la préférence est encore INCONNUE compte comme active (règle fail-closed A18).
 *
 * ─── ZÉRO ÉCRAN LIVRÉ N'EST TOUCHÉ ──────────────────────────────────────────────────────
 * Ce composant est un enveloppeur de SLOT, pas un restyling : il ne connaît pas le contenu qu'il
 * enveloppe. Il est monté par `apps/mobile/app/(tabs)/_layout.tsx` via `screenLayout`, autour de
 * CHAQUE écran d'onglet, et uniquement quand `mobile_tabs_experiment_v1` est allumé. Hors flag,
 * `screenLayout` n'est pas passé au navigateur et ce composant n'apparaît nulle part.
 *
 * *(Rédaction précédente, FAUSSE : « Il n'est monté que par le layout d'onglets sous flag » — le
 * layout ne l'importait pas. Le fade-through n'était donc rendu NULLE PART, flag allumé ou non :
 * un comportement écrit, testé, et jamais livré. La phrase disait le contraire.)*
 */
import { useEffect, useRef, type PropsWithChildren, type ReactElement } from 'react';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { TAB_SLOT_ENTER_SCALE, fadeThroughPlan, useReduceMotionPreference } from '@bob/ui';

/**
 * `easing.enter` du kit — `cubic-bezier(0, 0, 0, 1)`, entrée décélérée
 * ([03 § Courbes proposées](../../../docs/mobile-experience/03-motion-interaction-system.md)).
 * Elle est écrite ici sous la forme que Reanimated comprend ; la valeur, elle, vient du kit et
 * n'est pas une bézier inventée pour l'occasion.
 */
const ENTER_EASING = Easing.bezier(0, 0, 0, 1);

export interface BobTabSlotFadeProps {
  readonly focused: boolean;
  readonly testID?: string | undefined;
}

export function BobTabSlotFade({
  focused,
  children,
  testID,
}: PropsWithChildren<BobTabSlotFadeProps>): ReactElement {
  const reduceMotion = useReduceMotionPreference();
  const progress = useSharedValue(1);
  /**
   * DERNIER FOCUS TRAITÉ. `null` = on n'a encore rien traité, donc c'est le premier rendu.
   *
   * CETTE RÉFÉRENCE EST LA RÈGLE A18 RENDUE EXÉCUTABLE, et elle a été ajoutée sur constat d'un
   * test rouge, pas par précaution : `reduceMotion` est une dépendance de cet effet, et il
   * CHANGE tout seul — de `'unknown'` à sa valeur réelle, quelques millisecondes après le
   * montage. Sans cette garde, l'effet rejouait à ce moment-là et l'écran monté pendant la
   * fenêtre inconnue était RÉ-ANIMÉ à la résolution : exactement ce que le socle interdit
   * (« un élément monté pendant la fenêtre inconnue est rendu dans son état final et n'est
   * JAMAIS ré-animé »). On n'agit donc que si le FOCUS a changé.
   */
  const lastFocused = useRef<boolean | null>(null);

  useEffect(() => {
    const firstRender = lastFocused.current === null;
    if (lastFocused.current === focused) return;
    lastFocused.current = focused;
    const plan = fadeThroughPlan({ focused, firstRender, reduceMotion });

    if (plan.hideInstantly) {
      /*
       * L'ÉCRAN SORTANT — sa progression retombe à 0 dans la frame, sans course : opacité 0,
       * échelle 0,985. Et il cesse de recevoir des touches (voir `pointerEvents` ci-dessous),
       * ce qui est la seule chose qui rende « masqué » vrai : une vue à opacité 0 reste
       * PARFAITEMENT tactile, et un doigt qui tombe dessus toucherait l'écran d'à côté.
       *
       * *(Rédaction précédente, FAUSSE : « masqué instantanément (`display: none` côté
       * conteneur) ». Aucun conteneur du dépôt ne pose `display: none` — le navigateur peut
       * détacher ses scènes, mais ce n'est ni notre code ni notre garantie. On ne s'appuie
       * donc plus dessus : on coupe nous-mêmes le dispatch.)*
       */
      progress.value = 0;
      return;
    }
    if (!plan.animate) {
      // État FINAL directement — premier rendu, Reduce Motion, ou préférence encore INCONNUE.
      // Rien ne sera rejoué quand la préférence arrivera : seules les entrées SUIVANTES animent.
      progress.value = 1;
      return;
    }
    progress.value = plan.opacityFrom;
    progress.value = withTiming(1, { duration: plan.duration, easing: ENTER_EASING });
  }, [focused, progress, reduceMotion]);

  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    // Un souffle de profondeur, jamais une entrée depuis rien : l'échelle reste ≥ 0,985.
    transform: [{ scale: interpolate(progress.value, [0, 1], [TAB_SLOT_ENTER_SCALE, 1]) }],
  }));

  return (
    <Animated.View
      testID={testID}
      // Un écran non focusé est invisible ET intouchable. `pointerEvents` suit le FOCUS, pas
      // l'opacité : la coupure doit être vraie dès la frame du changement d'onglet, sans
      // attendre la fin d'une animation qui, pour l'écran sortant, n'existe même pas.
      pointerEvents={focused ? 'auto' : 'none'}
      style={[{ flex: 1 }, style]}
    >
      {children}
    </Animated.View>
  );
}
