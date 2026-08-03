/**
 * TrendBars — RENDU dans les 3 états de préférence (critère de preuve Lot 5, verdict P1) :
 * · préférence JAMAIS résolue (promise pendante) ⇒ barre STATIQUE à `n%` dès la première
 *   frame, AUCUN Animated.timing lancé ;
 * · SONDE MÊME-MONTAGE frame1/frame2 (mutant du verdict : FRAME1 42 % → FRAME2 0) : une
 *   résolution TARDIVE à `inactive` ne fait JAMAIS retomber la largeur déjà peinte — la
 *   décision est FIGÉE au montage (garde façon FadeIn, ratchet une seule direction) ;
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

  it('SONDE MÊME-MONTAGE : résolution TARDIVE à inactive ⇒ la largeur peinte NE RETOMBE JAMAIS', async () => {
    // La sonde du verdict : frame1 sous ignorance = 42 % ; la promesse se résout ensuite
    // à false (inactive). Avant correctif : bascule sur l'Animated.Value(0) ⇒ "width":0.
    let resolvePreference!: (value: boolean) => void;
    harness.readReduceMotion.impl = () =>
      new Promise<boolean>((resolve) => {
        resolvePreference = resolve;
      });
    const renderer = await render(42);
    const frame1 = JSON.stringify(renderer.toJSON());
    expect(frame1).toContain('"width":"42%"'); // FRAME1(unknown) : la vraie valeur, statique

    await act(async () => {
      resolvePreference(false);
    });
    const frame2 = JSON.stringify(renderer.toJSON());
    // FRAME2(inactive) : la décision est FIGÉE au montage — toujours 42 %, jamais 0.
    expect(frame2).toContain('"width":"42%"');
    expect(frame2).not.toContain('"width":0');
    // Et aucune poussée tardive : zéro timer fantôme après la première frame statique.
    expect(harness.timing).not.toHaveBeenCalled();
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
