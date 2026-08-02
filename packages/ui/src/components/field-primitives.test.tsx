/**
 * SearchField / FormField / DateField / HeaderIconButton — logique pure + RENDU (Lot 0).
 * `react-native` et svg sont des doublures string ; les styles-fonctions de Pressable
 * sont invoqués via l'instance (le patron des primitives sticky).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactNode } from 'react';
import { neutrals } from '@bob/tokens';
import { ThemeProvider } from '../theme';
import { contrastRatio } from './bob-tab-bar.logic';
import { SearchField } from './search-field';
import {
  SEARCH_CLEAR_HIT_SLOP,
  SEARCH_CLEAR_TARGET,
  SEARCH_CLEAR_VISUAL,
  searchClearVisible,
} from './search-field.logic';
import { FormField, DateField } from './form-field';
import { HeaderIconButton } from './header-icon-button';
import {
  HEADER_ICON_BUTTON_RADIUS,
  HEADER_ICON_BUTTON_SIZE,
  headerIconButtonStyle,
} from './header-icon-button.logic';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Circle: 'Circle',
  Path: 'Path',
}));

function render(node: ReactNode): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ThemeProvider>{node}</ThemeProvider>);
  });
  return renderer;
}

const tree = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

describe('SearchField', () => {
  it('surface + loupe (tracé SearchIcon) + input tokenisé — sans onClear, jamais de bouton', () => {
    const renderer = render(
      <SearchField value="mairie" onChange={() => {}} placeholder="Rechercher un client" />,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain('"backgroundColor":"#FFFFFF"');
    expect(rendered).toContain('M21 21l-4.3-4.3'); // loupe
    expect(rendered).toContain('Rechercher un client');
    expect(rendered).not.toContain('"accessibilityRole":"button"');
    const input = renderer.root.findByType('TextInput' as never);
    const glyph = renderer.root.findByType('Svg' as never);
    expect(input.props.placeholderTextColor).toBe(neutrals.slate500);
    expect(glyph.props.stroke).toBe(neutrals.slate500);
    expect(glyph.props.accessible).toBe(false);
    expect(contrastRatio(neutrals.slate500, neutrals.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('clear : visible seulement avec du texte ET un effaceur — cible 44 par hitSlop (28 + 2×8)', () => {
    // Logique pure d'abord (mutants) :
    expect(searchClearVisible('', true)).toBe(false);
    expect(searchClearVisible('mairie', false)).toBe(false);
    expect(searchClearVisible('mairie', true)).toBe(true);
    // 28 visuel + 8 de hitSlop de chaque côté = 44 effectif.
    expect(SEARCH_CLEAR_VISUAL + 2 * SEARCH_CLEAR_HIT_SLOP).toBeGreaterThanOrEqual(SEARCH_CLEAR_TARGET);

    const onClear = vi.fn();
    const renderer = render(
      <SearchField
        value="mairie"
        onChange={() => {}}
        placeholder="Rechercher"
        onClear={onClear}
        clearAccessibilityLabel="Effacer la recherche"
      />,
    );
    const clear = renderer.root.findByProps({ accessibilityLabel: 'Effacer la recherche' });
    expect(clear.props.hitSlop).toBe(SEARCH_CLEAR_HIT_SLOP);
    const clearGlyph = renderer.root
      .findAllByType('Text' as never)
      .find((node) => node.children.join('') === '×');
    expect(clearGlyph?.props.style.color).toBe(neutrals.slate500);
    expect(contrastRatio(neutrals.slate500, neutrals.surface)).toBeGreaterThanOrEqual(3);
    act(() => {
      clear.props.onPress();
    });
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('FormField', () => {
  it('label VISIBLE persistant + input 44 tokenisé, bord cardBorder au repos', () => {
    const renderer = render(
      <FormField label="Numéro de série" value="ABC-12" onChangeText={() => {}} />,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain('Numéro de série');
    expect(rendered).toContain('"minHeight":44');
    expect(rendered).toContain('"borderColor":"#EAEEF3"'); // controls.cardBorder
    expect(rendered).not.toContain('"accessibilityRole":"alert"');
  });

  it('erreur : slot danger role alert + bord danger', () => {
    const renderer = render(
      <FormField
        label="Numéro de série"
        value=""
        onChangeText={() => {}}
        error="Numéro obligatoire"
      />,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain('Numéro obligatoire');
    expect(rendered).toContain('"accessibilityRole":"alert"');
    expect(rendered).toContain('"borderColor":"#C8463C"'); // semantic.danger
    expect(rendered).toContain('"color":"#C8463C"');
  });

  it('DateField : préréglage AAAA-MM-JJ, le masque s’applique à la frappe (purement visuel)', () => {
    const onChangeText = vi.fn();
    const renderer = render(
      <DateField label="Installée le" value="" onChangeText={onChangeText} />,
    );
    expect(tree(renderer)).toContain('AAAA-MM-JJ');
    const input = renderer.root.findByType('TextInput' as never);
    act(() => {
      (input.props as { onChangeText: (t: string) => void }).onChangeText('20260802');
    });
    expect(onChangeText).toHaveBeenCalledWith('2026-08-02');
  });
});

describe('HeaderIconButton', () => {
  it('squircle 44×44 radius 13 (arbitrage 42-squircle vs 44-rond), aplat ink, press 0.94, désactivé 0.45', () => {
    // Logique pure (mutants) :
    expect(HEADER_ICON_BUTTON_SIZE).toBe(44);
    expect(HEADER_ICON_BUTTON_RADIUS).toBe(13);
    expect(headerIconButtonStyle({ pressed: false, disabled: false, ink: '#0C2340' })).toEqual({
      width: 44,
      height: 44,
      borderRadius: 13,
      backgroundColor: '#0C2340',
      alignItems: 'center',
      justifyContent: 'center',
    });
    expect(
      headerIconButtonStyle({ pressed: true, disabled: false, ink: '#0C2340' }).transform,
    ).toEqual([{ scale: 0.94 }]);
    expect(headerIconButtonStyle({ pressed: false, disabled: true, ink: '#0C2340' }).opacity).toBe(0.45);
    // Un appui sur un bouton DÉSACTIVÉ ne scale jamais.
    expect(
      headerIconButtonStyle({ pressed: true, disabled: true, ink: '#0C2340' }).transform,
    ).toBeUndefined();

    const renderer = render(
      <HeaderIconButton accessibilityLabel="Ajouter un client" onPress={() => {}}>
        {'PLUS'}
      </HeaderIconButton>,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain('Ajouter un client');
    expect(rendered).toContain('PLUS');
  });
});
