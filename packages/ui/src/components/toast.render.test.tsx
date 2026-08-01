/**
 * Toast — RENDU des tones (Lot 0). Preuves : (a) sans tone ni icône, AUCUN slot d'icône
 * (arbre historique inchangé) ; (b) tone danger → croix dessinée en encre danger on-dark ;
 * (c) tone success → coche successOnDark ; (d) une icône INJECTÉE garde la priorité sur le
 * glyphe du tone. `react-native` et `react-native-svg` sont mockés en balises string.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../theme';
import { Toast } from './toast';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { FakeAnimatedValue } = vi.hoisted(() => {
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
  return { FakeAnimatedValue };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove: vi.fn() }),
  },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    timing: () => ({ start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }) }),
  },
  Text: 'Text',
  View: 'View',
}));

vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Path: 'Path',
}));

function renderToast(props: Partial<Parameters<typeof Toast>[0]> = {}): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ThemeProvider>
        <Toast message="Facture encaissée" visible onHide={() => {}} {...props} />
      </ThemeProvider>,
    );
  });
  return renderer;
}

const tree = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

describe('Toast — tones (Lot 0)', () => {
  it('sans tone ni icône : aucun Svg, aucun slot — l’arbre historique est inchangé', () => {
    const renderer = renderToast();
    const rendered = tree(renderer);
    // Témoin : le toast est bien rendu.
    expect(rendered).toContain('Facture encaissée');
    expect(rendered).not.toContain('Svg');
  });

  it('tone danger : une CROIX (deux traits) en encre danger on-dark #FADDD9 — jamais une coche sur un échec', () => {
    const renderer = renderToast({ message: 'Export impossible', tone: 'danger' });
    const rendered = tree(renderer);
    expect(rendered).toContain('Export impossible');
    expect(rendered).toContain('"stroke":"#FADDD9"');
    // Tracé de croix (M6 6l12 12 · M18 6L6 18) — pas le tracé de coche.
    expect(rendered).toContain('M6 6l12 12M18 6L6 18');
    expect(rendered).not.toContain('M4 12.5l5 5L20 6.5');
  });

  it('tone success : la coche successOnDark #6EE7B7', () => {
    const renderer = renderToast({ tone: 'success' });
    const rendered = tree(renderer);
    expect(rendered).toContain('"stroke":"#6EE7B7"');
    expect(rendered).toContain('M4 12.5l5 5L20 6.5');
  });

  it('icône injectée PRIORITAIRE : le glyphe du tone ne double jamais l’icône de l’appelant', () => {
    const renderer = renderToast({ tone: 'danger', icon: <>{'icone-appelant'}</> });
    const rendered = tree(renderer);
    expect(rendered).toContain('icone-appelant');
    // Aucun tracé de glyphe dessiné par le tone.
    expect(rendered).not.toContain('M6 6l12 12M18 6L6 18');
  });
});
