/**
 * FAMILLE AUTH — RENDU MULTI-ÉTATS (vague hors-lots, audit 03/08) :
 * · UNE seule taille de H1 (screenH1 27) dans toute la famille — plus de 22/26/28/29 ;
 * · lignes d'erreur en encre danger on-dark CERTIFIÉE (surfaceTint.dark.danger.ink) —
 *   dangerVivid ≈4,3:1 échouait l'AA sur marine.d1 pour LE message qui débloque ;
 * · AuthCta/AuthField partagés : busy = ActivityIndicator (jamais « … »), toggle
 *   afficher/masquer sur les mots de passe du login (parité avec la récupération) ;
 * · succès de confirmation = COCHE verte (SparkIcon reste le glyphe exclusif de Bob) ;
 * · provisioning : chips forme/TVA à cible 44 + rôle radio, messages d'erreur DÉDIÉS
 *   (le libellé du champ ne sert plus de message) ;
 * · cibles 44 sur les échappatoires du header login ; détails ≥ white70.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { semantic, surfaceTint } from '@bob/tokens';
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
  },
  ActivityIndicator: 'ActivityIndicator',
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: vi.fn(), stop: vi.fn() }),
    loop: () => ({ start: vi.fn(), stop: vi.fn() }),
    sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, in: (f: unknown) => f, quad: {}, cubic: {}, ease: {} },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles, absoluteFill: {} },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  findNodeHandle: () => null,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Circle: 'Circle', Path: 'Path', Rect: 'Rect' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));
vi.mock('expo-linking', () => ({
  addEventListener: () => ({ remove: vi.fn() }),
  clearInitialURL: vi.fn(),
  getInitialURL: () => Promise.resolve(null),
}));
const nav = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: nav.push, back: nav.back, replace: nav.replace, canGoBack: () => true }),
  useLocalSearchParams: () => ({}),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));

const authState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../src/data/auth', () => ({ useAuth: () => authState.value }));
vi.mock('../../src/data/biometric', () => ({ markFreshLogin: vi.fn() }));
const lookupState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../src/data/hooks', () => ({ useLookupCompany: () => lookupState.value }));
vi.mock('../../src/data/client', () => ({
  useBobClient: () => ({
    registerCompany: vi.fn(async () => ({ ok: true, value: {} })),
    lookupCompany: vi.fn(async () => ({ ok: false, error: { kind: 'unavailable' } })),
  }),
}));
vi.mock('../../src/data/supabase', () => ({ supabase: null }));
vi.mock('../../src/data/no-company-state', () => ({ clearNoCompanyQueries: vi.fn() }));
const draftState = vi.hoisted(() => ({
  snapshot: null as Record<string, unknown> | null,
  siret: null as string | null,
}));
vi.mock('../../src/data/company-draft', () => ({
  LEGAL_FORM_LABELS: { EI: 'Entreprise individuelle', micro: 'Micro', EURL: 'EURL', SASU: 'SASU', SARL: 'SARL', SAS: 'SAS' },
  LEGAL_FORM_OPTIONS: ['EI', 'micro', 'EURL', 'SASU'],
  readCompanySnapshot: () => draftState.snapshot,
  readDraftSiret: () => draftState.siret,
  registerInputFromLookup: (lookup: unknown) => lookup,
}));
vi.mock('../../src/components/CompanyFicheCard', () => ({
  CompanyFicheCard: () => null,
  formatSiret: (raw: string) => raw,
}));

const { LoginScreen } = await import('../../src/screens/LoginScreen');
const { EmailConfirmationScreen } = await import('../../src/screens/EmailConfirmationScreen');
const { PasswordRecoveryScreen } = await import('../../src/screens/PasswordRecoveryScreen');
const { ProvisioningScreen } = await import('../../src/screens/ProvisioningScreen');

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ThemeProvider, null, element));
  });
  return renderer;
}

function pressables(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('Pressable' as never);
}
function byLabel(renderer: ReactTestRenderer, label: string) {
  return pressables(renderer).find(
    (node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === label,
  );
}
const styleOf = (node: { props: unknown }): string =>
  JSON.stringify((node.props as { style?: unknown }).style ?? null);

/** Toutes les tailles portées par la famille display 700 (les H1) — l'échelle se vérifie. */
function displayTitleSizes(renderer: ReactTestRenderer): number[] {
  return renderer.root
    .findAllByType('Text' as never)
    .map((node) => styleOf(node))
    .filter((style) => style.includes('SchibstedGrotesk_700Bold'))
    .map((style) => {
      const sizes = [...style.matchAll(/"fontSize":([\d.]+)/g)].map((m) => Number(m[1]));
      return sizes[sizes.length - 1] ?? 0;
    });
}

beforeEach(() => {
  authState.value = {
    signIn: vi.fn(async () => ({ error: null })),
    signUp: vi.fn(async () => ({ error: null, needsConfirmation: true })),
    resetPassword: vi.fn(async () => ({ error: null })),
    resendSignupConfirmation: vi.fn(async () => ({ error: null })),
    session: null,
    emailConfirmation: { phase: 'confirmed', error: null },
    beginEmailConfirmation: vi.fn(async () => {}),
    finishEmailConfirmation: vi.fn(),
    passwordRecovery: { phase: 'ready', error: null },
    beginPasswordRecovery: vi.fn(async () => {}),
    updateRecoveredPassword: vi.fn(async () => {}),
    finishPasswordRecovery: vi.fn(),
    signOut: vi.fn(),
  };
  lookupState.value = { isPending: false, mutateAsync: vi.fn() };
  draftState.snapshot = { legalForm: null };
  draftState.siret = null;
});

describe('LoginScreen — le chemin critique', () => {
  it('UNE seule taille de H1 : tous les titres display sont au cran screenH1 (27)', async () => {
    const renderer = await render(createElement(LoginScreen));
    const sizes = displayTitleSizes(renderer);
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBe(27);
  });

  it('erreur de connexion : encre danger on-dark certifiée (plus jamais dangerVivid)', async () => {
    const renderer = await render(createElement(LoginScreen));
    const cta = byLabel(renderer, 'Se connecter');
    expect(cta).toBeDefined();
    await act(async () => {
      (cta!.props as { onPress: () => void }).onPress();
    });
    const line = renderer.root
      .findAllByType('Text' as never)
      .find(
        (node) =>
          (node.props as { children?: unknown }).children === 'Il me faut ton email et ton mot de passe.',
      );
    expect(line).toBeDefined();
    expect(styleOf(line!)).toContain(`"color":"${surfaceTint.dark.danger.ink}"`);
    expect(styleOf(line!)).not.toContain('#E5544B');
  });

  it('le mot de passe du login porte le toggle afficher/masquer (parité récupération)', async () => {
    const renderer = await render(createElement(LoginScreen));
    const toggle = byLabel(renderer, 'Afficher le mot de passe');
    expect(toggle).toBeDefined();
  });

  it('« J’ai déjà un compte » et le retour ont une cible ≥ 44 (étape SIRET)', async () => {
    const renderer = await render(createElement(LoginScreen));
    const toSignup = pressables(renderer).find((node) =>
      ((node.props as { accessibilityLabel?: string }).accessibilityLabel ?? '').includes('compte ?'),
    );
    await act(async () => {
      (toSignup!.props as { onPress: () => void }).onPress();
    });
    for (const label of ['Retour', 'Déjà un compte ? Se connecter']) {
      const target = pressables(renderer).find((node) =>
        ((node.props as { accessibilityLabel?: string }).accessibilityLabel ?? '').includes(label),
      );
      expect(target).toBeDefined();
      expect(styleOf(target!)).toContain('"minHeight":44');
    }
  });

  it('CTA busy (lookup en cours) : ActivityIndicator, jamais « … »', async () => {
    lookupState.value = { isPending: true, mutateAsync: vi.fn() };
    const renderer = await render(createElement(LoginScreen));
    const toSignup = pressables(renderer).find((node) =>
      ((node.props as { accessibilityLabel?: string }).accessibilityLabel ?? '').includes('compte ?'),
    );
    await act(async () => {
      (toSignup!.props as { onPress: () => void }).onPress();
    });
    expect(renderer.root.findAllByType('ActivityIndicator' as never).length).toBeGreaterThan(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('…');
  });
});

describe('EmailConfirmationScreen — le succès parle en coche verte', () => {
  it('phase confirmed : COCHE verte (le SparkIcon de Bob ne dit jamais « succès »)', async () => {
    const renderer = await render(createElement(EmailConfirmationScreen));
    const svgs = renderer.root.findAllByType('Svg' as never);
    const successGlyphs = svgs.filter(
      (node) => (node.props as { stroke?: string }).stroke === semantic.success,
    );
    expect(successGlyphs.length).toBe(1);
    const path = successGlyphs[0]!
      .findAllByType('Path' as never)
      .map((node) => (node.props as { d?: string }).d)
      .join(' ');
    expect(path).toBe('M4 12.5l5 5L20 6.5'); // le tracé de CheckIcon, pas l'étoile Spark
    expect(JSON.stringify(renderer.toJSON())).toContain('compte est confirmé'); // titre pote
  });

  it('phase erreur : titre au cran 27 + AuthCta retour', async () => {
    authState.value = {
      ...authState.value,
      emailConfirmation: { phase: 'error', error: 'expired_link' },
    };
    const renderer = await render(createElement(EmailConfirmationScreen));
    for (const size of displayTitleSizes(renderer)) expect(size).toBe(27);
    expect(byLabel(renderer, 'Retour à la connexion')).toBeDefined();
  });
});

describe('PasswordRecoveryScreen — formulaire prêt', () => {
  it('deux champs à toggle + hint en white70 (détail ≥ white70)', async () => {
    const renderer = await render(createElement(PasswordRecoveryScreen));
    const toggles = pressables(renderer).filter(
      (node) =>
        (node.props as { accessibilityLabel?: string }).accessibilityLabel ===
        'Afficher le mot de passe',
    );
    expect(toggles).toHaveLength(2);
    const hint = renderer.root
      .findAllByType('Text' as never)
      .find((node) =>
        JSON.stringify((node.props as { children?: unknown }).children ?? '').includes('8 caractères'),
      );
    expect(hint).toBeDefined();
    expect(styleOf(hint!)).toContain('rgba(255,255,255,.7)');
  });

  it('phase establishing : progressbar annoncée, aucun formulaire', async () => {
    authState.value = {
      ...authState.value,
      passwordRecovery: { phase: 'establishing', error: null },
    };
    const renderer = await render(createElement(PasswordRecoveryScreen));
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('"accessibilityRole":"progressbar"');
    expect(byLabel(renderer, 'Afficher le mot de passe')).toBeUndefined();
  });
});

describe('ProvisioningScreen — chips 44/radio et erreurs dédiées', () => {
  it('les chips forme juridique et TVA sont des radios à cible 44', async () => {
    const renderer = await render(createElement(ProvisioningScreen));
    const radios = pressables(renderer).filter(
      (node) => (node.props as { accessibilityRole?: string }).accessibilityRole === 'radio',
    );
    expect(radios.length).toBeGreaterThanOrEqual(7); // 4 formes + 3 régimes
    for (const radio of radios) {
      expect(styleOf(radio)).toContain('"minHeight":44');
      expect((radio.props as { accessibilityState?: { checked?: boolean } }).accessibilityState)
        .toHaveProperty('checked');
    }
  });

  it('valider sans forme juridique ⇒ message DÉDIÉ (plus jamais le libellé du champ)', async () => {
    const renderer = await render(createElement(ProvisioningScreen));
    const confirm = byLabel(renderer, 'Créer mon espace');
    expect(confirm).toBeDefined();
    await act(async () => {
      (confirm!.props as { onPress: () => void }).onPress();
    });
    const line = renderer.root
      .findAllByType('Text' as never)
      .find(
        (node) =>
          (node.props as { children?: unknown }).children ===
          'Choisis ta forme juridique pour continuer.',
      );
    expect(line).toBeDefined();
    expect(styleOf(line!)).toContain(`"color":"${surfaceTint.dark.danger.ink}"`);
    // Le LIBELLÉ du champ n'est plus resservi comme message d'erreur.
    expect(styleOf(line!)).not.toContain('#E5544B');
  });
});
