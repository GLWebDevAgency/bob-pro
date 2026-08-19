/**
 * Jarvis U1-c — LISTE FERMÉE de revalidation §3 et acquittement du signal (revues C20+C21).
 *
 * Complément de jarvis-work-item-dispatch.service.test.ts (qui prouve l'orchestration, les
 * fakes non complaisants C19 et les axes action_unknown / execute_window_expired /
 * confirmation_receipt_unverified / kill switch avant claim). ICI, les axes RESTANTS de la
 * liste fermée — chacun doit refuser SANS authorize, sans exécuteur, sans storeResult :
 *   (a) source d'autorisation non-`confirmation` (union fermée §5.3, FD-05) ;
 *   (b) principal divergent (`actingPrincipalId` ≠ owner du run, parité §15) ;
 *   (c) kill switch coupé ENTRE claim et revalidation ⇒ retry_due, JAMAIS un cancel ;
 *   (d) action FERMÉE au catalogue (voiceMode 'closed', le catalogue a bougé) ;
 *   (e) tenant clôturé (une société fermée n'exécute plus jamais un effet différé) ;
 *   (f) `executeBy` passé contre l'horloge BASE ⇒ cancel, jamais une exécution posthume ;
 *   (g) `targetDigest` divergent au recalcul ⇒ cancel ; recalcul en PANNE ⇒ retry.
 * Le motif exact de chaque cancel est ÉPINGLÉ par le digest no-effect (le motif y est
 * scellé) : inverser deux gardes rougit.
 *
 * Puis les branches d'acquittement de `signalStoredResult` (doctrine §5.3 : un résultat
 * persisté n'est acquitté que si son observation est ADMISE ou définitivement sans objet —
 * tout le reste reste en redelivery level-triggered, jamais un signal perdu) :
 * acquittés : admitted/replayed, command_conflict (déjà admis sous une autre révision),
 * run_not_found, refused run_terminal, run purgé (null). NON acquittés (redélivrés) :
 * refused non-terminal, stale_revision, quarantined, company_unavailable, action_refused,
 * foreground_unavailable — perdre un signal serait perdre l'issue d'un effet parti.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTION_CATALOG_V0,
  sha256Hex,
  type JarvisAdmissionResult,
  type JarvisAdmissionUnitOfWorkPort,
  type JarvisRunEnvelope,
  type JarvisSystemAdmissionEnvelope,
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
  jarvisEffectExecutorKey,
  type JarvisDispatchRunDirectoryPort,
  type JarvisEffectExecutor,
} from './jarvis-work-item-dispatch.service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = 'co_reval';
const OWNER_USER_ID = 'usr_reval';
const RUN_ID = '55555555-5555-4555-8555-555555555555';
const EFFECT_ID = '66666666-6666-4666-8666-666666666666';
const RECEIPT_ID = '77777777-7777-4777-8777-777777777777';
const LEASE_TOKEN = '88888888-8888-4888-8888-888888888888';
const READ_AT = '2026-08-19T10:00:00.000Z';

const COORDINATES: JarvisWorkItemCoordinates = {
  companyId: COMPANY_ID,
  ownerUserId: OWNER_USER_ID,
  runId: RUN_ID,
};

/** Action OUVERTE réelle du catalogue — la revalidation lit le vrai ACTION_CATALOG_V0. */
const OPEN_ACTION = (() => {
  const entry = ACTION_CATALOG_V0.find((candidate) => candidate.voiceMode !== 'closed');
  if (entry === undefined) {
    throw new Error('Fixture impossible : aucune action ouverte au catalogue.');
  }
  return entry;
})();

/** Action FERMÉE réelle du catalogue (axe d — le catalogue a bougé depuis la confirmation). */
const CLOSED_ACTION = (() => {
  const entry = ACTION_CATALOG_V0.find((candidate) => candidate.voiceMode === 'closed');
  if (entry === undefined) {
    throw new Error('Fixture impossible : aucune action fermée au catalogue.');
  }
  return entry;
})();

/** Le motif du cancel est SCELLÉ dans le digest no-effect : l'épingler prouve la garde. */
function noEffectDigestFor(reason: string): string {
  return sha256Hex(JSON.stringify(['bob.jarvis.dispatch.no-effect.v1', EFFECT_ID, reason]));
}

function leaseFixture(overrides: Partial<JarvisWorkItemLease> = {}): JarvisWorkItemLease {
  return {
    id: 'wi_reval',
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

function pendingFixture(resultDigest: string): JarvisWorkItemPendingSignal {
  return {
    id: 'wi_reval',
    effectId: EFFECT_ID,
    status: 'succeeded',
    resultDigest,
    leaseFence: 2n,
    updatedAt: READ_AT,
  };
}

// ---------------------------------------------------------------------------
// Fakes stricts (aucun PostgreSQL) — recorder d'appels partagé
// ---------------------------------------------------------------------------

class StrictFakeRepository implements JarvisWorkItemsDispatchRepository {
  leases: JarvisWorkItemLease[] = [];
  pending: JarvisWorkItemPendingSignal[] = [];
  /** Hook du harnais : s'exécute au moment du claim (ex. couper le kill switch). */
  onClaim: (() => void) | null = null;

  readonly authorizeInputs: AuthorizeJarvisWorkItemInput[] = [];
  readonly storeInputs: StoreJarvisWorkItemResultInput[] = [];
  readonly retryInputs: MarkJarvisWorkItemRetryDueInput[] = [];
  readonly cancelInputs: CancelUnauthorizedJarvisWorkItemInput[] = [];
  readonly signalAppliedInputs: MarkJarvisWorkItemSignalAppliedInput[] = [];

  constructor(private readonly calls: string[]) {}

  async claimDue(
    _coordinates: JarvisWorkItemCoordinates,
    _input: ClaimDueJarvisWorkItemsInput,
  ): Promise<readonly JarvisWorkItemLease[]> {
    this.calls.push('repo.claimDue');
    this.onClaim?.();
    const leases = this.leases;
    this.leases = [];
    return leases;
  }

  async reclaimExpiredAuthorized(
    _coordinates: JarvisWorkItemCoordinates,
    _input: ClaimDueJarvisWorkItemsInput,
  ): Promise<readonly JarvisWorkItemLease[]> {
    this.calls.push('repo.reclaimExpiredAuthorized');
    return [];
  }

  async authorize(
    _coordinates: JarvisWorkItemCoordinates,
    input: AuthorizeJarvisWorkItemInput,
  ): Promise<boolean> {
    this.calls.push('repo.authorize');
    this.authorizeInputs.push(input);
    return true;
  }

  async storeResult(
    _coordinates: JarvisWorkItemCoordinates,
    input: StoreJarvisWorkItemResultInput,
  ): Promise<boolean> {
    this.calls.push('repo.storeResult');
    this.storeInputs.push(input);
    return true;
  }

  async markRetryDue(
    _coordinates: JarvisWorkItemCoordinates,
    input: MarkJarvisWorkItemRetryDueInput,
  ): Promise<boolean> {
    this.calls.push('repo.markRetryDue');
    this.retryInputs.push(input);
    return true;
  }

  async cancelUnauthorized(
    _coordinates: JarvisWorkItemCoordinates,
    input: CancelUnauthorizedJarvisWorkItemInput,
  ): Promise<boolean> {
    this.calls.push('repo.cancelUnauthorized');
    this.cancelInputs.push(input);
    return true;
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
    return true;
  }
}

interface Harness {
  readonly service: JarvisWorkItemDispatchService;
  readonly repository: StrictFakeRepository;
  readonly admitted: JarvisSystemAdmissionEnvelope[];
  readonly calls: string[];
}

function harness(
  options: {
    run?: JarvisRunEnvelope | null;
    admissionResults?: JarvisAdmissionResult[];
    executors?: ReadonlyMap<string, JarvisEffectExecutor>;
    tenantClosed?: boolean;
  } = {},
): Harness {
  const calls: string[] = [];
  const repository = new StrictFakeRepository(calls);
  const run = options.run === undefined ? runFixture() : options.run;
  const scripted = [...(options.admissionResults ?? [])];
  const admitted: JarvisSystemAdmissionEnvelope[] = [];
  const admission: JarvisAdmissionUnitOfWorkPort = {
    async runJarvisAdmission() {
      throw new Error('inattendu : le worker ne soumet jamais de commande utilisateur');
    },
    async runJarvisSystemAdmission(envelope) {
      calls.push('admission.admit');
      admitted.push(envelope);
      const next = scripted.shift();
      if (next !== undefined) return next;
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
  const persistence = {
    companies: {
      findById: async () => ({ isClosed: () => options.tenantClosed === true }),
    },
    notificationJobs: {
      enqueue: async () => {
        throw new Error('inattendu : aucune I/O outbox dans ces preuves');
      },
    },
    runWithTenant: <T>(_companyId: string, fn: () => Promise<T>) => fn(),
  } as unknown as Persistence;
  const directory: JarvisDispatchRunDirectoryPort = {
    listDispatchCoordinates: async () => [COORDINATES],
  };
  const tenants = {
    listCompanyIds: async () => [COMPANY_ID],
  } as unknown as ScheduledTenantDirectory;
  const service = new JarvisWorkItemDispatchService(
    persistence,
    tenants,
    new AppLogger(),
    repository,
    directory,
    admission,
    options.executors ?? null,
  );
  return { service, repository, admitted, calls };
}

/** Toute garde de revalidation refuse AVANT le point de non-retour et AVANT toute I/O. */
function expectRefusedWithoutAuthorize(h: Harness): void {
  expect(h.calls).not.toContain('repo.authorize');
  expect(h.calls).not.toContain('executor.execute');
  expect(h.calls).not.toContain('repo.storeResult');
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
// C20 — les axes restants de la LISTE FERMÉE §3
// ---------------------------------------------------------------------------

describe('Revalidation §3 — liste fermée, axes restants (revue C20)', () => {
  it('source d’autorisation non-confirmation (union fermée, FD-05) ⇒ cancel sans authorize', async () => {
    const h = harness();
    h.repository.leases = [
      leaseFixture({
        // Source VALIDE de l'union fermée, mais pas `confirmation` : refus U1 (post-V1 = mandats).
        authorizationSource: {
          source: 'certified_system_rule',
          ruleId: 'rule-1',
          ruleVersion: 1,
          observationScope: 'scope-1',
        },
      }),
    ];

    const summary = await h.service.runAllCompanies();

    expectRefusedWithoutAuthorize(h);
    expect(h.repository.cancelInputs).toEqual([
      {
        id: 'wi_reval',
        expectedLeaseFence: 1n,
        noEffectResultDigest: noEffectDigestFor('authorization_source_not_confirmation'),
      },
    ]);
    expect(summary).toMatchObject({ cancelled: 1, executed: 0, failures: 0 });
  });

  it('principal divergent (parité §15 : l’effet s’exécute au nom de l’owner) ⇒ cancel sans authorize', async () => {
    const h = harness();
    h.repository.leases = [leaseFixture({ actingPrincipalId: 'usr_intrus' })];

    const summary = await h.service.runAllCompanies();

    expectRefusedWithoutAuthorize(h);
    expect(h.repository.cancelInputs).toEqual([
      {
        id: 'wi_reval',
        expectedLeaseFence: 1n,
        noEffectResultDigest: noEffectDigestFor('acting_principal_mismatch'),
      },
    ]);
    expect(summary).toMatchObject({ cancelled: 1, failures: 0 });
  });

  it('kill switch coupé ENTRE claim et revalidation ⇒ retry_due (opérationnel), JAMAIS un cancel', async () => {
    const h = harness();
    h.repository.leases = [leaseFixture()];
    // Le switch tombe pendant que la lease est en main : la ligne est rendue honnêtement.
    h.repository.onClaim = () => {
      process.env.BOB_JARVIS_DISPATCH_ENABLED = 'false';
    };

    const summary = await h.service.runAllCompanies();

    expectRefusedWithoutAuthorize(h);
    expect(h.calls).not.toContain('repo.cancelUnauthorized');
    expect(h.repository.retryInputs).toEqual([
      { id: 'wi_reval', leaseToken: LEASE_TOKEN, leaseFence: 1n, retryDelayMs: 60_000 },
    ]);
    expect(summary).toMatchObject({ retried: 1, cancelled: 0, failures: 0 });
  });

  it('action FERMÉE au catalogue (voiceMode closed — le catalogue a bougé) ⇒ cancel sans authorize', async () => {
    const h = harness();
    h.repository.leases = [
      leaseFixture({ actionId: CLOSED_ACTION.actionId, actionVersion: CLOSED_ACTION.version }),
    ];

    const summary = await h.service.runAllCompanies();

    expectRefusedWithoutAuthorize(h);
    expect(h.repository.cancelInputs).toEqual([
      {
        id: 'wi_reval',
        expectedLeaseFence: 1n,
        noEffectResultDigest: noEffectDigestFor('action_closed'),
      },
    ]);
    expect(summary).toMatchObject({ cancelled: 1, failures: 0 });
  });

  it('tenant clôturé ⇒ cancel sans authorize : une société fermée n’exécute plus JAMAIS un effet différé', async () => {
    const h = harness({ tenantClosed: true });
    h.repository.leases = [leaseFixture()];

    const summary = await h.service.runAllCompanies();

    expectRefusedWithoutAuthorize(h);
    expect(h.repository.cancelInputs).toEqual([
      {
        id: 'wi_reval',
        expectedLeaseFence: 1n,
        noEffectResultDigest: noEffectDigestFor('tenant_closed'),
      },
    ]);
    expect(summary).toMatchObject({ cancelled: 1, failures: 0 });
  });

  it('executeBy passé contre l’horloge BASE ⇒ cancel sans authorize, jamais une exécution posthume', async () => {
    const h = harness();
    h.repository.leases = [leaseFixture({ executeBy: '2026-08-19T09:59:59.000Z' })]; // < READ_AT

    const summary = await h.service.runAllCompanies();

    expectRefusedWithoutAuthorize(h);
    expect(h.repository.cancelInputs).toEqual([
      {
        id: 'wi_reval',
        expectedLeaseFence: 1n,
        noEffectResultDigest: noEffectDigestFor('execute_window_expired'),
      },
    ]);
    expect(summary).toMatchObject({ cancelled: 1, failures: 0 });
  });

  it('targetDigest divergent au recalcul ⇒ cancel sans authorize ni exécution', async () => {
    const calls: string[] = [];
    const executor: JarvisEffectExecutor = {
      execute: async () => {
        calls.push('executor.execute');
        throw new Error('inattendu : la cible a dérivé, rien ne doit s’exécuter');
      },
      recalculateTargetDigest: async () => sha256Hex('cible-recalculee-differente'),
    };
    const h = harness({
      executors: new Map([
        [jarvisEffectExecutorKey(OPEN_ACTION.actionId, OPEN_ACTION.version), executor],
      ]),
    });
    h.repository.leases = [leaseFixture({ targetDigest: sha256Hex('cible-originale') })];

    const summary = await h.service.runAllCompanies();

    expectRefusedWithoutAuthorize(h);
    expect(calls).not.toContain('executor.execute');
    expect(h.repository.cancelInputs).toEqual([
      {
        id: 'wi_reval',
        expectedLeaseFence: 1n,
        noEffectResultDigest: noEffectDigestFor('target_digest_drift'),
      },
    ]);
    expect(summary).toMatchObject({ cancelled: 1, failures: 0 });
  });

  it('recalcul du targetDigest en PANNE ⇒ retry_due (transitoire), jamais un cancel ni une exécution', async () => {
    const executor: JarvisEffectExecutor = {
      execute: async () => {
        throw new Error('inattendu : jamais d’exécution sans revalidation complète');
      },
      recalculateTargetDigest: async () => {
        throw new Error('lecture de la cible indisponible');
      },
    };
    const h = harness({
      executors: new Map([
        [jarvisEffectExecutorKey(OPEN_ACTION.actionId, OPEN_ACTION.version), executor],
      ]),
    });
    h.repository.leases = [leaseFixture({ targetDigest: sha256Hex('cible-originale') })];

    const summary = await h.service.runAllCompanies();

    expectRefusedWithoutAuthorize(h);
    expect(h.calls).not.toContain('repo.cancelUnauthorized');
    expect(h.repository.retryInputs).toEqual([
      { id: 'wi_reval', leaseToken: LEASE_TOKEN, leaseFence: 1n, retryDelayMs: 60_000 },
    ]);
    expect(summary).toMatchObject({ retried: 1, cancelled: 0, failures: 0 });
  });
});

// ---------------------------------------------------------------------------
// C21 — branches d'acquittement de signalStoredResult (doctrine §5.3)
// ---------------------------------------------------------------------------

describe('Acquittement du signal — un résultat n’est acquitté que si son observation est admise ou sans objet (revue C21)', () => {
  const RESULT_DIGEST = sha256Hex('resultat-acquittement');

  /** Statuts ACQUITTÉS : l'observation est admise ou définitivement sans objet. */
  const ACKNOWLEDGED: ReadonlyArray<{ label: string; result: JarvisAdmissionResult }> = [
    {
      label: 'replayed (même observation déjà reçue — zéro-write)',
      result: {
        status: 'replayed',
        postimage: runFixture(),
        eventSequence: 6,
        signalRestamped: true,
      },
    },
    {
      label: 'command_conflict (observation déjà admise sous une autre révision attendue)',
      result: { status: 'command_conflict' },
    },
    {
      label: 'run_not_found (le run n’existe plus pour l’admission)',
      result: { status: 'run_not_found' },
    },
    {
      label: 'refused run_terminal (signal tardif sur run terminal — no-op §5.1)',
      result: { status: 'refused', error: { code: 'run_terminal', status: 'completed' } },
    },
  ];

  for (const { label, result } of ACKNOWLEDGED) {
    it(`${label} ⇒ ACQUITTÉ : markSignalApplied fencé, la file pending se vide`, async () => {
      const h = harness({ admissionResults: [result] });
      h.repository.pending = [pendingFixture(RESULT_DIGEST)];

      const summary = await h.service.runAllCompanies();

      expect(h.repository.signalAppliedInputs).toEqual([
        { id: 'wi_reval', leaseFence: 2n, resultDigest: RESULT_DIGEST },
      ]);
      expect(summary).toMatchObject({ signalled: 1, failures: 0 });
    });
  }

  it('run PURGÉ par la rétention (lecture null) ⇒ acquitté SANS admission : signal sans objet', async () => {
    const h = harness({ run: null });
    h.repository.pending = [pendingFixture(RESULT_DIGEST)];

    const summary = await h.service.runAllCompanies();

    expect(h.calls).not.toContain('admission.admit');
    expect(h.repository.signalAppliedInputs).toEqual([
      { id: 'wi_reval', leaseFence: 2n, resultDigest: RESULT_DIGEST },
    ]);
    expect(summary).toMatchObject({ signalled: 1, failures: 0 });
  });

  /** Statuts NON acquittés : l'observation n'est PAS admise — le signal reste dû. */
  const REDELIVERED: ReadonlyArray<{ label: string; result: JarvisAdmissionResult }> = [
    {
      label: 'refused non-terminal (la définition a refusé l’observation)',
      result: { status: 'refused', error: { code: 'invalid_command', reason: 'kind_mismatch' } },
    },
    {
      label: 'stale_revision (commande interactive intercalée)',
      result: { status: 'stale_revision', actualRevision: 6 },
    },
    {
      label: 'quarantined (run gelé §5.5 — l’issue de l’effet ne doit pas se perdre)',
      result: { status: 'quarantined' },
    },
    {
      label: 'company_unavailable (l’admission n’a pas consigné l’observation)',
      result: { status: 'company_unavailable', reason: 'missing' },
    },
    {
      label: 'action_refused (aucun kill switch n’est opposé au signal — il reste dû)',
      result: { status: 'action_refused', reason: 'admission_kill_switch' },
    },
    {
      label: 'foreground_unavailable (contention transitoire de la transaction)',
      result: { status: 'foreground_unavailable', reason: 'lock_timeout' },
    },
  ];

  for (const { label, result } of REDELIVERED) {
    it(`${label} ⇒ NON acquitté : redelivery level-triggered au tick suivant`, async () => {
      const h = harness({ admissionResults: [result] });
      h.repository.pending = [pendingFixture(RESULT_DIGEST)];

      const tick1 = await h.service.runAllCompanies();
      expect(h.calls).toContain('admission.admit');
      expect(h.repository.signalAppliedInputs).toHaveLength(0);
      expect(tick1).toMatchObject({ signalled: 0 });

      // Le résultat est TOUJOURS pending : le tick suivant re-signale (jamais perdu),
      // et une admission redevenue possible acquitte enfin.
      const tick2 = await h.service.runAllCompanies();
      expect(h.repository.signalAppliedInputs).toEqual([
        { id: 'wi_reval', leaseFence: 2n, resultDigest: RESULT_DIGEST },
      ]);
      expect(tick2).toMatchObject({ signalled: 1 });
    });
  }
});
