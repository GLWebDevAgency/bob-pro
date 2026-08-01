/**
 * LES FENCES MISSION DU POINT DE MONTAGE /devis/new — le câblage écran que RIEN ne regardait.
 *
 * ─── POURQUOI CE FICHIER EXISTE ─────────────────────────────────────────────────────────────
 * Toute la logique M2-A-3 est prouvée module par module (coordinateur, binding, transport,
 * surface). Mais l'ÉCRAN qui les compose — `app/devis/new.tsx` — n'avait AUCUN test : les
 * quatre fences anti-double-writer du contrat binaire (clause 2) n'étaient verrouillées par
 * rien au point de montage. Ce fichier prouve le CÂBLAGE, et rien d'autre : quels writers
 * sortent selon la phase du binding, ce que Bob publie comme affordances, ce que l'acquisition
 * Mission démonte de force. Les composants enfants sont des DOUBLONS-HÔTES — leur comportement
 * propre est prouvé par leurs propres suites.
 *
 * ─── LES QUATRE FENCES VERROUILLÉES ─────────────────────────────────────────────────────────
 * 1. Les affordances regex vocales du wizard ne sont publiées QU'EN phase `manual` — jamais
 *    pendant qu'une mission possède le slot (agentSurface.affordances = []).
 * 2. Une seule surface d'écriture à la fois : `agent_v2` exige `ready` ET `protocolVersion 2`
 *    (surface Mission rendue, writer legacy absent) ; `ready` V1 ne rend NI l'une NI l'autre ;
 *    `manual` rend le writer legacy seul. NB : la garde est portée à la fois par le module pur
 *    (quoteWizardLineSurfaceMode) et par l'écran (agentLineMission) — chaque verrou retiré
 *    SEUL est couvert par son jumeau ; le test tue le mutant qui retire les DEUX.
 * 3. L'acquisition Mission ferme DE FORCE le picker catalogue (callbacks démontés, état
 *    réinitialisé) — au retour en mode legacy, le picker ne réapparaît pas tout seul.
 * 4. Quand la mission possède l'entrée (`missionOwnsEntry`), le brouillon est une photographie
 *    serveur : ni `startFresh`, ni seed local `set_deposit_pct` — aucune révision locale avant
 *    l'ACK.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { t } from '@bob/i18n';
import type {
  AgentMissionViewV1,
  QuoteAgentMissionPresentationV1,
} from '@bob/core';
import {
  applyQuoteDraftCommands,
  createQuoteDraft,
  applyQuoteDraftCommand,
  type QuoteDraftCommand,
  type QuoteDraftState,
} from '../../../src/quote-draft/quote-draft-model';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

// ── Doublons ────────────────────────────────────────────────────────────────────────────────

interface PublishedSurface {
  readonly affordances: readonly unknown[];
  readonly greeting?: unknown;
}

const hoisted = vi.hoisted(() => ({
  /** État du binding Mission — c'est LUI qu'on bascule pour jouer les phases. */
  binding: { value: { phase: 'detecting' } as Record<string, unknown> },
  bindingRetry: vi.fn(),
  continueManually: vi.fn(async () => undefined),
  abandonMission: vi.fn(async () => true),
  /** Chaque publication (contexte, layout, surface) — la fence 1 se lit ICI. */
  surfaces: [] as PublishedSurface[],
  params: { value: {} as Record<string, string> },
  uuid: { sequence: 0 },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options['ios'] ?? options['default'] },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Share: { share: vi.fn(async () => ({ action: 'sharedAction' })) },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    hoisted.uuid.sequence += 1;
    return `00000000-0000-4000-8000-${hoisted.uuid.sequence.toString().padStart(12, '0')}`;
  },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => hoisted.params.value,
  useNavigation: () => ({
    addListener: vi.fn(() => () => undefined),
    dispatch: vi.fn(),
    setOptions: vi.fn(),
  }),
  useRouter: () => ({ back: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@bob/ai', () => ({
  challengeFor: vi.fn(() => ({ kind: 'confirm_all' })),
  parseVoiceConsent: vi.fn(() => null),
}));

vi.mock('@bob/ui', () => {
  /** Sac de tokens : l'écran lit ~60 clés de thème ; chacune rend une chaîne stable. Les
   * pixels ne sont pas l'objet de ce fichier — le câblage l'est. */
  const tokens = new Proxy({} as Record<string, string>, {
    get: (_target, property) =>
      typeof property === 'string' ? `tok-${property}` : undefined,
  });
  return {
    Avatar: 'Avatar',
    Button: 'Button',
    Card: 'Card',
    Chip: 'Chip',
    EmptyState: 'EmptyState',
    ErrorRetry: 'ErrorRetry',
    MoneyText: 'MoneyText',
    LegalHint: 'LegalHint',
    SignaturePad: 'SignaturePad',
    SkeletonRow: 'SkeletonRow',
    Sheet: 'Sheet',
    StatusBadge: 'StatusBadge',
    Stepper: 'Stepper',
    Toast: 'Toast',
    font: () => ({ fontFamily: 'MockFont' }),
    useReduceMotion: () => true,
    useTheme: () => ({
      colors: tokens,
      semantic: tokens,
      controls: tokens,
      overlays: tokens,
      radius: tokens,
      theme: 'light',
      personality: 'pro',
    }),
  };
});

const dataHooks = vi.hoisted(() => ({
  customers: {
    value: {
      data: [
        { id: 'customer-1', name: 'Camping Les Pins', type: 'b2c' },
      ] as readonly { id: string; name: string; type: string }[],
      isLoading: false,
      isError: false,
      refetch: vi.fn(async () => ({ isError: false })),
    },
  },
  billingPrefs: { value: { defaultDepositPercent: 40 } as { defaultDepositPercent: number } | null },
}));

vi.mock('../../../src/data/hooks', () => ({
  appErrorMessage: () => 'erreur',
  useChantiers: () => ({ data: [] }),
  useCompanyMe: () => ({ data: undefined, isLoading: false, isError: false }),
  useCustomers: () => dataHooks.customers.value,
  useProfile: () => ({ data: undefined }),
  useCreateQuote: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSendQuote: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSignQuote: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateQuoteSignatureLink: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('../../../src/data/catalogue', () => ({
  useCatalogue: () => ({
    prestations: [],
    mode: 'ready',
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../../src/data/billing-prefs', () => ({
  useBillingPrefs: () => ({
    prefs: dataHooks.billingPrefs.value,
    ready: true,
    isLoading: false,
    isError: false,
    isPending: false,
    refetch: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock('../../../src/components/ConfirmSheet', () => ({
  useConfirm: () => vi.fn(async () => true),
}));

vi.mock('../../../src/components/icons', () => ({
  CheckIcon: 'CheckIcon',
  ChevronLeftIcon: 'ChevronLeftIcon',
  CloseIcon: 'CloseIcon',
}));

/** Le module agent est ENTIÈREMENT doublé — la frontière testée est l'écran, pas le runtime.
 * `quote-wizard-interaction` n'est PAS doublé : c'est le module pur de la fence 2, et il doit
 * rester le VRAI pour que le test compose écran + gate comme en production. */
vi.mock('../../../src/agent', () => ({
  consumeWizardHint: vi.fn(() => null),
  deriveQuoteCustomerSelectionRows: vi.fn(() => []),
  QuoteAgentMissionSurface: 'QuoteAgentMissionSurface',
  QuoteMissionResumeGate: 'QuoteMissionResumeGate',
  QuoteCustomerDecisionCoordinator: class {},
  QuoteLineMissionCoordinator: class {},
  quoteScreenInstanceId: (input: Record<string, unknown>) => JSON.stringify(input),
  useAgentMissionCommandIdRegistry: () => ({}),
  useAgentMissionRuntimeActions: () => ({}),
  useQuoteScreenMissionBinding: () => ({
    state: hoisted.binding.value,
    retry: hoisted.bindingRetry,
    continueManually: hoisted.continueManually,
    abandonMission: hoisted.abandonMission,
  }),
  usePublishAgentContext: (
    _context: unknown,
    _layout: unknown,
    surface: PublishedSurface,
  ) => {
    hoisted.surfaces.push(surface);
  },
  useAgentSession: () => ({
    suspendForManualHandoff: vi.fn(async () => true),
    stopAfterManualHandoff: vi.fn(async () => null),
    resumeMission: vi.fn(async () => true),
  }),
}));

interface QuoteDraftDouble {
  readonly state: QuoteDraftState;
  [member: string]: unknown;
}

const quoteDraftStore = vi.hoisted(() => ({
  value: null as QuoteDraftDouble | null,
}));

vi.mock('../../../src/quote-draft', async () => {
  const model = await import('../../../src/quote-draft/quote-draft-model');
  return {
    hasUnsavedQuoteDraftChanges: model.hasUnsavedQuoteDraftChanges,
    useQuoteDraft: () => {
      if (quoteDraftStore.value === null) throw new Error('quoteDraft double absent');
      return quoteDraftStore.value;
    },
  };
});

const { default: DevisNew } = await import('../new');

// ── Fixtures Mission (mêmes formes que la suite du binding) ─────────────────────────────────

const MISSION_ID = '10000000-0000-4000-8000-000000000001';
const REALTIME_ID = '20000000-0000-4000-8000-000000000001';

const EMPTY_PRESENTATION = {
  schema: 'bob.agent-mission.quote-presentation',
  version: 1,
  requiredFact: null,
  pendingLine: null,
  decision: null,
  catalogueChoices: [],
  freeLineChoiceId: null,
  proposalStatus: { kind: 'absent' },
  proposal: null,
} as const satisfies QuoteAgentMissionPresentationV1;

function mission(): AgentMissionViewV1 {
  return {
    id: MISSION_ID,
    kind: 'quote_creation',
    status: 'active',
    actionable: true,
    phase: 'awaiting_lines',
    revision: 5,
    payloadVersion: 1,
    payload: {
      schema: 'bob.agent-mission.quote-creation',
      version: 1,
      draft: { sessionId: 'draft-session-1', slotRevision: 7, contentRevision: 4 },
      decision: null,
      stagedCustomerResolution: null,
    },
    currentBinding: {
      realtimeSessionId: REALTIME_ID,
      contextRevision: 4,
      contextDigest: 'a'.repeat(64),
      screenName: '/devis/new',
      screenInstanceId: 'screen-1',
      acknowledgedAt: '2026-07-30T00:00:00.000Z',
    },
    idleExpiresAt: '2026-07-30T00:10:00.000Z',
    hardExpiresAt: '2026-07-30T01:00:00.000Z',
    terminalAt: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  } as AgentMissionViewV1;
}

function readyState(protocolVersion: 1 | 2): Record<string, unknown> {
  return {
    phase: 'ready',
    protocolVersion,
    mission: mission(),
    customerChoices: [],
    presentation: protocolVersion === 2 ? EMPTY_PRESENTATION : null,
  };
}

// ── Harnais ─────────────────────────────────────────────────────────────────────────────────

function must(
  result: ReturnType<typeof applyQuoteDraftCommands>,
): QuoteDraftState {
  if (!result.ok) throw new Error(`fixture brouillon invalide: ${result.error.message}`);
  return result.value;
}

function makeQuoteDraft(commands: readonly QuoteDraftCommand[]): QuoteDraftDouble {
  let state = createQuoteDraft('draft-session-1');
  if (commands.length > 0) state = must(applyQuoteDraftCommands(state, commands));
  const applyReal = (command: QuoteDraftCommand) => {
    const result = applyQuoteDraftCommand(state, command);
    if (result.ok) state = result.value;
    return result;
  };
  return {
    get state() {
      return state;
    },
    authoritativeReference: null,
    pendingResume: null,
    guidance: null,
    persistence: { ready: true, status: 'ready', error: null },
    apply: vi.fn(applyReal),
    applyAtRevision: vi.fn((command: QuoteDraftCommand) => applyReal(command)),
    applyAll: vi.fn((batch: readonly QuoteDraftCommand[]) => {
      const result = applyQuoteDraftCommands(state, batch);
      if (result.ok) state = result.value;
      return result;
    }),
    selectCustomer: vi.fn(),
    addLine: vi.fn(() => ({ ok: true, value: state })),
    addCatalogueLine: vi.fn(() => ({ ok: true, value: state })),
    updateLine: vi.fn(),
    updateLineForm: vi.fn(),
    clearLineForm: vi.fn(),
    propose: vi.fn(),
    acceptProposal: vi.fn(),
    rejectProposal: vi.fn(),
    expireProposal: vi.fn(),
    startMission: vi.fn(() => ({ ok: true, value: state })),
    stopMission: vi.fn(),
    completeMission: vi.fn(),
    save: vi.fn(async () => true),
    discard: vi.fn(async () => true),
    complete: vi.fn(async () => true),
    reset: vi.fn(async () => true),
    startFresh: vi.fn(),
    resumePending: vi.fn(),
    hydrateMissionDraft: vi.fn(async () => ({ status: 'ready' })),
  };
}

/** Brouillon déjà à l'étape lignes — le chemin réel de la machine, jamais un état inventé. */
const LINE_STEP_COMMANDS: readonly QuoteDraftCommand[] = [
  {
    type: 'select_customer',
    customer: { id: 'customer-1', name: 'Camping Les Pins' },
  },
  { type: 'next_step' },
];

interface Harness {
  readonly renderer: ReactTestRenderer;
  readonly quoteDraft: QuoteDraftDouble;
  update(): Promise<void>;
  lastSurface(): PublishedSurface;
}

async function mount(options: {
  binding: Record<string, unknown>;
  commands?: readonly QuoteDraftCommand[];
}): Promise<Harness> {
  hoisted.binding.value = options.binding;
  hoisted.surfaces.length = 0;
  const quoteDraft = makeQuoteDraft(options.commands ?? []);
  quoteDraftStore.value = quoteDraft;
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<DevisNew />);
  });
  const tree = renderer as ReactTestRenderer;
  return {
    renderer: tree,
    quoteDraft,
    update: async () => {
      await act(async () => {
        tree.update(<DevisNew />);
      });
    },
    lastSurface: () => {
      const surface = hoisted.surfaces.at(-1);
      expect(surface, 'aucune publication de surface Bob').toBeDefined();
      return surface as PublishedSurface;
    },
  };
}

function nodes(harness: Harness, type: string): Record<string, unknown>[] {
  return harness.renderer.root
    .findAllByType(type as never)
    .map((node) => node.props as Record<string, unknown>);
}

/** Le Modal UNIQUE de l'écran est le picker catalogue — l'unicité est vérifiée, pas supposée. */
function cataloguePicker(harness: Harness): Record<string, unknown> {
  const found = nodes(harness, 'Modal');
  expect(found, 'attendu exactement UN Modal (le picker catalogue)').toHaveLength(1);
  return found[0] as Record<string, unknown>;
}

function pickerTrigger(harness: Harness): Record<string, unknown> | undefined {
  return nodes(harness, 'Pressable').find(
    (props) =>
      props['accessibilityLabel'] === t('devis.cataloguePickOpen', { personality: 'pro' }),
  );
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// FENCE 1 — LES AFFORDANCES REGEX NE SORTENT QU'EN MANUEL
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('fence 1 · les affordances vocales du wizard ne sortent qu’en phase manual', () => {
  it('manual → la surface publie les affordances historiques du wizard', async () => {
    const harness = await mount({
      binding: { phase: 'manual', reason: 'no_mission' },
    });
    expect(harness.lastSurface().affordances.length).toBeGreaterThanOrEqual(5);
  });

  it('ready V2 → affordances STRICTEMENT vides : la mission possède le slot', async () => {
    const harness = await mount({
      binding: readyState(2),
      commands: LINE_STEP_COMMANDS,
    });
    expect(harness.lastSurface().affordances).toEqual([]);
  });

  it('detecting → affordances vides aussi : pas d’autorité, pas de writer vocal', async () => {
    const harness = await mount({ binding: { phase: 'detecting' } });
    expect(harness.lastSurface().affordances).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// FENCE 2 — UNE SEULE SURFACE D'ÉCRITURE, ET agent_v2 EXIGE LE PROTOCOLE 2
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('fence 2 · une seule surface d’écriture à l’étape lignes', () => {
  it('ready V2 → la surface Mission est rendue UNE fois, le writer legacy est absent', async () => {
    const harness = await mount({
      binding: readyState(2),
      commands: LINE_STEP_COMMANDS,
    });

    const surfaces = nodes(harness, 'QuoteAgentMissionSurface');
    expect(surfaces).toHaveLength(1);
    expect(
      (surfaces[0]?.['state'] as { protocolVersion: number }).protocolVersion,
    ).toBe(2);
    // Le writer legacy est ABSENT — pas caché : son déclencheur n'existe pas dans l'arbre.
    expect(pickerTrigger(harness)).toBeUndefined();
    expect(cataloguePicker(harness)['visible']).toBe(false);
  });

  it('ready V1 → NI surface Mission NI writer legacy : jamais deux writers pendant la passation', async () => {
    const harness = await mount({
      binding: readyState(1),
      commands: LINE_STEP_COMMANDS,
    });

    expect(nodes(harness, 'QuoteAgentMissionSurface')).toHaveLength(0);
    expect(pickerTrigger(harness)).toBeUndefined();
  });

  it('manual → le writer legacy seul, aucune surface Mission', async () => {
    const harness = await mount({
      binding: { phase: 'manual', reason: 'no_mission' },
      commands: LINE_STEP_COMMANDS,
    });

    expect(nodes(harness, 'QuoteAgentMissionSurface')).toHaveLength(0);
    expect(pickerTrigger(harness)).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// FENCE 3 — L'ACQUISITION MISSION FERME LE PICKER DE FORCE
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('fence 3 · l’acquisition Mission démonte le picker catalogue, état compris', () => {
  it('picker ouvert en manuel → acquisition V2 → retour legacy : le picker est resté FERMÉ', async () => {
    const harness = await mount({
      binding: { phase: 'manual', reason: 'no_mission' },
      commands: LINE_STEP_COMMANDS,
    });

    const trigger = pickerTrigger(harness);
    expect(trigger, 'déclencheur du picker introuvable à l’étape lignes').toBeDefined();
    await act(async () => {
      (trigger?.['onPress'] as () => void)();
    });
    expect(cataloguePicker(harness)['visible']).toBe(true);

    // La mission acquiert le slot : l'effet de fermeture doit réinitialiser l'état du picker,
    // pas seulement le voiler derrière `legacyLineWriterEnabled`.
    hoisted.binding.value = readyState(2);
    await harness.update();
    expect(cataloguePicker(harness)['visible']).toBe(false);

    // Retour au writer legacy (passation aboutie) : un picker simplement voilé réapparaîtrait.
    hoisted.binding.value = { phase: 'handoff', mission: mission() };
    await harness.update();
    expect(cataloguePicker(harness)['visible']).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// FENCE 4 — MISSION PROPRIÉTAIRE ⇒ AUCUNE INITIALISATION LOCALE DU BROUILLON
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('fence 4 · missionOwnsEntry court-circuite startFresh et le seed de facturation', () => {
  it('ready V2 → ni startFresh, ni resumePending, ni set_deposit_pct local', async () => {
    const harness = await mount({
      binding: readyState(2),
      commands: LINE_STEP_COMMANDS,
    });

    expect(harness.quoteDraft['startFresh']).not.toHaveBeenCalled();
    expect(harness.quoteDraft['resumePending']).not.toHaveBeenCalled();
    const seeded = (harness.quoteDraft['applyAtRevision'] as ReturnType<typeof vi.fn>).mock.calls
      .filter(([command]) => (command as QuoteDraftCommand).type === 'set_deposit_pct');
    expect(seeded).toEqual([]);
  });

  it('manual → startFresh une fois et seed set_deposit_pct depuis les Réglages', async () => {
    const harness = await mount({
      binding: { phase: 'manual', reason: 'no_mission' },
    });

    expect(harness.quoteDraft['startFresh']).toHaveBeenCalledTimes(1);
    const seeded = (harness.quoteDraft['applyAtRevision'] as ReturnType<typeof vi.fn>).mock.calls
      .filter(([command]) => (command as QuoteDraftCommand).type === 'set_deposit_pct');
    expect(seeded).toEqual([[
      { type: 'set_deposit_pct', depositPct: 40 },
      expect.any(Number),
    ]]);
  });
});
