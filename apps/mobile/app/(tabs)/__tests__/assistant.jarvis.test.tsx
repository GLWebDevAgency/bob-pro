/**
 * LE PARCOURS VISIBLE DANS L'ONGLET ASSISTANT (lot U1-e §3/§5 — preuve É0, hôte PRIMAIRE).
 *
 * L'onglet est déjà la destination du handoff voix→écran et le catalogue y épingle
 * `bob-action-confirmer@1` : c'est là que la proposition de Bob doit se confirmer. On monte la
 * VRAIE route, le VRAI hook de découverte, le VRAI coordinateur et la VRAIE carte ; seuls le
 * transport HTTP, l'abonnement et l'agent conversationnel sont doublés.
 *
 * Il prouve aussi la RAISON du second hôte : cet onglet ferme TOUT son contenu derrière
 * `useEntitlement('ai_assistant')`. Une carte hébergée ici SEULE serait invisible dans les trois
 * états fermés — c'est pourquoi la fiche client, qui n'a aucune garde d'entitlement, l'héberge
 * aussi (test structurel en fin de fichier).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  Platform: {
    OS: 'ios',
    select: (options: Record<string, unknown>) => options['ios'] ?? options['default'],
  },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T): T => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
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
/**
 * `useFocusEffect` EXÉCUTE son effet — comme le vrai, sur un écran affiché. Un mock inerte
 * laisserait l'onglet éternellement « non focalisé », et l'accusé §7.1 (qui n'est dû QUE si la
 * proposition est réellement visible) ne partirait jamais : le test prouverait le contraire de
 * ce qu'il annonce. `focusedHost` permet de rejouer le cas inverse — écran monté, jamais vu.
 */
let focusedHost = true;
vi.mock('expo-router', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: () => true }),
    useLocalSearchParams: () => ({}),
    useFocusEffect: (callback: () => void | (() => void)) => {
      react.useEffect(() => {
        if (!focusedHost) return;
        return callback();
      }, [callback]);
    },
  };
});

const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const CONFIRMATION_ID = '33333333-3333-4333-8333-333333333333';
const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);

/** Le baril garde son VRAI hook Jarvis ; la session vocale racine est doublée. */
vi.mock('../../../src/agent', async () => {
  const jarvis = await import('../../../src/agent/use-jarvis-run-frame');
  return {
    ...jarvis,
    useAgentSession: () => ({
      active: false,
      phase: 'idle',
      response: null,
      reviewRequired: false,
      handoff: null,
      conversation: [],
      conversationEpoch: 1,
      stop: vi.fn(),
      toggle: vi.fn(),
      dismissResponse: vi.fn(),
      requestHandoff: vi.fn(),
      consumeHandoff: vi.fn(),
    }),
  };
});

const registry = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../../src/agent/agent-mission-provider', () => ({
  useAgentMissionCommandIdRegistry: () => registry.value,
}));

const server = vi.hoisted(() => ({
  confirmationStatus: 'issued' as 'issued' | 'presented',
  revision: 4,
  currentRunCalls: 0,
  submitted: [] as JarvisSubmitCommandClientInput[],
  runAbsent: false,
}));
const entitlement = vi.hoisted(() => ({
  assistant: { allowed: true, loading: false, verified: true, decision: null as unknown },
}));

vi.mock('../../../src/data/auth', () => ({
  useAuth: () => ({ enabled: true, session: { user: { id: 'owner-1' } } }),
}));
vi.mock('../../../src/data/client', () => ({ useBobClient: () => jarvisClient }));
vi.mock('../../../src/data/bob', () => ({
  makeBobAgent: () => ({ ask: vi.fn(), confirm: vi.fn(), cancel: vi.fn() }),
}));
vi.mock('../../../src/data/settings', () => ({ getAutonomy: async () => 'confirm' }));
vi.mock('../../../src/data/hooks', () => ({
  useSubscription: () => ({ isRefetching: false, refetch: vi.fn() }),
  useInvoices: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useQuotes: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('../../../src/monetization/paywall', () => ({
  PaywallCard: () => null,
  isPaywallMuted: async () => true,
  useEntitlement: (feature: string) =>
    feature === 'ai_assistant'
      ? entitlement.assistant
      : { allowed: false, loading: false, verified: true, decision: null },
}));

const { AgentMissionCommandIdRegistry } =
  await import('../../../src/agent/agent-mission-command-id-registry');
const { default: Assistant } = await import('../assistant');

function run(): JarvisRunView {
  return {
    runId: RUN_ID,
    kind: 'customer_contact',
    definitionVersion: 1,
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
    phase: 'awaiting_confirmation',
    intent: 'update',
    targetCustomerId: CUSTOMER_ID,
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
  };
}

/** Faux SERVEUR — mêmes transitions que l'admission, pas un faux hook. */
const jarvisClient = {
  companyId: 'company-1',
  jarvisCurrentRun: (): Promise<Result<JarvisCurrentRunView, AppError>> => {
    server.currentRunCalls += 1;
    return Promise.resolve({
      ok: true,
      value: server.runAbsent
        ? { run: null, presentation: null }
        : { run: run(), presentation: presentation() },
    });
  },
  jarvisSubmitCommand: (
    input: JarvisSubmitCommandClientInput,
  ): Promise<Result<JarvisCommandReceiptView, AppError>> => {
    server.submitted.push(input);
    if (input.command.type === 'record_presentation_ack') {
      server.confirmationStatus = 'presented';
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
        createElement(ThemeProvider, null, createElement(Assistant)),
      ),
    );
  });
  for (let turn = 0; turn < 12; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return renderer;
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

beforeEach(() => {
  announce.mockClear();
  registry.value = new AgentMissionCommandIdRegistry();
  server.confirmationStatus = 'issued';
  server.revision = 4;
  server.currentRunCalls = 0;
  server.submitted = [];
  server.runAbsent = false;
  entitlement.assistant = { allowed: true, loading: false, verified: true, decision: null };
  focusedHost = true;
});

describe('L’onglet assistant, hôte primaire du run Jarvis', () => {
  it('la carte est montée DANS le fil, sœur des cartes d’action de Bob', async () => {
    const renderer = await render();
    const rendered = treeOf(renderer);
    expect(server.currentRunCalls).toBeGreaterThanOrEqual(1);
    expect(rendered).toContain('Modifier la fiche client');
    // La MÊME grammaire visuelle que les propositions du fil : ActionDiffView, a11y composée.
    expect(rendered).toContain('E-mail. Avant : compta@martin.fr. Après : facturation@martin.fr.');
  });

  it('onglet en arrière-plan : la carte est montée mais RIEN n’est accusé (§7.1)', async () => {
    // `record_presentation_ack` atteste que la proposition A ÉTÉ AFFICHÉE — et c'est lui qui ouvre
    // le droit de confirmer. Un onglet monté sous une autre route est monté, pas VU : l'accuser
    // serait attester d'un affichage qui n'a pas eu lieu, et déverrouiller une écriture sur la
    // fiche d'un client que l'artisan n'a jamais regardée.
    focusedHost = false;
    await render();
    expect(server.submitted).toEqual([]);
    expect(announce).not.toHaveBeenCalledWith('Bob attend votre confirmation.');
  });

  it('enchaînement §7.1 : accusé au rendu réel → presented → « Confirmer » ouvert et émis', async () => {
    const renderer = await render();
    expect(server.submitted.map((input) => input.command.type)).toEqual([
      'record_presentation_ack',
    ]);
    expect(announce).toHaveBeenCalledWith('Bob attend votre confirmation.');

    const confirm = pressableLabelled(renderer, 'Confirmer');
    expect(confirm).toBeDefined();
    await act(async () => {
      (confirm!.props as { onPress: () => void }).onPress();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const emitted = server.submitted[1];
    expect(emitted?.command).toMatchObject({ type: 'confirm', proposalHash: HASH });
    // Le CAS repart avec la révision RELUE après l'accusé — pas celle du premier rendu.
    expect(emitted?.expectedRevision).toBe(5);
  });

  it('aucun run courant ⇒ le fil rend exactement comme avant, sans carte ni commande', async () => {
    server.runAbsent = true;
    const rendered = treeOf(await render());
    expect(rendered).not.toContain('Modifier la fiche client');
    expect(server.submitted).toEqual([]);
  });
});

describe('La garde d’abonnement de l’onglet — et pourquoi la fiche client est le second hôte', () => {
  it('abonnement sans ai_assistant ⇒ écran de vente, AUCUNE carte, AUCUNE commande', async () => {
    entitlement.assistant = { allowed: false, loading: false, verified: true, decision: null };
    const rendered = treeOf(await render());
    expect(rendered).not.toContain('Modifier la fiche client');
    expect(server.submitted).toEqual([]);
  });

  it('abonnement NON VÉRIFIÉ ⇒ garde fermée, la carte n’apparaît pas non plus', async () => {
    entitlement.assistant = { allowed: false, loading: false, verified: false, decision: null };
    const rendered = treeOf(await render());
    expect(rendered).not.toContain('Modifier la fiche client');
    expect(server.submitted).toEqual([]);
  });

  it('la fiche client, elle, n’est fermée par AUCUN entitlement — sinon la carte serait invisible', () => {
    const fiche = readFileSync(
      fileURLToPath(new URL('../../client/[id].tsx', import.meta.url)),
      'utf8',
    );
    expect(fiche).toContain('JarvisConfirmationCard');
    expect(fiche).not.toContain('useEntitlement');
  });
});
