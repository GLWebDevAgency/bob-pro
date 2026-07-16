import type { ElementType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AccountingLinesView, type LedgerLine } from './AccountingLinesView';

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
vi.mock('@bob/ui', () => ({
  font: () => ({ fontFamily: 'MockFont' }),
  useTheme: () => theme,
}));

const LINES: readonly LedgerLine[] = [
  { account: '512000', label: 'Banque principale', debitCents: 132_000, creditCents: 0 },
  { account: '411000', label: 'Client Durand', debitCents: 0, creditCents: 132_000 },
];

const HOST_TEXT = 'Text' as unknown as ElementType;
const HOST_VIEW = 'View' as unknown as ElementType;

function accessibilityLabels(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => typeof node.props.accessibilityLabel === 'string')
    .map((node) => node.props.accessibilityLabel as string);
}

describe('AccountingLinesView', () => {
  it('ne rend rien pour une écriture vide', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<AccountingLinesView lines={[]} />);
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it('annonce débit/crédit en toutes lettres sans tronquer les libellés', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<AccountingLinesView lines={LINES} />);
    });

    expect(accessibilityLabels(renderer).some((label) => label.includes('Débit'))).toBe(true);
    expect(accessibilityLabels(renderer).some((label) => label.includes('Crédit'))).toBe(true);
    const visibleLabels = renderer.root
      .findAllByType(HOST_TEXT)
      .filter((node) => node.children.join('').includes('Banque principale'));
    expect(visibleLabels).toHaveLength(1);
    expect(visibleLabels[0]?.props.numberOfLines).toBeUndefined();
    expect(
      renderer.root.findAllByType(HOST_VIEW).some((node) => node.props.style?.flexWrap === 'wrap'),
    ).toBe(true);
  });

  it('rend les totaux seulement quand débit et crédit sont tous les deux disponibles', async () => {
    let partial!: ReactTestRenderer;
    await act(async () => {
      partial = create(<AccountingLinesView lines={LINES} totalDebitCents={132_000} />);
    });
    expect(accessibilityLabels(partial).some((label) => label.startsWith('Total.'))).toBe(false);

    let complete!: ReactTestRenderer;
    await act(async () => {
      complete = create(
        <AccountingLinesView lines={LINES} totalDebitCents={132_000} totalCreditCents={132_000} />,
      );
    });
    expect(
      accessibilityLabels(complete).some((label) => /^Total\. Débit : .*Crédit : /.test(label)),
    ).toBe(true);
  });
});
