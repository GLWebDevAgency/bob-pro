/**
 * useReduceMotion — comportement FAIL-CLOSED (Lot 0, plan DA 01/08) de l'implémentation
 * UNIQUE : pendant la fenêtre d'ignorance (préférence système non résolue) le hook répond
 * `true` (RÉDUIT — pas d'animation), puis reflète la résolution et les changements système.
 * La MÉMOIRE DE MODULE (dernière valeur résolue) fait que seuls le tout premier montage et
 * les échecs de lecture traversent la fenêtre fermée — d'où `vi.resetModules()` + import
 * dynamique : chaque test repart d'une mémoire vierge, comme un démarrage à froid.
 * AccessibilityInfo est mocké (aucun accès natif sous vitest) ; le composant Probe rend
 * `null` : seul react-test-renderer pilote le cycle de vie React (effets compris).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, create } from 'react-test-renderer';

// react-test-renderer (React 19) exige ce drapeau pour flush les effets dans `act(...)`
// sous un runner hors navigateur/Jest (aucun `act`-environment configuré par défaut ici).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (enabled: boolean) => void;

const isReduceMotionEnabled = vi.fn<() => Promise<boolean>>();
const removeListener = vi.fn();
let capturedListener: Listener | null = null;
const addEventListener = vi.fn((_event: string, listener: Listener) => {
  capturedListener = listener;
  return { remove: removeListener };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: (...args: unknown[]) =>
      (isReduceMotionEnabled as unknown as (...a: unknown[]) => Promise<boolean>)(...args),
    addEventListener: (...args: [string, Listener]) => addEventListener(...args),
  },
}));

/** Mémoire de module VIERGE à chaque chargement — l'équivalent d'un démarrage à froid. */
async function loadHook(): Promise<typeof import('./use-reduce-motion')> {
  vi.resetModules();
  return import('./use-reduce-motion');
}

function makeProbe(useReduceMotion: () => boolean) {
  return function Probe({ onValue }: { onValue: (v: boolean) => void }) {
    onValue(useReduceMotion());
    return null;
  };
}

beforeEach(() => {
  isReduceMotionEnabled.mockReset();
  addEventListener.mockClear();
  removeListener.mockClear();
  capturedListener = null;
});

describe('useReduceMotion — fail-closed', () => {
  it('démarre RÉDUIT (true) avant résolution de la préférence système — aucune animation avant de savoir', async () => {
    const { useReduceMotion } = await loadHook();
    const Probe = makeProbe(useReduceMotion);
    let resolvePromise: (v: boolean) => void = () => {};
    isReduceMotionEnabled.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolvePromise = resolve;
      }),
    );
    const values: boolean[] = [];

    await act(async () => {
      create(<Probe onValue={(v) => values.push(v)} />);
    });

    // Fenêtre d'ignorance : FERMÉ (réduit) — c'est l'inversion voulue par l'arbitrage.
    expect(values.at(-1)).toBe(true);

    await act(async () => {
      resolvePromise(false);
      await Promise.resolve();
    });

    // Préférence résolue « pas de réduction » : les animations s'ouvrent.
    expect(values.at(-1)).toBe(false);
  });

  it('reflète immédiatement isReduceMotionEnabled() = true une fois résolu', async () => {
    const { useReduceMotion } = await loadHook();
    const Probe = makeProbe(useReduceMotion);
    isReduceMotionEnabled.mockResolvedValue(true);
    const values: boolean[] = [];

    await act(async () => {
      create(<Probe onValue={(v) => values.push(v)} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(values.at(-1)).toBe(true);
  });

  it('retient la dernière résolution (mémoire de module) : un montage SUIVANT démarre ouvert, pas fermé', async () => {
    const { useReduceMotion } = await loadHook();
    const Probe = makeProbe(useReduceMotion);
    isReduceMotionEnabled.mockResolvedValue(false);

    // Premier montage : traverse la fenêtre fermée puis résout `false`.
    let first: ReturnType<typeof create> | null = null;
    const firstValues: boolean[] = [];
    await act(async () => {
      first = create(<Probe onValue={(v) => firstValues.push(v)} />);
      await Promise.resolve();
    });
    expect(firstValues[0]).toBe(true); // témoin : la fenêtre fermée a bien existé
    expect(firstValues.at(-1)).toBe(false);
    await act(async () => {
      first?.unmount();
    });

    // Second montage : démarre DIRECTEMENT sur la valeur résolue — les animations de
    // montage (FadeIn ne joue qu'au montage) restent vivantes après la première résolution.
    const secondValues: boolean[] = [];
    await act(async () => {
      create(<Probe onValue={(v) => secondValues.push(v)} />);
    });
    expect(secondValues[0]).toBe(false);
  });

  it('reste FERMÉ quand la lecture système ÉCHOUE (rejet) — on ne décide pas à la place de l’utilisateur', async () => {
    const { useReduceMotion } = await loadHook();
    const Probe = makeProbe(useReduceMotion);
    isReduceMotionEnabled.mockRejectedValue(new Error('bridge indisponible'));
    const values: boolean[] = [];

    await act(async () => {
      create(<Probe onValue={(v) => values.push(v)} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(values.at(-1)).toBe(true);
  });

  it('réagit à un changement de préférence système en direct (reduceMotionChanged)', async () => {
    const { useReduceMotion } = await loadHook();
    const Probe = makeProbe(useReduceMotion);
    isReduceMotionEnabled.mockResolvedValue(false);
    const values: boolean[] = [];

    await act(async () => {
      create(<Probe onValue={(v) => values.push(v)} />);
      await Promise.resolve();
    });
    expect(values.at(-1)).toBe(false);

    expect(addEventListener).toHaveBeenCalledWith('reduceMotionChanged', expect.any(Function));

    await act(async () => {
      capturedListener?.(true);
    });
    expect(values.at(-1)).toBe(true);
  });

  it('se désabonne au démontage — aucune fuite de listener', async () => {
    const { useReduceMotion } = await loadHook();
    const Probe = makeProbe(useReduceMotion);
    isReduceMotionEnabled.mockResolvedValue(false);
    let renderer: ReturnType<typeof create> | null = null;

    await act(async () => {
      renderer = create(<Probe onValue={() => {}} />);
      await Promise.resolve();
    });

    expect(removeListener).not.toHaveBeenCalled();

    await act(async () => {
      renderer?.unmount();
    });

    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it("n'applique pas une résolution tardive après démontage (garde `alive`)", async () => {
    const { useReduceMotion } = await loadHook();
    const Probe = makeProbe(useReduceMotion);
    let resolvePromise: (v: boolean) => void = () => {};
    isReduceMotionEnabled.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolvePromise = resolve;
      }),
    );
    const values: boolean[] = [];
    let renderer: ReturnType<typeof create> | null = null;

    await act(async () => {
      renderer = create(<Probe onValue={(v) => values.push(v)} />);
    });

    await act(async () => {
      renderer?.unmount();
    });

    const countBeforeResolve = values.length;

    // Ne doit rien casser (pas de setState sur un composant démonté) : la garde `alive`
    // dans le hook évite l'avertissement React et toute mise à jour fantôme.
    await act(async () => {
      resolvePromise(true);
      await Promise.resolve();
    });

    expect(values.length).toBe(countBeforeResolve);
  });
});
