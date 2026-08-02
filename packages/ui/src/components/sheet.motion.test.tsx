/**
 * Sheet — comportement reduce-motion (audit 14/07 : Sheet est le modèle de référence du
 * hook partagé useReduceMotion). 'react-native' est intégralement mocké : les composants
 * hôtes (View/Text/Pressable/ScrollView/Modal) deviennent de simples balises string —
 * aucun pont natif requis sous vitest, seul le comportement de `Animated.timing` importe
 * ici (durée figée à 0 quand la préférence système « réduire les animations » est active).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../theme';
import { Sheet } from './sheet';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `vi.mock` est hoisté au sommet du fichier — toute variable référencée dans sa factory
// doit donc être elle-même déclarée via `vi.hoisted` pour exister au moment de l'exécution.
const { isReduceMotionEnabled, timing, FakeAnimatedValue } = vi.hoisted(() => {
  class FakeAnimatedValue {
    private value: number;
    constructor(value: number) {
      this.value = value;
    }
    interpolate(): number {
      return this.value;
    }
    setValue(value: number): void {
      this.value = value;
    }
  }
  return {
    isReduceMotionEnabled: vi.fn<() => Promise<boolean>>(),
    timing: vi.fn((_value: unknown, _config: { toValue: number; duration: number }) => ({
      start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }),
    })),
    FakeAnimatedValue,
  };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: (...args: unknown[]) =>
      (isReduceMotionEnabled as unknown as (...a: unknown[]) => Promise<boolean>)(...args),
    addEventListener: () => ({ remove: vi.fn() }),
    setAccessibilityFocus: vi.fn(),
  },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    timing: (...args: [unknown, { toValue: number; duration: number }]) => timing(...args),
  },
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
  findNodeHandle: () => null,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

beforeEach(() => {
  isReduceMotionEnabled.mockReset();
  timing.mockClear();
});

function renderSheet(visible: boolean): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ThemeProvider>
        <Sheet visible={visible} onClose={() => {}}>
          <></>
        </Sheet>
      </ThemeProvider>,
    );
  });
  return renderer;
}

describe('Sheet — reduce motion', () => {
  it('annonce le vrai effet du bouton de fermeture quand l’appelant le surcharge', async () => {
    isReduceMotionEnabled.mockResolvedValue(false);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ThemeProvider>
          <Sheet
            visible
            onClose={() => {}}
            closeAccessibilityHint="Recharge la version à jour avant de fermer."
            closeBusy
          >
            <></>
          </Sheet>
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    const closeButton = renderer.root.findAll(
      (node) =>
        (node.type as unknown) === 'Pressable' && node.props.accessibilityRole === 'button',
    )[0];
    expect(closeButton?.props.accessibilityHint).toBe(
      'Recharge la version à jour avant de fermer.',
    );
    expect(closeButton?.props.accessibilityState).toEqual({ busy: true, disabled: true });
    expect(closeButton?.props.disabled).toBe(true);
  });

  it('anime le slide/fondu sur DURATION_MS quand la préférence système est normale', async () => {
    isReduceMotionEnabled.mockResolvedValue(false);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = renderSheet(false);
      await Promise.resolve();
      await Promise.resolve();
    });
    timing.mockClear();

    await act(async () => {
      renderer.update(
        <ThemeProvider>
          <Sheet visible onClose={() => {}}>
            <></>
          </Sheet>
        </ThemeProvider>,
      );
    });

    expect(timing).toHaveBeenCalled();
    const [, config] = timing.mock.calls[0]!;
    expect(config.toValue).toBe(1);
    expect(config.duration).toBe(220);
  });

  it('saute directement à la valeur finale (duration 0) quand reduce-motion est actif', async () => {
    // Usage RÉEL de tous les appelants du repo : `visible` démarre à false et ne passe à
    // true qu'après une action utilisateur — la préférence système (probe asynchrone,
    // AccessibilityInfo n'a pas de variante synchrone) a donc largement eu le temps de se
    // résoudre avant la première ouverture. Monter directement `visible=true` dès le tout
    // premier rendu est un cas hors contrat (aucun appelant ne le fait) : la ref de la
    // préférence n'a alors pas encore pu se résoudre, ce qui n'est pas ce que ce test vise.
    isReduceMotionEnabled.mockResolvedValue(true);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = renderSheet(false);
      await Promise.resolve();
      await Promise.resolve();
    });
    timing.mockClear();

    await act(async () => {
      renderer.update(
        <ThemeProvider>
          <Sheet visible onClose={() => {}}>
            <></>
          </Sheet>
        </ThemeProvider>,
      );
    });

    expect(timing).toHaveBeenCalled();
    const calls = timing.mock.calls;
    const openingCall = calls.find(([, config]) => config.toValue === 1);
    expect(openingCall).toBeDefined();
    expect(openingCall![1].duration).toBe(0);
  });

  it('applique aussi duration 0 à la fermeture en reduce-motion', async () => {
    isReduceMotionEnabled.mockResolvedValue(true);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = renderSheet(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    timing.mockClear();

    await act(async () => {
      renderer.update(
        <ThemeProvider>
          <Sheet visible={false} onClose={() => {}}>
            <></>
          </Sheet>
        </ThemeProvider>,
      );
    });

    expect(timing).toHaveBeenCalled();
    const [, config] = timing.mock.calls[0]!;
    expect(config.toValue).toBe(0);
    expect(config.duration).toBe(0);
  });
});
