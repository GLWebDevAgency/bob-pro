import type { ElementType, ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { CompanyLookupResult } from '@bob/core';
import { CompanyFicheCard } from './CompanyFicheCard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const theme = vi.hoisted(() => ({
  colors: {
    ink900: '#ink900',
    ink800: '#ink800-aa',
    slate400: '#slate400',
    lineSoft: '#lineSoft',
  },
  semantic: {
    success: '#success',
    successBg: '#successBg',
    warning: '#warning-border',
    warningBg: '#warningBg',
  },
  personality: 'pro' as const,
}));

vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }));
vi.mock('@bob/ui', async () => {
  const { createElement } = await import('react');
  return {
    Card: ({ children, ...props }: { children?: ReactNode }) =>
      createElement('Card', props, children),
    font: () => ({ fontFamily: 'MockFont' }),
    useTheme: () => theme,
  };
});

const HOST_TEXT = 'Text' as unknown as ElementType;

const company = (etatAdministratif: CompanyLookupResult['etatAdministratif']): CompanyLookupResult => ({
  siren: '451321335',
  siret: '45132133501021',
  denomination: 'CARREFOUR HYPERMARCHES',
  nafApe: '68.20B',
  trade: null,
  natureJuridiqueCode: '5710',
  legalForm: 'SAS',
  dateCreation: '2000-01-03',
  address: { line1: '280 RUE DE PARIS', zip: '93100', city: 'MONTREUIL' },
  tvaIntracom: 'FR90451321335',
  etatAdministratif,
  rge: false,
});

describe('CompanyFicheCard — établissement fermé', () => {
  it('annonce le statut F dans inscription et provisioning avec une encre lisible', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CompanyFicheCard company={company('F')} />);
    });

    const alert = renderer.root.findByProps({
      accessibilityRole: 'alert',
      accessibilityLiveRegion: 'polite',
    });
    expect(alert.props.style).toMatchObject({
      backgroundColor: theme.semantic.warningBg,
      borderColor: theme.semantic.warning,
    });
    const warningText = alert.findByType(HOST_TEXT);
    const styles = Array.isArray(warningText.props.style)
      ? warningText.props.style
      : [warningText.props.style];
    expect(styles).toContainEqual(expect.objectContaining({ color: theme.colors.ink800 }));
    expect(warningText.children.join('')).toContain('déclaré fermé');
  });

  it.each(['A', null] as const)('ne fabrique pas d alerte pour l état %s', async (status) => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CompanyFicheCard company={company(status)} />);
    });
    expect(renderer.root.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(0);
  });
});
