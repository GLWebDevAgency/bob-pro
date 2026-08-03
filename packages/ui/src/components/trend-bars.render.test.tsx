/**
 * TrendBars — RENDU dans les 3 états de préférence (critère de preuve Lot 5) :
 * · préférence JAMAIS résolue (promise pendante) ⇒ barre STATIQUE à `n%` dès la première
 *   frame, AUCUN Animated.timing lancé ;
 * · résolue `false` (inactive) ⇒ la poussée 0→n% s'engage (timing {toValue: n, 400 ms}) ;
 * · résolue `true` (active) ⇒ statique, aucun timing.
 * L'état FINAL est identique au pixel : les trois états montrent la même largeur cible.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../theme';
import { TrendBars } from './trend-bars';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => {
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
    stopAnimation(): void {}
  }
  return {
    FakeAnimatedValue,
    timing: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    readReduceMotion: { impl: (): Promise<boolean> => new Promise<boolean>(() => {}) },
  };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => harness.readReduceMotion.impl(),
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
  },
  Animated: {
    Value: harness.FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: harness.timing,
  },
  Easing: { out: (f: unknown) => f, in: (f: unknown) => f, quad: {}, cubic: {}, ease: {} },
  Text: 'Text',
  View: 'View',
}));

async function render(pct: number): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ThemeProvider>
        <TrendBars bars={[{ pct, color: '#0E7C5A' }]} />
      </ThemeProvider>,
    );
  });
  return renderer;
}

beforeEach(() => {
  harness.timing.mockClear();
  harness.readReduceMotion.impl = () => new Promise<boolean>(() => {});
});

describe('TrendBars — les 3 états de préférence', () => {
  it('préférence JAMAIS résolue ⇒ statique à 42% dès la première frame, zéro timing', async () => {
    const rendered = JSON.stringify((await render(42)).toJSON());
    expect(rendered).toContain('"width":"42%"');
    expect(rendered).toContain('"backgroundColor":"#0E7C5A"');
    expect(harness.timing).not.toHaveBeenCalled();
  });

  it('résolue false (inactive) ⇒ la poussée s’engage : timing vers 42 en 400 ms, driver layout', async () => {
    harness.readReduceMotion.impl = () => Promise.resolve(false);
    await render(42);
    expect(harness.timing).toHaveBeenCalledWith(
      expect.any(harness.FakeAnimatedValue),
      expect.objectContaining({ toValue: 42, duration: 400, useNativeDriver: false }),
    );
  });

  it('résolue true (active) ⇒ statique à 42%, aucun timing — même état final au pixel', async () => {
    harness.readReduceMotion.impl = () => Promise.resolve(true);
    const rendered = JSON.stringify((await render(42)).toJSON());
    expect(rendered).toContain('"width":"42%"');
    expect(harness.timing).not.toHaveBeenCalled();
  });

  it('part hors bornes (130) ⇒ piste jamais dépassée : 100% statique sous ignorance', async () => {
    const rendered = JSON.stringify((await render(130)).toJSON());
    expect(rendered).toContain('"width":"100%"');
    expect(rendered).not.toContain('"width":"130%"');
  });
});
