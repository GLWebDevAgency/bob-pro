import { describe, expect, it } from 'vitest';
import {
  AGENT_MISSION_ACTORS,
  AGENT_MISSION_CORRELATION_SCREEN_ACK_EVENT_TYPES,
  AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES,
  AGENT_MISSION_CORRELATION_USER_EVENT_TYPES,
  AGENT_MISSION_DRAFT_ADVANCE_CUSTOMER_EVENT_TYPES,
  AGENT_MISSION_DRAFT_ADVANCE_LINE_EVENT_TYPES,
  AGENT_MISSION_DRAFT_NO_OP_EVENT_TYPES,
  AGENT_MISSION_DRAFT_REPLACE_EVENT_TYPES,
  AGENT_MISSION_DRAFT_START_EVENT_TYPES,
  AGENT_MISSION_EVENT_RETENTION_MS,
  AGENT_MISSION_EVENT_TYPES,
  AGENT_MISSION_EVENT_INT4_MAX,
  AGENT_MISSION_EVENT_MAX_DATA_BYTES,
  AGENT_MISSION_START_EXISTING_SLOT_OUTCOMES,
  AGENT_MISSION_START_CONFLICT_OUTCOMES,
  AGENT_MISSION_START_DIRECT_DRAFT_OUTCOMES,
  AGENT_MISSION_START_NEW_SLOT_OUTCOMES,
  AGENT_MISSION_START_OUTCOMES,
  AGENT_MISSION_SYSTEM_ACTORS,
  AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES,
  AGENT_MISSION_TAP_ACTORS,
  AGENT_MISSION_USER_ACTORS,
  AGENT_MISSION_VOICE_ACTORS,
  AgentMissionEvent,
  type AgentMissionEventDataV1,
  type AgentMissionEventSnapshot,
  type AgentMissionEventType,
} from './agent-mission-event';

const EVENT_ID = '00000000-0000-4000-8000-000000000010';
const MISSION_ID = '00000000-0000-4000-8000-000000000011';
const COMMAND_ID = '00000000-0000-4000-8000-000000000012';
const SYSTEM_COMMAND_ID = '00000000-0000-8000-8000-000000000012';
const SESSION_ID = '00000000-0000-4000-8000-000000000013';
const TURN_ID = '00000000-0000-4000-8000-000000000014';
const CHOICE_ID = '00000000-0000-4000-8000-000000000015';
const DIGEST = 'a'.repeat(64);

function event(overrides: Partial<AgentMissionEventSnapshot> = {}): AgentMissionEventSnapshot {
  return {
    id: EVENT_ID,
    companyId: 'company-1',
    ownerUserId: 'owner-1',
    missionId: MISSION_ID,
    sequence: 1,
    eventType: 'mission_started',
    eventVersion: 1,
    actor: 'user_tap',
    commandId: COMMAND_ID,
    requestFingerprintHmac: DIGEST,
    fingerprintKeyVersion: 2,
    fingerprintCanonicalizationVersion: 1,
    missionRevisionBefore: 0,
    missionRevisionAfter: 1,
    draftSlotRevisionBefore: null,
    draftSlotRevisionAfter: 1,
    draftContentRevisionBefore: null,
    draftContentRevisionAfter: 0,
    realtimeSessionId: null,
    turnId: null,
    contextRevision: null,
    contextDigest: null,
    data: { kind: 'mission_started', startOutcome: 'no_slot' },
    occurredAt: '2026-07-22T10:00:00.000Z',
    retentionExpiresAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

function dataFor(type: AgentMissionEventType): AgentMissionEventDataV1 {
  switch (type) {
    case 'mission_started':
      return { kind: type, startOutcome: 'no_slot' };
    case 'mission_joined':
    case 'draft_resume_selected':
    case 'draft_discard_requested':
    case 'draft_discard_cancelled':
    case 'draft_discard_confirmed':
      return { kind: type };
    case 'screen_acknowledged':
      return { kind: type, nextPhase: 'awaiting_customer' };
    case 'customer_resolution_staged':
      return { kind: type, result: 'choices', observedCandidateCount: 2 };
    case 'customer_not_found':
      return { kind: type, result: 'none' };
    case 'customer_choice_presented':
      return { kind: type, candidateCount: 2, choiceSetHash: DIGEST };
    case 'customer_selected':
      return {
        kind: type,
        customerId: 'customer-1',
        source: 'presented_choice',
        choiceId: CHOICE_ID,
        choiceSetHash: DIGEST,
      };
    case 'decision_invalidated':
      return { kind: type, reason: 'candidate_unavailable' };
    case 'line_candidates_staged':
      return {
        kind: type,
        stagedCount: 2,
        firstQueueOrdinal: 21,
        lastQueueOrdinal: 22,
      };
    case 'catalogue_not_found':
      return {
        kind: type,
        pendingLineId: EVENT_ID,
        workRevisionAfter: 3,
        result: 'none',
      };
    case 'catalogue_choices_presented':
      return {
        kind: type,
        pendingLineId: EVENT_ID,
        expectedWorkRevision: 2,
        candidateCount: 2,
        choiceSetHash: DIGEST,
      };
    case 'catalogue_choice_selected':
      return {
        kind: type,
        pendingLineId: EVENT_ID,
        workRevisionAfter: 3,
        resolution: 'selected',
        choiceId: CHOICE_ID,
        choiceSetHash: DIGEST,
      };
    case 'line_fact_patched':
      return {
        kind: type,
        pendingLineId: EVENT_ID,
        field: 'unit_price',
        workRevisionAfter: 4,
      };
    case 'line_details_requested':
      return {
        kind: type,
        pendingLineId: EVENT_ID,
        requiredFact: 'unit_price',
        workRevisionAfter: 4,
      };
    case 'line_proposal_presented':
      return {
        kind: type,
        pendingLineId: EVENT_ID,
        proposalId: MISSION_ID,
        proposalRevision: 1,
        expectedWorkRevision: 4,
        diffHash: DIGEST,
        choiceSetHash: DIGEST,
      };
    case 'line_proposal_rejected':
      return {
        kind: type,
        pendingLineId: EVENT_ID,
        proposalId: MISSION_ID,
        workRevisionAfter: 5,
        choiceId: CHOICE_ID,
        choiceSetHash: DIGEST,
      };
    case 'line_confirmed':
      return {
        kind: type,
        pendingLineId: EVENT_ID,
        proposalId: MISSION_ID,
        proposalRevision: 1,
        expectedWorkRevision: 4,
        choiceId: CHOICE_ID,
        choiceSetHash: DIGEST,
        diffHash: DIGEST,
      };
    case 'line_cancelled':
      return {
        kind: type,
        pendingLineId: EVENT_ID,
        expectedWorkRevision: 4,
        choiceId: CHOICE_ID,
        choiceSetHash: DIGEST,
      };
    case 'mission_cancelled':
      return { kind: type, reason: 'manual_handoff' };
    case 'mission_expired':
      return { kind: type, reason: 'idle_ttl' };
  }
}

function validEventFor(eventType: AgentMissionEventType): AgentMissionEventSnapshot {
  const isStart = eventType === 'mission_started';
  const systemContinuation = (
    eventType === 'catalogue_not_found'
    || eventType === 'catalogue_choices_presented'
    || eventType === 'line_details_requested'
    || eventType === 'line_proposal_presented'
  );
  const actor = (
    eventType === 'screen_acknowledged'
    || eventType === 'mission_expired'
    || systemContinuation
  )
    ? 'system'
    : 'user_tap';
  const needsScreenContext = eventType === 'screen_acknowledged';
  return event({
    eventType,
    actor,
    commandId: eventType === 'mission_expired' || systemContinuation
      ? SYSTEM_COMMAND_ID
      : COMMAND_ID,
    sequence: isStart ? 1 : 4,
    missionRevisionBefore: isStart ? 0 : 3,
    missionRevisionAfter: isStart ? 1 : 4,
    data: dataFor(eventType),
    draftSlotRevisionBefore: isStart ? null : 7,
    draftSlotRevisionAfter: isStart
      ? 1
      : eventType === 'draft_discard_confirmed'
        || eventType === 'customer_selected'
        || eventType === 'line_confirmed'
        ? 8
        : 7,
    draftContentRevisionBefore: isStart ? null : 3,
    draftContentRevisionAfter: isStart
      ? 0
      : eventType === 'draft_discard_confirmed'
        ? 0
        : eventType === 'customer_selected' || eventType === 'line_confirmed'
          ? 4
          : 3,
    realtimeSessionId: needsScreenContext ? SESSION_ID : null,
    turnId: null,
    contextRevision: needsScreenContext ? 2 : null,
    contextDigest: needsScreenContext ? DIGEST : null,
  });
}

describe('AgentMissionEvent', () => {
  it('partage des partitions exhaustives et disjointes avec les CHECK SQL générés', () => {
    const expectExactPartition = (
      universe: readonly string[],
      partitions: readonly (readonly string[])[],
    ): void => {
      const flattened = partitions.flat();
      expect(new Set(flattened)).toEqual(new Set(universe));
      expect(flattened).toHaveLength(universe.length);
    };

    expectExactPartition(AGENT_MISSION_EVENT_TYPES, [
      AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES,
      AGENT_MISSION_CORRELATION_SCREEN_ACK_EVENT_TYPES,
      AGENT_MISSION_CORRELATION_USER_EVENT_TYPES,
    ]);
    expectExactPartition(AGENT_MISSION_EVENT_TYPES, [
      AGENT_MISSION_DRAFT_START_EVENT_TYPES,
      AGENT_MISSION_DRAFT_NO_OP_EVENT_TYPES,
      AGENT_MISSION_DRAFT_REPLACE_EVENT_TYPES,
      AGENT_MISSION_DRAFT_ADVANCE_CUSTOMER_EVENT_TYPES,
      AGENT_MISSION_DRAFT_ADVANCE_LINE_EVENT_TYPES,
    ]);
    expectExactPartition(AGENT_MISSION_ACTORS, [
      AGENT_MISSION_VOICE_ACTORS,
      AGENT_MISSION_TAP_ACTORS,
      AGENT_MISSION_SYSTEM_ACTORS,
    ]);
    expect(new Set(AGENT_MISSION_USER_ACTORS)).toEqual(new Set([
      ...AGENT_MISSION_VOICE_ACTORS,
      ...AGENT_MISSION_TAP_ACTORS,
    ]));
    expectExactPartition(AGENT_MISSION_START_OUTCOMES, [
      AGENT_MISSION_START_NEW_SLOT_OUTCOMES,
      AGENT_MISSION_START_EXISTING_SLOT_OUTCOMES,
    ]);
    expectExactPartition(AGENT_MISSION_START_OUTCOMES, [
      AGENT_MISSION_START_DIRECT_DRAFT_OUTCOMES,
      AGENT_MISSION_START_CONFLICT_OUTCOMES,
    ]);
  });

  it('rejette les données brutes au-delà de 32 KiB avant toute persistance', () => {
    const source = validEventFor('mission_started');
    expect(AgentMissionEvent.record({
      ...source,
      data: {
        ...source.data,
        padding: 'x'.repeat(AGENT_MISSION_EVENT_MAX_DATA_BYTES),
      },
    })).toMatchObject({
      ok: false,
      error: { field: 'data', reason: 'payload_too_large' },
    });
  });

  it.each(AGENT_MISSION_EVENT_TYPES)('valide l’union exacte %s sans texte libre', (eventType) => {
    const result = AgentMissionEvent.record(validEventFor(eventType));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const snapshot = result.value.toSnapshot();
    expect(snapshot.eventType).toBe(eventType);
    expect(snapshot.data.kind).toBe(eventType);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.data)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('transcript');
  });

  it.each(AGENT_MISSION_CORRELATION_USER_EVENT_TYPES)(
    '%s réserve UUID v4 aux commandes utilisateur',
    (eventType) => {
      expect(AgentMissionEvent.record(validEventFor(eventType)).ok).toBe(true);
      expect(AgentMissionEvent.record({
        ...validEventFor(eventType),
        commandId: SYSTEM_COMMAND_ID,
      })).toMatchObject({
        ok: false,
        error: { field: 'commandId', reason: 'invalid_uuid_version' },
      });
    },
  );

  it.each(AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES)(
    '%s réserve UUID v8 aux commandes système',
    (eventType) => {
    expect(AgentMissionEvent.record(validEventFor(eventType)).ok).toBe(true);
    expect(AgentMissionEvent.record({
      ...validEventFor(eventType),
      commandId: COMMAND_ID,
    })).toMatchObject({
      ok: false,
        error: { field: 'commandId', reason: 'invalid_uuid_version' },
      });
    },
  );

  it.each(AGENT_MISSION_CORRELATION_SCREEN_ACK_EVENT_TYPES)(
    '%s consomme la commande UUID v4 du client et relit les ACK N-1 en UUID v8',
    (eventType) => {
      expect(AgentMissionEvent.record(validEventFor(eventType)).ok).toBe(true);
      expect(AgentMissionEvent.record({
        ...validEventFor(eventType),
        commandId: SYSTEM_COMMAND_ID,
      }).ok).toBe(true);
    },
  );

  it('rejette toute clé inconnue dans l’enveloppe et dans data', () => {
    expect(AgentMissionEvent.record({ ...event(), transcript: 'secret' })).toMatchObject({
      ok: false,
      error: { field: '$', reason: 'invalid_shape' },
    });
    expect(AgentMissionEvent.record(event({
      data: { kind: 'mission_started', startOutcome: 'no_slot', customerName: 'Secret' } as never,
    }))).toMatchObject({ ok: false, error: { field: 'data', reason: 'invalid_shape' } });
  });

  it('lie sequence, type de data et révisions avec start comme seule exception 0→1', () => {
    expect(AgentMissionEvent.record(event({ sequence: 2 }))).toMatchObject({
      ok: false,
      error: { field: 'sequence', reason: 'inconsistent_event' },
    });
    expect(AgentMissionEvent.record(event({ missionRevisionBefore: 1 }))).toMatchObject({
      ok: false,
      error: { field: 'missionRevisionBefore', reason: 'inconsistent_event' },
    });
    expect(AgentMissionEvent.record(event({
      eventType: 'mission_cancelled',
      sequence: 4,
      missionRevisionBefore: 2,
      missionRevisionAfter: 4,
      data: { kind: 'mission_cancelled', reason: 'user_cancelled' },
    }))).toMatchObject({ ok: false, error: { field: 'missionRevisionAfter' } });
    expect(AgentMissionEvent.record(event({
      eventType: 'mission_cancelled',
      sequence: 2,
      missionRevisionBefore: 1,
      missionRevisionAfter: 2,
      data: { kind: 'mission_expired', reason: 'idle_ttl' },
    }))).toMatchObject({ ok: false, error: { field: 'data.kind' } });
  });

  it.each([
    ['id', { id: 'not-a-uuid' }],
    ['missionId', { missionId: '00000000-0000-0000-0000-000000000000' }],
    ['commandId', { commandId: '00000000-0000-4000-8000-0000000000AA' }],
    ['companyId', { companyId: ' company-1' }],
    ['ownerUserId', { ownerUserId: 'owner\n1' }],
    ['ownerUserId', { ownerUserId: 'owner\u0085one' }],
    ['requestFingerprintHmac', { requestFingerprintHmac: 'A'.repeat(64) }],
    ['fingerprintKeyVersion', { fingerprintKeyVersion: 0 }],
    ['fingerprintKeyVersion', { fingerprintKeyVersion: AGENT_MISSION_EVENT_INT4_MAX + 1 }],
    ['occurredAt', { occurredAt: '2026-07-22T10:00:00Z' }],
    ['retentionExpiresAt', { retentionExpiresAt: '2026-07-22T09:00:00.000Z' }],
  ] as const)('refuse %s non canonique', (field, patch) => {
    expect(AgentMissionEvent.record(event(patch))).toMatchObject({
      ok: false,
      error: { field },
    });
  });

  it('valide le contexte tout-ou-rien et ses identifiants', () => {
    expect(AgentMissionEvent.record(event({ contextRevision: 2 }))).toMatchObject({
      ok: false,
      error: { field: 'context' },
    });
    expect(AgentMissionEvent.record(event({ contextDigest: DIGEST }))).toMatchObject({
      ok: false,
      error: { field: 'context' },
    });
    expect(AgentMissionEvent.record(event({
      realtimeSessionId: SESSION_ID,
      turnId: TURN_ID,
      contextRevision: 2,
      contextDigest: DIGEST,
      actor: 'user_voice',
    })).ok).toBe(true);
  });

  it('impose la rétention V1 exacte de 90 jours', () => {
    const occurredAt = '2026-07-22T10:00:00.000Z';
    expect(AgentMissionEvent.record(event({
      occurredAt,
      retentionExpiresAt: new Date(Date.parse(occurredAt) + AGENT_MISSION_EVENT_RETENTION_MS).toISOString(),
    })).ok).toBe(true);
    expect(AgentMissionEvent.record(event({
      occurredAt,
      retentionExpiresAt: new Date(Date.parse(occurredAt) + AGENT_MISSION_EVENT_RETENTION_MS + 1).toISOString(),
    }))).toMatchObject({ ok: false, error: { field: 'retentionExpiresAt' } });
  });

  it('exige choiceId et hash uniquement pour une sélection issue du jeu présenté', () => {
    const base = {
      eventType: 'customer_selected' as const,
      sequence: 2,
      missionRevisionBefore: 1,
      missionRevisionAfter: 2,
    };
    expect(AgentMissionEvent.record(event({
      ...base,
      data: {
        kind: 'customer_selected',
        customerId: 'customer-1',
        source: 'presented_choice',
        choiceId: null,
        choiceSetHash: null,
      },
    }))).toMatchObject({ ok: false, error: { field: 'data.choiceId' } });
    expect(AgentMissionEvent.record(event({
      ...base,
      data: {
        kind: 'customer_selected',
        customerId: 'customer-1',
        source: 'exact_match',
        choiceId: CHOICE_ID,
        choiceSetHash: DIGEST,
      },
    }))).toMatchObject({ ok: false, error: { field: 'data', reason: 'inconsistent_event' } });
  });

  it.each([0, 6, 1.5])('refuse candidateCount=%s hors borne', (candidateCount) => {
    expect(AgentMissionEvent.record(event({
      eventType: 'customer_choice_presented',
      sequence: 2,
      missionRevisionBefore: 1,
      missionRevisionAfter: 2,
      data: { kind: 'customer_choice_presented', candidateCount, choiceSetHash: DIGEST },
    }))).toMatchObject({ ok: false, error: { field: 'data.candidateCount' } });
  });

  it('clone les données avant stockage et à chaque lecture', () => {
    const source = event();
    const result = AgentMissionEvent.record(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    (source.data as { startOutcome: string }).startOutcome = 'draft_conflict';
    expect(result.value.toSnapshot().data).toEqual({ kind: 'mission_started', startOutcome: 'no_slot' });
    const output = result.value.toSnapshot();
    expect(() => {
      (output.data as { startOutcome: string }).startOutcome = 'draft_conflict';
    }).toThrow();
    expect(result.value.toSnapshot().data).toEqual({ kind: 'mission_started', startOutcome: 'no_slot' });
  });

  it('tolère toute valeur runtime inconnue sans lever et refuse les clés supplémentaires', () => {
    for (const candidate of [null, undefined, [], 'event', 42]) {
      expect(() => AgentMissionEvent.record(candidate)).not.toThrow();
      expect(AgentMissionEvent.record(candidate)).toMatchObject({
        ok: false,
        error: { field: '$', reason: 'invalid_shape' },
      });
    }
    expect(AgentMissionEvent.record({ ...event(), extra: true })).toMatchObject({
      ok: false,
      error: { field: '$', reason: 'invalid_shape' },
    });
    expect(() => AgentMissionEvent.record(event({ data: null as never }))).not.toThrow();
    expect(AgentMissionEvent.record(event({ data: null as never }))).toMatchObject({ ok: false });
  });

  it.each([
    ['Symbol', Symbol('digest')],
    ['objet coercible', { toString: () => DIGEST }],
  ] as const)('refuse sans lever un choiceSetHash %s dans les deux branches', (_label, choiceSetHash) => {
    const presented = {
      ...dataFor('customer_choice_presented'),
      choiceSetHash,
    };
    const selected = {
      ...dataFor('customer_selected'),
      choiceSetHash,
    };

    expect(() => AgentMissionEvent.record({
      ...validEventFor('customer_choice_presented'),
      data: presented as never,
    })).not.toThrow();
    expect(AgentMissionEvent.record({
      ...validEventFor('customer_choice_presented'),
      data: presented as never,
    })).toMatchObject({ ok: false, error: { field: 'data.choiceSetHash', reason: 'invalid_digest' } });
    expect(() => AgentMissionEvent.record({
      ...validEventFor('customer_selected'),
      data: selected as never,
    })).not.toThrow();
    expect(AgentMissionEvent.record({
      ...validEventFor('customer_selected'),
      data: selected as never,
    })).toMatchObject({ ok: false, error: { field: 'data.choiceSetHash', reason: 'invalid_digest' } });
  });

  it('accepte line_cancelled sans décision seulement avec la paire null/null', () => {
    const base = validEventFor('line_cancelled');
    const pendingLine = {
      ...dataFor('line_cancelled'),
      choiceId: null,
      choiceSetHash: null,
    };
    expect(AgentMissionEvent.record({
      ...base,
      data: pendingLine,
    }).ok).toBe(true);

    for (const mixed of [
      { ...pendingLine, choiceId: CHOICE_ID },
      { ...pendingLine, choiceSetHash: DIGEST },
    ]) {
      expect(AgentMissionEvent.record({
        ...base,
        data: mixed,
      })).toMatchObject({
        ok: false,
        error: { field: 'data', reason: 'inconsistent_event' },
      });
    }
  });
});

describe('AgentMissionEvent — matrice exhaustive acteur, contexte et effet draft', () => {
  const userEvents = AGENT_MISSION_CORRELATION_USER_EVENT_TYPES;
  const userOnlyEvents = userEvents.filter(
    (type) => !(AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES as readonly string[]).includes(type),
  );
  const noOpEvents = [
    'draft_resume_selected',
    'draft_discard_requested',
    'draft_discard_cancelled',
    'screen_acknowledged',
    'customer_not_found',
    'customer_choice_presented',
    'decision_invalidated',
    'line_candidates_staged',
    'catalogue_not_found',
    'catalogue_choices_presented',
    'catalogue_choice_selected',
    'line_fact_patched',
    'line_details_requested',
    'line_proposal_presented',
    'line_proposal_rejected',
    'line_cancelled',
    'mission_cancelled',
    'mission_expired',
  ] as const satisfies readonly AgentMissionEventType[];

  it.each(userEvents)('%s accepte voix complète, tap autonome et tap corrélé sans turn', (eventType) => {
    const base = validEventFor(eventType);
    expect(AgentMissionEvent.record({
      ...base,
      actor: 'user_voice',
      realtimeSessionId: SESSION_ID,
      turnId: TURN_ID,
      contextRevision: 2,
      contextDigest: DIGEST,
    }).ok).toBe(true);
    expect(AgentMissionEvent.record({
      ...base,
      actor: 'user_tap',
      realtimeSessionId: null,
      turnId: null,
      contextRevision: null,
      contextDigest: null,
    }).ok).toBe(true);
    expect(AgentMissionEvent.record({
      ...base,
      actor: 'user_tap',
      realtimeSessionId: SESSION_ID,
      turnId: null,
      contextRevision: 2,
      contextDigest: DIGEST,
    }).ok).toBe(true);
  });

  it.each(userOnlyEvents)('%s refuse l’acteur système', (eventType) => {
    expect(AgentMissionEvent.record({
      ...validEventFor(eventType),
      actor: 'system',
      commandId: SYSTEM_COMMAND_ID,
    })).toMatchObject({
      ok: false,
      error: { field: 'actor', reason: 'inconsistent_event' },
    });
  });

  it.each(AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES)(
    '%s accepte une continuation UUIDv8 autonome ou corrélée à l’ACK',
    (eventType) => {
      const base = validEventFor(eventType);
      const data = eventType === 'customer_selected'
        ? {
            kind: 'customer_selected' as const,
            customerId: 'customer-1',
            source: 'exact_match' as const,
            choiceId: null,
            choiceSetHash: null,
          }
        : base.data;
      const continuation = {
        ...base,
        actor: 'system' as const,
        commandId: SYSTEM_COMMAND_ID,
        realtimeSessionId: SESSION_ID,
        turnId: null,
        contextRevision: 2,
        contextDigest: DIGEST,
        data,
      };
      expect(AgentMissionEvent.record(continuation).ok).toBe(true);
      expect(AgentMissionEvent.record({
        ...continuation,
        realtimeSessionId: null,
        turnId: null,
        contextRevision: null,
        contextDigest: null,
      }).ok).toBe(true);
      expect(AgentMissionEvent.record({
        ...continuation,
        commandId: COMMAND_ID,
      })).toMatchObject({
        ok: false,
        error: { field: 'commandId', reason: 'invalid_uuid_version' },
      });
      for (const patch of [
        { realtimeSessionId: null },
        { contextRevision: null, contextDigest: null },
        { turnId: TURN_ID },
      ]) {
        expect(AgentMissionEvent.record({
          ...continuation,
          ...patch,
        })).toMatchObject({
          ok: false,
          error: { field: 'correlation', reason: 'inconsistent_event' },
        });
      }
    },
  );

  it.each(['screen_selection', 'presented_choice'] as const)(
    'refuse une sélection client système de source %s',
    (source) => {
      const base = validEventFor('customer_selected');
      expect(AgentMissionEvent.record({
        ...base,
        actor: 'system',
        commandId: SYSTEM_COMMAND_ID,
        realtimeSessionId: SESSION_ID,
        turnId: null,
        contextRevision: 2,
        contextDigest: DIGEST,
        data: {
          kind: 'customer_selected',
          customerId: 'customer-1',
          source,
          choiceId: source === 'presented_choice' ? CHOICE_ID : null,
          choiceSetHash: source === 'presented_choice' ? DIGEST : null,
        },
      })).toMatchObject({
        ok: false,
        error: { field: 'actor', reason: 'inconsistent_event' },
      });
    },
  );

  it.each(['user_voice', 'user_tap'] as const)('screen_acknowledged refuse l’acteur %s', (actor) => {
    expect(AgentMissionEvent.record({
      ...validEventFor('screen_acknowledged'),
      actor,
      commandId: COMMAND_ID,
    })).toMatchObject({
      ok: false,
      error: { field: 'actor', reason: 'inconsistent_event' },
    });
  });

  it.each(['user_voice', 'user_tap'] as const)('mission_expired refuse l’acteur %s', (actor) => {
    expect(AgentMissionEvent.record({
      ...validEventFor('mission_expired'),
      actor,
      commandId: COMMAND_ID,
    })).toMatchObject({
      ok: false,
      error: { field: 'actor', reason: 'inconsistent_event' },
    });
  });

  it.each(userEvents)('%s exige le tuple vocal session + turn + contexte complet', (eventType) => {
    const voice = {
      ...validEventFor(eventType),
      actor: 'user_voice' as const,
      realtimeSessionId: SESSION_ID,
      turnId: TURN_ID,
      contextRevision: 2,
      contextDigest: DIGEST,
    };
    for (const patch of [
      { realtimeSessionId: null },
      { turnId: null },
      { contextRevision: null, contextDigest: null },
    ]) {
      expect(AgentMissionEvent.record({ ...voice, ...patch })).toMatchObject({ ok: false });
    }
  });

  it.each(userEvents)('%s refuse les corrélations tap partielles ou dotées d’un turn', (eventType) => {
    const base = { ...validEventFor(eventType), actor: 'user_tap' as const };
    for (const patch of [
      { realtimeSessionId: SESSION_ID },
      { contextRevision: 2, contextDigest: DIGEST },
      { turnId: TURN_ID },
      {
        realtimeSessionId: SESSION_ID,
        turnId: TURN_ID,
        contextRevision: 2,
        contextDigest: DIGEST,
      },
    ]) {
      expect(AgentMissionEvent.record({ ...base, ...patch })).toMatchObject({ ok: false });
    }
  });

  it('impose les tuples système exacts pour ACK et expiration', () => {
    const ack = validEventFor('screen_acknowledged');
    for (const patch of [
      { realtimeSessionId: null },
      { contextRevision: null, contextDigest: null },
      { turnId: TURN_ID },
    ]) {
      expect(AgentMissionEvent.record({ ...ack, ...patch })).toMatchObject({ ok: false });
    }
    const expired = validEventFor('mission_expired');
    for (const patch of [
      { realtimeSessionId: SESSION_ID },
      { turnId: TURN_ID },
      { contextRevision: 2, contextDigest: DIGEST },
    ]) {
      expect(AgentMissionEvent.record({ ...expired, ...patch })).toMatchObject({ ok: false });
    }
  });

  it.each([
    ['no_slot', null, 1, null, 0, true],
    ['empty_slot_adopted', 7, 7, 3, 3, true],
    ['draft_conflict', 7, 7, 3, 3, true],
    ['no_slot', 7, 7, 3, 3, false],
    ['empty_slot_adopted', null, 1, null, 0, false],
    ['draft_conflict', 7, 8, 3, 3, false],
  ] as const)(
    'valide la table mission_started(%s) %s/%s/%s/%s => %s',
    (startOutcome, slotBefore, slotAfter, contentBefore, contentAfter, expected) => {
      const result = AgentMissionEvent.record(event({
        data: { kind: 'mission_started', startOutcome },
        draftSlotRevisionBefore: slotBefore,
        draftSlotRevisionAfter: slotAfter,
        draftContentRevisionBefore: contentBefore,
        draftContentRevisionAfter: contentAfter,
      }));
      expect(result.ok).toBe(expected);
    },
  );

  it.each(noOpEvents)('%s répète strictement les deux révisions draft', (eventType) => {
    const base = validEventFor(eventType);
    expect(AgentMissionEvent.record({ ...base, draftSlotRevisionAfter: 8 })).toMatchObject({ ok: false });
    expect(AgentMissionEvent.record({ ...base, draftContentRevisionAfter: 4 })).toMatchObject({ ok: false });
    expect(AgentMissionEvent.record({
      ...base,
      draftSlotRevisionBefore: null,
      draftSlotRevisionAfter: null,
      draftContentRevisionBefore: null,
      draftContentRevisionAfter: null,
    })).toMatchObject({ ok: false });
  });

  it.each([
    ['draft_discard_confirmed', 7, 8, 3, 0, true],
    ['draft_discard_confirmed', 7, 7, 3, 0, false],
    ['draft_discard_confirmed', 7, 8, 3, 1, false],
    ['customer_selected', 7, 8, 3, 4, true],
    ['customer_selected', 7, 7, 3, 4, false],
    ['customer_selected', 7, 8, 3, 3, false],
    ['line_confirmed', 7, 8, 3, 4, true],
    ['line_confirmed', 7, 7, 3, 4, false],
    ['line_confirmed', 7, 8, 3, 3, false],
  ] as const)(
    '%s impose le CAS draft %s→%s/%s→%s => %s',
    (eventType, slotBefore, slotAfter, contentBefore, contentAfter, expected) => {
      const result = AgentMissionEvent.record({
        ...validEventFor(eventType),
        draftSlotRevisionBefore: slotBefore,
        draftSlotRevisionAfter: slotAfter,
        draftContentRevisionBefore: contentBefore,
        draftContentRevisionAfter: contentAfter,
      });
      expect(result.ok).toBe(expected);
    },
  );

  it('rejette les couples draft avant/après incomplets', () => {
    const base = validEventFor('mission_cancelled');
    for (const patch of [
      { draftSlotRevisionBefore: null },
      { draftContentRevisionBefore: null },
      { draftSlotRevisionAfter: null },
      { draftContentRevisionAfter: null },
    ]) {
      expect(AgentMissionEvent.record({ ...base, ...patch })).toMatchObject({ ok: false });
    }
  });

  it('lie screen_selection au tap mais accepte exact_match depuis les deux canaux', () => {
    const base = validEventFor('customer_selected');
    const screenData = {
      kind: 'customer_selected' as const,
      customerId: 'customer-1',
      source: 'screen_selection' as const,
      choiceId: null,
      choiceSetHash: null,
    };
    expect(AgentMissionEvent.record({ ...base, data: screenData, actor: 'user_tap' }).ok).toBe(true);
    expect(AgentMissionEvent.record({
      ...base,
      data: screenData,
      actor: 'user_voice',
      realtimeSessionId: SESSION_ID,
      turnId: TURN_ID,
      contextRevision: 2,
      contextDigest: DIGEST,
    })).toMatchObject({ ok: false, error: { field: 'actor' } });

    const exactData = { ...screenData, source: 'exact_match' as const };
    expect(AgentMissionEvent.record({ ...base, data: exactData, actor: 'user_tap' }).ok).toBe(true);
    expect(AgentMissionEvent.record({
      ...base,
      data: exactData,
      actor: 'user_voice',
      realtimeSessionId: SESSION_ID,
      turnId: TURN_ID,
      contextRevision: 2,
      contextDigest: DIGEST,
    }).ok).toBe(true);
  });

  it('borne toutes les révisions au type PostgreSQL int4', () => {
    const maxEvent = {
      ...validEventFor('mission_cancelled'),
      sequence: AGENT_MISSION_EVENT_INT4_MAX,
      missionRevisionBefore: AGENT_MISSION_EVENT_INT4_MAX - 1,
      missionRevisionAfter: AGENT_MISSION_EVENT_INT4_MAX,
      draftSlotRevisionBefore: AGENT_MISSION_EVENT_INT4_MAX,
      draftSlotRevisionAfter: AGENT_MISSION_EVENT_INT4_MAX,
      draftContentRevisionBefore: AGENT_MISSION_EVENT_INT4_MAX,
      draftContentRevisionAfter: AGENT_MISSION_EVENT_INT4_MAX,
      contextRevision: null,
      contextDigest: null,
    };
    expect(AgentMissionEvent.record(maxEvent).ok).toBe(true);
    expect(AgentMissionEvent.record({
      ...maxEvent,
      sequence: AGENT_MISSION_EVENT_INT4_MAX + 1,
      missionRevisionAfter: AGENT_MISSION_EVENT_INT4_MAX + 1,
    })).toMatchObject({ ok: false, error: { field: 'missionRevisionAfter', reason: 'invalid_revision' } });

    const discard = validEventFor('draft_discard_confirmed');
    expect(AgentMissionEvent.record({
      ...discard,
      draftSlotRevisionBefore: AGENT_MISSION_EVENT_INT4_MAX,
      draftSlotRevisionAfter: AGENT_MISSION_EVENT_INT4_MAX,
    })).toMatchObject({ ok: false, error: { field: 'draftSlotRevisionBefore' } });
    const selected = validEventFor('customer_selected');
    expect(AgentMissionEvent.record({
      ...selected,
      draftContentRevisionBefore: AGENT_MISSION_EVENT_INT4_MAX,
      draftContentRevisionAfter: AGENT_MISSION_EVENT_INT4_MAX,
    })).toMatchObject({ ok: false, error: { field: 'draftContentRevisionBefore' } });
  });
});
