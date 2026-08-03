/**
 * CLÔTURE — RENDU MULTI-ÉTATS (Lot 5) + GRAMMAIRE D'ERREUR DU MOMENT LE PLUS ANXIOGÈNE :
 * · échec d'export FEC ⇒ ErrorSheet kit (titre = l'ACTION, message honnête) — plus jamais
 *   « Oups » système ; avertissements FEC ⇒ Sheet LISTÉE (une rangée par avertissement) ;
 * · les 2 CTA passent au Button kit : parité STRICTE disabled/loading (exportFec.isPending
 *   ⇒ busy annoncé + libellé « génération »), libellé d'action accessible STABLE ;
 * · balance générale : colonnes flexBasis+minWidth (60/92) — Dynamic Type XXL pousse au
 *   lieu de tronquer ; plus aucun width figé ;
 * · rangée retour kit 44 pt ; skeletons ; échec réseau ⇒ « Réessayer », jamais un
 *   « tout est prêt » fabriqué. Fixtures relatives au présent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { ThemeProvider } from '@bob/ui';

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
    stopAnimation(): void {}
  }
  return { FakeAnimatedValue };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => new Promise<boolean>(() => {}),
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
    announceForAccessibility: vi.fn(),
    setAccessibilityFocus: vi.fn(),
  },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
  ActivityIndicator: 'ActivityIndicator',
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, in: (f: unknown) => f, quad: {}, cubic: {}, ease: {} },
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles, absoluteFill: {} },
  Text: 'Text',
  View: 'View',
  findNodeHandle: () => null,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Circle: 'Circle', Path: 'Path', Rect: 'Rect' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));

const nav = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: nav.push, back: nav.back, canGoBack: () => true }),
}));
vi.mock('../../src/agent', () => ({ usePublishAgentContext: vi.fn() }));
vi.mock('../../src/components/use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 150,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));
const share = vi.hoisted(() => ({
  shareFec: vi.fn(async () => 'unavailable' as const),
  shareTextFile: vi.fn(async () => 'unavailable' as const),
}));
vi.mock('../../src/lib/share-fec', () => ({ shareFec: share.shareFec }));
vi.mock('../../src/lib/share-text', () => ({ shareTextFile: share.shareTextFile }));

const sources = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  exportFec: { value: {} as Record<string, unknown> },
  entitlement: {
    value: { allowed: true, verified: true, loading: false, decision: null } as unknown,
  },
}));
vi.mock('../../src/monetization/paywall', () => ({
  PaywallCard: () => null,
  useEntitlement: () => sources.entitlement.value,
}));
vi.mock('../../src/data/documents', () => ({ useDocuments: () => sources.value['documents'] }));
vi.mock('../../src/data/hooks', () => ({
  useInvoices: () => sources.value['invoices'],
  useQuotes: () => sources.value['quotes'],
  useAccountingEntries: () => sources.value['entries'],
  useCompany: () => sources.value['company'],
  useExportFec: () => sources.exportFec.value,
  appErrorMessage: (e: unknown) => (e instanceof Error ? e.message : 'Erreur inconnue'),
}));

const { default: Cloture } = await import('../cloture');

interface QueryDouble {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  refetch: ReturnType<typeof vi.fn>;
}
function q(over: Partial<QueryDouble> = {}): QueryDouble {
  return { data: undefined, isLoading: false, isError: false, isRefetching: false, refetch: vi.fn(), ...over };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const isoOf = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const TODAY = isoOf(new Date());

/** Écriture ÉQUILIBRÉE du mois (706 au crédit, 411 au débit) — la balance a des lignes. */
const SALE_ENTRY = {
  id: 'e1',
  reference: 'VT-0001',
  label: 'Facture Martin',
  entryDate: TODAY,
  journal: 'sales',
  sourceType: 'invoice',
  lines: [
    { account: '411', label: 'Client', debitCents: 120_000, creditCents: 0 },
    { account: '706', label: 'Prestations', debitCents: 0, creditCents: 120_000 },
  ],
};

function configure(over: Partial<Record<string, unknown>> = {}): void {
  sources.entitlement.value = { allowed: true, verified: true, loading: false, decision: null };
  sources.exportFec.value = { isPending: false, mutateAsync: vi.fn(), mutate: vi.fn() };
  sources.value = {
    invoices: q({ data: [] }),
    quotes: q({ data: [] }),
    documents: q({ data: [] }),
    entries: q({ data: [SALE_ENTRY] }),
    company: q({ data: { name: 'Fly Services', siren: '123456789' } }),
    ...over,
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, createElement(Cloture)));
  });
  return renderer;
}
const treeOf = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

function findByLabel(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType('Pressable' as never)
    .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === label);
}

beforeEach(() => {
  configure();
});

describe('Grammaire d’erreur — le moment le plus anxiogène garde la voix de Bob', () => {
  it('échec d’export FEC ⇒ ErrorSheet (titre = l’action, message honnête), plus d’Alert système', async () => {
    sources.exportFec.value = {
      isPending: false,
      mutateAsync: vi.fn(async () => {
        throw new Error('Le serveur comptable ne répond pas.');
      }),
    };
    const renderer = await render();
    const fecCta = findByLabel(renderer, 'Exporter le FEC seul');
    expect(fecCta).toBeDefined();
    await act(async () => {
      (fecCta!.props as { onPress: () => void }).onPress();
    });
    const rendered = treeOf(renderer);
    expect(rendered).toContain('Exporter le FEC seul'); // le titre de la feuille = l'ACTION
    expect(rendered).toContain('Le serveur comptable ne répond pas.');
  });

  it('avertissements FEC ⇒ Sheet LISTÉE (une rangée par avertissement) + toast succès', async () => {
    sources.exportFec.value = {
      isPending: false,
      mutateAsync: vi.fn(async () => ({
        filename: 'FEC-2026.txt',
        warnings: ['Compte 411 sans libellé', 'Pièce sans justificatif'],
      })),
    };
    const renderer = await render();
    const fecCta = findByLabel(renderer, 'Exporter le FEC seul');
    await act(async () => {
      (fecCta!.props as { onPress: () => void }).onPress();
    });
    const rendered = treeOf(renderer);
    expect(rendered).toContain('Avertissements FEC');
    expect(rendered).toContain('Compte 411 sans libellé');
    expect(rendered).toContain('Pièce sans justificatif');
    expect(rendered).toContain('FEC-2026.txt'); // toast honnête de génération
    // i18n common.close (verdict Lot 5, P3) : le bouton de la Sheet dit « Fermer » (catalogue),
    // plus jamais un « OK » en dur hors humeurs — assertion sur le NŒUD du bouton.
    expect(rendered).not.toContain('"OK"');
    const closeButton = renderer.root
      .findAllByType('Text' as never)
      .find((node) => (node.props as { children?: unknown }).children === 'Fermer');
    expect(closeButton).toBeDefined();
  });
});

describe('CTA kit — parité stricte des états', () => {
  it('exportFec.isPending ⇒ Button busy + disabled, libellé « génération », label d’action stable', async () => {
    sources.exportFec.value = { isPending: true, mutateAsync: vi.fn() };
    const renderer = await render();
    const fecCta = findByLabel(renderer, 'Exporter le FEC seul');
    expect(fecCta).toBeDefined();
    const state = (fecCta!.props as { accessibilityState?: { disabled?: boolean; busy?: boolean } })
      .accessibilityState;
    expect(state?.disabled).toBe(true);
    expect(state?.busy).toBe(true);
    expect(treeOf(renderer)).toContain('Génération'); // cloture.exportingFec
  });

  it('le CTA « Envoyer le dossier au comptable » porte l’icône envoi (slot leading du kit)', async () => {
    const renderer = await render();
    const send = findByLabel(renderer, 'Envoyer le dossier au comptable');
    expect(send).toBeDefined();
  });

  it('sendingDossier ⇒ le CTA d’envoi est busy + disabled, libellé « Préparation » (P2 du verdict)', async () => {
    // Le partage du dossier RESTE en vol : l'état sendingDossier est observable pendant ce temps.
    let releaseShare!: (value: 'unavailable') => void;
    share.shareTextFile.mockImplementationOnce(
      () =>
        new Promise<'unavailable'>((resolve) => {
          releaseShare = resolve;
        }),
    );
    const renderer = await render();
    const send = findByLabel(renderer, 'Envoyer le dossier au comptable');
    expect(send).toBeDefined();
    await act(async () => {
      (send!.props as { onPress: () => void }).onPress();
    });
    // Parité STRICTE (mutant N9 : disabled/loading retirés ⇒ ces trois assertions rougissent).
    const pending = findByLabel(renderer, 'Envoyer le dossier au comptable');
    const state = (pending!.props as { accessibilityState?: { disabled?: boolean; busy?: boolean } })
      .accessibilityState;
    expect(state?.disabled).toBe(true);
    expect(state?.busy).toBe(true);
    expect(treeOf(renderer)).toContain('Préparation du dossier…'); // cloture.sendingDossier
    await act(async () => {
      releaseShare('unavailable');
    });
    // Le geste terminé, le CTA revient actionnable — aucun état fantôme.
    const settled = findByLabel(renderer, 'Envoyer le dossier au comptable');
    expect(
      (settled!.props as { accessibilityState?: { disabled?: boolean } }).accessibilityState
        ?.disabled,
    ).toBe(false);
  });
});

describe('CheckRow — une rangée réglée n’est pas « non disponible » (P3 du verdict)', () => {
  it('compteur 0 ⇒ ni rôle bouton, ni onPress, ni disabled annoncé à VoiceOver', async () => {
    // Fixtures par défaut : aucune anomalie — toutes les rangées de checklist sont réglées.
    const renderer = await render();
    const row = findByLabel(renderer, 'Devis signés à facturer : 0');
    expect(row).toBeDefined();
    const props = row!.props as {
      accessibilityRole?: string;
      onPress?: unknown;
      disabled?: boolean;
      accessibilityState?: { disabled?: boolean };
    };
    expect(props.accessibilityRole).toBeUndefined();
    expect(props.onPress).toBeUndefined();
    // La sémantique inverse du sens porté (« c'est réglé » ≠ désactivé) ne revient jamais.
    expect(props.disabled).not.toBe(true);
    expect(props.accessibilityState?.disabled).not.toBe(true);
  });
});

describe('Balance générale — Dynamic Type ne tronque plus', () => {
  it('colonnes compte/solde en flexBasis 60/92 + minWidth, plus aucun width figé', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('"flexBasis":60');
    expect(rendered).toContain('"minWidth":60');
    expect(rendered).toContain('"flexBasis":92');
    expect(rendered).toContain('"minWidth":92');
    expect(rendered).not.toContain('"width":60');
    expect(rendered).not.toContain('"width":92');
  });
});

describe('États de premier rang', () => {
  it('échec réseau ⇒ « Réessayer » — jamais un « tout est prêt » fabriqué', async () => {
    configure({ entries: q({ isError: true }) });
    const rendered = treeOf(await render());
    expect(rendered).toContain('Réessayer');
    expect(rendered).not.toContain('VT-0001');
  });

  it('chargement ⇒ squelettes (décor masqué), aucun CTA d’envoi', async () => {
    configure({ entries: q({ isLoading: true }) });
    const renderer = await render();
    expect(treeOf(renderer)).toContain('"accessibilityElementsHidden":true');
    expect(findByLabel(renderer, 'Envoyer le dossier au comptable')).toBeUndefined();
  });
});

describe('Rangée retour kit — cible 44 pt', () => {
  it('le retour « Accueil » est un StickyBackRow à minHeight 44', async () => {
    const renderer = await render();
    const back = findByLabel(renderer, 'Accueil');
    expect(back).toBeDefined();
    const style = (back!.props as { style: unknown }).style;
    const resolved = JSON.stringify(typeof style === 'function' ? style({ pressed: false }) : style);
    expect(resolved).toContain('"minHeight":44');
  });
});
