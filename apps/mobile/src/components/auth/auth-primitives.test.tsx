/**
 * Primitives AUTH — la grammaire UNIQUE du CTA blanc-sur-navy et du champ navy
 * (vague hors-lots, audit 03/08 : 4 CTA dupliqués × 3 grammaires de feedback, 3 champs).
 * · logique pure par mutants : scale gaté reduce-motion (fail-closed), opacité busy, bord ;
 * · rendu : busy = ActivityIndicator + accessibilityState (JAMAIS « … »), toggle visibilité.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import {
  AUTH_CTA_MIN_HEIGHT,
  authCtaOpacity,
  authCtaPressedScale,
  authFieldBorderColor,
} from './auth-primitives.logic';

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => new Promise<boolean>(() => {}),
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
  },
  ActivityIndicator: 'ActivityIndicator',
  Animated: {
    Value: class {
      interpolate(): number {
        return 0;
      }
      setValue(): void {}
    },
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, in: (f: unknown) => f, quad: {}, cubic: {}, ease: {} },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T): T => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Circle: 'Circle', Path: 'Path', Rect: 'Rect' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ThemeProvider } = await import('@bob/ui');
const { AuthCta } = await import('./AuthCta');
const { AuthField } = await import('./AuthField');

describe('authCtaPressedScale — press gaté reduce-motion (fail-closed)', () => {
  it('pressé, motion autorisée ⇒ 0.97', () => {
    expect(authCtaPressedScale(true, false, false)).toBe(0.97);
  });
  it('pressé mais reduce-motion (ou préférence inconnue) ⇒ 1 — AUCUN mouvement', () => {
    expect(authCtaPressedScale(true, false, true)).toBe(1);
  });
  it('pressé mais busy ⇒ 1 (un envoi en cours ne rebondit pas)', () => {
    expect(authCtaPressedScale(true, true, false)).toBe(1);
  });
  it('non pressé ⇒ 1', () => {
    expect(authCtaPressedScale(false, false, false)).toBe(1);
  });
});

describe('authCtaOpacity / authFieldBorderColor', () => {
  it('busy ⇒ 0.7, sinon 1 — le feedback reste perceptible sans mouvement', () => {
    expect(authCtaOpacity(true)).toBe(0.7);
    expect(authCtaOpacity(false)).toBe(1);
  });
  it('bord : danger en erreur, white16 au repos', () => {
    const palette = { danger: '#E5544B', idle: 'rgba(255,255,255,.16)' };
    expect(authFieldBorderColor(true, palette)).toBe('#E5544B');
    expect(authFieldBorderColor(false, palette)).toBe('rgba(255,255,255,.16)');
  });
});

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, element));
  });
  return renderer;
}

describe('AuthCta — busy = ActivityIndicator, jamais « … »', () => {
  it('au repos : label rendu, cible ≥ 52, état a11y propre', async () => {
    const renderer = await render(createElement(AuthCta, { label: 'Se connecter', onPress: () => {} }));
    const cta = renderer.root.findByType('Pressable' as never);
    const props = cta.props as {
      accessibilityState: { disabled: boolean; busy: boolean };
      style: (s: { pressed: boolean }) => Record<string, unknown>;
    };
    expect(props.accessibilityState).toEqual({ disabled: false, busy: false });
    const style = props.style({ pressed: false });
    expect(style['minHeight']).toBe(AUTH_CTA_MIN_HEIGHT);
    expect(JSON.stringify(renderer.toJSON())).toContain('Se connecter');
  });

  it('busy : ActivityIndicator rendu, PAS de texte « … », disabled+busy annoncés', async () => {
    const renderer = await render(
      createElement(AuthCta, { label: 'Se connecter', busy: true, onPress: () => {} }),
    );
    expect(renderer.root.findAllByType('ActivityIndicator' as never)).toHaveLength(1);
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).not.toContain('…');
    const cta = renderer.root.findByType('Pressable' as never);
    expect((cta.props as { accessibilityState: unknown }).accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });
    const style = (cta.props as { style: (s: { pressed: boolean }) => Record<string, unknown> }).style({
      pressed: false,
    });
    expect(style['opacity']).toBe(0.7);
  });
});

describe('AuthField — label meta white70, toggle de visibilité', () => {
  it('label au cran meta (12) en white70 — détail ≥ white70 (doctrine on-dark)', async () => {
    const renderer = await render(createElement(AuthField, { label: 'Ton email' }));
    const label = renderer.root
      .findAllByType('Text' as never)
      .find((node) => (node.props as { children?: unknown }).children === 'Ton email');
    const style = JSON.stringify((label!.props as { style: unknown }).style);
    expect(style).toContain('"fontSize":12');
    expect(style).toContain('rgba(255,255,255,.7)');
  });

  it('secureToggle : masqué par défaut, le bouton bascule secureTextEntry (parité récupération↔connexion)', async () => {
    const renderer = await render(
      createElement(AuthField, { label: 'Ton mot de passe', secureToggle: true }),
    );
    const inputBefore = renderer.root.findByType('TextInput' as never);
    expect((inputBefore.props as { secureTextEntry?: boolean }).secureTextEntry).toBe(true);
    const toggle = renderer.root
      .findAllByType('Pressable' as never)
      .find((node) =>
        ((node.props as { accessibilityLabel?: string }).accessibilityLabel ?? '').includes(
          'Afficher',
        ),
      );
    expect(toggle).toBeDefined();
    await act(async () => {
      (toggle!.props as { onPress: () => void }).onPress();
    });
    const inputAfter = renderer.root.findByType('TextInput' as never);
    expect((inputAfter.props as { secureTextEntry?: boolean }).secureTextEntry).toBe(false);
  });

  it('erreur : bord dangerVivid (graphique) — le reste de la géométrie ne bouge pas', async () => {
    const renderer = await render(createElement(AuthField, { label: 'Email', error: true }));
    // SCOPÉ AU NŒUD (finding : le toContain global laissait le bord se poser sur n'importe
    // quel sous-nœud). Le bord d'erreur vit sur le WRAPPER direct du TextInput.
    const input = renderer.root.findByType('TextInput' as never);
    const wrapperStyle = JSON.stringify((input.parent!.props as { style?: unknown }).style);
    // semantic.dangerVivid — littéral recopié à la main (#E5544B) : si le token change, ce
    // test DOIT rougir et forcer la relecture du bord d'erreur.
    expect(wrapperStyle).toContain('"borderColor":"#E5544B"');
    expect(wrapperStyle).toContain('"borderWidth":1');
  });
});
