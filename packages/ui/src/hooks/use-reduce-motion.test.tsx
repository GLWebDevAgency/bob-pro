/**
 * useReduceMotion — comportement de l'implémentation UNIQUE (voir use-reduce-motion.ts) :
 * lit AccessibilityInfo.isReduceMotionEnabled() au montage, écoute 'reduceMotionChanged',
 * et se désabonne au démontage. AccessibilityInfo est mocké (aucun accès natif possible
 * sous vitest) — le composant Probe rend `null` : aucun composant hôte react-native n'est
 * nécessaire, seul react-test-renderer pilote le cycle de vie React (effets compris).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, create } from 'react-test-renderer';
import { useReduceMotion } from './use-reduce-motion';

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

function Probe({ onValue }: { onValue: (v: boolean) => void }) {
  const reduced = useReduceMotion();
  onValue(reduced);
  return null;
}

beforeEach(() => {
  isReduceMotionEnabled.mockReset();
  addEventListener.mockClear();
  removeListener.mockClear();
  capturedListener = null;
});

describe('useReduceMotion', () => {
  it('démarre à false avant résolution de la préférence système', async () => {
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

    expect(values.at(-1)).toBe(false);

    await act(async () => {
      resolvePromise(true);
      await Promise.resolve();
    });

    expect(values.at(-1)).toBe(true);
  });

  it('reflète immédiatement isReduceMotionEnabled() = true une fois résolu', async () => {
    isReduceMotionEnabled.mockResolvedValue(true);
    const values: boolean[] = [];

    await act(async () => {
      create(<Probe onValue={(v) => values.push(v)} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(values.at(-1)).toBe(true);
  });

  it('réagit à un changement de préférence système en direct (reduceMotionChanged)', async () => {
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
