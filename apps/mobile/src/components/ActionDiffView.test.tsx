import type { ElementType, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ActionDiff } from '@bob/ai';
import { ActionDiffView } from './ActionDiffView';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const theme = vi.hoisted(() => ({
  colors: {
    ink900: '#ink900',
    ink800: '#ink800',
    slate500: '#slate500',
    slate400: '#forbidden-slate400',
    slate300: '#forbidden-slate300',
    line: '#line',
  },
}));

vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@bob/ui', async () => {
  const { createElement } = await import('react');
  return {
    font: () => ({ fontFamily: 'MockFont' }),
    useTheme: () => theme,
    // AccountingLinesView partage le même mock et rend ses hôtes normalement.
    Fragment: ({ children }: { children?: ReactNode }) => createElement('Fragment', null, children),
  };
});

const HOST_IONICONS = 'Ionicons' as unknown as ElementType;
const HOST_TEXT = 'Text' as unknown as ElementType;
const HOST_VIEW = 'View' as unknown as ElementType;

function textColors(renderer: ReactTestRenderer): unknown[] {
  return renderer.root.findAllByType(HOST_TEXT).flatMap((node) => {
    const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
    return styles.map((style) => style?.color).filter(Boolean);
  });
}

function accessibilityLabels(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => typeof node.props.accessibilityLabel === 'string')
    .map((node) => node.props.accessibilityLabel as string);
}

describe('ActionDiffView', () => {
  it('ne rend rien sans changement ni écriture', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ActionDiffView diff={{ tool: 'noop', title: 'Vide', fields: [] }} />);
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it('annonce explicitement avant/après et autorise le repli Dynamic Type', async () => {
    const diff: ActionDiff = {
      tool: 'encaisser_facture',
      title: 'Encaisser',
      fields: [{ label: 'Reste dû', before: '1 320,00 €', after: '0,00 €' }],
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ActionDiffView diff={diff} />);
    });

    expect(
      renderer.root.findByProps({
        accessibilityLabel: 'Reste dû. Avant : 1 320,00 €. Après : 0,00 €.',
      }),
    ).toBeDefined();
    const wrappingRow = renderer.root
      .findAllByType(HOST_VIEW)
      .find((node) => node.props.style?.flexWrap === 'wrap');
    expect(wrappingRow?.props.style).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    expect(renderer.root.findByType(HOST_IONICONS).props).toMatchObject({
      accessible: false,
      importantForAccessibility: 'no',
    });
    expect(textColors(renderer)).not.toContain(theme.colors.slate400);
    expect(textColors(renderer)).not.toContain(theme.colors.slate300);
  });

  it('rend l’écriture comptable sous un vrai en-tête', async () => {
    const diff: ActionDiff = {
      tool: 'encaisser_facture',
      title: 'Encaisser',
      fields: [],
      accounting: [
        { account: '512000', label: 'Banque', debitCents: 132_000, creditCents: 0 },
        { account: '411000', label: 'Client', debitCents: 0, creditCents: 132_000 },
      ],
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ActionDiffView diff={diff} />);
    });

    const heading = renderer.root.findByProps({ accessibilityRole: 'header' });
    expect(heading.children.join('')).toContain('Écriture comptable');
    expect(accessibilityLabels(renderer).some((label) => label.includes('Débit'))).toBe(true);
    expect(accessibilityLabels(renderer).some((label) => label.includes('Crédit'))).toBe(true);
  });
});
