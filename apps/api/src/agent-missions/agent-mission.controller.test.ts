import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { HTTP_CODE_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type {
  AgentMission,
  AgentMissionEvent,
  AgentMissionFingerprintPort,
  AgentMissionOwner,
  AgentMissionQuoteDraftSlot,
  AgentMissionReadExecution,
  AgentMissionReadTransaction,
  AgentMissionRealtimeAuthorityProof,
  AgentMissionTransaction,
  AgentMissionUnitOfWorkPort,
  AgentMissionWriteExecution,
} from '@bob/core';
import { describe, expect, it, vi } from 'vitest';
import { AppModule } from '../app.module';
import { AppLogger, requestContext } from '../observability/logger';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import { AgentMissionController } from './agent-mission.controller';
import {
  AGENT_MISSION_FINGERPRINTS,
} from './agent-mission-fingerprint.provider';
import {
  AGENT_MISSION_HTTP_AUTHORITY,
  DisabledAgentMissionHttpAuthority,
  agentMissionHttpAuthorityProvider,
  type AgentMissionHttpAuthorization,
  type AgentMissionHttpAuthority,
} from './agent-mission-http-authority';
import { AgentMissionModule } from './agent-mission.module';
import { AgentMissionService } from './agent-mission.service';

function serviceSpies() {
  return {
    getCurrent: vi.fn(async () => ({ ok: true as const, value: { mission: null } })),
    getCurrentV2: vi.fn(async () => ({
      ok: true as const,
      value: { mission: null, presentation: null },
    })),
    getCurrentResume: vi.fn(async () => ({
      ok: true as const,
      value: { mission: null },
    })),
    getCurrentResumeV2: vi.fn(async () => ({
      ok: true as const,
      value: { mission: null, presentation: null },
    })),
    start: vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: 'created',
        startOutcome: 'no_slot',
        mission: { id: '20000000-0000-4000-8000-000000000001' },
      },
    })),
    cancel: vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: 'cancelled',
        mission: { id: '20000000-0000-4000-8000-000000000001' },
      },
    })),
    acknowledgeScreen: vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: 'acknowledged',
        mission: { id: '20000000-0000-4000-8000-000000000001' },
      },
    })),
    decide: vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: 'selected',
        effect: { kind: 'selected' },
        mission: { id: '20000000-0000-4000-8000-000000000001' },
      },
    })),
    stageLines: vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: 'staged',
        stagedCount: 1,
        firstQueueOrdinal: 1,
        lastQueueOrdinal: 1,
        continuation: {
          outcome: 'choices_presented',
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          presentedChoiceCount: 2,
        },
        mission: { id: '20000000-0000-4000-8000-000000000001' },
      },
    })),
    decideCatalogueChoice: vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: 'selected',
        resolution: 'selected',
        invalidationReason: null,
        continuation: {
          outcome: 'deferred_to_m2a2',
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          presentedChoiceCount: 0,
        },
        mission: { id: '20000000-0000-4000-8000-000000000001' },
      },
    })),
  };
}

function controller(
  authority: AgentMissionHttpAuthority = new DisabledAgentMissionHttpAuthority(),
) {
  const spies = serviceSpies();
  return {
    spies,
    controller: new AgentMissionController(
      spies as unknown as AgentMissionService,
      authority,
    ),
  };
}

function statusResponse() {
  return { status: vi.fn() };
}

const DATABASE_NOW = '2026-07-26T12:00:00.000Z';
const REALTIME_SESSION_ID = '30000000-0000-4000-8000-000000000001';
const TEST_CAPABILITY = `bam1_${Buffer.alloc(32, 7).toString('base64url')}`;
const TEST_PROOF = Object.freeze({
  protocolVersion: 1,
  subjectHashCandidates: Object.freeze(['a'.repeat(64)]),
  principalBindingHash: 'b'.repeat(64),
  capabilityHash: 'c'.repeat(64),
}) satisfies AgentMissionRealtimeAuthorityProof;
const TEST_PROOF_V2 = Object.freeze({
  ...TEST_PROOF,
  protocolVersion: 2,
}) satisfies AgentMissionRealtimeAuthorityProof;
const QUOTE_LINE = Object.freeze({
  serviceReference: 'Main-d’œuvre plomberie',
  categoryHint: 'labor',
  quantityDecimal: '2',
  unitReference: 'heure',
  unitPriceDecimal: '55',
  currency: 'EUR',
  priceBasis: 'per_unit',
  vatRateHint: null,
});

function testAuthorization(
  operation: AgentMissionHttpAuthorization['operation'],
  proof: AgentMissionRealtimeAuthorityProof = TEST_PROOF,
): AgentMissionHttpAuthorization {
  return Object.freeze({
    operation,
    owner: Object.freeze({ companyId: 'company-1', ownerUserId: 'owner-1' }),
    proof,
  });
}

function testAuthority(
  proof: AgentMissionRealtimeAuthorityProof = TEST_PROOF,
): AgentMissionHttpAuthority {
  return {
    prepare: vi.fn((operation, capability) => (
      capability === TEST_CAPABILITY
        ? { ok: true as const, value: testAuthorization(operation, proof) }
        : {
            ok: false as const,
            error: {
              kind: 'forbidden' as const,
              reason: 'agent_mission_capability_invalid',
            },
          }
    )),
  };
}

class RecordingAgentMissionUnitOfWork implements AgentMissionUnitOfWorkPort {
  mission: AgentMission | null = null;
  readonly events: AgentMissionEvent[] = [];
  slot: AgentMissionQuoteDraftSlot | null = null;
  transactions = 0;

  async readQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    _authority: AgentMissionRealtimeAuthorityProof,
    work: (transaction: AgentMissionReadTransaction) => Promise<T>,
  ): Promise<AgentMissionReadExecution<T>> {
    const value = await work({
      databaseNow: async () => DATABASE_NOW,
      realtime: { realtimeSessionId: REALTIME_SESSION_ID, appliedContext: null },
      missions: {
        findActive: async () => this.ownedMission(owner, true),
        findForeground: async () => {
          const mission = this.ownedMission(owner, true);
          return mission === null ? null : { status: 'known' as const, mission };
        },
        findById: async ({ missionId }) => {
          const mission = this.ownedMission(owner, false);
          return mission?.id === missionId ? { status: 'known', mission } : null;
        },
      },
    });
    return { status: 'executed', value };
  }

  async runQuoteCreationOwner<T>(
    owner: AgentMissionOwner,
    _authority: AgentMissionRealtimeAuthorityProof,
    work: (transaction: AgentMissionTransaction) => Promise<T>,
  ): Promise<AgentMissionWriteExecution<T>> {
    this.transactions += 1;
    const value = await work({
      databaseNow: async () => DATABASE_NOW,
      realtime: { realtimeSessionId: REALTIME_SESSION_ID, appliedContext: null },
      missions: {
        findActive: async () => this.ownedMission(owner, true),
        findForeground: async () => {
          const mission = this.ownedMission(owner, true);
          return mission === null ? null : { status: 'known' as const, mission };
        },
        findById: async ({ missionId }) => {
          const mission = this.ownedMission(owner, false);
          return mission?.id === missionId ? { status: 'known', mission } : null;
        },
        findActiveForUpdate: async () => this.ownedMission(owner, true),
        findForegroundForUpdate: async () => {
          const mission = this.ownedMission(owner, true);
          return mission === null ? null : { status: 'known' as const, mission };
        },
        findByIdForUpdate: async ({ missionId }) => {
          const mission = this.ownedMission(owner, false);
          return mission?.id === missionId ? { status: 'known', mission } : null;
        },
        insert: async (mission) => {
          if (this.mission !== null) throw new Error('duplicate mission fixture');
          this.mission = mission;
          return 'inserted';
        },
        updateCas: async ({ mission, expectedRevision }) => {
          if (this.mission?.revision !== expectedRevision) return 'revision_conflict';
          this.mission = mission;
          return 'updated';
        },
      },
      events: {
        findByCommandId: async ({ commandId }) => {
          const event =
            this.events.find((candidate) => candidate.toSnapshot().commandId === commandId)
            ?? null;
          return event === null ? null : { status: 'known', event };
        },
        append: async (event) => {
          this.events.push(event);
        },
      },
      quoteDrafts: {
        getForUpdate: async () => this.slot,
        create: async ({ payload }) => {
          if (this.slot !== null) return null;
          this.slot = {
            ...owner,
            revision: 1,
            payloadVersion: 1,
            payload,
            agentMissionId: null,
            createdAt: DATABASE_NOW,
            updatedAt: DATABASE_NOW,
          };
          return this.slot;
        },
        claim: async ({
          missionId,
          expectedSlotRevision,
          expectedDraftSessionId,
        }) => {
          if (
            this.slot === null
            || this.slot.agentMissionId !== null
            || this.slot.revision !== expectedSlotRevision
            || this.slot.payload.draft.sessionId !== expectedDraftSessionId
          ) {
            return null;
          }
          this.slot = { ...this.slot, agentMissionId: missionId };
          return this.slot;
        },
        release: async ({ missionId }) => {
          if (this.slot?.agentMissionId !== missionId) return false;
          this.slot = { ...this.slot, agentMissionId: null };
          return true;
        },
        selectCustomerCas: async () => null,
        appendLineCas: async () => null,
      },
      quoteLineWork: {
        listForUpdate: async () => [],
        findByIdForUpdate: async () => null,
        insertMany: async () => 'inserted',
        updateCas: async () => 'revision_conflict',
        delete: async () => 'not_found',
        deleteAll: async () => 0,
      },
      quoteScreen: {
        observeForUpdate: async () => ({
          status: 'rejected',
          reason: 'unavailable',
        }),
      },
      customers: {
        search: async () => [],
        findById: async () => null,
        findByIds: async () => [],
      },
      catalogueCandidates: {
        search: async () => ({ candidates: [], truncated: false }),
        getById: async () => null,
      },
      quoteVatContext: {
        getForUpdate: async () => null,
      },
    });
    return { status: 'executed', value };
  }

  private ownedMission(owner: AgentMissionOwner, activeOnly: boolean): AgentMission | null {
    if (this.mission === null) return null;
    const snapshot = this.mission.toSnapshot();
    if (
      snapshot.companyId !== owner.companyId
      || snapshot.ownerUserId !== owner.ownerUserId
      || (activeOnly && snapshot.status !== 'active')
    ) {
      return null;
    }
    return this.mission;
  }
}

const TEST_FINGERPRINTS: AgentMissionFingerprintPort = {
  sign(canonicalRequest) {
    return {
      keyVersion: 1,
      hmac: createHash('sha256').update(canonicalRequest).digest('hex'),
    };
  },
  matches(canonicalRequest, fingerprint) {
    if (fingerprint.keyVersion !== 1) return null;
    return fingerprint.hmac === createHash('sha256').update(canonicalRequest).digest('hex');
  },
};

describe('AgentMissionController M1-A', () => {
  it('conserve le GET capability V1 exact et exige la projection pour V2', async () => {
    const v1 = controller(testAuthority());
    await expect(v1.controller.getCurrent(TEST_CAPABILITY)).resolves.toEqual({
      mission: null,
    });
    expect(v1.spies.getCurrent).toHaveBeenCalledOnce();
    expect(v1.spies.getCurrentV2).not.toHaveBeenCalled();

    const v2 = controller(testAuthority(TEST_PROOF_V2));
    await expect(v2.controller.getCurrent(TEST_CAPABILITY)).resolves.toEqual({
      mission: null,
      presentation: null,
    });
    expect(v2.spies.getCurrentV2).toHaveBeenCalledOnce();
    expect(v2.spies.getCurrent).not.toHaveBeenCalled();
  });

  it('expose la reprise JWT sans authority capability et rejette toute query', async () => {
    const authority = testAuthority();
    const { controller: candidate, spies } = controller(authority);

    await expect(candidate.getCurrentResume({}, undefined)).resolves.toEqual({
      mission: null,
    });
    expect(spies.getCurrentResume).toHaveBeenCalledOnce();
    expect(spies.getCurrentResumeV2).not.toHaveBeenCalled();
    expect(authority.prepare).not.toHaveBeenCalled();

    const invalid = await candidate.getCurrentResume({
      ownerUserId: 'forged-owner',
    }, undefined).catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(HttpException);
    expect((invalid as HttpException).getStatus()).toBe(422);
    expect(spies.getCurrentResume).toHaveBeenCalledOnce();
    expect(spies.getCurrentResumeV2).not.toHaveBeenCalled();
  });

  it('négocie la reprise V2 explicitement sans fallback silencieux', async () => {
    const authority = testAuthority();
    const { controller: candidate, spies } = controller(authority);

    await expect(candidate.getCurrentResume({}, '2')).resolves.toEqual({
      mission: null,
      presentation: null,
    });
    expect(spies.getCurrentResumeV2).toHaveBeenCalledOnce();
    expect(spies.getCurrentResume).not.toHaveBeenCalled();
    expect(authority.prepare).not.toHaveBeenCalled();

    for (const unsupported of ['', '1', '3', ' 2 ']) {
      const invalid = await candidate.getCurrentResume(
        {},
        unsupported,
      ).catch((error: unknown) => error);
      expect(invalid).toBeInstanceOf(HttpException);
      expect((invalid as HttpException).getStatus()).toBe(422);
    }
    expect(spies.getCurrentResumeV2).toHaveBeenCalledOnce();
    expect(spies.getCurrentResume).not.toHaveBeenCalled();
  });

  it('fixe la baseline idempotente à 200 avant le statut dynamique 201 de la création', () => {
    expect(Reflect.getMetadata(
      HTTP_CODE_METADATA,
      AgentMissionController.prototype.start,
    )).toBe(200);
    expect(Reflect.getMetadata(
      HTTP_CODE_METADATA,
      AgentMissionController.prototype.cancel,
    )).toBe(200);
    expect(Reflect.getMetadata(
      HTTP_CODE_METADATA,
      AgentMissionController.prototype.decide,
    )).toBe(200);
    expect(Reflect.getMetadata(
      HTTP_CODE_METADATA,
      AgentMissionController.prototype.stageLines,
    )).toBe(200);
    expect(Reflect.getMetadata(
      HTTP_CODE_METADATA,
      AgentMissionController.prototype.decideCatalogueChoice,
    )).toBe(200);
  });

  it.each([
    ['get', (candidate: AgentMissionController) => candidate.getCurrent(undefined)],
    ['start', (candidate: AgentMissionController) => candidate.start(
      { forged: true },
      statusResponse(),
      undefined,
    )],
    ['cancel', (candidate: AgentMissionController) => candidate.cancel(
      'not-a-uuid',
      null,
      undefined,
    )],
    ['screen ACK', (candidate: AgentMissionController) => candidate.acknowledgeScreen(
      'not-a-uuid',
      null,
      undefined,
    )],
    ['decision', (candidate: AgentMissionController) => candidate.decide(
      'not-a-uuid',
      null,
      undefined,
    )],
    ['line staging', (candidate: AgentMissionController) => candidate.stageLines(
      'not-a-uuid',
      null,
      undefined,
    )],
    ['catalogue choice', (candidate: AgentMissionController) => (
      candidate.decideCatalogueChoice('not-a-uuid', null, undefined)
    )],
  ] as const)(
    'l’autorité production refuse %s avant validation métier et appel de service',
    async (_operation, invoke) => {
      const { controller: candidate, spies } = controller();

      const caught = await invoke(candidate).catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(503);
      expect((caught as HttpException).getResponse()).toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'agent_mission_http_capability' },
      });
      expect(spies.getCurrent).not.toHaveBeenCalled();
      expect(spies.start).not.toHaveBeenCalled();
      expect(spies.cancel).not.toHaveBeenCalled();
      expect(spies.acknowledgeScreen).not.toHaveBeenCalled();
      expect(spies.decide).not.toHaveBeenCalled();
      expect(spies.stageLines).not.toHaveBeenCalled();
      expect(spies.decideCatalogueChoice).not.toHaveBeenCalled();
    },
  );

  it('mappe les deux décisions HTTP exactes sans accepter identité ni acteur forgés', async () => {
    const { controller: candidate, spies } = controller(testAuthority());
    const common = {
      commandId: '10000000-0000-4000-8000-000000000010',
      expectedMissionRevision: 3,
      expectedDraftSessionId: 'quote-draft-session-1',
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
    };
    const missionId = '20000000-0000-4000-8000-000000000001';

    await candidate.decide(missionId, {
      action: 'choose_presented_option',
      ...common,
      decisionId: '30000000-0000-4000-8000-000000000001',
      choiceSetRevision: 3,
      choiceId: '40000000-0000-4000-8000-000000000001',
    }, TEST_CAPABILITY);
    await candidate.decide(missionId, {
      action: 'select_screen_customer',
      ...common,
      commandId: '10000000-0000-4000-8000-000000000011',
      customerId: 'customer-camping',
    }, TEST_CAPABILITY);

    expect(spies.decide).toHaveBeenNthCalledWith(1, {
      authorization: testAuthorization('decide_quote_creation'),
      missionId,
      ...common,
      decision: {
        action: 'choose_presented_option',
        decisionId: '30000000-0000-4000-8000-000000000001',
        choiceSetRevision: 3,
        choiceId: '40000000-0000-4000-8000-000000000001',
      },
    });
    expect(spies.decide).toHaveBeenNthCalledWith(2, {
      authorization: testAuthorization('decide_quote_creation'),
      missionId,
      ...common,
      commandId: '10000000-0000-4000-8000-000000000011',
      decision: {
        action: 'select_screen_customer',
        customerId: 'customer-camping',
      },
    });
  });

  it.each([
    ['action inconnue', { action: 'pick_customer' }],
    ['champ acteur forgé', {
      action: 'select_screen_customer',
      customerId: 'customer-camping',
      actor: 'user_voice',
    }],
    ['champs croisés', {
      action: 'choose_presented_option',
      decisionId: '30000000-0000-4000-8000-000000000001',
      choiceSetRevision: 3,
      choiceId: '40000000-0000-4000-8000-000000000001',
      customerId: 'customer-forged',
    }],
  ])('rejette une décision avec %s avant le service', async (_label, specific) => {
    const { controller: candidate, spies } = controller(testAuthority());
    const result = await candidate.decide(
      '20000000-0000-4000-8000-000000000001',
      {
        commandId: '10000000-0000-4000-8000-000000000010',
        expectedMissionRevision: 3,
        expectedDraftSessionId: 'quote-draft-session-1',
        expectedDraftSlotRevision: 1,
        expectedDraftContentRevision: 0,
        ...specific,
      },
      TEST_CAPABILITY,
    ).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(HttpException);
    expect((result as HttpException).getStatus()).toBe(422);
    expect(spies.decide).not.toHaveBeenCalled();
  });

  it('mappe le staging et le même choiceId catalogue sans accepter de donnée forgée', async () => {
    const authority = testAuthority();
    const { controller: candidate, spies } = controller(authority);
    const missionId = '20000000-0000-4000-8000-000000000001';
    const common = {
      expectedMissionRevision: 4,
      expectedDraftSessionId: 'quote-draft-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
    };

    await candidate.stageLines(missionId, {
      ...common,
      commandId: '10000000-0000-4000-8000-000000000020',
      lines: [QUOTE_LINE],
    }, TEST_CAPABILITY);
    await candidate.decideCatalogueChoice(missionId, {
      ...common,
      commandId: '10000000-0000-4000-8000-000000000021',
      expectedMissionRevision: 5,
      decisionId: '30000000-0000-4000-8000-000000000001',
      choiceSetRevision: 5,
      pendingLineId: '60000000-0000-4000-8000-000000000001',
      expectedWorkRevision: 2,
      choiceId: '40000000-0000-4000-8000-000000000001',
      additionalLines: [],
    }, TEST_CAPABILITY);

    expect(spies.stageLines).toHaveBeenCalledWith({
      authorization: testAuthorization('stage_quote_lines'),
      missionId,
      ...common,
      commandId: '10000000-0000-4000-8000-000000000020',
      lines: [QUOTE_LINE],
    });
    expect(spies.decideCatalogueChoice).toHaveBeenCalledWith({
      authorization: testAuthorization('decide_catalogue_choice'),
      missionId,
      ...common,
      expectedMissionRevision: 5,
      commandId: '10000000-0000-4000-8000-000000000021',
      decisionId: '30000000-0000-4000-8000-000000000001',
      choiceSetRevision: 5,
      pendingLineId: '60000000-0000-4000-8000-000000000001',
      expectedWorkRevision: 2,
      choiceId: '40000000-0000-4000-8000-000000000001',
      additionalLines: [],
    });
    expect(authority.prepare).toHaveBeenNthCalledWith(
      1,
      'stage_quote_lines',
      TEST_CAPABILITY,
    );
    expect(authority.prepare).toHaveBeenNthCalledWith(
      2,
      'decide_catalogue_choice',
      TEST_CAPABILITY,
    );

    const forged = await candidate.stageLines(missionId, {
      ...common,
      commandId: '10000000-0000-4000-8000-000000000022',
      lines: [{ ...QUOTE_LINE, catalogueItemId: 'forged-catalogue-id' }],
    }, TEST_CAPABILITY).catch((error: unknown) => error);
    expect(forged).toBeInstanceOf(HttpException);
    expect((forged as HttpException).getStatus()).toBe(422);
    expect(spies.stageLines).toHaveBeenCalledOnce();
  });

  it('une autorité de test explicite ouvre le contrat exact, jamais un champ forgé', async () => {
    const authority = testAuthority();
    const { controller: candidate, spies } = controller(authority);

    const invalid = await candidate.start(
      {
        commandId: '10000000-0000-4000-8000-000000000001',
        companyId: 'forged',
      },
      statusResponse(),
      TEST_CAPABILITY,
    ).catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(HttpException);
    expect((invalid as HttpException).getStatus()).toBe(422);
    expect(spies.start).not.toHaveBeenCalled();

    const response = statusResponse();
    await expect(candidate.start(
      { commandId: '10000000-0000-4000-8000-000000000001' },
      response,
      TEST_CAPABILITY,
    )).resolves.toMatchObject({
      outcome: 'created',
      startOutcome: 'no_slot',
    });
    expect(response.status).toHaveBeenCalledWith(201);
    expect(spies.start).toHaveBeenCalledWith({
      authorization: testAuthorization('start_quote_creation'),
      commandId: '10000000-0000-4000-8000-000000000001',
    });
  });

  it('AppModule importe la tranche verticale et celle-ci déclare ses vrais providers', async () => {
    const appImports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[];
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      AgentMissionModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      AgentMissionModule,
    ) as unknown[];

    expect(appImports).toContain(AgentMissionModule);
    expect(controllers).toEqual([AgentMissionController]);
    expect(providers).toContain(AgentMissionService);
    expect(providers).toContain(agentMissionHttpAuthorityProvider);
    expect(agentMissionHttpAuthorityProvider).toMatchObject({
      provide: AGENT_MISSION_HTTP_AUTHORITY,
      inject: expect.any(Array),
    });
    expect(typeof (agentMissionHttpAuthorityProvider as { useFactory?: unknown }).useFactory)
      .toBe('function');
    expect(new DisabledAgentMissionHttpAuthority().prepare(
      'start_quote_creation',
      TEST_CAPABILITY,
    )).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'agent_mission_http_capability' },
    });
  });

  it('compile la DI runtime et traverse controller → service → use case → UoW réel de test', async () => {
    const unitOfWork = new RecordingAgentMissionUnitOfWork();
    const persistence = {
      createAgentMissionUnitOfWork: vi.fn(() => unitOfWork),
    } as unknown as Persistence;
    const logger = { audit: vi.fn() };
    const authority = testAuthority();
    const moduleRef = await Test.createTestingModule({
      imports: [AgentMissionModule],
    })
      .overrideProvider(PERSISTENCE)
      .useValue(persistence)
      .overrideProvider(AppLogger)
      .useValue(logger)
      .overrideProvider(AGENT_MISSION_HTTP_AUTHORITY)
      .useValue(authority)
      .overrideProvider(AGENT_MISSION_FINGERPRINTS)
      .useValue(TEST_FINGERPRINTS)
      .compile();

    try {
      const candidate = moduleRef.get(AgentMissionController);
      const startCommand = '10000000-0000-4000-8000-000000000001';
      const joinCommand = '10000000-0000-4000-8000-000000000002';
      const cancelCommand = '10000000-0000-4000-8000-000000000003';
      const outputs = await requestContext.run(
        {
          correlationId: 'agent-mission-module-composition',
          principal: { userId: 'owner-1', companyId: 'company-1' },
        },
        async () => {
          const createdResponse = statusResponse();
          const replayResponse = statusResponse();
          const joinResponse = statusResponse();
          const created = await candidate.start(
            { commandId: startCommand },
            createdResponse,
            TEST_CAPABILITY,
          );
          const replayed = await candidate.start(
            { commandId: startCommand },
            replayResponse,
            TEST_CAPABILITY,
          );
          const joined = await candidate.start(
            { commandId: joinCommand },
            joinResponse,
            TEST_CAPABILITY,
          );
          const cancelled = await candidate.cancel(created.mission.id, {
            commandId: cancelCommand,
            expectedMissionRevision: joined.mission.revision,
          }, TEST_CAPABILITY);
          return {
            created,
            replayed,
            joined,
            cancelled,
            statuses: {
              created: createdResponse.status,
              replayed: replayResponse.status,
              joined: joinResponse.status,
            },
          };
        },
      );

      expect(outputs.created).toMatchObject({ outcome: 'created', startOutcome: 'no_slot' });
      expect(outputs.replayed).toMatchObject({ outcome: 'replayed' });
      expect(outputs.joined).toMatchObject({ outcome: 'joined_active' });
      expect(outputs.cancelled).toMatchObject({
        outcome: 'cancelled',
        mission: { status: 'cancelled', actionable: false },
      });
      expect(outputs.statuses.created).toHaveBeenCalledWith(201);
      expect(outputs.statuses.replayed).toHaveBeenCalledWith(200);
      expect(outputs.statuses.joined).toHaveBeenCalledWith(200);
      expect(unitOfWork.slot?.agentMissionId).toBeNull();
      expect(unitOfWork.events.map((event) => event.toSnapshot().eventType)).toEqual([
        'mission_started',
        'mission_joined',
        'mission_cancelled',
      ]);
      expect(logger.audit).toHaveBeenCalledTimes(2);
      expect(logger.audit).toHaveBeenNthCalledWith(
        1,
        'agent_mission.started',
        expect.objectContaining({ outcome: 'created' }),
      );
      expect(logger.audit).toHaveBeenNthCalledWith(
        2,
        'agent_mission.cancelled',
        expect.objectContaining({ outcome: 'cancelled' }),
      );
      const auditCalls = logger.audit.mock.calls as Array<
        [string, Record<string, unknown>]
      >;
      const serializedAudit = JSON.stringify(auditCalls);
      expect(serializedAudit).not.toContain('company-1');
      expect(serializedAudit).not.toContain('owner-1');
      expect(serializedAudit).not.toContain(outputs.created.mission.id);
      for (const [, fields] of auditCalls) {
        expect(fields).not.toHaveProperty('companyId');
        expect(fields).not.toHaveProperty('ownerUserId');
        expect(fields).not.toHaveProperty('missionId');
        expect(fields.tenantRef).toMatch(/^amr1_1_[a-f0-9]{64}$/u);
        expect(fields.ownerRef).toMatch(/^amr1_1_[a-f0-9]{64}$/u);
        expect(fields.missionRef).toMatch(/^amr1_1_[a-f0-9]{64}$/u);
        expect(new Set([fields.tenantRef, fields.ownerRef, fields.missionRef]).size).toBe(3);
      }
      expect(persistence.createAgentMissionUnitOfWork).toHaveBeenCalledTimes(4);
    } finally {
      await moduleRef.close();
    }
  });

  it('compile les providers production et refuse avant toute création d’UoW', async () => {
    const persistence = {
      createAgentMissionUnitOfWork: vi.fn(),
    } as unknown as Persistence;
    const moduleRef = await Test.createTestingModule({
      imports: [AgentMissionModule],
    })
      .overrideProvider(PERSISTENCE)
      .useValue(persistence)
      .overrideProvider(AppLogger)
      .useValue({ audit: vi.fn() })
      .compile();

    try {
      const candidate = moduleRef.get(AgentMissionController);
      const caught = await requestContext.run(
        {
          correlationId: 'agent-mission-production-authority',
          principal: { userId: 'owner-1', companyId: 'company-1' },
        },
        () => candidate.start(
          { commandId: 'not-even-validated' },
          statusResponse(),
          TEST_CAPABILITY,
        )
          .catch((error: unknown) => error),
      );
      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(503);
      expect(persistence.createAgentMissionUnitOfWork).not.toHaveBeenCalled();
    } finally {
      await moduleRef.close();
    }
  });
});
