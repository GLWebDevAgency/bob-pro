/**
 * Jarvis U1-c — unit tests du worker de dispatch (SPEC_U1C_ADMISSION_DISPATCH_20260818 §3).
 *
 * Tests par FAKES, aucun PostgreSQL : les preuves transactionnelles (CAS, fence, RLS) vivent
 * dans jarvis-work-items.persistence.postgres.test.ts. Ici on prouve l'ORCHESTRATION :
 * claim → revalidation → authorize → execute → store → signal ; revalidation en échec ⇒
 * cancel SANS authorize ; kill switch ⇒ aucun claim MAIS signaux et réconciliation
 * toujours servis (revue C11) ; exécuteur absent avant authorize ⇒ annulation no-effect,
 * tandis qu'une reprise authorized sans arbitre reste outcome_unknown non signalée ;
 * redelivery poussée au tick suivant ; backoff borné ; cancel gagné
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
  initialSingleBusinessActionState,
  isU1CandidateAction,
  sha256Hex,
  type JarvisAdmissionResult,
  type JarvisAdmissionUnitOfWorkPort,
  type JarvisActionReleasePolicy,
  type JarvisRunEnvelope,
  type JarvisSystemAdmissionEnvelope,
  type Notification,
} from '@bob/core';
import { AppLogger } from '../observability/logger';
import { TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY } from '../jarvis/jarvis-release-policy.testing';
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
import type { JarvisDispatchRunDirectoryPort } from './jarvis-dispatch-directory';
import {
  JarvisWorkItemDispatchService,
  NotificationJobEffectExecutor,
  jarvisDispatchEnabled,
  jarvisDispatchRetryDelayMs,
  jarvisEffectExecutorKey,
  jarvisNotificationEffectDedupeKey,
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
const DIRECTORY_CLAIM_ID = '66666666-6666-4666-8666-666666666666';
const READ_AT = '2026-08-19T10:00:00.000Z';
const COORDINATES: JarvisWorkItemCoordinates = {
  companyId: COMPANY_ID,
  ownerUserId: OWNER_USER_ID,
  runId: RUN_ID,
};

/** Action RÉELLE de la borne U1 — le statut de release est injecté séparément au harnais. */
const CANDIDATE_ACTION = (() => {
  const entry = ACTION_CATALOG_V0.find((candidate) =>
    isU1CandidateAction(candidate.actionId, candidate.version),
  );
  if (entry === undefined)
    throw new Error('Fixture impossible : aucune action candidate U1 au catalogue.');
  return entry;
})();

function leaseFixture(overrides: Partial<JarvisWorkItemLease> = {}): JarvisWorkItemLease {
  return {
    id: 'wi_1',
    effectId: EFFECT_ID,
    actionId: CANDIDATE_ACTION.actionId,
    actionVersion: CANDIDATE_ACTION.version,
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
  const initial = initialSingleBusinessActionState({
    actionId: CANDIDATE_ACTION.actionId,
    actionVersion: CANDIDATE_ACTION.version,
  });
  if (!initial.ok) throw new Error('Fixture SBA invalide.');
  const proposalId = '55555555-5555-4555-8555-555555555555';
  return {
    kind: 'single_business_action',
    runId: RUN_ID,
    companyId: COMPANY_ID,
    createdBy: OWNER_USER_ID,
    definitionVersion: 1,
    status: 'waiting_external',
    revision: 5,
    stateVersion: 1,
    state: {
      ...initial.value,
      phase: 'committing',
      stepCount: 3,
      proposal: {
        proposalId,
        proposalCommandId: 'proposal-command-dispatch',
        canonicalInputDigest: sha256Hex('dispatch-input'),
        proposalHash: sha256Hex('dispatch-proposal'),
        presentationRequirement: 'screen_ack',
        targetDigest: null,
        payloadRef: null,
        confirmationTtlMs: 60_000,
        executeWindowMs: 60_000,
        status: 'consumed',
        issuedAt: '2026-08-19T09:00:00.000Z',
        presentedAt: '2026-08-19T09:01:00.000Z',
        presentationAck: 'screen_ack',
        expiresAt: '2026-08-19T10:30:00.000Z',
        ttlWakeId: `sba-confirmation-ttl:${proposalId}`,
        consumedByCommandId: RECEIPT_ID,
        invalidationReason: null,
      },
      effect: {
        effectId: EFFECT_ID,
        proposalId,
        authorizationReceiptId: RECEIPT_ID,
        actingPrincipalId: OWNER_USER_ID,
        executeBy: '2026-08-19T12:00:00.000Z',
        submittedJobRef: null,
        outcome: null,
        resultDigest: null,
      },
    },
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
  readonly calls: string[];
}

function fakeDispatchDirectory(
  coordinates: readonly JarvisWorkItemCoordinates[] = [COORDINATES],
): JarvisDispatchRunDirectoryPort {
  return {
    claimDispatchCoordinates: vi.fn(async () => ({
      status: 'claimed' as const,
      claimId: DIRECTORY_CLAIM_ID,
      pageSize: coordinates.length,
      hasMore: false,
      replayed: false,
      hardLeaseRemainingMs: 295_000,
      entries: coordinates.map((entry, index) => ({
        position: index + 1,
        coordinates: entry,
      })),
    })),
    renewDispatchCoordinatesClaim: vi.fn(async () => ({
      status: 'succeeded' as const,
      renewed: true,
    })),
    startDispatchCoordinate: vi.fn(async () => ({
      status: 'succeeded' as const,
      started: true,
    })),
    acknowledgeDispatchCoordinates: vi.fn(async () => ({
      status: 'succeeded' as const,
      acknowledged: true,
    })),
  };
}

function harness(
  options: {
    run?: JarvisRunEnvelope | null;
    admissionResults?: JarvisAdmissionResult[];
    executors?: ReadonlyMap<string, JarvisEffectExecutor> | null;
    persistence?: { closed?: boolean; findByIdError?: Error };
    releasePolicy?: JarvisActionReleasePolicy | null;
    directory?: JarvisDispatchRunDirectoryPort;
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
  const directory = options.directory ?? fakeDispatchDirectory();
  const service = new JarvisWorkItemDispatchService(
    persistence,
    tenantDirectory([COMPANY_ID]),
    new AppLogger(),
    repository,
    directory,
    admission.port,
    options.executors ?? null,
    options.releasePolicy === undefined
      ? TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY
      : options.releasePolicy,
  );
  return { service, repository, admission, enqueue, calls };
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
  process.env.BOB_JARVIS_DISPATCH_ENABLED = 'true';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (ORIGINAL_KILL_SWITCH === undefined) delete process.env.BOB_JARVIS_DISPATCH_ENABLED;
  else process.env.BOB_JARVIS_DISPATCH_ENABLED = ORIGINAL_KILL_SWITCH;
});

// ---------------------------------------------------------------------------
// Les preuves
// ---------------------------------------------------------------------------

describe('JarvisWorkItemDispatchService — orchestration §5.3 (fakes, zéro PostgreSQL)', () => {
  it('le dispatch est fermé par défaut et ne s’ouvre que par la valeur littérale true', () => {
    delete process.env.BOB_JARVIS_DISPATCH_ENABLED;
    expect(jarvisDispatchEnabled()).toBe(false);
    process.env.BOB_JARVIS_DISPATCH_ENABLED = 'true';
    expect(jarvisDispatchEnabled()).toBe(true);
    process.env.BOB_JARVIS_DISPATCH_ENABLED = 'TRUE';
    expect(jarvisDispatchEnabled()).toBe(false);
  });

  it('manifest runtime vide ⇒ annule avant authorize et n’appelle aucun exécuteur', async () => {
    const execute = vi.fn(async () => ({
      status: 'succeeded' as const,
      resultDigest: sha256Hex('ne-doit-pas-partir'),
    }));
    const h = harness({
      executors: new Map([
        [
          jarvisEffectExecutorKey(CANDIDATE_ACTION.actionId, CANDIDATE_ACTION.version),
          { execute } satisfies JarvisEffectExecutor,
        ],
      ]),
      releasePolicy: null,
    });
    h.repository.leases = [leaseFixture()];

    const summary = await h.service.runAllCompanies();

    expect(h.calls).not.toContain('repo.authorize');
    expect(execute).not.toHaveBeenCalled();
    expect(h.repository.cancelInputs).toHaveLength(1);
    expect(summary).toMatchObject({ cancelled: 1, executed: 0, failures: 0 });
  });

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

  it('exécuteur absent avant authorize ⇒ annulation no-effect fencée, sans appel provider', async () => {
    const h = harness(); // executors: null ⇒ registre statique (vide)
    h.repository.leases = [leaseFixture()];

    const summary = await h.service.runAllCompanies();

    // Le registre est lu avant le point de non-retour : ni authorize, ni I/O provider.
    expect(h.calls).not.toContain('repo.authorize');
    expect(h.enqueue).not.toHaveBeenCalled();
    const expectedDigest = sha256Hex(
      JSON.stringify([
        'bob.jarvis.dispatch.no-effect.v1',
        EFFECT_ID,
        'executor_unregistered',
      ]),
    );
    expect(h.repository.storeInputs).toHaveLength(0);
    expect(h.repository.cancelInputs).toEqual([
      { id: 'wi_1', expectedLeaseFence: 1n, noEffectResultDigest: expectedDigest },
    ]);
    expect(h.admission.admitted[0]?.command).toEqual({
      type: 'record_effect_receipt',
      effectId: EFFECT_ID,
      receipt: { kind: 'failed_terminal', failureDigest: expectedDigest },
    });
    expect(summary).toMatchObject({ cancelled: 1, unknown: 0, executed: 0, signalled: 1 });
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

  it('un outcome_unknown durable n’est jamais converti en reçu terminal ni acquitté', async () => {
    const h = harness();
    h.repository.pending = [
      {
        id: 'wi_unknown',
        effectId: EFFECT_ID,
        status: 'outcome_unknown',
        resultDigest: sha256Hex('issue-indecidable'),
        leaseFence: 4n,
        updatedAt: READ_AT,
      } as unknown as JarvisWorkItemPendingSignal,
    ];

    const summary = await h.service.runAllCompanies();

    expect(h.admission.admitted).toHaveLength(0);
    expect(h.repository.signalAppliedInputs).toHaveLength(0);
    expect(summary).toMatchObject({ signalled: 0, failures: 0 });
  });

  it('authorized repris (lease expirée) + registre VIDE ⇒ outcome_unknown quarantiné, jamais signalé (revue C10)', async () => {
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
    expect(h.admission.admitted).toHaveLength(0);
    expect(h.repository.signalAppliedInputs).toHaveLength(0);
    expect(summary).toMatchObject({ unknown: 1, signalled: 0, claimed: 0, failures: 0 });
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

  it('manifest fermé + absence prouvée ⇒ aucun rejeu, reçu no-effect et compteur cancelled', async () => {
    const h = harnessWithReconciler(
      { kind: 'not_landed' },
      { status: 'succeeded', resultDigest: sha256Hex('interdit') },
      null,
    );
    h.repository.reclaimable = [leaseFixture({ leaseFence: 4n })];

    const summary = await h.service.runAllCompanies();

    const expectedDigest = sha256Hex(
      JSON.stringify([
        'bob.jarvis.dispatch.no-effect.v1',
        EFFECT_ID,
        'action_not_released_after_authorization',
      ]),
    );
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.repository.storeInputs[0]).toMatchObject({
      status: 'failed_terminal',
      resultDigest: expectedDigest,
    });
    expect(summary).toMatchObject({ cancelled: 1, executed: 0, unknown: 0 });
  });

  it('manifest fermé + safe_to_replay ⇒ outcome_unknown, jamais un faux no-effect', async () => {
    const h = harnessWithReconciler(
      { kind: 'safe_to_replay' },
      { status: 'succeeded', resultDigest: sha256Hex('interdit') },
      null,
    );
    h.repository.reclaimable = [leaseFixture({ leaseFence: 4n })];

    const summary = await h.service.runAllCompanies();

    const expectedDigest = sha256Hex(
      JSON.stringify([
        'bob.jarvis.dispatch.outcome-unknown.v1',
        EFFECT_ID,
        'action_not_released_safe_replay_suppressed',
      ]),
    );
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.repository.storeInputs[0]).toMatchObject({
      status: 'outcome_unknown',
      resultDigest: expectedDigest,
    });
    expect(summary).toMatchObject({ executed: 0, unknown: 1 });
  });

  it('réconciliation `undecidable` ⇒ outcome_unknown MOTIVÉ et quarantiné', async () => {
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
    expect(h.admission.admitted).toHaveLength(0);
    expect(h.repository.signalAppliedInputs).toHaveLength(0);
    expect(summary).toMatchObject({ unknown: 1, signalled: 0, failures: 0 });
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
    expect(summary).toMatchObject({ unknown: 1, signalled: 0 });
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
    expect(summary).toMatchObject({ unknown: 1, signalled: 0, failures: 0 });
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

/** Harness avec UN exécuteur enregistré sous la clé réelle de l'action candidate U1. */
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
  releasePolicy: JarvisActionReleasePolicy | null = TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY,
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
  const base = harnessWith(calls, { execute, reconcileEffect: reconcile }, releasePolicy);
  return { ...base, execute, reconcile };
}

function harnessWith(
  calls: string[],
  executor: JarvisEffectExecutor,
  releasePolicy: JarvisActionReleasePolicy | null = TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY,
): Harness {
  const executors = new Map<string, JarvisEffectExecutor>([
    [jarvisEffectExecutorKey(CANDIDATE_ACTION.actionId, CANDIDATE_ACTION.version), executor],
  ]);
  const repository = new FakeDispatchRepository(calls);
  const admission = fakeAdmission(calls, runFixture());
  const { persistence, enqueue } = fakePersistence();
  const directory = fakeDispatchDirectory();
  const service = new JarvisWorkItemDispatchService(
    persistence,
    tenantDirectory([COMPANY_ID]),
    new AppLogger(),
    repository,
    directory,
    admission.port,
    executors,
    releasePolicy,
  );
  return { service, repository, admission, enqueue, calls };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

type DirectoryClaimResult = Awaited<
  ReturnType<JarvisDispatchRunDirectoryPort['claimDispatchCoordinates']>
>;

function claimedDirectoryPage(
  coordinates: readonly JarvisWorkItemCoordinates[],
  options: {
    readonly claimId?: string;
    readonly hardLeaseRemainingMs?: number;
    readonly hasMore?: boolean;
    readonly replayed?: boolean;
    readonly firstPosition?: number;
    readonly pageSize?: number;
  } = {},
): Extract<DirectoryClaimResult, { readonly status: 'claimed' }> {
  const firstPosition = options.firstPosition ?? 1;
  return {
    status: 'claimed',
    claimId: options.claimId ?? DIRECTORY_CLAIM_ID,
    pageSize: options.pageSize ?? coordinates.length,
    hasMore: options.hasMore ?? false,
    replayed: options.replayed ?? false,
    hardLeaseRemainingMs: options.hardLeaseRemainingMs ?? 295_000,
    entries: coordinates.map((entry, index) => ({
      position: firstPosition + index,
      coordinates: entry,
    })),
  };
}

function scriptedDispatchDirectory(
  claims: readonly DirectoryClaimResult[],
): {
  readonly port: JarvisDispatchRunDirectoryPort;
  readonly claim: ReturnType<typeof vi.fn>;
  readonly renew: ReturnType<typeof vi.fn>;
  readonly start: ReturnType<typeof vi.fn>;
  readonly ack: ReturnType<typeof vi.fn>;
} {
  const queue = [...claims];
  const claim = vi.fn(async () => queue.shift() ?? { status: 'empty' as const });
  const renew = vi.fn(async () => ({ status: 'succeeded' as const, renewed: true }));
  const start = vi.fn(async () => ({ status: 'succeeded' as const, started: true }));
  const ack = vi.fn(async () => ({ status: 'succeeded' as const, acknowledged: true }));
  return {
    port: {
      claimDispatchCoordinates: claim,
      renewDispatchCoordinatesClaim: renew,
      startDispatchCoordinate: start,
      acknowledgeDispatchCoordinates: ack,
    },
    claim,
    renew,
    start,
    ack,
  };
}

describe('JarvisWorkItemDispatchService — contrôle de page U1-l', () => {
  it('acquitte 25 coordonnées fautives puis atteint la coordonnée suivante au tick suivant', async () => {
    const faultyCoordinates = Array.from({ length: 25 }, (_, index) => ({
      companyId: COMPANY_ID,
      ownerUserId: `usr-faulty-${index.toString().padStart(2, '0')}`,
      runId: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString().padStart(12, '0')}`,
    }));
    const nextCoordinate = {
      companyId: COMPANY_ID,
      ownerUserId: 'usr-valid-z',
      runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    const directory = scriptedDispatchDirectory([
      claimedDirectoryPage(faultyCoordinates, {
        claimId: '66666666-6666-4666-8666-666666666661',
        hasMore: true,
      }),
      claimedDirectoryPage([nextCoordinate], {
        claimId: '66666666-6666-4666-8666-666666666662',
      }),
    ]);
    const run = runFixture({
      kind: 'customer_contact',
      state: { effectId: EFFECT_ID, confirmation: { consumedByCommandId: RECEIPT_ID } },
    });
    const h = harness({ run, directory: directory.port });
    h.repository.pending = [{
      id: 'wi_unbuildable',
      effectId: EFFECT_ID,
      status: 'succeeded',
      resultDigest: sha256Hex('succes-inconstructible'),
      leaseFence: 2n,
      updatedAt: READ_AT,
    }];
    const pendingSpy = vi.spyOn(h.repository, 'listPendingSignals');

    const first = await h.service.runForCompany(COMPANY_ID);
    expect(first).toMatchObject({ failures: 0, signalled: 0 });
    expect(directory.start.mock.calls.map(([input]) => input.position)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    expect(directory.ack).toHaveBeenCalledTimes(1);
    expect(pendingSpy).toHaveBeenCalledTimes(25);

    const second = await h.service.runForCompany(COMPANY_ID);
    expect(second).toMatchObject({ failures: 0, signalled: 0 });
    expect(pendingSpy).toHaveBeenLastCalledWith(nextCoordinate, 25);
    expect(directory.ack).toHaveBeenCalledTimes(2);
  });

  it('distingue busy, empty, unavailable et ack_ready sans geste parasite', async () => {
    const busy = scriptedDispatchDirectory([{ status: 'busy' }]);
    await expect(harness({ directory: busy.port }).service.runForCompany(COMPANY_ID))
      .resolves.toEqual({
        busy: 1,
        claimed: 0,
        executed: 0,
        unknown: 0,
        cancelled: 0,
        retried: 0,
        signalled: 0,
        failures: 0,
      });
    expect(busy.renew).not.toHaveBeenCalled();
    expect(busy.start).not.toHaveBeenCalled();
    expect(busy.ack).not.toHaveBeenCalled();

    const empty = scriptedDispatchDirectory([{ status: 'empty' }]);
    await expect(harness({ directory: empty.port }).service.runForCompany(COMPANY_ID))
      .resolves.toEqual({
        busy: 0,
        claimed: 0,
        executed: 0,
        unknown: 0,
        cancelled: 0,
        retried: 0,
        signalled: 0,
        failures: 0,
      });
    expect(empty.ack).not.toHaveBeenCalled();

    const unavailable = scriptedDispatchDirectory([{ status: 'unavailable' }]);
    await expect(harness({ directory: unavailable.port }).service.runForCompany(COMPANY_ID))
      .resolves.toMatchObject({ busy: 0, failures: 1 });
    expect(unavailable.ack).not.toHaveBeenCalled();

    const ackReady = scriptedDispatchDirectory([{
      status: 'ack_ready',
      claimId: DIRECTORY_CLAIM_ID,
      pageSize: 25,
      hasMore: true,
      replayed: true,
      hardLeaseRemainingMs: 295_000,
    }]);
    await expect(harness({ directory: ackReady.port }).service.runForCompany(COMPANY_ID))
      .resolves.toEqual({
        busy: 0,
        claimed: 0,
        executed: 0,
        unknown: 0,
        cancelled: 0,
        retried: 0,
        signalled: 0,
        failures: 0,
      });
    expect(ackReady.renew).not.toHaveBeenCalled();
    expect(ackReady.start).not.toHaveBeenCalled();
    expect(ackReady.ack).toHaveBeenCalledOnce();
  });

  it('continue avec la société suivante quand le claim de la première est indisponible', async () => {
    const secondCompanyId = 'co_2';
    const secondCoordinate: JarvisWorkItemCoordinates = {
      companyId: secondCompanyId,
      ownerUserId: 'usr_2',
      runId: '77777777-7777-4777-8777-777777777777',
    };
    const claim = vi.fn(async (input: { readonly companyId: string }) =>
      input.companyId === COMPANY_ID
        ? { status: 'unavailable' as const }
        : claimedDirectoryPage([secondCoordinate], {
            claimId: '66666666-6666-4666-8666-666666666667',
          }));
    const renew = vi.fn(async () => ({ status: 'succeeded' as const, renewed: true }));
    const start = vi.fn(async () => ({ status: 'succeeded' as const, started: true }));
    const ack = vi.fn(async () => ({ status: 'succeeded' as const, acknowledged: true }));
    const calls: string[] = [];
    const repository = new FakeDispatchRepository(calls);
    const admission = fakeAdmission(calls, runFixture());
    const { persistence } = fakePersistence();
    const service = new JarvisWorkItemDispatchService(
      persistence,
      tenantDirectory([COMPANY_ID, secondCompanyId]),
      new AppLogger(),
      repository,
      {
        claimDispatchCoordinates: claim,
        renewDispatchCoordinatesClaim: renew,
        startDispatchCoordinate: start,
        acknowledgeDispatchCoordinates: ack,
      },
      admission.port,
      null,
      TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY,
    );

    await expect(service.runAllCompanies()).resolves.toMatchObject({
      companies: 2,
      failures: 1,
    });
    expect(claim.mock.calls.map(([input]) => input.companyId)).toEqual([
      COMPANY_ID,
      secondCompanyId,
    ]);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      companyId: secondCompanyId,
      position: 1,
    }));
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ companyId: secondCompanyId }));
  });

  it('conserve les positions absolues d’un suffixe rejoué', async () => {
    const suffix = [
      { ...COORDINATES, ownerUserId: 'usr_suffix_2' },
      {
        ...COORDINATES,
        ownerUserId: 'usr_suffix_3',
        runId: '88888888-8888-4888-8888-888888888888',
      },
    ];
    const directory = scriptedDispatchDirectory([
      claimedDirectoryPage(suffix, {
        firstPosition: 2,
        pageSize: 3,
        replayed: true,
      }),
    ]);

    await expect(harness({ directory: directory.port }).service.runForCompany(COMPANY_ID))
      .resolves.toMatchObject({ failures: 0 });
    expect(directory.start.mock.calls.map(([input]) => input.position)).toEqual([2, 3]);
    expect(directory.ack).toHaveBeenCalledOnce();
  });

  it('arrête la page sur renew/start refusé et rend un ACK refusé visible', async () => {
    const renewRefused = scriptedDispatchDirectory([claimedDirectoryPage([COORDINATES])]);
    renewRefused.port.renewDispatchCoordinatesClaim = vi.fn(async () => ({
      status: 'succeeded' as const,
      renewed: false,
    }));
    await expect(
      harness({ directory: renewRefused.port }).service.runForCompany(COMPANY_ID),
    ).resolves.toMatchObject({ failures: 1 });
    expect(renewRefused.start).not.toHaveBeenCalled();
    expect(renewRefused.ack).not.toHaveBeenCalled();

    const startUnavailable = scriptedDispatchDirectory([claimedDirectoryPage([COORDINATES])]);
    startUnavailable.port.startDispatchCoordinate = vi.fn(async () => ({
      status: 'unavailable' as const,
    }));
    await expect(
      harness({ directory: startUnavailable.port }).service.runForCompany(COMPANY_ID),
    ).resolves.toMatchObject({ failures: 1 });
    expect(startUnavailable.ack).not.toHaveBeenCalled();

    const ackRefused = scriptedDispatchDirectory([claimedDirectoryPage([COORDINATES])]);
    ackRefused.port.acknowledgeDispatchCoordinates = vi.fn(async () => ({
      status: 'succeeded' as const,
      acknowledged: false,
    }));
    await expect(harness({ directory: ackRefused.port }).service.runForCompany(COMPANY_ID))
      .resolves.toMatchObject({ failures: 1 });
  });

  it('le kill switch ferme seulement les nouveaux work items et acquitte encore la page', async () => {
    process.env.BOB_JARVIS_DISPATCH_ENABLED = 'false';
    const directory = scriptedDispatchDirectory([claimedDirectoryPage([COORDINATES])]);
    const h = harness({ directory: directory.port });

    await expect(h.service.runForCompany(COMPANY_ID)).resolves.toMatchObject({ failures: 0 });
    expect(h.repository.claimInputs).toHaveLength(0);
    expect(h.repository.reclaimInputs).toHaveLength(1);
    expect(directory.ack).toHaveBeenCalledOnce();
  });

  it('ne démarre aucune position si le renew initial rend après la deadline commune', async () => {
    let monotonicNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
    const pendingRenew = deferred<{
      readonly status: 'succeeded';
      readonly renewed: boolean;
    }>();
    const startDispatchCoordinate = vi.fn(async () => ({
      status: 'succeeded' as const,
      started: true,
    }));
    const acknowledgeDispatchCoordinates = vi.fn(async () => ({
      status: 'succeeded' as const,
      acknowledged: true,
    }));
    const directory: JarvisDispatchRunDirectoryPort = {
      claimDispatchCoordinates: vi.fn(async () => ({
        status: 'claimed' as const,
        claimId: DIRECTORY_CLAIM_ID,
        pageSize: 1,
        hasMore: false,
        replayed: false,
        hardLeaseRemainingMs: 100,
        entries: [{ position: 1, coordinates: COORDINATES }],
      })),
      renewDispatchCoordinatesClaim: vi.fn(() => pendingRenew.promise),
      startDispatchCoordinate,
      acknowledgeDispatchCoordinates,
    };
    const h = harness({ directory });

    const running = h.service.runForCompany(COMPANY_ID);
    await flushMicrotasks();
    monotonicNow = 101;
    pendingRenew.resolve({ status: 'succeeded', renewed: true });

    await expect(running).resolves.toMatchObject({ failures: 1 });
    expect(startDispatchCoordinate).not.toHaveBeenCalled();
    expect(acknowledgeDispatchCoordinates).not.toHaveBeenCalled();
    expect(h.repository.claimInputs).toHaveLength(0);
  });

  it('ne lance pas le handler si start revient après la deadline commune', async () => {
    let monotonicNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
    const pendingStart = deferred<{
      readonly status: 'succeeded';
      readonly started: boolean;
    }>();
    const acknowledgeDispatchCoordinates = vi.fn(async () => ({
      status: 'succeeded' as const,
      acknowledged: true,
    }));
    const directory: JarvisDispatchRunDirectoryPort = {
      claimDispatchCoordinates: vi.fn(async () => ({
        status: 'claimed' as const,
        claimId: DIRECTORY_CLAIM_ID,
        pageSize: 1,
        hasMore: false,
        replayed: false,
        hardLeaseRemainingMs: 100,
        entries: [{ position: 1, coordinates: COORDINATES }],
      })),
      renewDispatchCoordinatesClaim: vi.fn(async () => ({
        status: 'succeeded' as const,
        renewed: true,
      })),
      startDispatchCoordinate: vi.fn(() => pendingStart.promise),
      acknowledgeDispatchCoordinates,
    };
    const h = harness({ directory });

    const running = h.service.runForCompany(COMPANY_ID);
    await flushMicrotasks();
    monotonicNow = 101;
    pendingStart.resolve({ status: 'succeeded', started: true });

    await expect(running).resolves.toMatchObject({ failures: 1 });
    expect(acknowledgeDispatchCoordinates).not.toHaveBeenCalled();
    expect(h.repository.claimInputs).toHaveLength(0);
  });

  it('une perte du heartbeat en vol gagne sur un handler déjà résolu et interdit l’ACK', async () => {
    vi.useFakeTimers();
    const pendingSignals = deferred<readonly JarvisWorkItemPendingSignal[]>();
    const heartbeatRenew = deferred<{
      readonly status: 'succeeded';
      readonly renewed: boolean;
    }>();
    let renewCount = 0;
    const renewDispatchCoordinatesClaim = vi.fn(() => {
      renewCount += 1;
      return renewCount === 1
        ? Promise.resolve({ status: 'succeeded' as const, renewed: true })
        : heartbeatRenew.promise;
    });
    const acknowledgeDispatchCoordinates = vi.fn(async () => ({
      status: 'succeeded' as const,
      acknowledged: true,
    }));
    const directory: JarvisDispatchRunDirectoryPort = {
      claimDispatchCoordinates: vi.fn(async () => ({
        status: 'claimed' as const,
        claimId: DIRECTORY_CLAIM_ID,
        pageSize: 1,
        hasMore: false,
        replayed: false,
        hardLeaseRemainingMs: 60_000,
        entries: [{ position: 1, coordinates: COORDINATES }],
      })),
      renewDispatchCoordinatesClaim,
      startDispatchCoordinate: vi.fn(async () => ({
        status: 'succeeded' as const,
        started: true,
      })),
      acknowledgeDispatchCoordinates,
    };
    const h = harness({ directory });
    vi.spyOn(h.repository, 'listPendingSignals').mockImplementation(
      async () => pendingSignals.promise,
    );

    const running = h.service.runForCompany(COMPANY_ID);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renewDispatchCoordinatesClaim).toHaveBeenCalledTimes(2);

    pendingSignals.resolve([]);
    await flushMicrotasks();
    heartbeatRenew.resolve({ status: 'succeeded', renewed: false });

    await expect(running).resolves.toMatchObject({ failures: 1 });
    expect(acknowledgeDispatchCoordinates).not.toHaveBeenCalled();
  });

  it('sérialise les heartbeats, les arrête avant ACK et ne laisse aucun timer', async () => {
    vi.useFakeTimers();
    const pendingSignals = deferred<readonly JarvisWorkItemPendingSignal[]>();
    const slowHeartbeat = deferred<{
      readonly status: 'succeeded';
      readonly renewed: boolean;
    }>();
    let renewCount = 0;
    const renew = vi.fn(() => {
      renewCount += 1;
      if (renewCount === 2) return slowHeartbeat.promise;
      return Promise.resolve({ status: 'succeeded' as const, renewed: true });
    });
    const directory = scriptedDispatchDirectory([claimedDirectoryPage([COORDINATES], {
      hardLeaseRemainingMs: 120_000,
    })]);
    directory.port.renewDispatchCoordinatesClaim = renew;
    const h = harness({ directory: directory.port });
    vi.spyOn(h.repository, 'listPendingSignals').mockImplementation(
      async () => pendingSignals.promise,
    );

    const running = h.service.runForCompany(COMPANY_ID);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renew).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(renew).toHaveBeenCalledTimes(2);
    slowHeartbeat.resolve({ status: 'succeeded', renewed: true });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renew).toHaveBeenCalledTimes(3);

    pendingSignals.resolve([]);
    await expect(running).resolves.toMatchObject({ failures: 0 });
    expect(directory.ack).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('le watchdog fige le résumé, interdit l’ACK et absorbe une fin tardive', async () => {
    vi.useFakeTimers();
    const pendingSignals = deferred<readonly JarvisWorkItemPendingSignal[]>();
    const directory = scriptedDispatchDirectory([claimedDirectoryPage([COORDINATES], {
      hardLeaseRemainingMs: 100,
    })]);
    const h = harness({ directory: directory.port });
    vi.spyOn(h.repository, 'listPendingSignals').mockImplementation(
      async () => pendingSignals.promise,
    );

    const running = h.service.runForCompany(COMPANY_ID);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);
    const summary = await running;
    const settledSnapshot = { ...summary };

    expect(summary.failures).toBe(1);
    expect(directory.ack).not.toHaveBeenCalled();
    pendingSignals.resolve([]);
    await flushMicrotasks();
    expect(summary).toEqual(settledSnapshot);
    expect(directory.ack).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('adosse un slot repris à la Promise locale existante sans lancer un second handler', async () => {
    vi.useFakeTimers();
    const pendingSignals = deferred<readonly JarvisWorkItemPendingSignal[]>();
    const directory = scriptedDispatchDirectory([
      claimedDirectoryPage([COORDINATES], {
        claimId: '66666666-6666-4666-8666-666666666671',
        hardLeaseRemainingMs: 100,
      }),
      claimedDirectoryPage([COORDINATES], {
        claimId: '66666666-6666-4666-8666-666666666672',
        hardLeaseRemainingMs: 60_000,
        replayed: true,
      }),
    ]);
    const h = harness({ directory: directory.port });
    const pendingSpy = vi.spyOn(h.repository, 'listPendingSignals').mockImplementation(
      async () => pendingSignals.promise,
    );

    const first = h.service.runForCompany(COMPANY_ID);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toMatchObject({ failures: 1 });
    expect(directory.ack).not.toHaveBeenCalled();

    await expect(h.service.runForCompany(COMPANY_ID)).resolves.toMatchObject({ failures: 0 });
    expect(directory.start).toHaveBeenCalledTimes(2);
    expect(pendingSpy).toHaveBeenCalledOnce();
    expect(directory.ack).toHaveBeenCalledOnce();

    pendingSignals.resolve([]);
    await flushMicrotasks();
    expect(pendingSpy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('borne la registry à 50 digests opaques puis libère exactement les Promises terminées', async () => {
    vi.useFakeTimers();
    const pendingSignals = deferred<readonly JarvisWorkItemPendingSignal[]>();
    const coordinates = Array.from({ length: 52 }, (_, index) => ({
      companyId: COMPANY_ID,
      ownerUserId: `usr-registry-${index.toString().padStart(2, '0')}`,
      runId: `cccccccc-cccc-4ccc-8ccc-${index.toString().padStart(12, '0')}`,
    }));
    const claims = coordinates.map((coordinate, index) => claimedDirectoryPage([coordinate], {
      claimId: `dddddddd-dddd-4ddd-8ddd-${index.toString().padStart(12, '0')}`,
      hardLeaseRemainingMs: index < 50 ? 100 : 60_000,
    }));
    const directory = scriptedDispatchDirectory(claims);
    const h = harness({ directory: directory.port });
    vi.spyOn(h.repository, 'listPendingSignals').mockImplementation(
      async () => pendingSignals.promise,
    );

    const firstWave = Array.from({ length: 50 }, () => h.service.runForCompany(COMPANY_ID));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(firstWave);

    const registry = (h.service as unknown as {
      readonly inFlightCoordinates: ReadonlyMap<string, unknown>;
    }).inFlightCoordinates;
    expect(registry.size).toBe(50);
    expect([...registry.keys()].every((key) => /^[0-9a-f]{64}$/u.test(key))).toBe(true);
    expect([...registry.keys()].some((key) => key.includes('usr-registry'))).toBe(false);

    await expect(h.service.runForCompany(COMPANY_ID)).resolves.toMatchObject({ failures: 1 });
    expect(directory.start).toHaveBeenCalledTimes(50);
    expect(directory.ack).not.toHaveBeenCalled();

    pendingSignals.resolve([]);
    for (let index = 0; index < 100; index += 1) await Promise.resolve();
    expect(registry.size).toBe(0);

    await expect(h.service.runForCompany(COMPANY_ID)).resolves.toMatchObject({ failures: 0 });
    expect(directory.start).toHaveBeenCalledTimes(51);
    expect(directory.ack).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('le shutdown coupe le contrôle, n’acquitte pas la page et ferme les ticks suivants', async () => {
    vi.useFakeTimers();
    const pendingSignals = deferred<readonly JarvisWorkItemPendingSignal[]>();
    const directory = scriptedDispatchDirectory([claimedDirectoryPage([COORDINATES], {
      hardLeaseRemainingMs: 60_000,
    })]);
    const h = harness({ directory: directory.port });
    vi.spyOn(h.repository, 'listPendingSignals').mockImplementation(
      async () => pendingSignals.promise,
    );

    const running = h.service.runForCompany(COMPANY_ID);
    await flushMicrotasks();
    const shuttingDown = h.service.onApplicationShutdown();
    await expect(running).resolves.toMatchObject({ failures: 0 });
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(directory.ack).not.toHaveBeenCalled();
    await expect(h.service.runAllCompanies()).resolves.toMatchObject({ skipped: 'shutdown' });

    pendingSignals.resolve([]);
    await flushMicrotasks();
    expect(directory.ack).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
