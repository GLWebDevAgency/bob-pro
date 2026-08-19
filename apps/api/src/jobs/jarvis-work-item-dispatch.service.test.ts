/**
 * Jarvis U1-c — unit tests du worker de dispatch (SPEC_U1C_ADMISSION_DISPATCH_20260818 §3).
 *
 * Tests par FAKES, aucun PostgreSQL : les preuves transactionnelles (CAS, fence, RLS) vivent
 * dans jarvis-work-items.persistence.postgres.test.ts. Ici on prouve l'ORCHESTRATION :
 * claim → revalidation → authorize → execute → store → signal ; revalidation en échec ⇒
 * cancel SANS authorize ; kill switch ⇒ aucun claim MAIS signaux et réconciliation
 * toujours servis (revue C11) ; exécuteur absent ⇒ outcome_unknown `executor_unregistered`
 * sans appel provider ; redelivery poussée au tick suivant ; backoff borné ; cancel gagné
 * ⇒ résultat no-effect signalé ; `authorized` repris (lease expirée) ⇒ réconciliation
 * (revue C10) ; fakes NON complaisants (revue C19) : authorize/storeResult peuvent rendre
 * false et le worker S'ARRÊTE — aucun exécuteur après une autorisation perdue, aucun
 * signal après un storeResult refusé.
 *
 * U1-d (revue C9) : le ROUTAGE de la réconciliation d'une reprise `authorized` — reçu trouvé
 * ⇒ persistance + observation sans rejeu ; absence prouvée ou action idempotente ⇒ nouvel appel
 * avec le MÊME effectId ; indécidable (verdict ou exception) ⇒ `outcome_unknown` motivé plutôt
 * qu'une lease renouvelée à vie ; exécuteur sans réconciliation ⇒ rien n'est clos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_CATALOG_V0,
  deriveJarvisSystemCommandId,
  sha256Hex,
  type JarvisAdmissionResult,
  type JarvisAdmissionUnitOfWorkPort,
  type JarvisRunEnvelope,
  type JarvisSystemAdmissionEnvelope,
  type Notification,
} from '@bob/core';
import { AppLogger } from '../observability/logger';
import type { Persistence } from '../persistence/persistence';
import type {
  AuthorizeJarvisWorkItemInput,
  CancelUnauthorizedJarvisWorkItemInput,
  ClaimDueJarvisWorkItemsInput,
  JarvisWorkItemCoordinates,
  JarvisWorkItemLease,
  JarvisWorkItemPendingSignal,
  JarvisWorkItemsDispatchRepository,
  MarkJarvisWorkItemRetryDueInput,
  MarkJarvisWorkItemSignalAppliedInput,
  StoreJarvisWorkItemResultInput,
} from '../persistence/prisma/jarvis-work-items.persistence';
import type { ScheduledTenantDirectory } from './tenant-directory';
import {
  JarvisWorkItemDispatchService,
  NotificationJobEffectExecutor,
  jarvisDispatchRetryDelayMs,
  jarvisEffectExecutorKey,
  jarvisNotificationEffectDedupeKey,
  type JarvisDispatchRunDirectoryPort,
  type JarvisEffectExecutionInput,
  type JarvisEffectExecutionOutcome,
  type JarvisEffectExecutor,
  type JarvisEffectReconciliation,
} from './jarvis-work-item-dispatch.service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = 'co_1';
const OWNER_USER_ID = 'usr_1';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const EFFECT_ID = '22222222-2222-4222-8222-222222222222';
const RECEIPT_ID = '33333333-3333-4333-8333-333333333333';
const LEASE_TOKEN = '44444444-4444-4444-8444-444444444444';
const READ_AT = '2026-08-19T10:00:00.000Z';

const COORDINATES: JarvisWorkItemCoordinates = {
  companyId: COMPANY_ID,
  ownerUserId: OWNER_USER_ID,
  runId: RUN_ID,
};

/** Action RÉELLE du catalogue, non fermée — la revalidation lit le vrai ACTION_CATALOG_V0. */
const OPEN_ACTION = (() => {
  const entry = ACTION_CATALOG_V0.find((candidate) => candidate.voiceMode !== 'closed');
  if (entry === undefined)
    throw new Error('Fixture impossible : aucune action ouverte au catalogue.');
  return entry;
})();

function leaseFixture(overrides: Partial<JarvisWorkItemLease> = {}): JarvisWorkItemLease {
  return {
    id: 'wi_1',
    effectId: EFFECT_ID,
    actionId: OPEN_ACTION.actionId,
    actionVersion: OPEN_ACTION.version,
    authorizationSource: { source: 'confirmation', receiptId: RECEIPT_ID },
    actingPrincipalId: OWNER_USER_ID,
    targetDigest: null,
    payloadRef: null,
    executeBy: '2026-08-19T12:00:00.000Z',
    attempts: 0,
    leaseToken: LEASE_TOKEN,
    leaseFence: 1n,
    leaseExpiresAt: '2026-08-19T10:05:00.000Z',
    ...overrides,
  };
}

function runFixture(overrides: Partial<Record<string, unknown>> = {}): JarvisRunEnvelope {
  return {
    kind: 'single_business_action',
    runId: RUN_ID,
    companyId: COMPANY_ID,
    createdBy: OWNER_USER_ID,
    definitionVersion: 1,
    status: 'waiting_external',
    revision: 5,
    stateVersion: 1,
    state: { effect: { effectId: EFFECT_ID, authorizationReceiptId: RECEIPT_ID } },
    nextWakeAt: null,
    terminalAt: null,
    ...overrides,
  } as JarvisRunEnvelope;
}

// ---------------------------------------------------------------------------
// Fakes (aucun PostgreSQL) — un recorder partagé prouve l'ORDRE du pipeline
// ---------------------------------------------------------------------------

class FakeDispatchRepository implements JarvisWorkItemsDispatchRepository {
  leases: JarvisWorkItemLease[] = [];
  /** Lignes `authorized` à lease expirée que le tick doit reprendre (revue C10). */
  reclaimable: JarvisWorkItemLease[] = [];
  pending: JarvisWorkItemPendingSignal[] = [];
  authorizeResult = true;
  storeResultResult = true;
  cancelResult = true;
  retryResult = true;
  signalAppliedResult = true;

  readonly claimInputs: ClaimDueJarvisWorkItemsInput[] = [];
  readonly reclaimInputs: ClaimDueJarvisWorkItemsInput[] = [];
  readonly authorizeInputs: AuthorizeJarvisWorkItemInput[] = [];
  readonly storeInputs: StoreJarvisWorkItemResultInput[] = [];
  readonly retryInputs: MarkJarvisWorkItemRetryDueInput[] = [];
  readonly cancelInputs: CancelUnauthorizedJarvisWorkItemInput[] = [];
  readonly signalAppliedInputs: MarkJarvisWorkItemSignalAppliedInput[] = [];

  constructor(private readonly calls: string[]) {}

  async claimDue(
    _coordinates: JarvisWorkItemCoordinates,
    input: ClaimDueJarvisWorkItemsInput,
  ): Promise<readonly JarvisWorkItemLease[]> {
    this.calls.push('repo.claimDue');
    this.claimInputs.push(input);
    return this.leases;
  }

  async reclaimExpiredAuthorized(
    _coordinates: JarvisWorkItemCoordinates,
    input: ClaimDueJarvisWorkItemsInput,
  ): Promise<readonly JarvisWorkItemLease[]> {
    this.calls.push('repo.reclaimExpiredAuthorized');
    this.reclaimInputs.push(input);
    return this.reclaimable;
  }

  async authorize(
    _coordinates: JarvisWorkItemCoordinates,
    input: AuthorizeJarvisWorkItemInput,
  ): Promise<boolean> {
    this.calls.push('repo.authorize');
    this.authorizeInputs.push(input);
    return this.authorizeResult;
  }

  async storeResult(
    _coordinates: JarvisWorkItemCoordinates,
    input: StoreJarvisWorkItemResultInput,
  ): Promise<boolean> {
    this.calls.push('repo.storeResult');
    this.storeInputs.push(input);
    return this.storeResultResult;
  }

  async markRetryDue(
    _coordinates: JarvisWorkItemCoordinates,
    input: MarkJarvisWorkItemRetryDueInput,
  ): Promise<boolean> {
    this.calls.push('repo.markRetryDue');
    this.retryInputs.push(input);
    return this.retryResult;
  }

  async cancelUnauthorized(
    _coordinates: JarvisWorkItemCoordinates,
    input: CancelUnauthorizedJarvisWorkItemInput,
  ): Promise<boolean> {
    this.calls.push('repo.cancelUnauthorized');
    this.cancelInputs.push(input);
    return this.cancelResult;
  }

  async listPendingSignals(
    _coordinates: JarvisWorkItemCoordinates,
    _limit: number,
  ): Promise<readonly JarvisWorkItemPendingSignal[]> {
    this.calls.push('repo.listPendingSignals');
    return this.pending;
  }

  async markSignalApplied(
    _coordinates: JarvisWorkItemCoordinates,
    input: MarkJarvisWorkItemSignalAppliedInput,
  ): Promise<boolean> {
    this.calls.push('repo.markSignalApplied');
    this.signalAppliedInputs.push(input);
    return this.signalAppliedResult;
  }
}

interface FakeAdmission {
  readonly port: JarvisAdmissionUnitOfWorkPort;
  readonly admitted: JarvisSystemAdmissionEnvelope[];
}

/** Port d'admission fake : run figé, résultats scriptables (défaut `admitted`). */
function fakeAdmission(
  calls: string[],
  run: JarvisRunEnvelope | null,
  scriptedResults: JarvisAdmissionResult[] = [],
): FakeAdmission {
  const admitted: JarvisSystemAdmissionEnvelope[] = [];
  const port: JarvisAdmissionUnitOfWorkPort = {
    async runJarvisAdmission() {
      throw new Error('inattendu : le worker ne soumet jamais de commande utilisateur');
    },
    async runJarvisSystemAdmission(envelope) {
      calls.push('admission.admit');
      admitted.push(envelope);
      const scripted = scriptedResults.shift();
      if (scripted !== undefined) return scripted;
      return {
        status: 'admitted',
        postimage: run as JarvisRunEnvelope,
        eventSequence: 6,
        workItemIds: [],
      };
    },
    async readJarvisStateless(_owner, read) {
      calls.push('admission.read');
      const value = await read({ runById: async () => run });
      return { status: 'executed', value, readAt: READ_AT };
    },
  };
  return { port, admitted };
}

function fakePersistence(options: { closed?: boolean; findByIdError?: Error } = {}): {
  persistence: Persistence;
  enqueue: ReturnType<typeof vi.fn>;
} {
  const enqueue = vi.fn(async (input: { id: string }) => ({ ...input, id: 'job_1' }));
  const persistence = {
    companies: {
      findById: async () => {
        if (options.findByIdError) throw options.findByIdError;
        return { isClosed: () => options.closed === true };
      },
    },
    notificationJobs: { enqueue },
    runWithTenant: <T>(_companyId: string, fn: () => Promise<T>) => fn(),
  } as unknown as Persistence;
  return { persistence, enqueue };
}

function tenantDirectory(companyIds: string[]): ScheduledTenantDirectory {
  return { listCompanyIds: async () => companyIds } as unknown as ScheduledTenantDirectory;
}

interface Harness {
  readonly service: JarvisWorkItemDispatchService;
  readonly repository: FakeDispatchRepository;
  readonly admission: FakeAdmission;
  readonly enqueue: ReturnType<typeof vi.fn>;
  readonly listDispatchCoordinates: ReturnType<typeof vi.fn>;
  readonly calls: string[];
}

function harness(
  options: {
    run?: JarvisRunEnvelope | null;
    admissionResults?: JarvisAdmissionResult[];
    executors?: ReadonlyMap<string, JarvisEffectExecutor> | null;
    persistence?: { closed?: boolean; findByIdError?: Error };
  } = {},
): Harness {
  const calls: string[] = [];
  const repository = new FakeDispatchRepository(calls);
  const admission = fakeAdmission(
    calls,
    options.run === undefined ? runFixture() : options.run,
    options.admissionResults ?? [],
  );
  const { persistence, enqueue } = fakePersistence(options.persistence ?? {});
  const listDispatchCoordinates = vi.fn(async () => [COORDINATES]);
  const directory: JarvisDispatchRunDirectoryPort = { listDispatchCoordinates };
  const service = new JarvisWorkItemDispatchService(
    persistence,
    tenantDirectory([COMPANY_ID]),
    new AppLogger(),
    repository,
    directory,
    admission.port,
    options.executors ?? null,
  );
  return { service, repository, admission, enqueue, listDispatchCoordinates, calls };
}

function recordingExecutor(
  calls: string[],
  resultDigest: string,
): { executor: JarvisEffectExecutor; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => {
    calls.push('executor.execute');
    return { status: 'succeeded' as const, resultDigest };
  });
  return { executor: { execute }, execute };
}

const ORIGINAL_KILL_SWITCH = process.env.BOB_JARVIS_DISPATCH_ENABLED;

beforeEach(() => {
  delete process.env.BOB_JARVIS_DISPATCH_ENABLED;
});

afterEach(() => {
  if (ORIGINAL_KILL_SWITCH === undefined) delete process.env.BOB_JARVIS_DISPATCH_ENABLED;
  else process.env.BOB_JARVIS_DISPATCH_ENABLED = ORIGINAL_KILL_SWITCH;
});

// ---------------------------------------------------------------------------
// Les preuves
// ---------------------------------------------------------------------------

describe('JarvisWorkItemDispatchService — orchestration §5.3 (fakes, zéro PostgreSQL)', () => {
  it('déroule le pipeline dans l’ordre : claim → revalidation → authorize → execute → store → signal', async () => {
    const resultDigest = sha256Hex('resultat-effet');
    const h = harnessWithExecutor(resultDigest);
    h.repository.leases = [leaseFixture()];

    const summary = await h.service.runAllCompanies();

    expect(h.calls).toEqual([
      'repo.listPendingSignals',
      'repo.reclaimExpiredAuthorized', // réconciliation des authorized expirés (revue C10)
      'repo.claimDue',
      'admission.read', // revalidation : lecture stateless (run + horloge base)
      'repo.authorize',
      'executor.execute',
      'repo.storeResult',
      'admission.read', // signal : relecture de la révision courante
      'admission.admit',
      'repo.markSignalApplied',
    ]);
    expect(h.repository.storeInputs).toEqual([
      {
        id: 'wi_1',
        leaseToken: LEASE_TOKEN,
        leaseFence: 1n,
        status: 'succeeded',
        resultDigest,
      },
    ]);
    const envelope = h.admission.admitted[0];
    expect(envelope).toMatchObject({
      companyId: COMPANY_ID,
      ownerUserId: OWNER_USER_ID,
      kind: 'single_business_action',
      runId: RUN_ID,
      expectedRevision: 5,
      observationKind: 'effect_result',
      occurredAt: READ_AT,
      command: {
        type: 'record_effect_receipt',
        effectId: EFFECT_ID,
        receipt: { kind: 'succeeded', resultDigest },
      },
    });
    // commandId DÉTERMINISTE : dérivé, jamais inventé.
    const derived = deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, 'effect_result', resultDigest);
    expect(derived.ok && envelope?.commandId === derived.value).toBe(true);
    expect(h.repository.signalAppliedInputs).toEqual([
      { id: 'wi_1', leaseFence: 1n, resultDigest },
    ]);
    expect(summary).toMatchObject({
      companies: 1,
      claimed: 1,
      executed: 1,
      signalled: 1,
      cancelled: 0,
      retried: 0,
      unknown: 0,
      failures: 0,
      skipped: null,
    });
  });

  it('revalidation en échec (action hors catalogue) ⇒ cancel no-effect SANS authorize ni exécuteur', async () => {
    const h = harnessWithExecutor(sha256Hex('jamais-utilise'));
    h.repository.leases = [leaseFixture({ actionId: 'action-inconnue-jarvis', actionVersion: 1 })];

    const summary = await h.service.runAllCompanies();

    expect(h.calls).not.toContain('repo.authorize');
    expect(h.calls).not.toContain('executor.execute');
    expect(h.calls).not.toContain('repo.storeResult');
    expect(h.repository.cancelInputs).toHaveLength(1);
    expect(h.repository.cancelInputs[0]).toMatchObject({ id: 'wi_1', expectedLeaseFence: 1n });
    expect(summary).toMatchObject({ cancelled: 1, executed: 0, failures: 0 });
  });

  it('cancel gagné ⇒ le résultat no-effect est SIGNALÉ (reçu failed_terminal), jamais tacite', async () => {
    const h = harness();
    h.repository.leases = [leaseFixture({ executeBy: '2026-08-19T09:00:00.000Z' })]; // < READ_AT

    await h.service.runAllCompanies();

    expect(h.repository.cancelInputs).toHaveLength(1);
    const noEffectDigest = h.repository.cancelInputs[0]?.noEffectResultDigest;
    expect(noEffectDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(h.admission.admitted).toHaveLength(1);
    expect(h.admission.admitted[0]?.command).toEqual({
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      receipt: { kind: 'failed_terminal', failureDigest: noEffectDigest },
    });
    expect(h.repository.signalAppliedInputs).toEqual([
      { id: 'wi_1', leaseFence: 1n, resultDigest: noEffectDigest },
    ]);
  });

  it('cancel PERDU (course : claim intercalé ou authorize concurrent) ⇒ aucun signal émis ici', async () => {
    const h = harness();
    h.repository.leases = [leaseFixture({ executeBy: '2026-08-19T09:00:00.000Z' })];
    h.repository.cancelResult = false;

    const summary = await h.service.runAllCompanies();

    expect(h.admission.admitted).toHaveLength(0);
    expect(h.repository.signalAppliedInputs).toHaveLength(0);
    expect(summary).toMatchObject({ cancelled: 0, signalled: 0, failures: 0 });
  });

  it('kill switch coupé ⇒ AUCUN claim, MAIS signaux redélivrés et authorized réconciliés (revue C11, §5.3)', async () => {
    process.env.BOB_JARVIS_DISPATCH_ENABLED = 'false';
    const resultDigest = sha256Hex('resultat-sous-switch');
    const h = harness();
    // Un résultat d'effet AUTORISÉ attend son signal : le switch ne le coupe jamais.
    h.repository.pending = [
      {
        id: 'wi_1',
        effectId: EFFECT_ID,
        status: 'succeeded',
        resultDigest,
        leaseFence: 2n,
        updatedAt: READ_AT,
      },
    ];
    // Des work items dus existent : ils ne doivent JAMAIS être claimés sous switch coupé.
    h.repository.leases = [leaseFixture()];

    const summary = await h.service.runAllCompanies();

    expect(h.calls).toContain('repo.listPendingSignals');
    expect(h.calls).toContain('repo.reclaimExpiredAuthorized');
    expect(h.calls).not.toContain('repo.claimDue');
    expect(h.calls).not.toContain('repo.authorize');
    expect(h.repository.signalAppliedInputs).toEqual([
      { id: 'wi_1', leaseFence: 2n, resultDigest },
    ]);
    expect(summary).toMatchObject({ skipped: 'kill_switch', claimed: 0, signalled: 1 });
  });

  it('exécuteur absent (registre statique VIDE en U1-c) ⇒ outcome_unknown executor_unregistered, sans appel provider', async () => {
    const h = harness(); // executors: null ⇒ registre statique (vide)
    h.repository.leases = [leaseFixture()];

    const summary = await h.service.runAllCompanies();

    // Le point de non-retour est posé (le CHECK U1-a exige `authorized` pour outcome_unknown)…
    expect(h.calls).toContain('repo.authorize');
    // …mais AUCUNE I/O provider ne part : le registre vide le prouve.
    expect(h.enqueue).not.toHaveBeenCalled();
    const expectedDigest = sha256Hex(
      JSON.stringify([
        'bob.jarvis.dispatch.outcome-unknown.v1',
        EFFECT_ID,
        'executor_unregistered',
      ]),
    );
    expect(h.repository.storeInputs).toEqual([
      {
        id: 'wi_1',
        leaseToken: LEASE_TOKEN,
        leaseFence: 1n,
        status: 'outcome_unknown',
        resultDigest: expectedDigest,
      },
    ]);
    // Clôture honnête signalée au run (registre vide ⇒ rien n'est jamais parti).
    expect(h.admission.admitted[0]?.command).toEqual({
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      receipt: { kind: 'failed_terminal', failureDigest: expectedDigest },
    });
    expect(summary).toMatchObject({ unknown: 1, executed: 0, signalled: 1 });
  });

  it('redelivery level-triggered : un résultat non signalé est repoussé au tick suivant', async () => {
    const resultDigest = sha256Hex('resultat-persiste');
    const pending: JarvisWorkItemPendingSignal = {
      id: 'wi_1',
      effectId: EFFECT_ID,
      status: 'succeeded',
      resultDigest,
      leaseFence: 3n,
      updatedAt: READ_AT,
    };
    // Tick 1 : une commande interactive s'intercale ⇒ stale_revision, signal NON appliqué.
    const h = harness({ admissionResults: [{ status: 'stale_revision', actualRevision: 6 }] });
    h.repository.pending = [pending];

    const tick1 = await h.service.runAllCompanies();
    expect(h.repository.signalAppliedInputs).toHaveLength(0);
    expect(tick1).toMatchObject({ signalled: 0 });

    // Tick 2 : le résultat est toujours pending (level-triggered) ⇒ re-signalé et appliqué.
    const tick2 = await h.service.runAllCompanies();
    expect(h.repository.signalAppliedInputs).toEqual([
      { id: 'wi_1', leaseFence: 3n, resultDigest },
    ]);
    expect(tick2).toMatchObject({ signalled: 1 });

    // Même observation ⇒ même commandId déterministe sur les DEUX ticks (replay zéro-write).
    const derived = deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, 'effect_result', resultDigest);
    expect(derived.ok).toBe(true);
    expect(h.admission.admitted.map((envelope) => envelope.commandId)).toEqual([
      derived.ok ? derived.value : '',
      derived.ok ? derived.value : '',
    ]);
  });

  it('authorized repris (lease expirée) + registre VIDE ⇒ outcome_unknown executor_unregistered signalé (revue C10)', async () => {
    const h = harness(); // executors: null ⇒ registre statique VIDE : zéro I/O n'a pu partir
    h.repository.reclaimable = [leaseFixture({ leaseFence: 4n })];

    const summary = await h.service.runAllCompanies();

    const expectedDigest = sha256Hex(
      JSON.stringify([
        'bob.jarvis.dispatch.outcome-unknown.v1',
        EFFECT_ID,
        'executor_unregistered',
      ]),
    );
    // Statut jamais re-prepared : le règlement part du point de non-retour, sans authorize.
    expect(h.calls).not.toContain('repo.authorize');
    expect(h.calls).not.toContain('repo.markRetryDue');
    expect(h.repository.storeInputs).toEqual([
      {
        id: 'wi_1',
        leaseToken: LEASE_TOKEN,
        leaseFence: 4n,
        status: 'outcome_unknown',
        resultDigest: expectedDigest,
      },
    ]);
    expect(h.admission.admitted[0]?.command).toEqual({
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      receipt: { kind: 'failed_terminal', failureDigest: expectedDigest },
    });
    expect(h.repository.signalAppliedInputs).toEqual([
      { id: 'wi_1', leaseFence: 4n, resultDigest: expectedDigest },
    ]);
    expect(summary).toMatchObject({ unknown: 1, signalled: 1, claimed: 0, failures: 0 });
  });

  it('authorized repris, exécuteur enregistré SANS réconciliation ⇒ fail-closed : aucune clôture inventée', async () => {
    const h = harnessWithExecutor(sha256Hex('jamais-execute'));
    h.repository.reclaimable = [leaseFixture({ leaseFence: 4n })];

    const summary = await h.service.runAllCompanies();

    // Sans lecture par effectId, rien ici ne peut trancher : ni exécution, ni règlement, ni
    // signal — la ligne reste authorized sous sa lease renouvelée (l'exécuteur doit exposer sa
    // réconciliation avant d'être enregistré).
    expect(h.calls).not.toContain('executor.execute');
    expect(h.calls).not.toContain('repo.storeResult');
    expect(h.admission.admitted).toHaveLength(0);
    expect(h.repository.signalAppliedInputs).toHaveLength(0);
    expect(summary).toMatchObject({ unknown: 0, signalled: 0, failures: 0 });
  });

  it('réconciliation `landed` ⇒ le reçu trouvé est persisté et signalé, SANS rejouer l’effet (revue C9)', async () => {
    const landedDigest = sha256Hex('effet-deja-atterri');
    const h = harnessWithReconciler({
      kind: 'landed',
      outcome: { status: 'succeeded', resultDigest: landedDigest },
    });
    h.repository.reclaimable = [leaseFixture({ leaseFence: 4n })];

    const summary = await h.service.runAllCompanies();

    expect(h.calls).toContain('executor.reconcileEffect');
    // L'effet est DÉJÀ parti : le rejouer serait un doublon.
    expect(h.calls).not.toContain('executor.execute');
    expect(h.repository.storeInputs).toEqual([
      {
        id: 'wi_1',
        leaseToken: LEASE_TOKEN,
        leaseFence: 4n,
        status: 'succeeded',
        resultDigest: landedDigest,
      },
    ]);
    expect(h.admission.admitted[0]?.command).toEqual({
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      receipt: { kind: 'succeeded', resultDigest: landedDigest },
    });
    expect(h.repository.signalAppliedInputs).toEqual([
      { id: 'wi_1', leaseFence: 4n, resultDigest: landedDigest },
    ]);
    expect(summary).toMatchObject({ executed: 1, unknown: 0, signalled: 1, failures: 0 });
  });

  it('réconciliation `not_landed` ⇒ NOUVEL appel avec le MÊME effectId, puis résultat signalé', async () => {
    const replayDigest = sha256Hex('rejeu-du-meme-effet');
    const h = harnessWithReconciler(
      { kind: 'not_landed' },
      { status: 'succeeded', resultDigest: replayDigest },
    );
    h.repository.reclaimable = [leaseFixture({ leaseFence: 4n })];

    const summary = await h.service.runAllCompanies();

    expect(h.calls).toEqual([
      'repo.listPendingSignals',
      'repo.reclaimExpiredAuthorized',
      'executor.reconcileEffect',
      'executor.execute',
      'repo.storeResult',
      'admission.read',
      'admission.admit',
      'repo.markSignalApplied',
      'repo.claimDue',
    ]);
    // Le rejeu porte le MÊME effectId : jamais un second effet, jamais un nouvel identifiant.
    expect(h.execute.mock.calls[0]?.[0]?.lease.effectId).toBe(EFFECT_ID);
    // Jamais un retour à `authorize` : `authorized` est le point de non-retour.
    expect(h.calls).not.toContain('repo.authorize');
    expect(h.repository.storeInputs[0]).toMatchObject({
      leaseFence: 4n,
      status: 'succeeded',
      resultDigest: replayDigest,
    });
    expect(summary).toMatchObject({ executed: 1, signalled: 1, claimed: 0, failures: 0 });
  });

  it('réconciliation `safe_to_replay` (action idempotente) ⇒ rejeu du même effectId', async () => {
    const replayDigest = sha256Hex('rejeu-idempotent');
    const h = harnessWithReconciler(
      { kind: 'safe_to_replay' },
      { status: 'succeeded', resultDigest: replayDigest },
    );
    h.repository.reclaimable = [leaseFixture({ leaseFence: 4n })];

    await h.service.runAllCompanies();

    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.execute.mock.calls[0]?.[0]?.lease.effectId).toBe(EFFECT_ID);
    expect(h.repository.storeInputs[0]).toMatchObject({ resultDigest: replayDigest });
  });

  it('réconciliation `undecidable` ⇒ outcome_unknown MOTIVÉ et signalé — jamais une lease renouvelée à vie', async () => {
    const h = harnessWithReconciler({ kind: 'undecidable' });
    h.repository.reclaimable = [leaseFixture({ leaseFence: 4n })];

    const summary = await h.service.runAllCompanies();

    const expectedDigest = sha256Hex(
      JSON.stringify([
        'bob.jarvis.dispatch.outcome-unknown.v1',
        EFFECT_ID,
        'reconciliation_undecidable',
      ]),
    );
    expect(h.calls).not.toContain('executor.execute');
    expect(h.repository.storeInputs).toEqual([
      {
        id: 'wi_1',
        leaseToken: LEASE_TOKEN,
        leaseFence: 4n,
        status: 'outcome_unknown',
        resultDigest: expectedDigest,
      },
    ]);
    expect(h.repository.signalAppliedInputs).toEqual([
      { id: 'wi_1', leaseFence: 4n, resultDigest: expectedDigest },
    ]);
    expect(summary).toMatchObject({ unknown: 1, signalled: 1, failures: 0 });
  });

  it('réconciliation qui LÈVE ⇒ indécidable (aucune absence prouvée), jamais un rejeu à l’aveugle', async () => {
    const h = harnessWithReconciler(new Error('autorité muette'));
    h.repository.reclaimable = [leaseFixture({ leaseFence: 4n })];

    const summary = await h.service.runAllCompanies();

    expect(h.calls).not.toContain('executor.execute');
    expect(h.repository.storeInputs[0]).toMatchObject({
      status: 'outcome_unknown',
      resultDigest: sha256Hex(
        JSON.stringify([
          'bob.jarvis.dispatch.outcome-unknown.v1',
          EFFECT_ID,
          'reconciliation_undecidable',
        ]),
      ),
    });
    expect(summary).toMatchObject({ unknown: 1, signalled: 1 });
  });

  it('rejeu réconcilié qui LÈVE ⇒ outcome_unknown executor_error, résultat tout de même persisté', async () => {
    const h = harnessWithReconciler({ kind: 'not_landed' }, new Error('provider en panne'));
    h.repository.reclaimable = [leaseFixture({ leaseFence: 4n })];

    const summary = await h.service.runAllCompanies();

    expect(h.calls).toContain('executor.execute');
    expect(h.repository.storeInputs[0]).toMatchObject({
      status: 'outcome_unknown',
      resultDigest: sha256Hex(
        JSON.stringify(['bob.jarvis.dispatch.outcome-unknown.v1', EFFECT_ID, 'executor_error']),
      ),
    });
    expect(summary).toMatchObject({ unknown: 1, signalled: 1, failures: 0 });
  });

  it('storeResult REFUSÉ après réconciliation ⇒ aucun signal indû (fence repris par un successeur)', async () => {
    const h = harnessWithReconciler({
      kind: 'landed',
      outcome: { status: 'succeeded', resultDigest: sha256Hex('reçu-trouve') },
    });
    h.repository.reclaimable = [leaseFixture({ leaseFence: 4n })];
    h.repository.storeResultResult = false;

    const summary = await h.service.runAllCompanies();

    expect(h.calls).toContain('repo.storeResult');
    expect(h.admission.admitted).toHaveLength(0);
    expect(h.repository.signalAppliedInputs).toHaveLength(0);
    expect(summary).toMatchObject({ executed: 0, unknown: 0, signalled: 0, failures: 0 });
  });

  it('autorisation PERDUE (authorize rend false) ⇒ HALT avant I/O, route no-effect fencée (revues C12+C19)', async () => {
    const h = harnessWithExecutor(sha256Hex('jamais-utilise'));
    h.repository.leases = [leaseFixture()];
    h.repository.authorizeResult = false;

    const summary = await h.service.runAllCompanies();

    // HALT : sans le point de non-retour, JAMAIS d'exécuteur ni de résultat d'exécution.
    expect(h.calls).not.toContain('executor.execute');
    expect(h.calls).not.toContain('repo.storeResult');
    // Route no-effect fencée : échéance passée in-tx (C12) ou lease expirée ⇒ cancel gagne
    // et le règlement est signalé — un successeur intercalé l'aurait fait perdre (test suivant).
    expect(h.repository.cancelInputs).toHaveLength(1);
    expect(h.repository.cancelInputs[0]).toMatchObject({ id: 'wi_1', expectedLeaseFence: 1n });
    const noEffectDigest = h.repository.cancelInputs[0]?.noEffectResultDigest;
    expect(h.admission.admitted[0]?.command).toEqual({
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      receipt: { kind: 'failed_terminal', failureDigest: noEffectDigest },
    });
    expect(summary).toMatchObject({ cancelled: 1, executed: 0, signalled: 1, failures: 0 });
  });

  it('autorisation perdue ET cancel perdu (successeur détient la ligne) ⇒ zéro écriture, zéro signal (revue C19)', async () => {
    const h = harnessWithExecutor(sha256Hex('jamais-utilise'));
    h.repository.leases = [leaseFixture()];
    h.repository.authorizeResult = false;
    h.repository.cancelResult = false;

    const summary = await h.service.runAllCompanies();

    expect(h.calls).not.toContain('executor.execute');
    expect(h.calls).not.toContain('repo.storeResult');
    expect(h.admission.admitted).toHaveLength(0);
    expect(h.repository.signalAppliedInputs).toHaveLength(0);
    expect(summary).toMatchObject({ cancelled: 0, executed: 0, signalled: 0, failures: 0 });
  });

  it('storeResult REFUSÉ (fence périmé, résultat non persisté) ⇒ AUCUN signal indû (revue C19)', async () => {
    const h = harnessWithExecutor(sha256Hex('resultat-refuse'));
    h.repository.leases = [leaseFixture()];
    h.repository.storeResultResult = false;

    const summary = await h.service.runAllCompanies();

    expect(h.calls).toContain('repo.storeResult');
    // Un résultat que la base a refusé n'existe pas : jamais signalé, jamais acquitté.
    expect(h.calls).not.toContain('admission.admit');
    expect(h.repository.signalAppliedInputs).toHaveLength(0);
    expect(summary).toMatchObject({ executed: 0, signalled: 0, failures: 0 });
  });

  it('échec transitoire de revalidation ⇒ markRetryDue avec backoff exponentiel BORNÉ', async () => {
    const h = harness({ persistence: { findByIdError: new Error('db indisponible') } });
    h.repository.leases = [
      leaseFixture({ attempts: 0 }),
      leaseFixture({ id: 'wi_2', attempts: 64 }),
    ];

    const summary = await h.service.runAllCompanies();

    expect(h.calls).not.toContain('repo.authorize');
    expect(h.calls).not.toContain('repo.cancelUnauthorized');
    expect(h.repository.retryInputs).toEqual([
      { id: 'wi_1', leaseToken: LEASE_TOKEN, leaseFence: 1n, retryDelayMs: 60_000 },
      // 2^64 minutes déborderait tout : le plafond de 120 minutes (= plafond repository) tient.
      { id: 'wi_2', leaseToken: LEASE_TOKEN, leaseFence: 1n, retryDelayMs: 7_200_000 },
    ]);
    expect(summary).toMatchObject({ retried: 2, failures: 0 });
  });

  it('la loi de backoff est pure et bornée [1 min, 120 min]', () => {
    expect(jarvisDispatchRetryDelayMs(0)).toBe(60_000);
    expect(jarvisDispatchRetryDelayMs(1)).toBe(120_000);
    expect(jarvisDispatchRetryDelayMs(6)).toBe(64 * 60_000);
    expect(jarvisDispatchRetryDelayMs(7)).toBe(120 * 60_000);
    expect(jarvisDispatchRetryDelayMs(1_000)).toBe(120 * 60_000);
  });

  it('succès customer_contact non reconstructible ⇒ signal_unbuildable, jamais un reçu inventé', async () => {
    const run = runFixture({
      kind: 'customer_contact',
      state: { effectId: EFFECT_ID, confirmation: { consumedByCommandId: RECEIPT_ID } },
    });
    const h = harness({ run });
    h.repository.pending = [
      {
        id: 'wi_1',
        effectId: EFFECT_ID,
        status: 'succeeded',
        resultDigest: sha256Hex('succes-cc'),
        leaseFence: 2n,
        updatedAt: READ_AT,
      },
    ];

    const summary = await h.service.runAllCompanies();

    expect(h.admission.admitted).toHaveLength(0);
    expect(h.repository.signalAppliedInputs).toHaveLength(0);
    expect(summary).toMatchObject({ signalled: 0 });
  });

  it('clôture customer_contact (cancelled) ⇒ reçu outcome failed_terminal au vocabulaire fermé', async () => {
    const run = runFixture({
      kind: 'customer_contact',
      state: { effectId: EFFECT_ID, confirmation: { consumedByCommandId: RECEIPT_ID } },
    });
    const h = harness({ run });
    h.repository.pending = [
      {
        id: 'wi_1',
        effectId: EFFECT_ID,
        status: 'cancelled',
        resultDigest: sha256Hex('no-effect-cc'),
        leaseFence: 2n,
        updatedAt: READ_AT,
      },
    ];

    await h.service.runAllCompanies();

    expect(h.admission.admitted[0]?.command).toEqual({
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      outcome: { kind: 'failed_terminal', reasonCode: 'dispatch_cancelled_no_effect' },
    });
  });

  it('reçu de confirmation introuvable dans la trace durable du run ⇒ cancel fail-closed', async () => {
    const run = runFixture({
      state: { effect: { effectId: EFFECT_ID, authorizationReceiptId: 'autre-command-id' } },
    });
    const h = harness({ run });
    h.repository.leases = [leaseFixture()];

    await h.service.runAllCompanies();

    expect(h.calls).not.toContain('repo.authorize');
    expect(h.repository.cancelInputs).toHaveLength(1);
  });

  it('NotificationJobEffectExecutor : enqueue outbox canonique, dedupeKey jarvis:{effectId}:v1', async () => {
    const { persistence, enqueue } = fakePersistence();
    const notification: Notification = {
      channel: 'email',
      to: 'client@example.fr',
      subject: 'Objet',
      body: 'Corps',
    };
    const executor = new NotificationJobEffectExecutor({ persistence, now: () => READ_AT }, () => ({
      kind: 'quote-signature',
      notification,
    }));

    const outcome = await executor.execute({ coordinates: COORDINATES, lease: leaseFixture() });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      companyId: COMPANY_ID,
      kind: 'quote-signature',
      dedupeKey: jarvisNotificationEffectDedupeKey(EFFECT_ID),
      notification,
      now: READ_AT,
    });
    expect(jarvisNotificationEffectDedupeKey(EFFECT_ID)).toBe(`jarvis:${EFFECT_ID}:v1`);
    expect(outcome.status).toBe('succeeded');
    expect(outcome.resultDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('NotificationJobEffectExecutor : traduction impossible ⇒ échec terminal AVANT toute écriture', async () => {
    const { persistence, enqueue } = fakePersistence();
    const executor = new NotificationJobEffectExecutor(
      { persistence, now: () => READ_AT },
      () => null,
    );

    const outcome = await executor.execute({ coordinates: COORDINATES, lease: leaseFixture() });

    expect(enqueue).not.toHaveBeenCalled();
    expect(outcome.status).toBe('failed_terminal');
  });
});

/** Harness avec UN exécuteur enregistré sous la clé réelle de l'action ouverte du catalogue. */
function harnessWithExecutor(resultDigest: string): Harness {
  const calls: string[] = [];
  const { executor } = recordingExecutor(calls, resultDigest);
  return harnessWith(calls, executor);
}

/**
 * Harness avec un exécuteur qui SAIT réconcilier son effet par `effectId` (revue C9) : le
 * verdict est scripté, l'exécution éventuelle aussi — un `Error` en position de verdict ou de
 * résultat fait LEVER l'appel correspondant.
 */
function harnessWithReconciler(
  verdict: JarvisEffectReconciliation | Error,
  execution: JarvisEffectExecutionOutcome | Error = {
    status: 'succeeded',
    resultDigest: sha256Hex('rejeu-reconcilie'),
  },
): Harness & {
  readonly execute: ReturnType<typeof vi.fn>;
  readonly reconcile: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  const execute = vi.fn(async (_input: JarvisEffectExecutionInput) => {
    calls.push('executor.execute');
    if (execution instanceof Error) throw execution;
    return execution;
  });
  const reconcile = vi.fn(async (_input: JarvisEffectExecutionInput) => {
    calls.push('executor.reconcileEffect');
    if (verdict instanceof Error) throw verdict;
    return verdict;
  });
  const base = harnessWith(calls, { execute, reconcileEffect: reconcile });
  return { ...base, execute, reconcile };
}

function harnessWith(calls: string[], executor: JarvisEffectExecutor): Harness {
  const executors = new Map<string, JarvisEffectExecutor>([
    [jarvisEffectExecutorKey(OPEN_ACTION.actionId, OPEN_ACTION.version), executor],
  ]);
  const repository = new FakeDispatchRepository(calls);
  const admission = fakeAdmission(calls, runFixture());
  const { persistence, enqueue } = fakePersistence();
  const listDispatchCoordinates = vi.fn(async () => [COORDINATES]);
  const service = new JarvisWorkItemDispatchService(
    persistence,
    tenantDirectory([COMPANY_ID]),
    new AppLogger(),
    repository,
    { listDispatchCoordinates },
    admission.port,
    executors,
  );
  return { service, repository, admission, enqueue, listDispatchCoordinates, calls };
}
