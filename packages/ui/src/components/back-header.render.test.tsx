/**
 * BackHeader — contrat de RENDU de l'eyebrow OPTIONNEL (verdict PR #61, P2 iso-information) :
 * une migration d'en-tête ad hoc → BackHeader ne doit pas IMPOSER une ligne de texte qui
 * n'existait pas dans l'écran d'origine. Absent = AUCUN nœud eyebrow ; fourni = arbre
 * historique inchangé (le slot reste le même pour tous les consommateurs existants).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactNode } from 'react';
import { ThemeProvider } from '../theme';
import { BackHeader } from './back-header';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => new Promise<boolean>(() => {}),
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
  },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T): T => styles },
  Text: 'Text',
  View: 'View',
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));

function render(node: ReactNode): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ThemeProvider>{node}</ThemeProvider>);
  });
  return renderer;
}

describe('BackHeader — eyebrow optionnel (iso-information)', () => {
  it('avec eyebrow : le nœud est rendu au-dessus du titre (consommateurs historiques inchangés)', () => {
    const renderer = render(
      <BackHeader backLabel="Accueil" onBack={() => {}} eyebrow="Documents" title="Mes papiers" />,
    );
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('Documents');
    expect(rendered.indexOf('Documents')).toBeLessThan(rendered.indexOf('Mes papiers'));
  });

  it('sans eyebrow : AUCUN nœud eyebrow — le titre reste header, le retour reste nommé', () => {
    const renderer = render(
      <BackHeader backLabel="Accueil" onBack={() => {}} title="Devis & Factures" />,
    );
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('Devis & Factures');
    expect(rendered).toContain('"accessibilityRole":"header"');
    // Le SEUL texte au-dessus du titre est le libellé du bouton retour — pas d'eyebrow fantôme.
    const texts = renderer.root
      .findAllByType('Text' as never)
      .map((n) => String((n.props as { children: unknown }).children));
    expect(texts).toEqual(['Accueil', 'Devis & Factures']);
  });
});
