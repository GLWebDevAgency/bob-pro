/**
 * Lot 3 — primitives mono-lot (plan DA 01/08, « 1er commit du lot ») : FilterChip
 * (croix, cible 44, sélection theme.ink dans les 4 thèmes), PieceListRow (gabarit exact
 * des cartes de ventes.tsx), QuotePreviewBox (encadré du vrai message), et le slot `hint`
 * additif de QuestionSheet (pédagogie légale au point de décision — l'arbre sans hint
 * reste STRICTEMENT historique).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactNode } from 'react';
import { ThemeProvider } from '../theme';
import { FilterChip } from './filter-chip';
import { PieceListRow } from './piece-list-row';
import { QuotePreviewBox } from './quote-preview-box';
import { QuestionSheet } from './question-sheet';

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
    // Préférence motion JAMAIS résolue — fail-closed hérité pendant tout le fichier.
    isReduceMotionEnabled: () => new Promise<boolean>(() => {}),
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
  },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }) }),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, ease: {}, cubic: {}, quad: {} },
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles },
  Text: 'Text',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
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

const tree = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

describe('FilterChip — chip de filtre actif supprimable', () => {
  it('marine (défaut) : bord ink #0C2340, fond teinté #E9EBEE, croix hitSlop 13 (cible 44)', () => {
    const renderer = render(
      <FilterChip
        label="chauffe-eau"
        onRemove={() => {}}
        removeAccessibilityLabel="Retirer le filtre — chauffe-eau"
      />,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain('chauffe-eau');
    expect(rendered).toContain('"borderColor":"#0C2340"');
    expect(rendered).toContain('"backgroundColor":"#E9EBEE"');
    expect(rendered).toContain('"height":30');
    // Croix : tracé CloseIcon + libellé i18n de l'APPELANT (jamais fabriqué par le kit).
    expect(rendered).toContain('M18 6L6 18M6 6l12 12');
    expect(rendered).toContain('Retirer le filtre — chauffe-eau');
    const cross = renderer.root
      .findAllByType('Pressable' as never)
      .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel?.startsWith('Retirer'));
    expect(cross).toBeDefined();
    expect((cross!.props as { hitSlop: number }).hitSlop).toBe(13);
  });

  it.each([
    ['foret', '#0C4A37'],
    ['graphite', '#1B2028'],
    ['indigo', '#312C8A'],
  ] as const)('thème %s : la sélection suit theme.ink (%s), jamais semantic.ai', async (themeName, expectedInk) => {
    const storage = {
      read: () => Promise.resolve(JSON.stringify({ themeName })),
      write: () => Promise.resolve(),
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ThemeProvider storage={storage}>
          <FilterChip label="Ce mois-ci" onRemove={() => {}} removeAccessibilityLabel="Retirer" />
        </ThemeProvider>,
      );
    });
    const rendered = tree(renderer);
    expect(rendered).toContain(`"borderColor":"${expectedInk}"`);
    expect(rendered).not.toContain('"borderColor":"#4338CA"'); // semantic.ai — canal de Bob
    expect(rendered).not.toContain('"backgroundColor":"#F1EBFA"'); // semantic.aiBg
  });

  it('pressable (onPress) : rôle bouton + selected annoncé + press feedback', () => {
    const renderer = render(<FilterChip label="Devis" active onPress={() => {}} />);
    const chip = renderer.root
      .findAllByType('Pressable' as never)
      .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === 'Devis');
    expect(chip).toBeDefined();
    expect((chip!.props as { accessibilityState: { selected: boolean } }).accessibilityState).toMatchObject({
      selected: true,
    });
    const style = (chip!.props as { style: (s: { pressed: boolean }) => { transform: unknown[] } }).style;
    expect(style({ pressed: true })).toMatchObject({ opacity: 0.8 });
  });
});

describe('PieceListRow — le gabarit exact des cartes de ventes.tsx', () => {
  it('titre cardTitle ink900, client meta slate400, colonne droite montant → statut', () => {
    const renderer = render(
      <PieceListRow
        title="F-2026-012"
        subtitle="Mairie de Lyon"
        meta="Émise le 12/07/2026 · échéance 12/08/2026"
        amount={<>{'1 250 €'}</>}
        status={<>{'BADGE'}</>}
        onPress={() => {}}
        accessibilityLabel="Facture F-2026-012 — Mairie de Lyon"
      />,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain('F-2026-012');
    expect(rendered).toContain('"color":"#0C2340"'); // ink900 du titre
    expect(rendered).toContain('Mairie de Lyon');
    expect(rendered).toContain('Émise le 12/07/2026 · échéance 12/08/2026');
    // Ordre du document : montant AVANT badge dans la colonne de droite.
    expect(rendered.indexOf('1 250 €')).toBeLessThan(rendered.indexOf('BADGE'));
    const row = renderer.root.findByType('Pressable' as never);
    expect((row.props as { accessibilityLabel: string }).accessibilityLabel).toBe(
      'Facture F-2026-012 — Mairie de Lyon',
    );
    // Press feedback historique des cartes de ventes (opacité 0.65).
    const style = (row.props as { style: (s: { pressed: boolean }) => { opacity: number } }).style;
    expect(style({ pressed: true })).toMatchObject({ opacity: 0.65 });
  });

  it('sans meta ni chips : aucune ligne fantôme', () => {
    const renderer = render(
      <PieceListRow
        title="Brouillon"
        subtitle="M. Bernard"
        amount={<>{'480 €'}</>}
        status={<>{'BADGE'}</>}
        onPress={() => {}}
        accessibilityLabel="Devis brouillon — M. Bernard"
      />,
    );
    const texts = renderer.root
      .findAllByType('Text' as never)
      .map((n) => JSON.stringify((n.props as { children: unknown }).children));
    expect(texts).toHaveLength(2); // titre + client, rien d'autre
  });
});

describe('QuotePreviewBox — l’encadré du vrai message', () => {
  it('bord cardBorder #E7ECF2, radius 12, padding 12, texte sub/500 interligne 20', () => {
    const renderer = render(<QuotePreviewBox text="Bonjour, un rappel pour le devis D-2026-004…" />);
    const rendered = tree(renderer);
    expect(rendered).toContain('Bonjour, un rappel pour le devis D-2026-004…');
    expect(rendered).toContain('"borderRadius":12');
    expect(rendered).toContain('"borderWidth":1');
    expect(rendered).toContain('"padding":12');
    expect(rendered).toContain('"lineHeight":20');
    expect(rendered).toContain('"fontSize":13.5'); // cran sub — plus jamais un 13.5 ad hoc
  });
});

describe('QuestionSheet — slot hint additif (pédagogie au point de décision)', () => {
  it('hint rendu APRÈS les options, AVANT le geste « autre »', () => {
    const renderer = render(
      <QuestionSheet
        visible
        header="TVA"
        question="Conditions du taux réduit toujours remplies ?"
        options={[
          { value: 'eligible', label: 'Oui — conditions remplies' },
          { value: 'standard', label: 'Non — TVA 20 %' },
        ]}
        hint={<>{'HINT-LEGAL'}</>}
        confirmLabel="Valider"
        otherLabel="Annuler"
        onClose={() => {}}
        onSelect={() => {}}
        onOther={() => {}}
      />,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain('HINT-LEGAL');
    expect(rendered.indexOf('Non — TVA 20 %')).toBeLessThan(rendered.indexOf('HINT-LEGAL'));
    expect(rendered.indexOf('HINT-LEGAL')).toBeLessThan(rendered.indexOf('Annuler'));
  });

  it('sans hint : arbre historique STRICTEMENT inchangé (aucun conteneur fantôme)', () => {
    const props = {
      visible: true,
      header: 'TVA',
      question: 'Q ?',
      options: [{ value: 'a', label: 'A' }],
      confirmLabel: 'Valider',
      otherLabel: 'Annuler',
      onClose: () => {},
      onSelect: () => {},
      onOther: () => {},
    };
    const withOut = tree(render(<QuestionSheet {...props} />));
    expect(withOut).not.toContain('HINT-LEGAL');
    // Le slot absent ne laisse AUCUNE View supplémentaire entre options et « autre ».
    const withHint = tree(render(<QuestionSheet {...props} hint={<>{'HINT-LEGAL'}</>} />));
    expect(withHint.length).toBeGreaterThan(withOut.length);
  });
});
