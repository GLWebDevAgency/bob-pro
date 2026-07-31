import { describe, expect, it } from 'vitest';
import {
  AgentMission,
  type AgentMissionResult,
} from '../../domain/agent/agent-mission';
import {
  type AgentMissionQuoteLineWorkRepositoryPort,
} from '../ports/agent-mission-quote-line-work';
import {
  type AgentMissionTransaction,
} from '../ports/agent-mission-unit-of-work';
import {
  type IdGeneratorPort,
} from '../ports/services';
import {
  type AgentMissionQuoteLineCandidateV1,
  createQueuedAgentMissionQuoteLineWork,
} from './quote-line-candidate';
import {
  AGENT_MISSION_QUOTE_LINE_MAX_ORDINAL,
  type AgentMissionQuoteLineWork,
} from './quote-line-work';
import {
  stageQuoteAgentMissionLinesInTransaction,
} from './stage-quote-agent-mission-lines';

const OWNER = Object.freeze({
  companyId: 'company-1',
  ownerUserId: 'owner-1',
});
const MISSION_ID = '00000000-0000-4000-8000-000000000001';
const OCCURRED_AT = '2026-07-29T10:00:00.000Z';

const CANDIDATE: AgentMissionQuoteLineCandidateV1 = Object.freeze({
  serviceReference: 'Main-d’œuvre plomberie',
  categoryHint: 'labor',
  quantityDecimal: '2',
  unitReference: 'heure',
  unitPriceDecimal: null,
  currency: null,
  priceBasis: null,
  vatRateHint: null,
});

function value<T>(result: AgentMissionResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function mission(protocolVersion: 1 | 2 = 2) {
  return value(AgentMission.start({
    id: MISSION_ID,
    ...OWNER,
    protocolVersion,
    createdAt: OCCURRED_AT,
    stagedCustomerResolution: null,
    startOutcome: 'no_slot',
    draft: {
      sessionId: 'quote-session-1',
      slotRevision: 1,
      contentRevision: 0,
    },
  })).mission;
}

function work(input: {
  readonly id: string;
  readonly ordinal: number;
}): AgentMissionQuoteLineWork {
  const created = createQueuedAgentMissionQuoteLineWork({
    ...input,
    ...OWNER,
    missionId: MISSION_ID,
    origin: 'user_voice',
    candidate: CANDIDATE,
    occurredAt: OCCURRED_AT,
  });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return created.value;
}

class SequenceIds implements IdGeneratorPort {
  private next = 100;

  newId(): string {
    const suffix = this.next.toString(16).padStart(12, '0');
    this.next += 1;
    return `00000000-0000-4000-8000-${suffix}`;
  }
}

function transaction(input: {
  readonly existing?: readonly AgentMissionQuoteLineWork[];
  readonly insertOutcome?: 'inserted' | 'conflict';
}) {
  const inserted: AgentMissionQuoteLineWork[][] = [];
  let listCalls = 0;
  const repository: AgentMissionQuoteLineWorkRepositoryPort = {
    listForUpdate: async () => {
      listCalls += 1;
      return input.existing ?? [];
    },
    findByIdForUpdate: async () => null,
    insertMany: async ({ workItems }) => {
      inserted.push([...workItems]);
      return input.insertOutcome ?? 'inserted';
    },
    updateCas: async () => 'revision_conflict',
    delete: async () => 'not_found',
    deleteAll: async () => 0,
  };
  return {
    inserted,
    listCalls: () => listCalls,
    value: { quoteLineWork: repository } as AgentMissionTransaction,
  };
}

describe('stageQuoteAgentMissionLinesInTransaction', () => {
  it('alloue des ordinals monotones après les trous sans réutiliser les rangs', async () => {
    const tx = transaction({
      existing: [
        work({ id: '00000000-0000-4000-8000-000000000010', ordinal: 2 }),
        work({ id: '00000000-0000-4000-8000-000000000011', ordinal: 9 }),
      ],
    });

    const result = await stageQuoteAgentMissionLinesInTransaction({
      transaction: tx.value,
      owner: OWNER,
      mission: mission(),
      confirmedLineCount: 0,
      candidates: [CANDIDATE, { ...CANDIDATE, serviceReference: 'Déplacement' }],
      origin: 'user_voice',
      occurredAt: OCCURRED_AT,
      ids: new SequenceIds(),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        firstQueueOrdinal: 10,
        lastQueueOrdinal: 11,
      },
    });
    expect(tx.inserted).toHaveLength(1);
    expect(tx.inserted[0]?.map((item) => item.ordinal)).toEqual([10, 11]);
    expect(tx.inserted[0]?.map((item) => item.origin)).toEqual([
      'user_voice',
      'user_voice',
    ]);
  });

  it('persiste le canonique partagé de l’unité au bord transactionnel', async () => {
    const tx = transaction({});

    const result = await stageQuoteAgentMissionLinesInTransaction({
      transaction: tx.value,
      owner: OWNER,
      mission: mission(),
      confirmedLineCount: 0,
      candidates: [{ ...CANDIDATE, unitReference: 'heures' }],
      origin: 'user_voice',
      occurredAt: OCCURRED_AT,
      ids: new SequenceIds(),
    });

    expect(result).toMatchObject({ ok: true });
    expect(tx.inserted).toHaveLength(1);
    expect(tx.inserted[0]?.[0]?.unit).toBe('heure');
  });

  it('refuse V1 avant de verrouiller ou écrire la file', async () => {
    const tx = transaction({});

    const result = await stageQuoteAgentMissionLinesInTransaction({
      transaction: tx.value,
      owner: OWNER,
      mission: mission(1),
      confirmedLineCount: 0,
      candidates: [CANDIDATE],
      origin: 'user_tap',
      occurredAt: OCCURRED_AT,
      ids: new SequenceIds(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_protocol',
        reason: 'upgrade_required',
      },
    });
    expect(tx.listCalls()).toBe(0);
    expect(tx.inserted).toHaveLength(0);
  });

  it('borne le nombre présent à vingt, pas la valeur de l’ordinal', async () => {
    const existing = Array.from({ length: 20 }, (_, index) => work({
      id: `00000000-0000-4000-8000-${(index + 20).toString(16).padStart(12, '0')}`,
      ordinal: index + 50,
    }));
    const tx = transaction({ existing });

    const result = await stageQuoteAgentMissionLinesInTransaction({
      transaction: tx.value,
      owner: OWNER,
      mission: mission(),
      confirmedLineCount: 0,
      candidates: [CANDIDATE],
      origin: 'user_voice',
      occurredAt: OCCURRED_AT,
      ids: new SequenceIds(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_quote_line_work',
        reason: 'queue_full',
      },
    });
    expect(tx.inserted).toHaveLength(0);
  });

  it('priorise la limite du brouillon sur la capacité technique de la file', async () => {
    const existing = Array.from({ length: 20 }, (_, index) => work({
      id: `00000000-0000-4000-8000-${(index + 70).toString(16).padStart(12, '0')}`,
      ordinal: index + 1,
    }));
    const tx = transaction({ existing });

    const result = await stageQuoteAgentMissionLinesInTransaction({
      transaction: tx.value,
      owner: OWNER,
      mission: mission(),
      confirmedLineCount: 80,
      candidates: [CANDIDATE],
      origin: 'user_voice',
      occurredAt: OCCURRED_AT,
      ids: new SequenceIds(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_quote_draft',
        reason: 'line_limit_reached',
      },
    });
    expect(tx.inserted).toHaveLength(0);
  });

  it('accepte exactement la centième ligne autoritaire du brouillon', async () => {
    const tx = transaction({});

    const result = await stageQuoteAgentMissionLinesInTransaction({
      transaction: tx.value,
      owner: OWNER,
      mission: mission(),
      confirmedLineCount: 99,
      candidates: [CANDIDATE],
      origin: 'user_voice',
      occurredAt: OCCURRED_AT,
      ids: new SequenceIds(),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        firstQueueOrdinal: 1,
        lastQueueOrdinal: 1,
      },
    });
    expect(tx.inserted).toHaveLength(1);
  });

  it('refuse toute file qui pourrait dépasser les cent lignes du brouillon', async () => {
    const tx = transaction({
      existing: [
        work({
          id: '00000000-0000-4000-8000-000000000012',
          ordinal: 1,
        }),
      ],
    });

    const result = await stageQuoteAgentMissionLinesInTransaction({
      transaction: tx.value,
      owner: OWNER,
      mission: mission(),
      confirmedLineCount: 99,
      candidates: [CANDIDATE],
      origin: 'user_voice',
      occurredAt: OCCURRED_AT,
      ids: new SequenceIds(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_mission_quote_draft',
        reason: 'line_limit_reached',
      },
    });
    expect(tx.inserted).toHaveLength(0);
  });

  it.each([-1, -0, 101, 1.5, Number.NaN])(
    'refuse fail-closed un nombre autoritaire de lignes invalide (%s)',
    async (confirmedLineCount) => {
      const tx = transaction({});

      const result = await stageQuoteAgentMissionLinesInTransaction({
        transaction: tx.value,
        owner: OWNER,
        mission: mission(),
        confirmedLineCount,
        candidates: [CANDIDATE],
        origin: 'user_voice',
        occurredAt: OCCURRED_AT,
        ids: new SequenceIds(),
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: 'dependency',
          port: 'quote_draft_slot',
          cause: 'invalid_confirmed_line_count',
        },
      });
      expect(tx.listCalls()).toBe(0);
      expect(tx.inserted).toHaveLength(0);
    },
  );

  it('refuse une collision concurrente et un dépassement INT4', async () => {
    const conflictTx = transaction({ insertOutcome: 'conflict' });
    const conflict = await stageQuoteAgentMissionLinesInTransaction({
      transaction: conflictTx.value,
      owner: OWNER,
      mission: mission(),
      confirmedLineCount: 0,
      candidates: [CANDIDATE],
      origin: 'user_voice',
      occurredAt: OCCURRED_AT,
      ids: new SequenceIds(),
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: {
        reason: 'concurrent_insert',
      },
    });

    const overflowTx = transaction({
      existing: [
        work({
          id: '00000000-0000-4000-8000-000000000099',
          ordinal: AGENT_MISSION_QUOTE_LINE_MAX_ORDINAL,
        }),
      ],
    });
    const overflow = await stageQuoteAgentMissionLinesInTransaction({
      transaction: overflowTx.value,
      owner: OWNER,
      mission: mission(),
      confirmedLineCount: 0,
      candidates: [CANDIDATE],
      origin: 'user_voice',
      occurredAt: OCCURRED_AT,
      ids: new SequenceIds(),
    });
    expect(overflow).toMatchObject({
      ok: false,
      error: {
        reason: 'ordinal_overflow',
      },
    });
    expect(overflowTx.inserted).toHaveLength(0);
  });
});
