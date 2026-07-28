/**
 * Motion de PRÉSENCE — composants du kit « matière Bob » (P1 §1.4, câblés par la revue du
 * train n°2). Trois pièces, transform/opacity UNIQUEMENT, interruptibles :
 *  · `useRowPresence` — suit une liste et fait VIVRE ses rangées : insertion `enter 240`,
 *    sortie `exitFast 140` (la rangée retirée reste affichée le temps de son fondu) ; une
 *    bascule de vue (segment/filtre) ne joue JAMAIS d'animation (autre registre) ;
 *  · `PresenceRow` — enveloppe animée d'une rangée (+ highlight d'insertion après ACK,
 *    voile de couleur passé par l'écran — zéro hex ici, token-lint) ;
 *  · `MorphReplace` — remplacement d'un état par un autre (badge morph, `replace 280`).
 * REDUCE-MOTION = ÉQUIVALENCE D'INFORMATION : tout est immédiat, et l'écran ANNONCE le fait
 * au point d'ACK (announceForAccessibility) — jamais une info portée par le seul mouvement.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import {
  diffRowPresence,
  mergeExitingKeys,
  resolvePresenceMotion,
  type PresenceMotion,
} from './motion-presence.logic';

export type RowPresenceState = 'enter' | 'idle' | 'exit';

export interface PresentRow<T> {
  key: string;
  item: T;
  presence: RowPresenceState;
}

export interface RowPresenceResult<T> {
  rows: PresentRow<T>[];
  motion: PresenceMotion;
}

interface PresenceTrack<T> {
  viewKey: string;
  keys: string[];
  byKey: Map<string, T>;
  entered: Set<string>;
  exiting: { key: string; index: number; item: T }[];
}

const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((key, index) => key === b[index]);

/**
 * Fait vivre les rangées d'une liste réelle : diffe les clés d'un rendu à l'autre (même
 * `viewKey` seulement), marque les entrantes (`enter`) et RETIENT les sortantes (`exit`)
 * le temps de `exitFast` avant de les purger. Le diff se fait EN RENDU (la rangée retirée
 * ne clignote jamais) ; reduce-motion : retrait immédiat, aucune rétention.
 */
export function useRowPresence<T>(input: {
  items: readonly T[];
  keyOf: (item: T) => string;
  viewKey: string;
}): RowPresenceResult<T> {
  const reduceMotion = useReduceMotion();
  const motion = resolvePresenceMotion(reduceMotion);
  const trackRef = useRef<PresenceTrack<T> | null>(null);
  // Horloge de purge : chaque bump retire sortantes échues et marques d'entrée consommées.
  const [, setPurgeTick] = useState(0);

  const keys = input.items.map(input.keyOf);
  const byKey = new Map<string, T>();
  input.items.forEach((item, index) => byKey.set(keys[index]!, item));

  const previous = trackRef.current;
  const diff = diffRowPresence(
    previous === null ? null : { viewKey: previous.viewKey, keys: previous.keys },
    { viewKey: input.viewKey, keys },
  );
  if (previous === null || diff.reset) {
    trackRef.current = {
      viewKey: input.viewKey,
      keys,
      byKey,
      entered: new Set<string>(),
      exiting: [],
    };
  } else if (!sameKeys(previous.keys, keys)) {
    const entered = new Set(previous.entered);
    for (const key of diff.entered) entered.add(key);
    // Une clé revenue (retrait annulé) quitte les sortantes : la rangée vivante prime.
    const stillExiting = previous.exiting.filter((entry) => !byKey.has(entry.key));
    const additions = motion.animated
      ? diff.exited
          .map((entry) => ({ ...entry, item: previous.byKey.get(entry.key) }))
          .filter((entry): entry is { key: string; index: number; item: T } => entry.item !== undefined)
      : [];
    trackRef.current = {
      viewKey: input.viewKey,
      keys,
      byKey,
      entered,
      exiting: [
        ...stillExiting.filter((entry) => !additions.some((added) => added.key === entry.key)),
        ...additions,
      ],
    };
  } else {
    // Même vue, mêmes clés : rafraîchit les items (données rechargées) sans toucher au motion.
    trackRef.current = { ...previous, byKey };
  }

  const track = trackRef.current;
  const exitingCount = track.exiting.length;
  const enteredCount = track.entered.size;
  useEffect(() => {
    if (exitingCount === 0 && enteredCount === 0) return;
    // La purge attend la FIN du plus long mouvement (enter + voile replace) — une marque
    // d'entrée consommée trop tôt casserait l'animation en vol.
    const settleMs = Math.max(motion.exitFast, motion.enter + motion.replace) + 40;
    const timer = setTimeout(() => {
      const current = trackRef.current;
      if (current !== null) trackRef.current = { ...current, exiting: [], entered: new Set() };
      setPurgeTick((tick) => tick + 1);
    }, settleMs);
    return () => clearTimeout(timer);
  }, [exitingCount, enteredCount, motion.exitFast, motion.enter, motion.replace]);

  const mergedKeys = mergeExitingKeys(
    track.keys,
    track.exiting.map(({ key, index }) => ({ key, index })),
  );
  const rows = mergedKeys.map((key): PresentRow<T> => {
    const live = track.byKey.get(key);
    if (live !== undefined) {
      return {
        key,
        item: live,
        presence: motion.animated && track.entered.has(key) ? 'enter' : 'idle',
      };
    }
    const exiting = track.exiting.find((entry) => entry.key === key)!;
    return { key, item: exiting.item, presence: 'exit' };
  });
  return { rows, motion };
}

export interface PresenceRowProps {
  presence: RowPresenceState;
  motion: PresenceMotion;
  /** Voile d'INSERTION après ACK (création §2.1) : couleur passée par l'écran (tokens). */
  highlightColor?: string;
  /** Rayon du voile de highlight (aligne la rangée sur sa surface). */
  highlightRadius?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

/**
 * Enveloppe animée d'une rangée : enter 240 (fondu + 6 px), exit 140 (fondu sortant, plus
 * rapide — l'œil suit l'arrivée), highlight d'insertion en simple voile d'opacité.
 * Interruptible : un retrait annulé ramène la rangée depuis sa valeur courante.
 * Reduce-motion (motion.animated = false) : rendu immédiat, aucun voile.
 */
export function PresenceRow({
  presence,
  motion,
  highlightColor,
  highlightRadius,
  style,
  children,
}: PresenceRowProps) {
  const progress = useRef(
    new Animated.Value(presence === 'enter' && motion.animated ? 0 : 1),
  ).current;
  const highlight = useRef(new Animated.Value(0)).current;
  const enterStarted = useRef(false);
  const lastPresence = useRef<RowPresenceState>(presence);

  useEffect(() => {
    const cameFrom = lastPresence.current;
    lastPresence.current = presence;
    if (!motion.animated) {
      progress.setValue(presence === 'exit' ? 0 : 1);
      return;
    }
    if (presence === 'exit') {
      // Interruptible : le fondu sortant part de la valeur COURANTE.
      Animated.timing(progress, {
        toValue: 0,
        duration: motion.exitFast,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }
    if (presence === 'enter' && !enterStarted.current) {
      enterStarted.current = true;
      Animated.timing(progress, {
        toValue: 1,
        duration: motion.enter,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      if (highlightColor !== undefined) {
        // Voile d'insertion : visible pendant l'entrée, puis fondu `replace` — opacité pure.
        highlight.setValue(1);
        Animated.timing(highlight, {
          toValue: 0,
          duration: motion.replace,
          delay: motion.enter,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }).start();
      }
      return;
    }
    if (presence === 'idle' && cameFrom === 'exit') {
      // Retrait ANNULÉ : la rangée revient — jamais un fantôme bloqué à mi-fondu.
      Animated.timing(progress, {
        toValue: 1,
        duration: motion.exitFast,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [presence, motion, progress, highlight, highlightColor]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }),
            },
          ],
        },
      ]}
    >
      {highlightColor !== undefined && motion.animated ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: -6,
            right: -6,
            backgroundColor: highlightColor,
            borderRadius: highlightRadius ?? 10,
            opacity: highlight,
          }}
        />
      ) : null}
      {children}
    </Animated.View>
  );
}

export interface MorphReplaceProps {
  /** Clé d'ÉTAT : son changement déclenche le morph (ex. `active` → `retired`). */
  morphKey: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

/**
 * Remplacement d'un état par un autre (badge morph §2.1/§2.2) : l'état sortant fond, l'état
 * entrant fond + micro-échelle — `replace 280` au total, interruptible (un changement en vol
 * repart vers le contenu le PLUS RÉCENT demandé). Reduce-motion : bascule immédiate.
 */
export function MorphReplace({ morphKey, style, children }: MorphReplaceProps) {
  const reduceMotion = useReduceMotion();
  const motion = resolvePresenceMotion(reduceMotion);
  const opacity = useRef(new Animated.Value(1)).current;
  const [displayed, setDisplayed] = useState<{ key: string; node: ReactNode }>({
    key: morphKey,
    node: children,
  });
  // L'état ENTRANT est toujours le plus récent demandé (interruption propre).
  const target = useRef<{ key: string; node: ReactNode }>({ key: morphKey, node: children });
  target.current = { key: morphKey, node: children };

  useEffect(() => {
    if (morphKey === displayed.key) return;
    if (!motion.animated) {
      opacity.setValue(1);
      setDisplayed({ ...target.current });
      return;
    }
    Animated.timing(opacity, {
      toValue: 0,
      duration: motion.replace / 2,
      easing: Easing.in(Easing.ease),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      setDisplayed({ ...target.current });
      Animated.timing(opacity, {
        toValue: 1,
        duration: motion.replace / 2,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    });
  }, [morphKey, displayed.key, motion, opacity]);

  // Même état : le contenu suit les données EN DIRECT ; en morph, l'instantané sortant reste
  // affiché jusqu'au point bas du fondu.
  const node = displayed.key === morphKey ? children : displayed.node;
  return (
    <Animated.View
      style={[
        style,
        {
          opacity,
          transform: [
            { scale: opacity.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
          ],
        },
      ]}
    >
      {node}
    </Animated.View>
  );
}
