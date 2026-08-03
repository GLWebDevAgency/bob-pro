/**
 * SegmentedControl — contrat de RENDU du correctif a11y Lot 3 (verdict PR #61, P2) :
 * `disabled` doit être PORTÉ par chaque segment (prop `disabled` + accessibilityState.disabled)
 * — un contrôle inerte s'ANNONCE, il ne se voile pas en douce (pointerEvents='none' côté
 * écran laissait VoiceOver présenter des onglets actionnables qui ne répondaient pas).
 * Décision sémantique documentée au composant : tablist/tab + selected(+disabled), PAS
 * radiogroup — un seul rôle pour tous les consommateurs (périodes d'argent, kindFilter…).
 * SANS `disabled`, l'arbre reste STRICTEMENT historique (aucun état ni prop ajouté).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactNode } from 'react';
import { ThemeProvider } from '../theme';
import { SegmentedControl } from './segmented-control';

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

function render(node: ReactNode): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ThemeProvider>{node}</ThemeProvider>);
  });
  return renderer;
}

const OPTIONS = [
  { key: 'all', label: 'Tout' },
  { key: 'quotes', label: 'Devis' },
  { key: 'invoices', label: 'Factures' },
] as const;

type Segment = { props: { disabled?: boolean; accessibilityState: { selected: boolean; disabled?: boolean } } };

function segments(renderer: ReactTestRenderer): Segment[] {
  return renderer.root
    .findAllByType('Pressable' as never)
    .filter((n) => (n.props as { accessibilityRole?: string }).accessibilityRole === 'tab') as unknown as Segment[];
}

describe('SegmentedControl — disabled annoncé segment par segment', () => {
  it('disabled : chaque tab porte disabled + accessibilityState.disabled, la piste prend le voile 0.5', () => {
    const renderer = render(
      <SegmentedControl options={OPTIONS} value="all" onChange={() => {}} disabled />,
    );
    const tabs = segments(renderer);
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      expect(tab.props.disabled).toBe(true);
      expect(tab.props.accessibilityState.disabled).toBe(true);
    }
    // L'état sélectionné reste annoncé MÊME inerte (VoiceOver : « onglet, sélectionné, désactivé »).
    expect(tabs[0]!.props.accessibilityState.selected).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('"opacity":0.5');
  });

  it('sans disabled : arbre STRICTEMENT historique — aucun disabled, aucun voile, selected seul', () => {
    const renderer = render(<SegmentedControl options={OPTIONS} value="quotes" onChange={() => {}} />);
    const tabs = segments(renderer);
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      expect(tab.props.disabled).toBeUndefined();
      // accessibilityState EXACT : { selected } — pas de clé disabled fantôme.
      expect(Object.keys(tab.props.accessibilityState)).toEqual(['selected']);
    }
    expect(tabs[1]!.props.accessibilityState.selected).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('"opacity":0.5');
  });

  it('rôles : tablist sur la piste, tab par segment (décision sémantique du kit, pas radiogroup)', () => {
    const renderer = render(<SegmentedControl options={OPTIONS} value="all" onChange={() => {}} />);
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('"accessibilityRole":"tablist"');
    expect(rendered).toContain('"accessibilityRole":"tab"');
    expect(rendered).not.toContain('radiogroup');
  });
});
