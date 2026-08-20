/**
 * LE PARCOURS VISIBLE, DANS UNE ROUTE RÉELLE (lot U1-e §3/§5 — preuve É0).
 *
 * Ce fichier monte la VRAIE fiche client (`app/client/[id].tsx`), avec le VRAI hook de découverte,
 * le VRAI coordinateur, la VRAIE carte et les VRAIS boutons `@bob/ui`. Seuls le transport HTTP et
 * les sources de données de la fiche sont doublés : rien de la chaîne testée n'est simulé.
 *
 * Ce qu'il prouve, et que le lot U1-d ne pouvait pas prouver (la carte n'avait AUCUN appelant) :
 * - l'appareil apprend son `runId` tout seul (`GET /jarvis/runs/current`) et la carte apparaît ;
 * - l'enchaînement §7.1 complet : accusé d'affichage → relecture autoritative → `presented` →
 *   « Confirmer » ouvert → `confirm` émis ;
 * - un échec du canal tactile s'affiche et se réessaie, il ne disparaît pas ;
 * - la gate d'hôte : seule une MODIFICATION visant CETTE fiche s'y montre ;
 * - la cible tactile ≥ 44 pt et l'annonce lecteur d'écran au point de décision.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@bob/ui';
import type {
  CustomerContactPresentationV1,
  JarvisCommandReceiptView,
  JarvisCurrentRunView,
  JarvisRunView,
  JarvisSubmitCommandClientInput,
} from '@bob/api-client';
import type { AppError, Result } from '@bob/core';

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

const announce = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => new Promise<boolean>(() => {}),
    isReduceTransparencyEnabled: () => new Promise<boolean>(() => {}),
    addEventListener: () => ({ remove: vi.fn() }),
    setAccessibilityFocus: vi.fn(),
    announceForAccessibility: announce,
  },
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Animated: {
    Value: FakeAnimatedValue,
    View: 'Animated.View',
    createAnimatedComponent: (component: unknown) => component,
    timing: () => ({ start: vi.fn(), stop: vi.fn() }),
    loop: () => ({ start: vi.fn(), stop: vi.fn() }),
    sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
  Easing: { inOut: (f: unknown) => f, out: (f: unknown) => f, quad: {}, cubic: {} },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Linking: { openURL: vi.fn(async () => {}) },
  Platform: {
    OS: 'ios',
    select: (options: Record<string, unknown>) => options['ios'] ?? options['default'],
  },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  findNodeHandle: () => null,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Circle: 'Circle',
  Path: 'Path',
  Rect: 'Rect',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));
vi.mock('expo-crypto', () => ({
  randomUUID: (): string => '88888888-8888-4888-8888-888888888888',
}));

const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_CUSTOMER_ID = '66666666-6666-4666-8666-666666666666';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const CONFIRMATION_ID = '33333333-3333-4333-8333-333333333333';
const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);

const hoisted = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
  setParams: vi.fn(),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({
    push: hoisted.push,
    back: hoisted.back,
    replace: hoisted.replace,
    setParams: hoisted.setParams,
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({ id: '55555555-5555-4555-8555-555555555555' }),
}));

/**
 * Le baril `src/agent` garde son VRAI hook Jarvis (c'est lui qu'on teste) ; seul le contexte
 * agent publié par la fiche est neutralisé — il parle à la session vocale, hors sujet ici.
 */
vi.mock('../../../src/agent', async () => {
  const jarvis = await import('../../../src/agent/use-jarvis-run-frame');
  // Le geste d'ouverture (U1-f §3) est le VRAI : ces preuves l'exercent depuis la route.
  const ouverture = await import('../../../src/agent/use-jarvis-open-run');
  return { ...jarvis, ...ouverture, usePublishAgentContext: vi.fn() };
});

const registry = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../../src/agent/agent-mission-provider', () => ({
  useAgentMissionCommandIdRegistry: () => registry.value,
}));

const server = vi.hoisted(() => ({
  intent: 'update' as 'update' | 'create',
  targetCustomerId: null as string | null,
  confirmationStatus: 'issued' as 'issued' | 'presented',
  phase: 'awaiting_confirmation' as CustomerContactPresentationV1['phase'],
  revision: 4,
  currentRunCalls: 0,
  submitted: [] as JarvisSubmitCommandClientInput[],
  portDown: false,
  runAbsent: false,
  /** Ouvertures reçues par la route dédiée (U1-f §3). */
  opened: [] as Array<{ commandId: string; customerId: string }>,
  /** Le premier plan est déjà occupé : la route refuse en 409 `foreground_busy`. */
  foregroundBusy: false,
  /** Transport muet : aucun reçu ne revient (réseau coupé). */
  openUnreachable: false,
}));

vi.mock('../../../src/data/auth', () => ({
  useAuth: () => ({ enabled: true, session: { user: { id: 'owner-1' } } }),
}));
vi.mock('../../../src/data/client', () => ({
  useBobClient: () => jarvisClient,
}));
vi.mock('../../../src/data/documents', () => ({ useDocuments: () => sources.value['documents'] }));
vi.mock('../../../src/components/customer-form', () => ({ CustomerForm: () => null }));
vi.mock('../../../src/components/CustomerBillingSections', () => ({
  CustomerBillingSections: () => null,
}));
vi.mock('../../../src/components/CustomerContactsCard', () => ({
  CustomerContactsCard: () => null,
}));
vi.mock('../../../src/components/CustomerContractsCard', () => ({
  CustomerContractsCard: () => null,
}));
vi.mock('../../../src/components/use-bob-aware-scroll-insets', () => ({
  useBobAwareScrollInsets: () => ({
    paddingBottom: 150,
    scrollIndicatorBottom: 0,
    automaticallyAdjustKeyboardInsets: false,
  }),
}));
vi.mock('../../../src/lib/navigation-notice', () => ({ consumeContractDeletedNotice: () => null }));

const sources = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  blocking: { value: false },
}));
vi.mock('../../../src/data/hooks', () => ({
  useChantiers: () => sources.value['chantiers'],
  useCreateChantier: () => ({ isPending: false, mutate: vi.fn() }),
  useCustomers: () => sources.value['customers'],
  useProfile: () => sources.value['profile'],
  useQuotes: () => sources.value['quotes'],
  useInvoices: () => sources.value['invoices'],
  useSearchAddress: () => ({
    isPending: false,
    isError: false,
    isSuccess: false,
    variables: undefined,
    reset: vi.fn(),
    mutate: vi.fn(),
  }),
  useUpdateCustomer: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('../../../src/data/authoritative-query-state', () => ({
  hasBlockingAuthoritativeDataError: () => sources.blocking.value,
}));

const { AgentMissionCommandIdRegistry } =
  await import('../../../src/agent/agent-mission-command-id-registry');
const { default: ClientDetail } = await import('../[id]');

function run(): JarvisRunView {
  return {
    runId: RUN_ID,
    kind: 'customer_contact',
    definitionVersion: 1,
    actionReference: { actionId: 'client-modifier', actionVersion: 1 },
    status: 'waiting_user',
    revision: server.revision,
    nextWakeAt: null,
    terminalAt: null,
  };
}

function presentation(): CustomerContactPresentationV1 {
  return {
    schema: 'bob.jarvis-run.customer-contact-presentation',
    version: 1,
    phase: server.phase,
    intent: server.intent,
    targetCustomerId: server.targetCustomerId,
    targetLabel: 'SARL Martin',
    duplicateReview: null,
    proposal: {
      proposalId: PROPOSAL_ID,
      proposalHash: HASH,
      fieldsDigest: DIGEST,
      fields: [
        {
          field: 'email',
          label: 'E-mail',
          before: 'compta@martin.fr',
          after: 'facturation@martin.fr',
          // §9.1 : l'e-mail COMPOSE le champ sensible `recipient` (table de projection du domaine).
          sensitiveField: 'recipient',
        },
      ],
    },
    confirmation: {
      confirmationId: CONFIRMATION_ID,
      status: server.confirmationStatus,
      expiresAt: '2026-08-19T10:05:00.000Z',
      presentedAt: server.confirmationStatus === 'presented' ? '2026-08-19T10:00:10.000Z' : null,
    },
    completion: null,
  };
}

/**
 * Faux SERVEUR (pas un faux hook) : il applique les mêmes transitions que l'admission — un accusé
 * d'affichage fait passer la confirmation à `presented` et avance la révision.
 */
const jarvisClient = {
  companyId: 'company-1',
  documentDownloadUrl: vi.fn(async () => ({ ok: false })),
  jarvisCurrentRun: (): Promise<Result<JarvisCurrentRunView, AppError>> => {
    server.currentRunCalls += 1;
    return Promise.resolve({
      ok: true,
      value: server.runAbsent
        ? { run: null, presentation: null }
        : { run: run(), presentation: presentation() },
    });
  },
  jarvisOpenRun: (input: {
    commandId: string;
    intent: { mode: 'update'; target: { customerId: string } };
  }): Promise<Result<JarvisCommandReceiptView, AppError>> => {
    server.opened.push({ commandId: input.commandId, customerId: input.intent.target.customerId });
    if (server.openUnreachable) {
      return Promise.resolve({
        ok: false,
        error: { kind: 'dependency', port: 'jarvis_admission', cause: 'unreachable' },
      });
    }
    if (server.foregroundBusy) {
      return Promise.resolve({
        ok: false,
        error: { kind: 'conflict', entity: 'jarvis_foreground', reason: 'foreground_busy' },
      });
    }
    server.runAbsent = false;
    return Promise.resolve({
      ok: true,
      value: { outcome: 'admitted', run: run(), presentation: presentation(), eventSequence: 2 },
    });
  },
  jarvisSubmitCommand: (
    input: JarvisSubmitCommandClientInput,
  ): Promise<Result<JarvisCommandReceiptView, AppError>> => {
    server.submitted.push(input);
    if (server.portDown) {
      return Promise.resolve({
        ok: false,
        error: { kind: 'dependency', port: 'jarvis_admission', cause: 'unreachable' },
      });
    }
    if (input.command.type === 'record_presentation_ack') {
      server.confirmationStatus = 'presented';
      server.revision += 1;
    }
    if (input.command.type === 'confirm') {
      server.phase = 'committing';
      server.revision += 1;
    }
    return Promise.resolve({
      ok: true,
      value: {
        outcome: 'admitted',
        run: run(),
        presentation: presentation(),
        eventSequence: server.submitted.length,
      },
    });
  },
};

interface QueryDouble {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  refetch: ReturnType<typeof vi.fn>;
}
function q(over: Partial<QueryDouble> = {}): QueryDouble {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
    ...over,
  };
}

const CUSTOMER = {
  id: CUSTOMER_ID,
  name: 'SARL Martin',
  type: 'b2b',
  outstandingCents: 0,
  siren: null,
  siret: null,
  tvaIntracom: null,
  email: 'compta@martin.fr',
  phone: '01 02 03 04 05',
  avgDelayDays: null,
  contactName: null,
  address: { line1: '', zip: '', city: '' },
  paymentHistoryStatus: 'incomplete',
  paidOnTimeRatio: null,
  settledInvoiceCount: 0,
  paymentTermsLabel: null,
  paymentTerms: null,
  billingChannel: null,
  isInternational: false,
  isSubcontractingBtp: false,
};

async function render(): Promise<ReactTestRenderer> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ThemeProvider, null, createElement(ClientDetail)),
      ),
    );
  });
  await settle();
  return renderer;
}

/** Laisse converger découverte + accusé + relecture, avec une borne stricte. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const TEST_JSON = Symbol.for('react.test.json');
const treeOf = (renderer: ReactTestRenderer): string =>
  JSON.stringify(renderer.toJSON(), (_key, value: unknown) => {
    if (value === null || typeof value !== 'object') return value;
    const tagged = value as { $$typeof?: symbol };
    if (tagged.$$typeof !== undefined && tagged.$$typeof !== TEST_JSON) return '[react-element]';
    return value;
  });

function pressableLabelled(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType('Pressable' as never)
    .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === label);
}

function commandTypes(): string[] {
  return server.submitted.map((input) => input.command.type);
}

beforeEach(() => {
  announce.mockClear();
  registry.value = new AgentMissionCommandIdRegistry();
  server.intent = 'update';
  server.targetCustomerId = CUSTOMER_ID;
  server.confirmationStatus = 'issued';
  server.phase = 'awaiting_confirmation';
  server.revision = 4;
  server.currentRunCalls = 0;
  server.submitted = [];
  server.portDown = false;
  server.opened = [];
  server.foregroundBusy = false;
  server.openUnreachable = false;
  server.runAbsent = false;
  sources.blocking.value = false;
  sources.value = {
    customers: q({ data: [CUSTOMER] }),
    invoices: q({ data: [] }),
    quotes: q({ data: [] }),
    chantiers: q({ data: [] }),
    documents: q({ data: [] }),
    profile: q({ data: { trade: 'plombier', modules: [] } }),
  };
});

describe('La carte Jarvis dans la ROUTE fiche client', () => {
  it('l’appareil découvre le run seul et la carte apparaît avec l’avant/après réel', async () => {
    const renderer = await render();
    expect(server.currentRunCalls).toBeGreaterThanOrEqual(1);
    const rendered = treeOf(renderer);
    expect(rendered).toContain('Modifier la fiche client');
    // Le MÊME rendu avant/après que les propositions de Bob (ActionDiffView), a11y composée.
    expect(rendered).toContain('E-mail. Avant : compta@martin.fr. Après : facturation@martin.fr.');
    // La pédagogie du champ sensible est rendue au point de décision (§9.1).
    expect(rendered).toContain('Bob relit ces informations juste avant d’enregistrer');
  });

  it('elle est ancrée AVANT les actions rapides — la proposition se voit avant le geste manuel concurrent', async () => {
    const rendered = treeOf(await render());
    const card = rendered.indexOf('Modifier la fiche client');
    const quickAction = rendered.indexOf('Nouveau devis');
    expect(card).toBeGreaterThan(-1);
    expect(quickAction).toBeGreaterThan(-1);
    expect(card).toBeLessThan(quickAction);
  });

  it('enchaînement §7.1 : accusé d’affichage → presented → « Confirmer » ouvert → confirm émis', async () => {
    const renderer = await render();
    // 1. L'accusé part au rendu RÉEL, pas au montage de l'écran.
    expect(commandTypes()).toEqual(['record_presentation_ack']);
    expect(announce).toHaveBeenCalledWith('Bob attend votre confirmation.');

    // 2. La relecture autoritative a ramené `presented` : le bouton s'ouvre.
    const confirm = pressableLabelled(renderer, 'Confirmer');
    expect(confirm).toBeDefined();
    expect(
      (confirm!.props as { accessibilityState?: { disabled?: boolean } }).accessibilityState,
    ).toMatchObject({ disabled: false });

    // 3. Le geste humain consomme la proposition.
    await act(async () => {
      (confirm!.props as { onPress: () => void }).onPress();
    });
    await settle();
    expect(commandTypes()).toEqual(['record_presentation_ack', 'confirm']);
    const emitted = server.submitted[1];
    expect(emitted?.command).toMatchObject({ type: 'confirm', confirmationId: CONFIRMATION_ID });
    // Le CAS repart avec la révision RELUE, jamais celle du premier rendu.
    expect(emitted?.expectedRevision).toBe(5);
  });

  it('tant que la confirmation n’est pas présentée, « Confirmer » reste fermé et s’explique', async () => {
    // Le canal tactile est coupé : l'accusé ne peut pas aboutir, la confirmation reste `issued`.
    server.portDown = true;
    const renderer = await render();
    const confirm = pressableLabelled(
      renderer,
      'Confirmer. Disponible dès que Bob a enregistré l’affichage de la proposition.',
    );
    expect(confirm).toBeDefined();
    expect(
      (confirm!.props as { accessibilityState?: { disabled?: boolean } }).accessibilityState,
    ).toMatchObject({ disabled: true });
  });

  it('échec du canal tactile : l’erreur s’AFFICHE et « Réessayer » relance l’accusé', async () => {
    server.portDown = true;
    const renderer = await render();
    expect(treeOf(renderer)).toContain(
      'Bob n’a pas pu enregistrer l’affichage de cette proposition.',
    );
    const attempts = server.submitted.length;
    expect(attempts).toBeGreaterThanOrEqual(1);

    server.portDown = false;
    const retry = pressableLabelled(renderer, 'Réessayer');
    expect(retry).toBeDefined();
    await act(async () => {
      (retry!.props as { onPress: () => void }).onPress();
    });
    await settle();
    expect(server.submitted.length).toBeGreaterThan(attempts);
    // Le rejeu porte le MÊME commandId : le serveur rejoue, il n'exécute pas deux fois.
    expect(server.submitted[0]?.commandId).toBe(server.submitted[attempts]?.commandId);
    expect(treeOf(renderer)).not.toContain(
      'Bob n’a pas pu enregistrer l’affichage de cette proposition.',
    );
  });
});

describe('La gate d’hôte de la fiche — elle n’héberge que ce qui parle d’elle', () => {
  it('une modification visant un AUTRE client ne s’affiche pas ici', async () => {
    server.targetCustomerId = OTHER_CUSTOMER_ID;
    const rendered = treeOf(await render());
    expect(rendered).toContain('SARL Martin');
    expect(rendered).not.toContain('Modifier la fiche client');
    expect(commandTypes()).toEqual([]);
  });

  it('une CRÉATION ne s’affiche pas sur une fiche existante', async () => {
    server.intent = 'create';
    server.targetCustomerId = null;
    const rendered = treeOf(await render());
    expect(rendered).not.toContain('Créer la fiche client');
    expect(commandTypes()).toEqual([]);
  });

  it('publication fermée : la fiche n’offre aucun semis Jarvis', async () => {
    server.runAbsent = true;
    const renderer = await render();
    server.openUnreachable = true;
    server.foregroundBusy = true;
    expect(pressableLabelled(renderer, 'Modifier avec Bob')).toBeUndefined();
    expect(server.opened).toEqual([]);
    expect(treeOf(renderer)).not.toContain('Modifier la fiche client');
  });

  it('aucun run courant ⇒ la fiche rend exactement comme avant, sans carte', async () => {
    server.runAbsent = true;
    const rendered = treeOf(await render());
    expect(rendered).toContain('SARL Martin');
    expect(rendered).not.toContain('Modifier la fiche client');
    expect(commandTypes()).toEqual([]);
  });
});

describe('Accessibilité et cible tactile de la carte hébergée', () => {
  it('« Confirmer » offre une cible ≥ 44 pt (redlines §18)', async () => {
    const renderer = await render();
    const confirm = pressableLabelled(renderer, 'Confirmer');
    expect(confirm).toBeDefined();
    const styleOf = (confirm!.props as { style: (state: { pressed: boolean }) => unknown }).style;
    const resolved = JSON.stringify(styleOf({ pressed: false }));
    const minHeight = /"minHeight":(\d+)/.exec(resolved);
    expect(minHeight).not.toBeNull();
    expect(Number(minHeight?.[1])).toBeGreaterThanOrEqual(44);
  });

  it('les trois gestes sont annoncés en clair, sans jargon ni libellé muet', async () => {
    const renderer = await render();
    expect(pressableLabelled(renderer, 'Confirmer')).toBeDefined();
    expect(
      pressableLabelled(
        renderer,
        'Modifier. Bob écarte cette proposition et vous en prépare une autre.',
      ),
    ).toBeDefined();
    expect(
      pressableLabelled(
        renderer,
        'Annuler. Bob annule ce qui peut encore l’être puis relit la demande.',
      ),
    ).toBeDefined();
  });

  it('la carte est une région vivante et son titre est un en-tête', async () => {
    const rendered = treeOf(await render());
    expect(rendered).toContain('"accessibilityLiveRegion":"polite"');
    expect(rendered).toContain('"accessibilityRole":"header"');
  });
});
