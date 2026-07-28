/**
 * Motion de PRÉSENCE — logique pure du kit « matière Bob » (P1 §1.4, câblée par la revue du
 * train n°2) : les micro-interactions spécifiées aux écrans §2.1 consomment les tokens
 * `motionSemantic` — insertion + highlight `enter 240` APRÈS ACK, sortie de rangée
 * `exitFast 140` (layout transition vers Retirés), morph d'état `replace 280`.
 * TABLE REDUCE-MOTION = ÉQUIVALENCE D'INFORMATION : toutes les durées passent à 0 (immédiat)
 * et l'écran ANNONCE le fait (announceForAccessibility) — jamais une info perdue.
 * Transform/opacity uniquement, interruptible ; zéro couleur ici (token-lint).
 */
import { motionSemantic } from '@bob/tokens';

export interface PresenceMotion {
  /** Insertion d'une rangée après ACK (création) — motionSemantic.enter. */
  enter: number;
  /** Sortie d'une rangée (retrait) — motionSemantic.exitFast, plus rapide que l'entrée. */
  exitFast: number;
  /** Remplacement d'un état par un autre (badge morph) — motionSemantic.replace. */
  replace: number;
  /** false = reduce-motion : IMMÉDIAT — l'équivalence d'information passe par l'annonce. */
  animated: boolean;
}

/** Résout la table de motion selon Reduce Motion (immédiat = toutes durées à 0). */
export function resolvePresenceMotion(reduceMotion: boolean): PresenceMotion {
  if (reduceMotion) return { enter: 0, exitFast: 0, replace: 0, animated: false };
  return {
    enter: motionSemantic.enter,
    exitFast: motionSemantic.exitFast,
    replace: motionSemantic.replace,
    animated: true,
  };
}

export interface RowPresenceView {
  /** Clé de VUE (segment + filtre) : à son changement, AUCUNE animation de rangée — le
   * remplacement de contenu est un autre registre que l'insertion/le retrait. */
  viewKey: string;
  keys: readonly string[];
}

export interface RowPresenceDiff {
  /** Rangées apparues dans la MÊME vue (insertion réelle → enter). */
  entered: readonly string[];
  /** Rangées disparues de la MÊME vue (retrait réel → exit), avec leur index d'origine. */
  exited: readonly { key: string; index: number }[];
  /** true = amorçage ou bascule de vue : reprise sans animation. */
  reset: boolean;
}

/** Diffe deux instantanés de liste — pur, ordre STABLE, jamais d'animation trans-vue. */
export function diffRowPresence(
  previous: RowPresenceView | null,
  next: RowPresenceView,
): RowPresenceDiff {
  if (previous === null || previous.viewKey !== next.viewKey) {
    return { entered: [], exited: [], reset: true };
  }
  const previousKeys = new Set(previous.keys);
  const nextKeys = new Set(next.keys);
  return {
    entered: next.keys.filter((key) => !previousKeys.has(key)),
    exited: previous.keys
      .map((key, index) => ({ key, index }))
      .filter((entry) => !nextKeys.has(entry.key)),
    reset: false,
  };
}

/**
 * Fusionne les rangées SORTANTES (déjà retirées des données mais encore affichées le temps de
 * l'exit 140) aux rangées courantes, à leur index d'origine borné. Une clé revenue dans les
 * données (retrait annulé) n'est jamais dupliquée : la rangée vivante prime.
 */
export function mergeExitingKeys(
  currentKeys: readonly string[],
  exiting: readonly { key: string; index: number }[],
): string[] {
  const merged = [...currentKeys];
  const alive = new Set(currentKeys);
  for (const entry of [...exiting].sort((a, b) => a.index - b.index)) {
    if (alive.has(entry.key) || merged.includes(entry.key)) continue;
    merged.splice(Math.min(entry.index, merged.length), 0, entry.key);
  }
  return merged;
}
