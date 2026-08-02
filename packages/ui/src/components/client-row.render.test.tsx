/**
 * ClientRow v2 — RENDU des slots du Lot 4 (nameAccessory / statusWord / amountText) :
 * la primitive CRM devient consommable par le carnet C12. Le mot de statut est 11.5
 * slate400 (plan : le slate300/11 de l'écran échouait au soleil) ; `amountText` prime
 * sur `amountCents` (« à jour » n'est pas un montant) ; le libellé accessible composé
 * par l'écran remplace la concaténation par défaut.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../theme';
import { ClientRow } from './client-row';

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
    isReduceMotionEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
  },
  Animated: {
    Value: FakeAnimatedValue,
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T): T => styles },
  Text: 'Text',
  View: 'View',
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }));

function render(props: Partial<Parameters<typeof ClientRow>[0]> = {}): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ThemeProvider>
        <ClientRow name="SARL Martin" {...props} />
      </ThemeProvider>,
    );
  });
  return renderer;
}

describe('ClientRow v2 — slots du carnet (Lot 4)', () => {
  it('statusWord rendu sous le montant en 11.5 (jamais 11/slate300)', () => {
    const rendered = JSON.stringify(
      render({ amountText: '1 250 €', statusWord: 'en retard', tone: 'danger' }).toJSON(),
    );
    expect(rendered).toContain('en retard');
    expect(rendered).toContain('"fontSize":11.5');
    expect(rendered).toContain('1 250 €');
  });

  it('amountText prime sur amountCents (« à jour » n’est pas un montant)', () => {
    const rendered = JSON.stringify(
      render({ amountCents: 123400, amountText: 'à jour', tone: 'success' }).toJSON(),
    );
    expect(rendered).toContain('à jour');
    expect(rendered).not.toContain('1 234');
  });

  it('nameAccessory injecté rendu à côté du nom', () => {
    const rendered = JSON.stringify(
      render({ nameAccessory: createElement('Text' as never, null, 'BADGE-TÉMOIN') }).toJSON(),
    );
    expect(rendered).toContain('BADGE-TÉMOIN');
  });

  it('accessibilityLabel composé par l’écran prime sur la concaténation par défaut', () => {
    const renderer = render({
      amountText: '890 €',
      statusWord: 'en attente',
      accessibilityLabel: 'SARL Martin, relance en cours, 890 € en attente',
      onPress: () => {},
    });
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('SARL Martin, relance en cours, 890 € en attente');
  });
});
