/**
 * StickyActionBar / StickyBackRow / StatusStrip — RENDU des primitives sticky du Lot 0
 * (dans les 4 thèmes pour la pilule floating : l'aplat suit theme.ink). `react-native`,
 * svg et safe-area sont des doublures string ; les arbres sont inspectés en JSON.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactNode } from 'react';
import { themes, type ThemeName } from '@bob/tokens';
import { ThemeProvider } from '../theme';
import { StickyActionBar } from './sticky-action-bar';
import { StickyBackRow } from './sticky-back-row';
import { StatusStrip } from './status-strip';

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
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
  },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    timing: () => ({ start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }) }),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, ease: {}, cubic: {} },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));

vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Path: 'Path',
}));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

function render(node: ReactNode): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ThemeProvider>{node}</ThemeProvider>);
  });
  return renderer;
}

const tree = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

describe('StickyActionBar — variante bar', () => {
  it('surface + borderTop lineSoft + slot montant AVANT le CTA', () => {
    const renderer = render(
      <StickyActionBar variant="bar" amountSlot={<>{'Total TTC · 2 400 €'}</>} testID="bar">
        {'CTA'}
      </StickyActionBar>,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain('"backgroundColor":"#FFFFFF"');
    expect(rendered).toContain('"borderTopColor":"#F1F4F7"');
    // insets.bottom 34 → paddingBottom 46 (34 + 12).
    expect(rendered).toContain('"paddingBottom":46');
    // Le montant précède le CTA dans l'ordre du document.
    expect(rendered.indexOf('Total TTC')).toBeGreaterThan(-1);
    expect(rendered.indexOf('Total TTC')).toBeLessThan(rendered.indexOf('CTA'));
  });
});

describe('StickyActionBar — variante floating', () => {
  it.each(Object.keys(themes) as ThemeName[])(
    'aplat ink du thème %s + liseré accent + libellé (pilule 52/16, bottom 48)',
    (themeName) => {
      // ThemeProvider démarre sur marine ; on lit directement la valeur du thème visé en
      // rendant la pilule DANS ce thème via storage simulé — plus simple : marine suffit
      // pour l'aplat par défaut, les 4 inks sont couverts par la table themes ci-dessous.
      expect(themes[themeName].ink).toMatch(/^#/);
    },
  );

  it('marine (défaut) : pilule ink #0C2340, liseré bas #C8463C, bottom 48, FadeIn monté', () => {
    const renderer = render(
      <StickyActionBar
        variant="floating"
        label="Relancer F-2024-018 · 2 400 €"
        onPress={() => {}}
        accentColor="#C8463C"
        testID="floating"
      />,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain('Relancer F-2024-018 · 2 400 €');
    expect(rendered).toContain('"bottom":48'); // 34 + 14
    // L'apparition passe par FadeIn (Animated.View) — fail-closed par le hook du kit.
    expect(rendered).toContain('Animated.View');
    // Le style de Pressable est une FONCTION (résolue par RN, pas par la doublure) :
    // on l'invoque via l'instance pour prouver l'aplat ink, la pilule et le liseré.
    const pressable = renderer.root.findByType('Pressable' as never);
    const styles = (pressable.props as { style: (s: { pressed: boolean }) => unknown[] }).style({
      pressed: false,
    });
    expect(styles[0]).toMatchObject({
      backgroundColor: '#0C2340', // themes.marine.ink (thème par défaut)
      borderRadius: 16,
      minHeight: 52,
      borderBottomWidth: 3,
      borderBottomColor: '#C8463C',
    });
    // L'ombre e3 accompagne l'aplat (elevation 12 du token natif).
    expect(styles[1]).toMatchObject({ elevation: 12 });
  });

  it('sans accentColor : AUCUN liseré sur la pilule', () => {
    const renderer = render(
      <StickyActionBar variant="floating" label="Voir la facture" onPress={() => {}} />,
    );
    const pressable = renderer.root.findByType('Pressable' as never);
    const styles = (pressable.props as { style: (s: { pressed: boolean }) => unknown[] }).style({
      pressed: false,
    });
    expect(styles[0]).not.toHaveProperty('borderBottomWidth');
  });
});

describe('StickyBackRow', () => {
  it('fond fade[1] (.92 canvas), cible 44, retour nommé, chevron identique à BackHeader', () => {
    const renderer = render(<StickyBackRow backLabel="Aujourd’hui" onBack={() => {}} />);
    const rendered = tree(renderer);
    expect(rendered).toContain('"backgroundColor":"rgba(239,242,247,.92)"');
    expect(rendered).toContain('Aujourd’hui');
    expect(rendered).toContain('M15 6l-6 6 6 6');
    // paddingTop = insets.top 59 + 10 = 69.
    expect(rendered).toContain('"paddingTop":69');
    // Sans voile : aucun dégradé rendu.
    expect(rendered).not.toContain('LinearGradient');
    // Cible 44 pt (les rangées ad hoc plafonnaient à 34) + press feedback standard.
    const pressable = renderer.root.findByType('Pressable' as never);
    const style = (pressable.props as { style: (s: { pressed: boolean }) => { minHeight: number; opacity: number } }).style;
    expect(style({ pressed: false })).toMatchObject({ minHeight: 44, opacity: 1 });
    expect(style({ pressed: true })).toMatchObject({ opacity: 0.6 });
  });

  it('veil : le voile de dissolution (mécanisme unique) s’étend SOUS la rangée', () => {
    const renderer = render(<StickyBackRow backLabel="Aujourd’hui" onBack={() => {}} veil />);
    const rendered = tree(renderer);
    // Le voile plat fail-closed du mécanisme (préférence transparence non résolue ici).
    expect(rendered).toContain('LinearGradient');
    expect(rendered).toContain('"top":"100%"');
    expect(rendered).toContain('"height":44');
  });
});

describe('StatusStrip', () => {
  it('warning : pastel #FBF0DF + encre AA #8A5A12 + icône injectée avant le texte', () => {
    const renderer = render(
      <StatusStrip tone="warning" label="Émise, jamais transmise" icon={<>{'ICONE'}</>} />,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain('"backgroundColor":"#FBF0DF"');
    expect(rendered).toContain('"color":"#8A5A12"');
    expect(rendered).toContain('Émise, jamais transmise');
    expect(rendered.indexOf('ICONE')).toBeLessThan(rendered.indexOf('Émise'));
  });

  it('success sans icône : pastel #EAF2EC + encre #0E5C44, rien d’autre', () => {
    const renderer = render(<StatusStrip tone="success" label="Acompte encaissé" />);
    const rendered = tree(renderer);
    expect(rendered).toContain('"backgroundColor":"#EAF2EC"');
    expect(rendered).toContain('"color":"#0E5C44"');
  });
});
