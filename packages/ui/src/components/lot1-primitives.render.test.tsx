/**
 * Lot 1 — primitives mono-lot (plan DA 01/08, « 1er commit du lot ») : états loading/failed
 * de FloatingBalanceCard et HeroMoneyCard, presets SkeletonKpiTile/SkeletonPriorityCard,
 * MoneyRow empty/skeleton, DeadlineRow, TipCard. Preuves :
 *  (a) GÉOMÉTRIE en littéraux — les placeholders portent la MÊME recette que les composants
 *      qu'ils miment (patterns.floatingBalanceCard : overlap −30, radius 22 ; héros 24/20) ;
 *  (b) A11Y HONNÊTE — MoneyRowEmpty annonce « non renseigné » (jamais un tiret verbalisé),
 *      DeadlineRow annonce badge ET explication ;
 *  (c) FAIL-CLOSED hérité du kit — préférence motion NON RÉSOLUE ⇒ aucun pulse de skeleton
 *      (Animated.loop jamais appelé), TipCard sans fondu (animationType 'none').
 * La préférence reste NON RÉSOLUE dans tout le fichier : la mémoire de module de
 * useReduceMotion n'est jamais écrite, chaque montage traverse la fenêtre d'ignorance.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactNode } from 'react';
import { ThemeProvider } from '../theme';
import {
  FloatingBalanceCardPlaceholder,
} from './floating-balance-card';
import { HeroMoneyCardPlaceholder } from './hero-money-card';
import { MoneyRowEmpty, MoneyRowSkeleton } from './money-row';
import { DeadlineRow, DeadlineRowSkeleton } from './deadline-row';
import { SkeletonKpiTile, SkeletonPriorityCard } from './skeleton';
import { TipCard } from './tip-card';
import { ErrorRetry } from './ui-states';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { FakeAnimatedValue, animatedLoop } = vi.hoisted(() => {
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
    stopAnimation(): void {}
  }
  return {
    FakeAnimatedValue,
    animatedLoop: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    // JAMAIS résolue : préférence motion inconnue pendant tout le fichier (fail-closed).
    isReduceMotionEnabled: () => new Promise<boolean>(() => {}),
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
  },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    loop: animatedLoop,
    sequence: vi.fn(() => ({})),
    timing: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  },
  Easing: {
    inOut: (f: unknown) => f,
    out: (f: unknown) => f,
    in: (f: unknown) => f,
    ease: {},
    cubic: {},
  },
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  Pressable: 'Pressable',
  StyleSheet: {
    create: <T,>(styles: T): T => styles,
    absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  },
  Text: 'Text',
  View: 'View',
}));

vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Circle: 'Circle',
  Defs: 'Defs',
  Path: 'Path',
  RadialGradient: 'RadialGradient',
  Rect: 'Rect',
  Stop: 'Stop',
}));

beforeEach(() => {
  animatedLoop.mockClear();
});

function render(node: ReactNode): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ThemeProvider>{node}</ThemeProvider>);
  });
  return renderer;
}

const tree = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

describe('FloatingBalanceCardPlaceholder — la géométrie du héros ne vit plus qu au kit', () => {
  it('loading : recette patterns.floatingBalanceCard (overlap −30, radius 22) + skeleton 31, hint masqué', () => {
    const renderer = render(
      <FloatingBalanceCardPlaceholder
        label="Solde bancaire observé"
        hint="Confirme ton solde dans Argent."
        loading
        onPress={() => {}}
      />,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain('"marginTop":-30');
    expect(rendered).toContain('"marginHorizontal":16');
    expect(rendered).toContain('"borderRadius":22');
    expect(rendered).toContain('"height":31'); // le skeleton du montant, à la taille du chiffre
    expect(rendered).not.toContain('"fontSize":31'); // pas de tiret au cran du montant en loading
    expect(rendered).not.toContain('Confirme ton solde dans Argent.');
    expect(rendered).toContain('"accessibilityLabel":"Solde bancaire observé"');
    expect(rendered).toContain('"accessibilityState":{"busy":true}');
  });

  it('failed/missing : « — » honnête (jamais un montant inventé) + hint voix de Bob + a11y = hint', () => {
    const renderer = render(
      <FloatingBalanceCardPlaceholder
        label="Solde bancaire observé"
        hint="Solde indisponible. Réessaie dans Argent."
        loading={false}
        onPress={() => {}}
      />,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain('—');
    expect(rendered).toContain('Solde indisponible. Réessaie dans Argent.');
    expect(rendered).toContain('"accessibilityLabel":"Solde indisponible. Réessaie dans Argent."');
    expect(rendered).toContain('"accessibilityState":{"busy":false}');
    expect(rendered).toContain('"fontSize":31'); // le tiret au cran EXACT du montant héros
  });
});

describe('ErrorRetry — le CTA appartient au catalogue i18n, pas à la primitive', () => {
  it('rend la reprise générique issue de la personnalité courante', () => {
    const rendered = tree(render(<ErrorRetry message="Incident" onRetry={() => {}} />));
    expect(rendered).toContain('Réessayer');
    expect(rendered).toContain('Incident');
  });
});

describe('HeroMoneyCardPlaceholder — même géométrie que la HeroMoneyCard', () => {
  it('radius 24 / padding 20, skeletons en loading, « — » sinon', () => {
    const loading = tree(
      render(<HeroMoneyCardPlaceholder label="Trésorerie mobilisable" loading />),
    );
    expect(loading).toContain('"borderRadius":24');
    expect(loading).toContain('"padding":20');
    expect(loading).toContain('"height":34');
    expect(loading).not.toContain('—');

    const failed = tree(
      render(<HeroMoneyCardPlaceholder label="Trésorerie mobilisable" loading={false} />),
    );
    expect(failed).toContain('—');
  });
});

describe('MoneyRowEmpty / MoneyRowSkeleton — mêmes styles que MoneyRow', () => {
  it('annonce « non renseigné » au lecteur d’écran quand l’écran le fournit — le tiret reste visuel', () => {
    const renderer = render(
      <MoneyRowEmpty label="Cotisations à venir" valueA11yLabel="non renseigné" />,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain('"accessibilityLabel":"Cotisations à venir, non renseigné"');
    expect(rendered).toContain('—');
  });

  it('sans libellé fourni, retombe sur le tiret (comportement historique)', () => {
    const rendered = tree(render(<MoneyRowEmpty label="TVA à provisionner" />));
    expect(rendered).toContain('"accessibilityLabel":"TVA à provisionner, —"');
  });

  it('variante total : crans 15/700 (label) et 20/800 (montant), padding-top 13 — la grammaire MoneyRow', () => {
    const rendered = tree(render(<MoneyRowEmpty label="Disponible prudent" variant="total" divider={false} />));
    expect(rendered).toContain('"fontSize":15');
    expect(rendered).toContain('"fontSize":20');
    expect(rendered).toContain('"paddingTop":13');
    expect(rendered).not.toContain('"borderBottomWidth":1');
  });

  it('skeleton lead : icône 17 + séparateur du pattern (#F1F4F7)', () => {
    const rendered = tree(render(<MoneyRowSkeleton variant="lead" />));
    expect(rendered).toContain('"width":17');
    expect(rendered).toContain('"borderBottomColor":"#F1F4F7"');
  });
});

describe('DeadlineRow — l’oreille entend TOUT ce que l’œil voit', () => {
  it('annonce date, intitulé, badge d’hypothèse ET explication en une phrase', () => {
    const renderer = render(
      <DeadlineRow
        dateLabel="15 sept."
        title="Déclaration URSSAF"
        explain="Ton chiffre d’affaires du trimestre à déclarer."
        badgeLabel="À CONFIRMER"
        last
      />,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain(
      '"accessibilityLabel":"15 sept., Déclaration URSSAF, À CONFIRMER. Ton chiffre d’affaires du trimestre à déclarer."',
    );
    expect(rendered).toContain('À CONFIRMER'); // le badge est RENDU, pas seulement annoncé
    expect(rendered).not.toContain('"borderBottomWidth":1'); // last : pas de séparateur
  });

  it('sans badge : l’annonce ne fabrique rien, le séparateur bas revient hors dernière rangée', () => {
    const rendered = tree(
      render(
        <DeadlineRow dateLabel="30 nov." title="Clôture" explain="Fin d’exercice." />,
      ),
    );
    expect(rendered).toContain('"accessibilityLabel":"30 nov., Clôture. Fin d’exercice."');
    expect(rendered).toContain('"borderBottomWidth":1');
  });

  it('skeleton : colonne date 62 + deux lignes — le gabarit de la rangée réelle', () => {
    const rendered = tree(render(<DeadlineRowSkeleton />));
    expect(rendered).toContain('"minWidth":62');
  });
});

describe('Presets skeleton du briefing', () => {
  it('SkeletonKpiTile : la géométrie EXACTE de KpiTile (radius 18, padding 15, minHeight 44)', () => {
    const rendered = tree(render(<SkeletonKpiTile />));
    expect(rendered).toContain('"borderRadius":18');
    expect(rendered).toContain('"padding":15');
    expect(rendered).toContain('"minHeight":44');
    expect(rendered).toContain('"height":21'); // la barre du montant au cran bigNum
  });

  it('SkeletonPriorityCard : badge + 2 lignes + CTA compact', () => {
    const rendered = tree(render(<SkeletonPriorityCard />));
    expect(rendered).toContain('"height":20');
    expect(rendered).toContain('"height":34');
  });
});

describe('FAIL-CLOSED hérité du kit — préférence motion NON RÉSOLUE', () => {
  it('aucun pulse de skeleton monté : Animated.loop n’est JAMAIS appelé pendant la fenêtre d’ignorance', () => {
    render(
      <>
        <SkeletonKpiTile />
        <MoneyRowSkeleton />
        <HeroMoneyCardPlaceholder label="x" loading />
      </>,
    );
    expect(animatedLoop).not.toHaveBeenCalled();
  });

  it('TipCard : aucun fondu de Modal (animationType none) tant que la préférence est inconnue, titre au cran sheetTitle (20)', () => {
    const renderer = render(
      <TipCard
        visible
        eyebrow="LE CONSEIL DE BOB"
        author="par Bob"
        title="Mets de côté sans y penser"
        body="La réserve TVA + charges se calcule toute seule."
        ctaLabel="Compris"
        skipLabel="Passer"
        onDismiss={() => {}}
      />,
    );
    const rendered = tree(renderer);
    expect(rendered).toContain('"animationType":"none"');
    expect(rendered).toContain('"fontSize":20');
    expect(rendered).toContain('Mets de côté sans y penser');
  });

  it('TipCard invisible : RIEN n’est monté (pas de Modal fantôme)', () => {
    const renderer = render(
      <TipCard
        visible={false}
        eyebrow="E"
        author="A"
        title="T"
        body="B"
        ctaLabel="C"
        skipLabel="S"
        onDismiss={() => {}}
      />,
    );
    expect(renderer.toJSON()).toBeNull();
  });
});
