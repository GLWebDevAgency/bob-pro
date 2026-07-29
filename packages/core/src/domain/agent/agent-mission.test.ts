import { describe, expect, it } from 'vitest';
import {
  AGENT_MISSION_HARD_TTL_MS,
  AGENT_MISSION_IDLE_TTL_MS,
  AGENT_MISSION_INT4_MAX,
  AGENT_MISSION_MAX_PAYLOAD_BYTES,
  AGENT_MISSION_RETENTION_MS,
  AgentMission,
  computeQuoteMissionChoiceSetHash,
  type AgentMissionResult,
  type AgentMissionTransition,
  type QuoteMissionDraftReferenceV1,
  type QuoteMissionStagedCustomerResolutionV1,
} from './agent-mission';

const MISSION_ID = '00000000-0000-4000-8000-000000000001';
const REALTIME_ID = '00000000-0000-4000-8000-000000000002';
const DECISION_1 = '00000000-0000-4000-8000-000000000003';
const DECISION_2 = '00000000-0000-4000-8000-000000000004';
const CHOICE_1 = '00000000-0000-4000-8000-000000000005';
const CHOICE_2 = '00000000-0000-4000-8000-000000000006';
const CHOICE_3 = '00000000-0000-4000-8000-000000000007';
const CHOICE_4 = '00000000-0000-4000-8000-000000000008';
const CHOICE_5 = '00000000-0000-4000-8000-000000000009';
const CHOICE_6 = '00000000-0000-4000-8000-00000000000a';
const CREATED_AT = '2026-07-22T10:00:00.000Z';
const DIGEST = 'a'.repeat(64);

const draft = (
  sessionId = 'quote-session-1',
  slotRevision = 1,
  contentRevision = 0,
): QuoteMissionDraftReferenceV1 => ({ sessionId, slotRevision, contentRevision });

function at(minutes: number): string {
  return new Date(Date.parse(CREATED_AT) + minutes * 60_000).toISOString();
}

function value<T>(result: AgentMissionResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function noSlotMission(): AgentMission {
  return value(AgentMission.start({
    id: MISSION_ID,
    companyId: 'company-1',
    ownerUserId: 'owner-1',
    createdAt: CREATED_AT,
    stagedCustomerResolution: null,
    startOutcome: 'no_slot',
    draft: draft(),
  })).mission;
}

function conflictMission(): AgentMission {
  return value(AgentMission.start({
    id: MISSION_ID,
    companyId: 'company-1',
    ownerUserId: 'owner-1',
    createdAt: CREATED_AT,
    stagedCustomerResolution: null,
    startOutcome: 'draft_conflict',
    existingDraft: draft('existing-session', 7, 3),
    decision: {
      decisionId: DECISION_1,
      resumeChoiceId: CHOICE_1,
      requestDiscardChoiceId: CHOICE_2,
    },
  })).mission;
}

function binding(acknowledgedAt = at(1)) {
  return {
    realtimeSessionId: REALTIME_ID,
    contextRevision: 3,
    contextDigest: DIGEST,
    screenName: '/devis/new' as const,
    screenInstanceId: 'quote-screen-1',
    acknowledgedAt,
  };
}

function awaitingCustomer(): AgentMission {
  return value(noSlotMission().acknowledgeQuoteScreen({
    expectedRevision: 1,
    binding: binding(),
    observedDraft: draft(),
    draftHasCustomer: false,
    occurredAt: at(1),
  })).mission;
}

function awaitingCustomerWithStaged(
  stagedCustomerResolution: QuoteMissionStagedCustomerResolutionV1,
): AgentMission {
  const started = value(AgentMission.start({
    id: MISSION_ID,
    companyId: 'company-1',
    ownerUserId: 'owner-1',
    createdAt: CREATED_AT,
    stagedCustomerResolution,
    startOutcome: 'no_slot',
    draft: draft(),
  })).mission;
  return value(started.acknowledgeQuoteScreen({
    expectedRevision: 1,
    binding: binding(),
    observedDraft: draft(),
    draftHasCustomer: false,
    occurredAt: at(1),
  })).mission;
}

function stagedChoices(): Extract<
  QuoteMissionStagedCustomerResolutionV1,
  { readonly kind: 'choices' }
> {
  return {
    kind: 'choices',
    decisionId: DECISION_1,
    candidates: [
      { choiceId: CHOICE_1, customerId: 'customer-a' },
      { choiceId: CHOICE_2, customerId: 'customer-b' },
      { choiceId: CHOICE_3, customerId: 'customer-c' },
    ],
  };
}

function awaitingChoice(): AgentMission {
  return value(awaitingCustomer().presentCustomerChoices({
    expectedRevision: 2,
    decisionId: DECISION_1,
    candidates: [
      { choiceId: CHOICE_1, customerId: 'customer-a' },
      { choiceId: CHOICE_2, customerId: 'customer-b' },
    ],
    occurredAt: at(2),
  })).mission;
}

function expectTransition(
  transition: AgentMissionTransition,
  before: number,
  after: number,
  eventType: AgentMissionTransition['event']['eventType'],
): void {
  expect(transition.mission.revision).toBe(after);
  expect(transition.event).toMatchObject({
    eventType,
    missionRevisionBefore: before,
    missionRevisionAfter: after,
  });
  expect(Object.isFrozen(transition.event)).toBe(true);
  expect(Object.isFrozen(transition.event.data)).toBe(true);
}

describe('AgentMission — création et enveloppe M1', () => {
  it.each(['no_slot', 'empty_slot_adopted'] as const)(
    'démarre %s à la révision 1 avec un brouillon lié et les TTL V1 exacts',
    (startOutcome) => {
      const transition = value(AgentMission.start({
        id: MISSION_ID,
        companyId: 'company-1',
        ownerUserId: 'owner-1',
        createdAt: CREATED_AT,
        stagedCustomerResolution: null,
        startOutcome,
        draft: draft(),
      }));

      expectTransition(transition, 0, 1, 'mission_started');
      expect(transition.event.data).toEqual({ kind: 'mission_started', startOutcome });
      expect(transition.mission.toSnapshot()).toMatchObject({
        id: MISSION_ID,
        companyId: 'company-1',
        ownerUserId: 'owner-1',
        kind: 'quote_creation',
        status: 'active',
        phase: 'awaiting_quote_screen',
        revision: 1,
        payloadVersion: 1,
        payload: {
          schema: 'bob.agent-mission.quote-creation',
          version: 1,
          draft: draft(),
          decision: null,
        },
        currentBinding: null,
        idleExpiresAt: new Date(Date.parse(CREATED_AT) + AGENT_MISSION_IDLE_TTL_MS).toISOString(),
        hardExpiresAt: new Date(Date.parse(CREATED_AT) + AGENT_MISSION_HARD_TTL_MS).toISOString(),
        retentionExpiresAt: new Date(
          Date.parse(CREATED_AT) + AGENT_MISSION_HARD_TTL_MS + AGENT_MISSION_RETENTION_MS,
        ).toISOString(),
        terminalAt: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      });
    },
  );

  it('démarre un conflit sans adopter le brouillon et scelle les deux choix', () => {
    const mission = conflictMission();
    const snapshot = mission.toSnapshot();

    expect(snapshot.phase).toBe('awaiting_draft_decision');
    expect(snapshot.payload.draft).toBeNull();
    expect(snapshot.payload.decision).toMatchObject({
      kind: 'existing_draft',
      decisionId: DECISION_1,
      choiceSetRevision: 1,
      expectedDraftSessionId: 'existing-session',
      expectedDraftSlotRevision: 7,
      expectedDraftContentRevision: 3,
      choices: [
        { choiceId: CHOICE_1, action: 'resume_existing' },
        { choiceId: CHOICE_2, action: 'request_discard' },
      ],
    });
    expect(snapshot.payload.decision?.choiceSetHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('reste profondément immutable face aux références données et rendues', () => {
    const sourceDraft = draft();
    const transition = value(AgentMission.start({
      id: MISSION_ID,
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      createdAt: CREATED_AT,
      stagedCustomerResolution: null,
      startOutcome: 'no_slot',
      draft: sourceDraft,
    }));
    (sourceDraft as { sessionId: string }).sessionId = 'mutated-source';

    const snapshot = transition.mission.toSnapshot();
    expect(snapshot.payload.draft?.sessionId).toBe('quote-session-1');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(transition.mission)).toBe(true);
    expect(Object.isFrozen(snapshot.payload)).toBe(true);
    expect(Object.isFrozen(snapshot.payload.draft)).toBe(true);
    expect(() => {
      (snapshot.payload.draft as { sessionId: string }).sessionId = 'mutated-output';
    }).toThrow();
    expect(transition.mission.payload.draft?.sessionId).toBe('quote-session-1');
  });

  it('intègre atomiquement une résolution initiale et la fige profondément', () => {
    const resolution = stagedChoices();
    const transition = value(AgentMission.start({
      id: MISSION_ID,
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      createdAt: CREATED_AT,
      stagedCustomerResolution: resolution,
      startOutcome: 'no_slot',
      draft: draft(),
    }));
    (resolution.candidates as unknown as { customerId: string }[])[0]!.customerId = 'mutated-source';

    const staged = transition.mission.payload.stagedCustomerResolution;
    expect(staged).toEqual(stagedChoices());
    expect(staged?.kind).toBe('choices');
    expect(Object.isFrozen(staged)).toBe(true);
    if (staged?.kind === 'choices') {
      expect(Object.isFrozen(staged.candidates)).toBe(true);
      expect(Object.isFrozen(staged.candidates[0])).toBe(true);
      expect(() => {
        (staged.candidates[0] as { customerId: string }).customerId = 'mutated-output';
      }).toThrow();
    }
    expect(transition.event.data).toEqual({
      kind: 'mission_started',
      startOutcome: 'no_slot',
    });
  });

  it('rejette au start une résolution staged ouverte, dupliquée ou trop large', () => {
    const base = {
      id: MISSION_ID,
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      createdAt: CREATED_AT,
      startOutcome: 'no_slot' as const,
      draft: draft(),
    };
    expect(AgentMission.start({
      ...base,
      stagedCustomerResolution: {
        kind: 'exact',
        customerId: 'customer-a',
        label: 'halluciné',
      } as never,
    })).toMatchObject({
      ok: false,
      error: { field: 'payload.stagedCustomerResolution', reason: 'invalid_shape' },
    });
    expect(AgentMission.start({
      ...base,
      stagedCustomerResolution: {
        kind: 'choices',
        decisionId: DECISION_1,
        candidates: [
          { choiceId: CHOICE_1, customerId: 'customer-a' },
          { choiceId: CHOICE_2, customerId: 'customer-a' },
        ],
      },
    })).toMatchObject({
      ok: false,
      error: {
        field: 'payload.stagedCustomerResolution.candidates[1]',
        reason: 'invalid_value',
      },
    });
    expect(AgentMission.start({
      ...base,
      stagedCustomerResolution: {
        kind: 'choices',
        decisionId: DECISION_1,
        candidates: [CHOICE_1, CHOICE_2, CHOICE_3, CHOICE_4, CHOICE_5, CHOICE_6].map(
          (choiceId, index) => ({ choiceId, customerId: `customer-${index}` }),
        ),
      },
    })).toMatchObject({
      ok: false,
      error: {
        field: 'payload.stagedCustomerResolution.candidates',
        reason: 'invalid_value',
      },
    });
  });

  it.each([
    ['id', { id: 'NOT-A-UUID' }],
    ['companyId', { companyId: ' company-1' }],
    ['ownerUserId', { ownerUserId: `owner-${'x'.repeat(200)}` }],
    ['createdAt', { createdAt: '2026-07-22T10:00:00Z' }],
  ] as const)('refuse %s non canonique au start', (field, patch) => {
    const result = AgentMission.start({
      id: MISSION_ID,
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      createdAt: CREATED_AT,
      stagedCustomerResolution: null,
      startOutcome: 'no_slot',
      draft: draft(),
      ...patch,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_agent_mission', field } });
  });

  it('refuse identifiants de choix dupliqués et références de brouillon non canoniques', () => {
    expect(AgentMission.start({
      id: MISSION_ID,
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      createdAt: CREATED_AT,
      stagedCustomerResolution: null,
      startOutcome: 'draft_conflict',
      existingDraft: draft('existing-session', 7, 3),
      decision: { decisionId: DECISION_1, resumeChoiceId: CHOICE_1, requestDiscardChoiceId: CHOICE_1 },
    })).toMatchObject({ ok: false, error: { field: 'choices[1].choiceId' } });

    expect(AgentMission.start({
      id: MISSION_ID,
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      createdAt: CREATED_AT,
      stagedCustomerResolution: null,
      startOutcome: 'no_slot',
      draft: draft(' bad-session'),
    })).toMatchObject({ ok: false, error: { field: 'draft.sessionId' } });

    expect(AgentMission.start({
      id: MISSION_ID,
      companyId: 'company\u0085name',
      ownerUserId: 'owner-1',
      createdAt: CREATED_AT,
      stagedCustomerResolution: null,
      startOutcome: 'no_slot',
      draft: draft(),
    })).toMatchObject({ ok: false, error: { field: 'companyId', reason: 'invalid_identifier' } });
  });

  it('impose au start no_slot le brouillon neuf slot=1/content=0 annoncé par le journal', () => {
    for (const invalidDraft of [draft('quote-session-1', 2, 0), draft('quote-session-1', 1, 1)]) {
      expect(AgentMission.start({
        id: MISSION_ID,
        companyId: 'company-1',
        ownerUserId: 'owner-1',
        createdAt: CREATED_AT,
        stagedCustomerResolution: null,
        startOutcome: 'no_slot',
        draft: invalidDraft,
      })).toMatchObject({ ok: false, error: { field: 'draft', reason: 'inconsistent_state' } });
    }
  });
});

describe('AgentMission — hash et parseur exact', () => {
  it('produit un hash stable qui lie mission, révision, décision, ordre, choix et cible réelle', () => {
    const base = {
      missionId: MISSION_ID,
      choiceSetRevision: 4,
      decisionId: DECISION_1,
      choices: [
        { choiceId: CHOICE_1, customerId: 'client-é' },
        { choiceId: CHOICE_2, customerId: 'client-b' },
      ],
    } as const;
    const first = value(computeQuoteMissionChoiceSetHash(base));
    const second = value(computeQuoteMissionChoiceSetHash(base));
    const reordered = value(computeQuoteMissionChoiceSetHash({ ...base, choices: [...base.choices].reverse() }));
    const changedRevision = value(computeQuoteMissionChoiceSetHash({ ...base, choiceSetRevision: 5 }));

    expect(first).toBe(second);
    expect(first).toBe('fc1987a3bd7ca61183b13670e8ab95329d6ec8bdd2e70cc3d05dcebfcd1a955a');
    expect(reordered).not.toBe(first);
    expect(changedRevision).not.toBe(first);
  });

  it('fige un vecteur doré de décision brouillon et lie chaque fence au hash', () => {
    const input = {
      missionId: MISSION_ID,
      choiceSetRevision: 1,
      decisionId: DECISION_1,
      draftFence: draft('existing-session', 7, 3),
      choices: [
        { choiceId: CHOICE_1, action: 'resume_existing' },
        { choiceId: CHOICE_2, action: 'request_discard' },
      ],
    } as const;
    const hash = value(computeQuoteMissionChoiceSetHash(input));
    const changedFence = value(computeQuoteMissionChoiceSetHash({
      ...input,
      draftFence: draft('existing-session', 7, 4),
    }));

    expect(hash).toBe('4e98e9fbfb25bfb5f54b5a0e84053b3ef9e5cb8cf7a4b2a6d1311fe3fa24b6a4');
    expect(changedFence).toBe('9d3ab4fad111994f0bc6cbc2421e2dcc3563d70d4ddd3d0e0b1b8c520f879386');
  });

  it.each([
    null,
    { missionId: MISSION_ID, choiceSetRevision: 1, decisionId: DECISION_1, choices: [null] },
    {
      missionId: MISSION_ID,
      choiceSetRevision: 1,
      decisionId: DECISION_1,
      choices: [{ choiceId: CHOICE_1, action: 'resume_existing', extra: true }],
    },
    {
      missionId: MISSION_ID,
      choiceSetRevision: 1,
      decisionId: DECISION_1,
      choices: [{ choiceId: CHOICE_1, action: 'resume_existing', customerId: 'customer-a' }],
    },
  ])('rejette sans exception une entrée de hash runtime malformée %#', (input) => {
    expect(() => (computeQuoteMissionChoiceSetHash as (value: unknown) => unknown)(input)).not.toThrow();
    expect((computeQuoteMissionChoiceSetHash as (value: unknown) => AgentMissionResult<string>)(input)).toMatchObject({
      ok: false,
      error: { code: 'invalid_agent_mission' },
    });
  });

  it('rehydrate un snapshot exact et rejette clés inconnues, hash forgé et état impossible', () => {
    const snapshot = conflictMission().toSnapshot();
    expect(AgentMission.rehydrate(snapshot).ok).toBe(true);
    expect(AgentMission.rehydrate({ ...snapshot, transcript: 'secret' })).toMatchObject({
      ok: false,
      error: { field: '$', reason: 'invalid_shape' },
    });
    expect(AgentMission.rehydrate({
      ...snapshot,
      payload: {
        ...snapshot.payload,
        decision: { ...snapshot.payload.decision, choiceSetHash: 'b'.repeat(64) },
      },
    })).toMatchObject({ ok: false, error: { field: 'payload.decision.choiceSetHash' } });
    expect(AgentMission.rehydrate({ ...snapshot, phase: 'awaiting_customer' })).toMatchObject({
      ok: false,
      error: { reason: 'inconsistent_state' },
    });
    expect(AgentMission.rehydrate({ ...snapshot, currentBinding: binding(CREATED_AT) })).toMatchObject({
      ok: false,
      error: { reason: 'inconsistent_state' },
    });
    expect(AgentMission.rehydrate({ ...snapshot, status: 'completed' })).toMatchObject({
      ok: false,
      error: { field: 'status', reason: 'invalid_value' },
    });
  });

  it('rehydrate un payload N-1 sans stagedCustomerResolution et le normalise vers null', () => {
    const snapshot = noSlotMission().toSnapshot();
    const {
      stagedCustomerResolution: _stagedCustomerResolution,
      ...legacyPayload
    } = snapshot.payload;
    const legacy = value(AgentMission.rehydrate({
      ...snapshot,
      payload: legacyPayload,
    }));

    expect(legacy.payload.stagedCustomerResolution).toBeNull();
    expect(Object.keys(legacy.payload).sort()).toEqual([
      'decision',
      'draft',
      'schema',
      'stagedCustomerResolution',
      'version',
    ]);
  });

  it('rejette les horodatages non canoniques et les politiques TTL altérées', () => {
    const snapshot = noSlotMission().toSnapshot();
    expect(AgentMission.rehydrate({ ...snapshot, updatedAt: '2026-07-22T10:00:00Z' })).toMatchObject({
      ok: false,
      error: { field: 'updatedAt' },
    });
    expect(AgentMission.rehydrate({ ...snapshot, hardExpiresAt: at(60) })).toMatchObject({
      ok: false,
      error: { field: 'timestamps', reason: 'inconsistent_state' },
    });
    expect(AgentMission.rehydrate({ ...snapshot, idleExpiresAt: at(1_500) })).toMatchObject({
      ok: false,
      error: { field: 'timestamps', reason: 'inconsistent_state' },
    });
    expect(AgentMission.rehydrate({ ...snapshot, terminalAt: at(1) })).toMatchObject({
      ok: false,
      error: { field: 'timestamps', reason: 'inconsistent_state' },
    });
  });

  it('applique aussi les invariants phase/payload/binding aux états terminaux', () => {
    const cancelled = value(noSlotMission().cancel({
      expectedRevision: 1,
      reason: 'user_cancelled',
      occurredAt: at(2),
    })).mission.toSnapshot();

    expect(AgentMission.rehydrate({ ...cancelled, phase: 'awaiting_customer' })).toMatchObject({
      ok: false,
      error: { field: 'currentBinding', reason: 'inconsistent_state' },
    });
    expect(AgentMission.rehydrate({
      ...cancelled,
      phase: 'awaiting_draft_decision',
    })).toMatchObject({ ok: false, error: { field: 'payload.decision', reason: 'inconsistent_state' } });
  });

  it.each([
    ['active idle dérivé', (snapshot: ReturnType<AgentMission['toSnapshot']>) => ({ ...snapshot, idleExpiresAt: at(1_441) })],
    ['active rétention', (snapshot: ReturnType<AgentMission['toSnapshot']>) => ({ ...snapshot, retentionExpiresAt: at(1) })],
    ['hard exact', (snapshot: ReturnType<AgentMission['toSnapshot']>) => ({ ...snapshot, hardExpiresAt: at(10_079) })],
  ] as const)('rejette un invariant temporel actif altéré : %s', (_label, mutate) => {
    expect(AgentMission.rehydrate(mutate(noSlotMission().toSnapshot()))).toMatchObject({
      ok: false,
      error: { reason: 'inconsistent_state' },
    });
  });

  it('rejette chaque incohérence temporelle terminale exacte', () => {
    const cancelled = value(noSlotMission().cancel({
      expectedRevision: 1,
      reason: 'user_cancelled',
      occurredAt: at(2),
    })).mission.toSnapshot();
    const expired = value(noSlotMission().expire({
      expectedRevision: 1,
      occurredAt: new Date(Date.parse(CREATED_AT) + AGENT_MISSION_IDLE_TTL_MS).toISOString(),
    })).mission.toSnapshot();

    expect(AgentMission.rehydrate({ ...cancelled, updatedAt: at(1) })).toMatchObject({
      ok: false,
      error: { field: 'timestamps' },
    });
    expect(AgentMission.rehydrate({ ...cancelled, retentionExpiresAt: cancelled.hardExpiresAt })).toMatchObject({
      ok: false,
      error: { field: 'timestamps' },
    });
    expect(AgentMission.rehydrate({
      ...cancelled,
      terminalAt: cancelled.idleExpiresAt,
      updatedAt: cancelled.idleExpiresAt,
      retentionExpiresAt: new Date(
        Date.parse(cancelled.idleExpiresAt) + AGENT_MISSION_RETENTION_MS,
      ).toISOString(),
    })).toMatchObject({ ok: false, error: { field: 'terminalAt' } });
    expect(AgentMission.rehydrate({
      ...expired,
      terminalAt: at(1),
      updatedAt: at(1),
      retentionExpiresAt: new Date(Date.parse(at(1)) + AGENT_MISSION_RETENTION_MS).toISOString(),
    })).toMatchObject({ ok: false, error: { field: 'terminalAt' } });
  });
});

describe('AgentMission — brouillon existant et double confirmation', () => {
  it('reprend le brouillon observé par un choix courant et efface la décision', () => {
    const mission = conflictMission();
    const transition = value(mission.resumeExistingDraft({
      expectedRevision: 1,
      decisionId: DECISION_1,
      choiceSetRevision: 1,
      choiceId: CHOICE_1,
      observedDraft: draft('existing-session', 7, 3),
      draftHasCustomer: false,
      occurredAt: at(1),
    }));

    expectTransition(transition, 1, 2, 'draft_resume_selected');
    expect(transition.mission.toSnapshot()).toMatchObject({
      phase: 'awaiting_quote_screen',
      payload: { draft: draft('existing-session', 7, 3), decision: null },
    });
    expect(mission.phase).toBe('awaiting_draft_decision');
  });

  it('demande puis annule l’abandon avec un nouveau jeu de choix lié à la nouvelle révision', () => {
    const requested = value(conflictMission().requestDraftDiscard({
      expectedRevision: 1,
      decisionId: DECISION_1,
      choiceSetRevision: 1,
      choiceId: CHOICE_2,
      observedDraft: draft('existing-session', 7, 3),
      nextDecision: { decisionId: DECISION_2, confirmChoiceId: CHOICE_3, keepChoiceId: CHOICE_4 },
      occurredAt: at(1),
    }));
    expectTransition(requested, 1, 2, 'draft_discard_requested');
    expect(requested.mission.payload.decision).toMatchObject({
      kind: 'confirm_draft_discard',
      choiceSetRevision: 2,
      expectedDraftSessionId: 'existing-session',
      expectedDraftSlotRevision: 7,
      expectedDraftContentRevision: 3,
    });

    const kept = value(requested.mission.keepExistingDraft({
      expectedRevision: 2,
      decisionId: DECISION_2,
      choiceSetRevision: 2,
      choiceId: CHOICE_4,
      nextDecision: { decisionId: DECISION_1, resumeChoiceId: CHOICE_5, requestDiscardChoiceId: CHOICE_6 },
      occurredAt: at(2),
    }));
    expectTransition(kept, 2, 3, 'draft_discard_cancelled');
    expect(kept.mission.payload.decision).toMatchObject({
      kind: 'existing_draft',
      choiceSetRevision: 3,
    });
  });

  it('confirme uniquement la référence décidée et un remplacement in-place N→N+1', () => {
    const requested = value(conflictMission().requestDraftDiscard({
      expectedRevision: 1,
      decisionId: DECISION_1,
      choiceSetRevision: 1,
      choiceId: CHOICE_2,
      observedDraft: draft('existing-session', 7, 3),
      nextDecision: { decisionId: DECISION_2, confirmChoiceId: CHOICE_3, keepChoiceId: CHOICE_4 },
      occurredAt: at(1),
    })).mission;

    expect(requested.confirmDraftDiscard({
      expectedRevision: 2,
      decisionId: DECISION_2,
      choiceSetRevision: 2,
      choiceId: CHOICE_3,
      expectedDraft: draft('existing-session', 8, 3),
      replacementDraft: draft('fresh-session', 9, 0),
      occurredAt: at(2),
    })).toMatchObject({ ok: false, error: { reason: 'draft_reference' } });

    expect(requested.confirmDraftDiscard({
      expectedRevision: 2,
      decisionId: DECISION_2,
      choiceSetRevision: 2,
      choiceId: CHOICE_3,
      expectedDraft: draft('existing-session', 7, 3),
      replacementDraft: draft('fresh-session', 9, 0),
      occurredAt: at(2),
    })).toMatchObject({ ok: false, error: { reason: 'draft_reference' } });

    expect(requested.confirmDraftDiscard({
      expectedRevision: 2,
      decisionId: DECISION_2,
      choiceSetRevision: 2,
      choiceId: CHOICE_3,
      expectedDraft: draft('existing-session', 7, 3),
      replacementDraft: draft('fresh-session', 8, 1),
      occurredAt: at(2),
    })).toMatchObject({ ok: false, error: { reason: 'draft_reference' } });

    const confirmed = value(requested.confirmDraftDiscard({
      expectedRevision: 2,
      decisionId: DECISION_2,
      choiceSetRevision: 2,
      choiceId: CHOICE_3,
      expectedDraft: draft('existing-session', 7, 3),
      replacementDraft: draft('fresh-session', 8, 0),
      occurredAt: at(2),
    }));
    expectTransition(confirmed, 2, 3, 'draft_discard_confirmed');
    expect(confirmed.mission.payload).toMatchObject({
      draft: draft('fresh-session', 8, 0),
      decision: null,
    });
  });

  it.each([
    ['mission revision', { expectedRevision: 2 }, 'agent_mission_revision_conflict'],
    ['decision id', { decisionId: DECISION_2 }, 'agent_mission_decision_conflict'],
    ['choice set revision', { choiceSetRevision: 2 }, 'agent_mission_decision_conflict'],
    ['choice id', { choiceId: CHOICE_2 }, 'agent_mission_decision_conflict'],
  ] as const)('refuse une preuve périmée : %s', (_label, patch, code) => {
    const result = conflictMission().resumeExistingDraft({
      expectedRevision: 1,
      decisionId: DECISION_1,
      choiceSetRevision: 1,
      choiceId: CHOICE_1,
      observedDraft: draft('existing-session', 7, 3),
      draftHasCustomer: false,
      occurredAt: at(1),
      ...patch,
    });
    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  it.each([
    ['session', draft('replaced-session', 7, 3)],
    ['slot revision', draft('existing-session', 8, 3)],
    ['content revision', draft('existing-session', 7, 4)],
  ] as const)('refuse de reprendre ou abandonner un draft dont la fence %s a changé', (_label, observedDraft) => {
    const mission = conflictMission();
    expect(mission.resumeExistingDraft({
      expectedRevision: 1,
      decisionId: DECISION_1,
      choiceSetRevision: 1,
      choiceId: CHOICE_1,
      observedDraft,
      draftHasCustomer: false,
      occurredAt: at(1),
    })).toMatchObject({ ok: false, error: { reason: 'draft_reference' } });
    expect(mission.requestDraftDiscard({
      expectedRevision: 1,
      decisionId: DECISION_1,
      choiceSetRevision: 1,
      choiceId: CHOICE_2,
      observedDraft,
      nextDecision: { decisionId: DECISION_2, confirmChoiceId: CHOICE_3, keepChoiceId: CHOICE_4 },
      occurredAt: at(1),
    })).toMatchObject({ ok: false, error: { reason: 'draft_reference' } });
  });
});

describe('AgentMission — ACK écran et résolution client', () => {
  it.each([
    [false, 'awaiting_customer'],
    [true, 'awaiting_lines'],
  ] as const)('ACK le contexte et va vers %s=%s', (draftHasCustomer, expectedPhase) => {
    const transition = value(noSlotMission().acknowledgeQuoteScreen({
      expectedRevision: 1,
      binding: binding(),
      observedDraft: draft(),
      draftHasCustomer,
      occurredAt: at(1),
    }));
    expectTransition(transition, 1, 2, 'screen_acknowledged');
    expect(transition.mission.phase).toBe(expectedPhase);
    expect(transition.mission.currentBinding).toEqual(binding());
    expect(transition.event.data).toEqual({ kind: 'screen_acknowledged', nextPhase: expectedPhase });
  });

  it('refuse un ACK dont contexte ou brouillon ne correspond pas exactement', () => {
    expect(noSlotMission().acknowledgeQuoteScreen({
      expectedRevision: 1,
      binding: binding(at(2)),
      observedDraft: draft(),
      draftHasCustomer: false,
      occurredAt: at(1),
    })).toMatchObject({ ok: false, error: { field: 'binding.acknowledgedAt' } });
    expect(noSlotMission().acknowledgeQuoteScreen({
      expectedRevision: 1,
      binding: binding(),
      observedDraft: draft('other-session'),
      draftHasCustomer: false,
      occurredAt: at(1),
    })).toMatchObject({ ok: false, error: { reason: 'draft_reference' } });
    expect(noSlotMission().acknowledgeQuoteScreen({
      expectedRevision: 1,
      binding: { ...binding(), screenName: '/factures/new' as '/devis/new' },
      observedDraft: draft(),
      draftHasCustomer: false,
      occurredAt: at(1),
    })).toMatchObject({ ok: false, error: { field: 'currentBinding.screenName' } });
  });

  it('remplace la liaison après reconnexion sans perdre la décision client courante', () => {
    const mission = awaitingChoice();
    const reboundBinding = {
      ...binding(at(3)),
      realtimeSessionId: '00000000-0000-4000-8000-000000000020',
      contextRevision: 1,
      contextDigest: 'b'.repeat(64),
      screenInstanceId: 'quote-screen-after-relaunch',
    };
    const rebound = value(mission.acknowledgeQuoteScreen({
      expectedRevision: 3,
      binding: reboundBinding,
      observedDraft: draft(),
      draftHasCustomer: false,
      occurredAt: at(3),
    }));

    expectTransition(rebound, 3, 4, 'screen_acknowledged');
    expect(rebound.mission.phase).toBe('awaiting_customer_choice');
    expect(rebound.mission.currentBinding).toEqual(reboundBinding);
    expect(rebound.mission.payload.decision).toEqual(mission.payload.decision);

    const selected = value(rebound.mission.selectCustomer({
      expectedRevision: 4,
      source: 'presented_choice',
      customerId: 'customer-a',
      decisionId: DECISION_1,
      choiceSetRevision: 3,
      choiceId: CHOICE_1,
      updatedDraft: draft('quote-session-1', 2, 1),
      occurredAt: at(4),
    }));
    expect(selected.mission.phase).toBe('awaiting_lines');
  });

  it('refuse une re-liaison qui contredit l’étape réelle du brouillon', () => {
    expect(awaitingChoice().acknowledgeQuoteScreen({
      expectedRevision: 3,
      binding: { ...binding(at(3)), realtimeSessionId: '00000000-0000-4000-8000-000000000020' },
      observedDraft: draft(),
      draftHasCustomer: true,
      occurredAt: at(3),
    })).toMatchObject({ ok: false, error: { reason: 'draft_reference' } });
  });

  it('conserve le staged après ACK sans client et l’efface si le brouillon réel en a déjà un', () => {
    const stagedCustomerResolution = {
      kind: 'exact' as const,
      customerId: 'customer-a',
    };
    const started = value(AgentMission.start({
      id: MISSION_ID,
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      createdAt: CREATED_AT,
      stagedCustomerResolution,
      startOutcome: 'no_slot',
      draft: draft(),
    })).mission;

    const withoutCustomer = value(started.acknowledgeQuoteScreen({
      expectedRevision: 1,
      binding: binding(),
      observedDraft: draft(),
      draftHasCustomer: false,
      occurredAt: at(1),
    })).mission;
    expect(withoutCustomer.payload.stagedCustomerResolution).toEqual(stagedCustomerResolution);
    expect(withoutCustomer.phase).toBe('awaiting_customer');

    const withCustomer = value(started.acknowledgeQuoteScreen({
      expectedRevision: 1,
      binding: binding(),
      observedDraft: draft(),
      draftHasCustomer: true,
      occurredAt: at(1),
    })).mission;
    expect(withCustomer.payload.stagedCustomerResolution).toBeNull();
    expect(withCustomer.phase).toBe('awaiting_lines');
  });

  it('intègre au join une résolution seulement avant l’écran et préserve l’existante avec null', () => {
    const mission = noSlotMission();
    const joined = value(mission.joinActive({
      expectedRevision: 1,
      stagedCustomerResolution: { kind: 'exact', customerId: 'customer-a' },
      occurredAt: at(1),
    }));
    expect(joined.mission.payload.stagedCustomerResolution).toEqual({
      kind: 'exact',
      customerId: 'customer-a',
    });

    const preserved = value(joined.mission.joinActive({
      expectedRevision: 2,
      stagedCustomerResolution: null,
      occurredAt: at(2),
    }));
    expect(preserved.mission.payload.stagedCustomerResolution).toEqual({
      kind: 'exact',
      customerId: 'customer-a',
    });

    const acknowledged = value(preserved.mission.acknowledgeQuoteScreen({
      expectedRevision: 3,
      binding: binding(at(3)),
      observedDraft: draft(),
      draftHasCustomer: false,
      occurredAt: at(3),
    })).mission;
    expect(acknowledged.joinActive({
      expectedRevision: 4,
      stagedCustomerResolution: { kind: 'none' },
      occurredAt: at(4),
    })).toMatchObject({
      ok: false,
      error: {
        code: 'agent_mission_invalid_transition',
        action: 'join_active',
      },
    });
  });

  it('stage une résolution ultérieure sans écraser la décision brouillon et la journalise sans IDs', () => {
    const transition = value(conflictMission().stageCustomerResolution({
      expectedRevision: 1,
      resolution: stagedChoices(),
      occurredAt: at(1),
    }));
    expectTransition(transition, 1, 2, 'customer_resolution_staged');
    expect(transition.mission.payload.decision).toEqual(conflictMission().payload.decision);
    expect(transition.mission.payload.stagedCustomerResolution).toEqual(stagedChoices());
    expect(transition.event.data).toEqual({
      kind: 'customer_resolution_staged',
      result: 'choices',
      observedCandidateCount: 3,
    });
    expect(JSON.stringify(transition.event)).not.toContain('customer-a');

    const acknowledged = awaitingCustomer();
    expect(acknowledged.stageCustomerResolution({
      expectedRevision: 2,
      resolution: { kind: 'none' },
      occurredAt: at(2),
    })).toMatchObject({
      ok: false,
      error: {
        code: 'agent_mission_invalid_transition',
        action: 'stage_customer_resolution',
      },
    });
  });

  it('reprendre un brouillon réel avec client gagne sur le staged, sinon le staged survit', () => {
    const started = value(AgentMission.start({
      id: MISSION_ID,
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      createdAt: CREATED_AT,
      stagedCustomerResolution: { kind: 'exact', customerId: 'customer-a' },
      startOutcome: 'draft_conflict',
      existingDraft: draft('existing-session', 7, 3),
      decision: {
        decisionId: DECISION_1,
        resumeChoiceId: CHOICE_1,
        requestDiscardChoiceId: CHOICE_2,
      },
    })).mission;
    const base = {
      expectedRevision: 1,
      decisionId: DECISION_1,
      choiceSetRevision: 1,
      choiceId: CHOICE_1,
      observedDraft: draft('existing-session', 7, 3),
      occurredAt: at(1),
    } as const;

    expect(value(started.resumeExistingDraft({
      ...base,
      draftHasCustomer: false,
    })).mission.payload.stagedCustomerResolution).toEqual({
      kind: 'exact',
      customerId: 'customer-a',
    });
    expect(value(started.resumeExistingDraft({
      ...base,
      draftHasCustomer: true,
    })).mission.payload.stagedCustomerResolution).toBeNull();
  });

  it.each([
    [{ kind: 'none' }, 'none'],
    [{ kind: 'too_many' }, 'too_many'],
    [{ kind: 'exact', customerId: 'customer-gone' }, 'none'],
    [stagedChoices(), 'none'],
  ] as const)('consomme honnêtement un staged indisponible %#', (resolution, result) => {
    const mission = awaitingCustomerWithStaged(resolution);
    const transition = value(mission.consumeStagedCustomerResolution({
      expectedRevision: 2,
      outcome: 'not_found',
      occurredAt: at(2),
    }));

    expectTransition(transition, 2, 3, 'customer_not_found');
    expect(transition.event.data).toEqual({
      kind: 'customer_not_found',
      result,
    });
    expect(transition.mission.payload.stagedCustomerResolution).toBeNull();
  });

  it('sélectionne uniquement le client exact staged et garde la sélection manuelle prioritaire', () => {
    const mission = awaitingCustomerWithStaged({
      kind: 'exact',
      customerId: 'customer-a',
    });
    expect(mission.consumeStagedCustomerResolution({
      expectedRevision: 2,
      outcome: 'select_exact',
      customerId: 'customer-b',
      updatedDraft: draft('quote-session-1', 2, 1),
      occurredAt: at(2),
    })).toMatchObject({
      ok: false,
      error: {
        code: 'agent_mission_decision_conflict',
        reason: 'customer_reference',
      },
    });
    expect(mission.selectCustomer({
      expectedRevision: 2,
      source: 'exact_match',
      customerId: 'customer-a',
      updatedDraft: draft('quote-session-1', 2, 1),
      occurredAt: at(2),
    })).toMatchObject({
      ok: false,
      error: {
        code: 'agent_mission_invalid_transition',
        action: 'select_customer',
      },
    });

    const selected = value(mission.consumeStagedCustomerResolution({
      expectedRevision: 2,
      outcome: 'select_exact',
      customerId: 'customer-a',
      updatedDraft: draft('quote-session-1', 2, 1),
      occurredAt: at(2),
    }));
    expectTransition(selected, 2, 3, 'customer_selected');
    expect(selected.event.data).toMatchObject({
      customerId: 'customer-a',
      source: 'exact_match',
    });

    const manual = value(mission.selectCustomer({
      expectedRevision: 2,
      source: 'screen_selection',
      customerId: 'customer-b',
      updatedDraft: draft('quote-session-1', 2, 1),
      occurredAt: at(2),
    }));
    expect(manual.event.data).toMatchObject({
      customerId: 'customer-b',
      source: 'screen_selection',
    });
    expect(manual.mission.payload.stagedCustomerResolution).toBeNull();
  });

  it('promeut seulement un sous-ensemble ordonné des choix staged et refuse toute injection', () => {
    const mission = awaitingCustomerWithStaged(stagedChoices());
    const candidates = [
      { choiceId: CHOICE_1, customerId: 'customer-a' },
      { choiceId: CHOICE_3, customerId: 'customer-c' },
    ] as const;
    const presented = value(mission.consumeStagedCustomerResolution({
      expectedRevision: 2,
      outcome: 'present_choices',
      candidates,
      occurredAt: at(2),
    }));
    expectTransition(presented, 2, 3, 'customer_choice_presented');
    expect(presented.mission.payload.decision).toMatchObject({
      kind: 'customer',
      decisionId: DECISION_1,
      choiceSetRevision: 3,
      candidates,
    });
    expect(presented.mission.payload.stagedCustomerResolution).toBeNull();

    for (const invalidCandidates of [
      [
        { choiceId: CHOICE_3, customerId: 'customer-c' },
        { choiceId: CHOICE_1, customerId: 'customer-a' },
      ],
      [{ choiceId: CHOICE_1, customerId: 'customer-injected' }],
      [{ choiceId: CHOICE_4, customerId: 'customer-a' }],
      [
        { choiceId: CHOICE_1, customerId: 'customer-a' },
        { choiceId: CHOICE_1, customerId: 'customer-a' },
      ],
    ] as const) {
      expect(mission.consumeStagedCustomerResolution({
        expectedRevision: 2,
        outcome: 'present_choices',
        candidates: invalidCandidates,
        occurredAt: at(2),
      })).toMatchObject({
        ok: false,
        error: {
          code: 'agent_mission_decision_conflict',
          reason: 'customer_reference',
        },
      });
    }
  });

  it('interdit les transitions directes tant qu’une résolution staged attend sa consommation', () => {
    const mission = awaitingCustomerWithStaged(stagedChoices());
    expect(mission.recordCustomerNotFound({
      expectedRevision: 2,
      result: 'none',
      occurredAt: at(2),
    })).toMatchObject({
      ok: false,
      error: { code: 'agent_mission_invalid_transition' },
    });
    expect(mission.presentCustomerChoices({
      expectedRevision: 2,
      decisionId: DECISION_2,
      candidates: [{ choiceId: CHOICE_4, customerId: 'customer-d' }],
      occurredAt: at(2),
    })).toMatchObject({
      ok: false,
      error: { code: 'agent_mission_invalid_transition' },
    });
  });

  it.each(['none', 'too_many'] as const)('journalise %s sans inventer ni sélectionner', (result) => {
    const mission = awaitingCustomer();
    const transition = value(mission.recordCustomerNotFound({
      expectedRevision: 2,
      result,
      occurredAt: at(2),
    }));
    expectTransition(transition, 2, 3, 'customer_not_found');
    expect(transition.mission.phase).toBe('awaiting_customer');
    expect(transition.mission.payload.decision).toBeNull();
  });

  it.each([1, 5])('présente exactement %s candidat(s) réel(s), dans l’ordre fourni', (count) => {
    const candidates = [
      { choiceId: CHOICE_1, customerId: 'customer-a' },
      { choiceId: CHOICE_2, customerId: 'customer-b' },
      { choiceId: CHOICE_3, customerId: 'customer-c' },
      { choiceId: CHOICE_4, customerId: 'customer-d' },
      { choiceId: CHOICE_5, customerId: 'customer-e' },
    ].slice(0, count);
    const transition = value(awaitingCustomer().presentCustomerChoices({
      expectedRevision: 2,
      decisionId: DECISION_1,
      candidates,
      occurredAt: at(2),
    }));
    expectTransition(transition, 2, 3, 'customer_choice_presented');
    expect(transition.mission.payload.decision).toMatchObject({
      kind: 'customer',
      choiceSetRevision: 3,
      candidates,
    });
    expect(transition.event.data).toMatchObject({ candidateCount: count });
  });

  it('refuse 0, plus de 5, choix dupliqués et clients dupliqués', () => {
    const mission = awaitingCustomer();
    const base = {
      expectedRevision: 2,
      decisionId: DECISION_1,
      occurredAt: at(2),
    };
    expect(mission.presentCustomerChoices({ ...base, candidates: [] })).toMatchObject({
      ok: false,
      error: { field: 'choices' },
    });
    expect(mission.presentCustomerChoices({
      ...base,
      candidates: [CHOICE_1, CHOICE_2, CHOICE_3, CHOICE_4, CHOICE_5, CHOICE_6].map((choiceId, index) => ({
        choiceId,
        customerId: `customer-${index}`,
      })),
    })).toMatchObject({ ok: false, error: { field: 'choices' } });
    expect(mission.presentCustomerChoices({
      ...base,
      candidates: [
        { choiceId: CHOICE_1, customerId: 'customer-a' },
        { choiceId: CHOICE_1, customerId: 'customer-b' },
      ],
    })).toMatchObject({ ok: false, error: { field: 'choices[1].choiceId' } });
    expect(mission.presentCustomerChoices({
      ...base,
      candidates: [
        { choiceId: CHOICE_1, customerId: 'customer-a' },
        { choiceId: CHOICE_2, customerId: 'customer-a' },
      ],
    })).toMatchObject({ ok: false, error: { field: 'candidates' } });
  });

  it('sélectionne un choix présenté seulement après relecture du même customerId', () => {
    const mission = awaitingChoice();
    expect(mission.selectCustomer({
      expectedRevision: 3,
      source: 'presented_choice',
      customerId: 'customer-other',
      decisionId: DECISION_1,
      choiceSetRevision: 3,
      choiceId: CHOICE_2,
      updatedDraft: draft('quote-session-1', 2, 1),
      occurredAt: at(3),
    })).toMatchObject({ ok: false, error: { reason: 'customer_reference' } });

    const transition = value(mission.selectCustomer({
      expectedRevision: 3,
      source: 'presented_choice',
      customerId: 'customer-b',
      decisionId: DECISION_1,
      choiceSetRevision: 3,
      choiceId: CHOICE_2,
      updatedDraft: draft('quote-session-1', 2, 1),
      occurredAt: at(3),
    }));
    expectTransition(transition, 3, 4, 'customer_selected');
    expect(transition.mission.phase).toBe('awaiting_lines');
    expect(transition.mission.payload).toMatchObject({
      draft: draft('quote-session-1', 2, 1),
      decision: null,
    });
    expect(transition.event.data).toMatchObject({
      customerId: 'customer-b',
      source: 'presented_choice',
      choiceId: CHOICE_2,
    });
    expect(JSON.stringify(transition)).not.toContain('Camping');
  });

  it('permet de choisir au toucher un client réel hors suggestions et invalide le jeu courant', () => {
    const transition = value(awaitingChoice().selectCustomer({
      expectedRevision: 3,
      source: 'screen_selection',
      customerId: 'customer-outside-current-choice-set',
      updatedDraft: draft('quote-session-1', 2, 1),
      occurredAt: at(3),
    }));

    expectTransition(transition, 3, 4, 'customer_selected');
    expect(transition.mission.phase).toBe('awaiting_lines');
    expect(transition.mission.payload).toMatchObject({
      draft: draft('quote-session-1', 2, 1),
      decision: null,
    });
    expect(transition.event.data).toEqual({
      kind: 'customer_selected',
      customerId: 'customer-outside-current-choice-set',
      source: 'screen_selection',
      choiceId: null,
      choiceSetHash: null,
    });
  });

  it('remplace en une transition le jeu courant après une nouvelle référence vocale', () => {
    const notFound = value(awaitingChoice().recordCustomerNotFound({
      expectedRevision: 3,
      result: 'none',
      occurredAt: at(3),
    }));
    expectTransition(notFound, 3, 4, 'customer_not_found');
    expect(notFound.mission.phase).toBe('awaiting_customer');
    expect(notFound.mission.payload.decision).toBeNull();

    const replaced = value(awaitingChoice().presentCustomerChoices({
      expectedRevision: 3,
      decisionId: DECISION_2,
      candidates: [
        { choiceId: CHOICE_3, customerId: 'customer-c' },
      ],
      occurredAt: at(3),
    }));
    expectTransition(replaced, 3, 4, 'customer_choice_presented');
    expect(replaced.mission.phase).toBe('awaiting_customer_choice');
    expect(replaced.mission.payload.decision).toMatchObject({
      kind: 'customer',
      decisionId: DECISION_2,
      candidates: [{ choiceId: CHOICE_3, customerId: 'customer-c' }],
    });

    const selected = value(awaitingChoice().selectCustomer({
      expectedRevision: 3,
      source: 'exact_match',
      customerId: 'customer-new-exact',
      updatedDraft: draft('quote-session-1', 2, 1),
      occurredAt: at(3),
    }));
    expectTransition(selected, 3, 4, 'customer_selected');
    expect(selected.mission.phase).toBe('awaiting_lines');
    expect(selected.mission.payload.decision).toBeNull();
  });

  it.each(['exact_match', 'screen_selection'] as const)(
    'fait passer la sélection %s par la même transition de brouillon',
    (source) => {
      const transition = value(awaitingCustomer().selectCustomer({
        expectedRevision: 2,
        source,
        customerId: 'customer-a',
        updatedDraft: draft('quote-session-1', 2, 1),
        occurredAt: at(2),
      }));
      expectTransition(transition, 2, 3, 'customer_selected');
      expect(transition.mission.phase).toBe('awaiting_lines');
      expect(transition.event.data).toEqual({
        kind: 'customer_selected',
        customerId: 'customer-a',
        source,
        choiceId: null,
        choiceSetHash: null,
      });
    },
  );

  it('fence le choix périmé et chaque révision du brouillon sélectionné', () => {
    const mission = awaitingChoice();
    expect(mission.selectCustomer({
      expectedRevision: 3,
      source: 'presented_choice',
      customerId: 'customer-a',
      decisionId: DECISION_2,
      choiceSetRevision: 3,
      choiceId: CHOICE_1,
      updatedDraft: draft('quote-session-1', 2, 1),
      occurredAt: at(3),
    })).toMatchObject({ ok: false, error: { reason: 'decision_id' } });
    expect(mission.selectCustomer({
      expectedRevision: 3,
      source: 'presented_choice',
      customerId: 'customer-a',
      decisionId: DECISION_1,
      choiceSetRevision: 2,
      choiceId: CHOICE_1,
      updatedDraft: draft('quote-session-1', 2, 1),
      occurredAt: at(3),
    })).toMatchObject({ ok: false, error: { reason: 'choice_set_revision' } });
    expect(mission.selectCustomer({
      expectedRevision: 3,
      source: 'presented_choice',
      customerId: 'customer-a',
      decisionId: DECISION_1,
      choiceSetRevision: 3,
      choiceId: CHOICE_1,
      updatedDraft: draft('quote-session-1', 3, 1),
      occurredAt: at(3),
    })).toMatchObject({ ok: false, error: { reason: 'draft_reference' } });
    expect(mission.selectCustomer({
      expectedRevision: 3,
      source: 'presented_choice',
      customerId: 'customer-a',
      decisionId: DECISION_1,
      choiceSetRevision: 3,
      choiceId: CHOICE_1,
      updatedDraft: draft('quote-session-1', 2, 2),
      occurredAt: at(3),
    })).toMatchObject({ ok: false, error: { reason: 'draft_reference' } });
  });

  it('invalide un candidat devenu indisponible sans réutiliser son ancien choix', () => {
    const transition = value(awaitingChoice().invalidateCustomerDecision({
      expectedRevision: 3,
      reason: 'candidate_unavailable',
      occurredAt: at(3),
    }));
    expectTransition(transition, 3, 4, 'decision_invalidated');
    expect(transition.mission.phase).toBe('awaiting_customer');
    expect(transition.mission.payload.decision).toBeNull();
  });
});

describe('AgentMission — terminalité, horloge et table de transitions', () => {
  it('journalise un join actif sans changer le contexte et prolonge seulement le TTL idle', () => {
    const mission = awaitingChoice();
    const before = mission.toSnapshot();
    const joined = value(mission.joinActive({
      expectedRevision: mission.revision,
      stagedCustomerResolution: null,
      occurredAt: at(4),
    }));

    expectTransition(joined, mission.revision, mission.revision + 1, 'mission_joined');
    expect(joined.event.data).toEqual({ kind: 'mission_joined' });
    expect(joined.mission.toSnapshot()).toMatchObject({
      phase: before.phase,
      payload: before.payload,
      currentBinding: before.currentBinding,
      updatedAt: at(4),
      idleExpiresAt: at(1_444),
    });
  });

  it.each([
    ['awaiting_quote_screen', () => noSlotMission()],
    ['awaiting_draft_decision', () => conflictMission()],
    ['awaiting_customer', () => awaitingCustomer()],
    ['awaiting_customer_choice', () => awaitingChoice()],
  ] as const)('annule depuis %s en conservant le brouillon éventuel', (_phase, factory) => {
    const mission = factory();
    const beforeDraft = mission.payload.draft;
    const transition = value(mission.cancel({
      expectedRevision: mission.revision,
      reason: 'user_cancelled',
      occurredAt: at(4),
    }));
    expectTransition(transition, mission.revision, mission.revision + 1, 'mission_cancelled');
    expect(transition.mission.status).toBe('cancelled');
    expect(transition.mission.payload.draft).toEqual(beforeDraft);
    expect(transition.mission.toSnapshot()).toMatchObject({
      terminalAt: at(4),
      retentionExpiresAt: new Date(Date.parse(at(4)) + AGENT_MISSION_RETENTION_MS).toISOString(),
    });
    expect(AgentMission.rehydrate(transition.mission.toSnapshot()).ok).toBe(true);
    expect(transition.mission.cancel({
      expectedRevision: transition.mission.revision,
      reason: 'user_cancelled',
      occurredAt: at(5),
    })).toMatchObject({ ok: false, error: { code: 'agent_mission_terminal', status: 'cancelled' } });
  });

  it('réserve le handoff manuel à l’étape lignes', () => {
    expect(noSlotMission().cancel({
      expectedRevision: 1,
      reason: 'manual_handoff',
      occurredAt: at(1),
    })).toMatchObject({
      ok: false,
      error: {
        code: 'agent_mission_invalid_transition',
        phase: 'awaiting_quote_screen',
      },
    });

    const lines = value(noSlotMission().acknowledgeQuoteScreen({
      expectedRevision: 1,
      binding: binding(),
      observedDraft: draft(),
      draftHasCustomer: true,
      occurredAt: at(1),
    })).mission;
    expect(value(lines.cancel({
      expectedRevision: 2,
      reason: 'manual_handoff',
      occurredAt: at(2),
    })).mission.status).toBe('cancelled');
  });

  it('expire à la première échéance effective, même si le worker intervient après la seconde', () => {
    const idleBoundary = new Date(Date.parse(CREATED_AT) + AGENT_MISSION_IDLE_TTL_MS).toISOString();
    const hardBoundary = new Date(Date.parse(CREATED_AT) + AGENT_MISSION_HARD_TTL_MS).toISOString();
    const mission = noSlotMission();

    expect(value(mission.isExpiredAt(at(60)))).toBe(false);
    expect(value(mission.isExpiredAt(idleBoundary))).toBe(true);
    expect(mission.revision).toBe(1);
    expect(mission.expire({ expectedRevision: 1, occurredAt: at(60) })).toMatchObject({
      ok: false,
      error: { code: 'agent_mission_invalid_transition', action: 'expire' },
    });

    const idle = value(mission.expire({ expectedRevision: 1, occurredAt: idleBoundary }));
    expect(idle.event.data).toEqual({ kind: 'mission_expired', reason: 'idle_ttl' });
    expect(idle.mission.status).toBe('expired');

    const hard = value(mission.expire({ expectedRevision: 1, occurredAt: hardBoundary }));
    expect(hard.event.data).toEqual({ kind: 'mission_expired', reason: 'idle_ttl' });

    const original = mission.toSnapshot();
    const tieUpdatedAt = new Date(
      Date.parse(CREATED_AT) + AGENT_MISSION_HARD_TTL_MS - AGENT_MISSION_IDLE_TTL_MS,
    ).toISOString();
    const tie = AgentMission.rehydrate({
      ...original,
      updatedAt: tieUpdatedAt,
      idleExpiresAt: original.hardExpiresAt,
    });
    expect(tie.ok).toBe(true);
    if (!tie.ok) return;
    expect(value(tie.value.expire({
      expectedRevision: tie.value.revision,
      occurredAt: original.hardExpiresAt,
    })).event.data).toEqual({ kind: 'mission_expired', reason: 'hard_ttl' });
  });

  it('refuse toute mutation active arrivée après expiration et toute régression d’horloge', () => {
    const mission = noSlotMission();
    const idleBoundary = new Date(Date.parse(CREATED_AT) + AGENT_MISSION_IDLE_TTL_MS).toISOString();
    expect(mission.cancel({
      expectedRevision: 1,
      reason: 'user_cancelled',
      occurredAt: idleBoundary,
    })).toMatchObject({ ok: false, error: { code: 'agent_mission_expired' } });
    expect(mission.cancel({
      expectedRevision: 1,
      reason: 'user_cancelled',
      occurredAt: '2026-07-22T09:59:59.999Z',
    })).toMatchObject({ ok: false, error: { code: 'agent_mission_clock_regression' } });
  });

  it('refuse les actions dans une mauvaise phase au lieu de deviner', () => {
    const mission = noSlotMission();
    expect(mission.resumeExistingDraft({
      expectedRevision: 1,
      decisionId: DECISION_1,
      choiceSetRevision: 1,
      choiceId: CHOICE_1,
      observedDraft: draft(),
      draftHasCustomer: false,
      occurredAt: at(1),
    })).toMatchObject({
      ok: false,
      error: { code: 'agent_mission_invalid_transition', phase: 'awaiting_quote_screen' },
    });
    expect(mission.presentCustomerChoices({
      expectedRevision: 1,
      decisionId: DECISION_1,
      candidates: [{ choiceId: CHOICE_1, customerId: 'customer-a' }],
      occurredAt: at(1),
    })).toMatchObject({ ok: false, error: { code: 'agent_mission_invalid_transition' } });
  });

  it('refuse les discriminants forgés même si un appelant contourne TypeScript', () => {
    expect((AgentMission.start as (input: unknown) => unknown)({
      id: MISSION_ID,
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      createdAt: CREATED_AT,
      startOutcome: 'forged',
      draft: draft(),
    })).toMatchObject({ ok: false, error: { field: 'startOutcome' } });

    expect(awaitingCustomer().recordCustomerNotFound({
      expectedRevision: 2,
      result: 'forged' as never,
      occurredAt: at(2),
    })).toMatchObject({ ok: false, error: { field: 'result' } });
    expect(noSlotMission().cancel({
      expectedRevision: 1,
      reason: 'forged' as never,
      occurredAt: at(1),
    })).toMatchObject({ ok: false, error: { field: 'reason' } });
  });

  it('fait glisser le TTL idle à chaque transition sans dépasser le plafond hard', () => {
    const transition = value(noSlotMission().acknowledgeQuoteScreen({
      expectedRevision: 1,
      binding: binding(at(1_430)),
      observedDraft: draft(),
      draftHasCustomer: false,
      occurredAt: at(1_430),
    }));
    const snapshot = transition.mission.toSnapshot();
    expect(snapshot.idleExpiresAt).toBe(at(2_870));
    expect(Date.parse(snapshot.idleExpiresAt)).toBeLessThan(Date.parse(snapshot.hardExpiresAt));

    let current = transition.mission;
    for (const minute of [2_800, 4_200, 5_600, 7_000, 8_400, 9_800]) {
      current = value(current.recordCustomerNotFound({
        expectedRevision: current.revision,
        result: 'none',
        occurredAt: at(minute),
      })).mission;
    }
    expect(current.toSnapshot().idleExpiresAt).toBe(current.toSnapshot().hardExpiresAt);
  });
});

describe('AgentMission — bornes de persistance et frontières runtime', () => {
  it('rejette le payload brut au-delà de 64 KiB avant toute persistance', () => {
    const snapshot = noSlotMission().toSnapshot();
    const oversized = {
      ...snapshot,
      payload: {
        ...snapshot.payload,
        padding: 'x'.repeat(AGENT_MISSION_MAX_PAYLOAD_BYTES),
      },
    };

    expect(AgentMission.rehydrate(oversized)).toMatchObject({
      ok: false,
      error: { field: 'payload', reason: 'payload_too_large' },
    });
  });

  it('accepte int4 max à la relecture puis refuse tout incrément avec une erreur structurée', () => {
    const snapshot = { ...noSlotMission().toSnapshot(), revision: AGENT_MISSION_INT4_MAX };
    const mission = value(AgentMission.rehydrate(snapshot));

    expect(mission.cancel({
      expectedRevision: AGENT_MISSION_INT4_MAX,
      reason: 'user_cancelled',
      occurredAt: at(1),
    })).toEqual({
      ok: false,
      error: { code: 'agent_mission_revision_overflow', field: 'missionRevision' },
    });
    expect(AgentMission.rehydrate({ ...snapshot, revision: AGENT_MISSION_INT4_MAX + 1 })).toMatchObject({
      ok: false,
      error: { field: 'revision', reason: 'invalid_revision' },
    });
  });

  it('refuse séparément les dépassements slot et contenu du brouillon', () => {
    const conflictAtMax = value(AgentMission.start({
      id: MISSION_ID,
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      createdAt: CREATED_AT,
      stagedCustomerResolution: null,
      startOutcome: 'draft_conflict',
      existingDraft: draft('existing-session', AGENT_MISSION_INT4_MAX, 3),
      decision: { decisionId: DECISION_1, resumeChoiceId: CHOICE_1, requestDiscardChoiceId: CHOICE_2 },
    })).mission;
    const discardRequested = value(conflictAtMax.requestDraftDiscard({
      expectedRevision: 1,
      decisionId: DECISION_1,
      choiceSetRevision: 1,
      choiceId: CHOICE_2,
      observedDraft: draft('existing-session', AGENT_MISSION_INT4_MAX, 3),
      nextDecision: { decisionId: DECISION_2, confirmChoiceId: CHOICE_3, keepChoiceId: CHOICE_4 },
      occurredAt: at(1),
    })).mission;
    expect(discardRequested.confirmDraftDiscard({
      expectedRevision: 2,
      decisionId: DECISION_2,
      choiceSetRevision: 2,
      choiceId: CHOICE_3,
      expectedDraft: draft('existing-session', AGENT_MISSION_INT4_MAX, 3),
      replacementDraft: draft('fresh-session', AGENT_MISSION_INT4_MAX, 0),
      occurredAt: at(2),
    })).toEqual({
      ok: false,
      error: { code: 'agent_mission_revision_overflow', field: 'draftSlotRevision' },
    });

    const customerSnapshot = awaitingCustomer().toSnapshot();
    const slotAtMax = value(AgentMission.rehydrate({
      ...customerSnapshot,
      payload: { ...customerSnapshot.payload, draft: draft('quote-session-1', AGENT_MISSION_INT4_MAX, 0) },
    }));
    expect(slotAtMax.selectCustomer({
      expectedRevision: 2,
      source: 'exact_match',
      customerId: 'customer-a',
      updatedDraft: draft('quote-session-1', AGENT_MISSION_INT4_MAX, 1),
      occurredAt: at(2),
    })).toEqual({
      ok: false,
      error: { code: 'agent_mission_revision_overflow', field: 'draftSlotRevision' },
    });

    const contentAtMax = value(AgentMission.rehydrate({
      ...customerSnapshot,
      payload: { ...customerSnapshot.payload, draft: draft('quote-session-1', 1, AGENT_MISSION_INT4_MAX) },
    }));
    expect(contentAtMax.selectCustomer({
      expectedRevision: 2,
      source: 'exact_match',
      customerId: 'customer-a',
      updatedDraft: draft('quote-session-1', 2, AGENT_MISSION_INT4_MAX),
      occurredAt: at(2),
    })).toEqual({
      ok: false,
      error: { code: 'agent_mission_revision_overflow', field: 'draftContentRevision' },
    });
  });

  it('ne lève jamais sur null aux frontières publiques', () => {
    const requested = value(conflictMission().requestDraftDiscard({
      expectedRevision: 1,
      decisionId: DECISION_1,
      choiceSetRevision: 1,
      choiceId: CHOICE_2,
      observedDraft: draft('existing-session', 7, 3),
      nextDecision: { decisionId: DECISION_2, confirmChoiceId: CHOICE_3, keepChoiceId: CHOICE_4 },
      occurredAt: at(1),
    })).mission;
    const calls: readonly (() => unknown)[] = [
      () => (AgentMission.start as (input: unknown) => unknown)(null),
      () => AgentMission.rehydrate(null),
      () => (computeQuoteMissionChoiceSetHash as (input: unknown) => unknown)(null),
      () => noSlotMission().isExpiredAt(null as never),
      () => (conflictMission().resumeExistingDraft as unknown as (input: unknown) => unknown).call(conflictMission(), null),
      () => (conflictMission().requestDraftDiscard as unknown as (input: unknown) => unknown).call(conflictMission(), null),
      () => (requested.keepExistingDraft as unknown as (input: unknown) => unknown).call(requested, null),
      () => (requested.confirmDraftDiscard as unknown as (input: unknown) => unknown).call(requested, null),
      () => (noSlotMission().joinActive as unknown as (input: unknown) => unknown).call(noSlotMission(), null),
      () => (noSlotMission().stageCustomerResolution as unknown as (input: unknown) => unknown).call(noSlotMission(), null),
      () => (noSlotMission().acknowledgeQuoteScreen as unknown as (input: unknown) => unknown).call(noSlotMission(), null),
      () => (awaitingCustomerWithStaged({ kind: 'none' }).consumeStagedCustomerResolution as unknown as ((input: unknown) => unknown)).call(awaitingCustomerWithStaged({ kind: 'none' }), null),
      () => (awaitingCustomer().recordCustomerNotFound as unknown as (input: unknown) => unknown).call(awaitingCustomer(), null),
      () => (awaitingCustomer().presentCustomerChoices as unknown as (input: unknown) => unknown).call(awaitingCustomer(), null),
      () => (awaitingChoice().invalidateCustomerDecision as unknown as (input: unknown) => unknown).call(awaitingChoice(), null),
      () => (awaitingCustomer().selectCustomer as unknown as (input: unknown) => unknown).call(awaitingCustomer(), null),
      () => (noSlotMission().cancel as unknown as (input: unknown) => unknown).call(noSlotMission(), null),
      () => (noSlotMission().expire as unknown as (input: unknown) => unknown).call(noSlotMission(), null),
    ];

    for (const call of calls) {
      expect(call).not.toThrow();
      expect(call()).toMatchObject({ ok: false, error: { code: 'invalid_agent_mission' } });
    }
  });

  it('rejette une clé inconnue à chaque commande sans l’interpréter', () => {
    const requested = value(conflictMission().requestDraftDiscard({
      expectedRevision: 1,
      decisionId: DECISION_1,
      choiceSetRevision: 1,
      choiceId: CHOICE_2,
      observedDraft: draft('existing-session', 7, 3),
      nextDecision: { decisionId: DECISION_2, confirmChoiceId: CHOICE_3, keepChoiceId: CHOICE_4 },
      occurredAt: at(1),
    })).mission;
    const calls: readonly (() => AgentMissionResult<unknown>)[] = [
      () => (AgentMission.start as (input: unknown) => AgentMissionResult<unknown>)({
        id: MISSION_ID, companyId: 'company-1', ownerUserId: 'owner-1', createdAt: CREATED_AT,
        stagedCustomerResolution: null, startOutcome: 'no_slot', draft: draft(), extra: true,
      }),
      () => AgentMission.rehydrate({ ...noSlotMission().toSnapshot(), extra: true }),
      () => (computeQuoteMissionChoiceSetHash as (input: unknown) => AgentMissionResult<string>)({
        missionId: MISSION_ID, choiceSetRevision: 1, decisionId: DECISION_1,
        choices: [{ choiceId: CHOICE_1, customerId: 'customer-a' }], extra: true,
      }),
      () => conflictMission().resumeExistingDraft({
        expectedRevision: 1, decisionId: DECISION_1, choiceSetRevision: 1, choiceId: CHOICE_1,
        observedDraft: draft('existing-session', 7, 3), draftHasCustomer: false,
        occurredAt: at(1), extra: true,
      } as never),
      () => conflictMission().requestDraftDiscard({
        expectedRevision: 1, decisionId: DECISION_1, choiceSetRevision: 1, choiceId: CHOICE_2,
        observedDraft: draft('existing-session', 7, 3),
        nextDecision: { decisionId: DECISION_2, confirmChoiceId: CHOICE_3, keepChoiceId: CHOICE_4 },
        occurredAt: at(1), extra: true,
      } as never),
      () => requested.keepExistingDraft({
        expectedRevision: 2, decisionId: DECISION_2, choiceSetRevision: 2, choiceId: CHOICE_4,
        nextDecision: { decisionId: DECISION_1, resumeChoiceId: CHOICE_5, requestDiscardChoiceId: CHOICE_6 },
        occurredAt: at(2), extra: true,
      } as never),
      () => requested.confirmDraftDiscard({
        expectedRevision: 2, decisionId: DECISION_2, choiceSetRevision: 2, choiceId: CHOICE_3,
        expectedDraft: draft('existing-session', 7, 3), replacementDraft: draft('fresh-session', 8, 0),
        occurredAt: at(2), extra: true,
      } as never),
      () => noSlotMission().joinActive({
        expectedRevision: 1, stagedCustomerResolution: null, occurredAt: at(1), extra: true,
      } as never),
      () => noSlotMission().stageCustomerResolution({
        expectedRevision: 1, resolution: { kind: 'none' }, occurredAt: at(1), extra: true,
      } as never),
      () => noSlotMission().acknowledgeQuoteScreen({
        expectedRevision: 1, binding: binding(), observedDraft: draft(), draftHasCustomer: false,
        occurredAt: at(1), extra: true,
      } as never),
      () => awaitingCustomerWithStaged({ kind: 'none' }).consumeStagedCustomerResolution({
        expectedRevision: 2, outcome: 'not_found', occurredAt: at(2), extra: true,
      } as never),
      () => awaitingCustomer().recordCustomerNotFound({
        expectedRevision: 2, result: 'none', occurredAt: at(2), extra: true,
      } as never),
      () => awaitingCustomer().presentCustomerChoices({
        expectedRevision: 2, decisionId: DECISION_1,
        candidates: [{ choiceId: CHOICE_1, customerId: 'customer-a' }], occurredAt: at(2), extra: true,
      } as never),
      () => awaitingChoice().invalidateCustomerDecision({
        expectedRevision: 3, reason: 'choice_set_stale', occurredAt: at(3), extra: true,
      } as never),
      () => awaitingCustomer().selectCustomer({
        expectedRevision: 2, source: 'exact_match', customerId: 'customer-a',
        updatedDraft: draft('quote-session-1', 2, 1), occurredAt: at(2), extra: true,
      } as never),
      () => noSlotMission().cancel({
        expectedRevision: 1, reason: 'user_cancelled', occurredAt: at(1), extra: true,
      } as never),
      () => noSlotMission().expire({ expectedRevision: 1, occurredAt: at(1), extra: true } as never),
    ];

    for (const call of calls) {
      expect(call()).toMatchObject({ ok: false, error: { field: '$', reason: 'invalid_shape' } });
    }
  });
});
