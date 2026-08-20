/**
 * DÉCOUVERTE DU RUN JARVIS (lot U1-e §1/§3) — le hook qui apprend son `runId` à l'appareil.
 *
 * Ce que ces tests protègent, et qui n'existe nulle part ailleurs :
 * - la projection PURE de la query (aucune branche implicite : un run vivant sans projection
 *   serveur n'est jamais confondu avec « pas de run ») ;
 * - le registre de `commandId` INJECTÉ : deux hôtes montés en même temps émettent le MÊME id,
 *   donc le serveur rejoue au lieu d'exécuter deux fois. Un registre privé par coordinateur
 *   transformerait chaque remontage de route en seconde commande ;
 * - le narrowing des méthodes OPTIONNELLES du `BobClient` : un transport sans Jarvis ne « montre
 *   rien », il ne plante pas et ne parle à personne ;
 * - `refresh()` : invalidation des préfixes métier PUIS relecture causale du run.
 */
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  BobClient,
  CustomerContactPresentationV1,
  JarvisCommandReceiptView,
  JarvisCurrentRunView,
  JarvisRunView,
  JarvisSubmitCommandClientInput,
} from '@bob/api-client';
import type { AppError, Result } from '@bob/core';
import { AgentMissionCommandIdRegistry } from './agent-mission-command-id-registry';
import type { JarvisRunFrame, JarvisRunPorts } from './jarvis-run-coordinator';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const uuid = vi.hoisted(() => ({ next: 0 }));
vi.mock('expo-crypto', () => ({
  randomUUID: (): string => {
    uuid.next += 1;
    const digit = String(uuid.next).padStart(12, '0');
    return `aaaaaaaa-aaaa-4aaa-8aaa-${digit}`;
  },
}));

const doubles = vi.hoisted(() => ({
  auth: { enabled: true, session: { user: { id: 'owner-1' } } as unknown },
  client: {} as unknown as BobClient,
  registry: null as unknown,
}));
vi.mock('../data/auth', () => ({ useAuth: () => doubles.auth }));
vi.mock('../data/client', () => ({ useBobClient: () => doubles.client }));
vi.mock('./agent-mission-provider', () => ({
  useAgentMissionCommandIdRegistry: () => doubles.registry,
}));

const { deriveJarvisRunFrameState, jarvisFrameTargetsCustomer, useJarvisRunFrame } =
  await import('./use-jarvis-run-frame');
type JarvisRunFrameBinding = ReturnType<typeof useJarvisRunFrame>;

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const CONFIRMATION_ID = '33333333-3333-4333-8333-333333333333';
const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_CUSTOMER_ID = '66666666-6666-4666-8666-666666666666';
const HASH = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);

function run(overrides: Partial<JarvisRunView> = {}): JarvisRunView {
  return {
    runId: RUN_ID,
    kind: 'customer_contact',
    definitionVersion: 1,
    actionReference: { actionId: 'client-modifier', actionVersion: 1 },
    status: 'waiting_user',
    revision: 4,
    nextWakeAt: null,
    terminalAt: null,
    ...overrides,
  };
}

function presentation(
  overrides: Partial<CustomerContactPresentationV1> = {},
): CustomerContactPresentationV1 {
  return {
    schema: 'bob.jarvis-run.customer-contact-presentation',
    version: 1,
    phase: 'awaiting_confirmation',
    intent: 'update',
    targetCustomerId: CUSTOMER_ID,
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
      status: 'issued',
      expiresAt: '2026-08-19T10:05:00.000Z',
      presentedAt: null,
    },
    completion: null,
    ...overrides,
  };
}

function frame(): JarvisRunFrame {
  return { run: run(), presentation: presentation() };
}

const PORTS: JarvisRunPorts = { submitCommand: vi.fn() };

function receipt(): JarvisCommandReceiptView {
  return {
    outcome: 'admitted',
    run: run({ revision: 5 }),
    presentation: presentation({
      confirmation: {
        confirmationId: CONFIRMATION_ID,
        status: 'presented',
        expiresAt: '2026-08-19T10:05:00.000Z',
        presentedAt: '2026-08-19T10:00:10.000Z',
      },
    }),
    eventSequence: 9,
  };
}

interface Transport {
  readonly currentRunCalls: number[];
  readonly submitted: JarvisSubmitCommandClientInput[];
  readonly client: BobClient;
}

function transport(
  view: JarvisCurrentRunView = { run: run(), presentation: presentation() },
  overrides: { readonly withCurrentRun?: boolean; readonly withSubmit?: boolean } = {},
): Transport {
  const currentRunCalls: number[] = [];
  const submitted: JarvisSubmitCommandClientInput[] = [];
  const client = {
    companyId: 'company-1',
    ...(overrides.withCurrentRun === false
      ? {}
      : {
          jarvisCurrentRun: (): Promise<Result<JarvisCurrentRunView, AppError>> => {
            currentRunCalls.push(currentRunCalls.length + 1);
            return Promise.resolve({ ok: true, value: view });
          },
        }),
    ...(overrides.withSubmit === false
      ? {}
      : {
          jarvisSubmitCommand: (
            input: JarvisSubmitCommandClientInput,
          ): Promise<Result<JarvisCommandReceiptView, AppError>> => {
            submitted.push(input);
            return Promise.resolve({ ok: true, value: receipt() });
          },
        }),
  } as unknown as BobClient;
  return { currentRunCalls, submitted, client };
}

function queryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** Sonde sans UI : le hook n'a besoin d'aucun composant natif pour être exercé. */
function Probe({ onBinding }: { readonly onBinding: (binding: JarvisRunFrameBinding) => void }) {
  onBinding(useJarvisRunFrame());
  return null;
}

async function mount(
  qc: QueryClient,
  hosts: number,
): Promise<{ readonly bindings: JarvisRunFrameBinding[][] }> {
  const bindings: JarvisRunFrameBinding[][] = Array.from({ length: hosts }, () => []);
  const children: ReactNode[] = Array.from({ length: hosts }, (_unused, host) =>
    createElement(Probe, {
      key: `host-${host}`,
      onBinding: (binding: JarvisRunFrameBinding) => {
        bindings[host]?.push(binding);
      },
    }),
  );
  await act(async () => {
    create(createElement(QueryClientProvider, { client: qc }, ...children));
  });
  // La query owner-scopée résout hors du rendu : on laisse converger, avec une borne stricte
  // (une découverte qui ne converge pas doit rougir, jamais boucler).
  for (let turn = 0; turn < 20; turn += 1) {
    if (bindings.every((host) => last(host).state.phase !== 'loading')) break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return { bindings };
}

function last(bindings: JarvisRunFrameBinding[]): JarvisRunFrameBinding {
  const value = bindings[bindings.length - 1];
  if (value === undefined) throw new Error('BINDING_ABSENT');
  return value;
}

beforeEach(() => {
  uuid.next = 0;
  doubles.auth = { enabled: true, session: { user: { id: 'owner-1' } } };
  doubles.registry = new AgentMissionCommandIdRegistry();
});

describe('deriveJarvisRunFrameState — projection PURE, aucune branche implicite', () => {
  const base = {
    authenticated: true,
    supported: true,
    pending: false,
    failed: false,
    data: undefined as JarvisCurrentRunView | undefined,
    ports: PORTS as JarvisRunPorts | null,
  };

  it('non authentifié ⇒ unavailable (aucune lecture owner-scopée possible)', () => {
    expect(deriveJarvisRunFrameState({ ...base, authenticated: false })).toEqual({
      phase: 'unavailable',
    });
  });

  it('transport sans canal tactile (ports absents) ⇒ unavailable, jamais une carte sans transport', () => {
    expect(deriveJarvisRunFrameState({ ...base, supported: false, ports: null })).toEqual({
      phase: 'unavailable',
    });
  });

  it('lecture RATÉE ⇒ une présentation métier précédente ne survit jamais', () => {
    expect(
      deriveJarvisRunFrameState({
        ...base,
        failed: true,
        data: { run: run(), presentation: presentation() },
      }),
    ).toEqual({ phase: 'error' });
  });

  it('première lecture en vol ⇒ loading', () => {
    expect(deriveJarvisRunFrameState({ ...base, pending: true })).toEqual({ phase: 'loading' });
  });

  it('aucun run non terminal ⇒ absent', () => {
    expect(deriveJarvisRunFrameState({ ...base, data: { run: null, presentation: null } })).toEqual(
      { phase: 'absent' },
    );
  });

  it('run vivant SANS projection (fail-closed G4) ⇒ unpresentable, jamais confondu avec absent', () => {
    const runView = run();
    expect(
      deriveJarvisRunFrameState({ ...base, data: { run: runView, presentation: null } }),
    ).toEqual({ phase: 'unpresentable', run: runView, ports: PORTS, refreshFailed: false });
  });

  it('échec de relecture ⇒ conserve seulement la frame de contrôle déjà imprésentable', () => {
    const runView = run();
    expect(
      deriveJarvisRunFrameState({
        ...base,
        failed: true,
        data: { run: runView, presentation: null },
      }),
    ).toEqual({ phase: 'unpresentable', run: runView, ports: PORTS, refreshFailed: true });
  });

  it('run + projection ⇒ ready, ports transportés avec la frame', () => {
    const state = deriveJarvisRunFrameState({
      ...base,
      data: { run: run(), presentation: presentation() },
    });
    expect(state.phase).toBe('ready');
    if (state.phase !== 'ready') throw new Error('READY_ATTENDU');
    expect(state.frame.run.runId).toBe(RUN_ID);
    expect(state.frame.presentation.confirmation?.confirmationId).toBe(CONFIRMATION_ID);
    expect(state.ports).toBe(PORTS);
  });
});

describe('jarvisFrameTargetsCustomer — la fiche n’héberge que la proposition qui parle d’elle', () => {
  it('modification de CETTE fiche ⇒ vrai', () => {
    expect(jarvisFrameTargetsCustomer(frame(), CUSTOMER_ID)).toBe(true);
  });

  it('modification d’un AUTRE client ⇒ faux', () => {
    expect(jarvisFrameTargetsCustomer(frame(), OTHER_CUSTOMER_ID)).toBe(false);
  });

  it('création (aucune cible) ⇒ faux — l’écran de création n’est pas la fiche', () => {
    const creation: JarvisRunFrame = {
      run: run(),
      presentation: presentation({ intent: 'create', targetCustomerId: null }),
    };
    expect(jarvisFrameTargetsCustomer(creation, CUSTOMER_ID)).toBe(false);
  });

  it('id de route vide ⇒ faux (jamais un match par le vide)', () => {
    const orphan: JarvisRunFrame = {
      run: run(),
      presentation: presentation({ targetCustomerId: '' }),
    };
    expect(jarvisFrameTargetsCustomer(orphan, '')).toBe(false);
  });
});

describe('useJarvisRunFrame — la découverte', () => {
  it('apprend le runId à l’appareil : GET run courant ⇒ frame prête', async () => {
    const wire = transport();
    doubles.client = wire.client;
    const { bindings } = await mount(queryClient(), 1);
    const state = last(bindings[0] ?? []).state;
    expect(wire.currentRunCalls).toHaveLength(1);
    expect(state.phase).toBe('ready');
    if (state.phase !== 'ready') throw new Error('READY_ATTENDU');
    expect(state.frame.run.runId).toBe(RUN_ID);
  });

  it('transport SANS jarvisCurrentRun ⇒ unavailable et AUCUN appel réseau', async () => {
    const wire = transport(undefined, { withCurrentRun: false });
    doubles.client = wire.client;
    const { bindings } = await mount(queryClient(), 1);
    expect(last(bindings[0] ?? []).state).toEqual({ phase: 'unavailable' });
    expect(wire.submitted).toHaveLength(0);
  });

  it('transport SANS canal tactile ⇒ unavailable : la carte n’est pas montrable sans ports', async () => {
    const wire = transport(undefined, { withSubmit: false });
    doubles.client = wire.client;
    const { bindings } = await mount(queryClient(), 1);
    expect(last(bindings[0] ?? []).state).toEqual({ phase: 'unavailable' });
  });

  it('non authentifié ⇒ unavailable, la lecture owner-scopée ne part pas', async () => {
    const wire = transport();
    doubles.client = wire.client;
    doubles.auth = { enabled: true, session: null };
    const { bindings } = await mount(queryClient(), 1);
    expect(last(bindings[0] ?? []).state).toEqual({ phase: 'unavailable' });
    expect(wire.currentRunCalls).toHaveLength(0);
  });

  it('run terminé côté serveur ⇒ absent : la carte disparaît sans que l’écran le devine', async () => {
    const wire = transport({ run: null, presentation: null });
    doubles.client = wire.client;
    const { bindings } = await mount(queryClient(), 1);
    expect(last(bindings[0] ?? []).state).toEqual({ phase: 'absent' });
  });
});

describe('useJarvisRunFrame — le registre de commandId est INJECTÉ, pas privé', () => {
  it('deux hôtes montés ensemble émettent le MÊME commandId (le serveur rejoue, il n’exécute pas deux fois)', async () => {
    const wire = transport();
    doubles.client = wire.client;
    const { bindings } = await mount(queryClient(), 2);
    const first = last(bindings[0] ?? []);
    const second = last(bindings[1] ?? []);
    expect(first.coordinator).not.toBe(second.coordinator);
    if (first.state.phase !== 'ready' || second.state.phase !== 'ready') {
      throw new Error('READY_ATTENDU');
    }
    const firstState = first.state;
    const secondState = second.state;
    await act(async () => {
      await first.coordinator.acknowledgePresentation(firstState.frame, firstState.ports);
    });
    await act(async () => {
      await second.coordinator.acknowledgePresentation(secondState.frame, secondState.ports);
    });
    expect(wire.submitted).toHaveLength(2);
    expect(wire.submitted[0]?.commandId).toBe(wire.submitted[1]?.commandId);
  });

  it('un registre NEUF (ce que ferait un registre privé) refabrique un id — la preuve du contraire', async () => {
    const wire = transport();
    doubles.client = wire.client;
    const { bindings: firstMount } = await mount(queryClient(), 1);
    const first = last(firstMount[0] ?? []);
    const firstState = first.state;
    if (firstState.phase !== 'ready') throw new Error('READY_ATTENDU');
    await act(async () => {
      await first.coordinator.acknowledgePresentation(firstState.frame, firstState.ports);
    });
    // Le registre est vidé/recréé — exactement ce qu'un registre privé au coordinateur ferait
    // à chaque remontage d'écran.
    doubles.registry = new AgentMissionCommandIdRegistry();
    const { bindings: secondMount } = await mount(queryClient(), 1);
    const second = last(secondMount[0] ?? []);
    const secondState = second.state;
    if (secondState.phase !== 'ready') throw new Error('READY_ATTENDU');
    await act(async () => {
      await second.coordinator.acknowledgePresentation(secondState.frame, secondState.ports);
    });
    expect(wire.submitted[0]?.commandId).not.toBe(wire.submitted[1]?.commandId);
  });
});

describe('useJarvisRunFrame — refresh() : invalidation métier PUIS relecture causale', () => {
  it('relit le run courant et invalide les préfixes existants (customers en tête)', async () => {
    const wire = transport();
    doubles.client = wire.client;
    const qc = queryClient();
    const invalidated: unknown[] = [];
    const spy = vi.spyOn(qc, 'invalidateQueries').mockImplementation((filters) => {
      invalidated.push(filters?.queryKey);
      return Promise.resolve();
    });
    const { bindings } = await mount(qc, 1);
    expect(wire.currentRunCalls).toHaveLength(1);

    await act(async () => {
      last(bindings[0] ?? []).refresh();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(invalidated).toContainEqual(['customers']);
    expect(invalidated).toContainEqual(['quotes']);
    // La relecture est bien repartie : l'écran ne déduit jamais le post-état d'un reçu.
    expect(wire.currentRunCalls).toHaveLength(2);
    spy.mockRestore();
  });
});
