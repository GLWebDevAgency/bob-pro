import { describe, expect, it, vi } from 'vitest';
import {
  planRealtimeSemanticTurn,
  type LlmPort,
  type LlmToolCall,
} from '@bob/ai';
import type {
  AgentMissionViewV1,
  DecideQuoteAgentMissionOutput,
  QuoteAgentMissionPlannerResumeV2,
  QuoteAgentMissionPresentationV1,
} from '@bob/core';
import {
  RealtimeQuoteMissionOrchestrator,
  type RealtimeQuoteMissionGateway,
  type RealtimeQuoteMissionOrchestrationInput,
} from './realtime-quote-mission-orchestrator';
import type {
  CancelQuoteAgentMissionPendingLineServiceOutput,
  DecideQuoteAgentMissionLineProposalServiceOutput,
  DecideQuoteAgentMissionCatalogueChoiceServiceOutput,
  PatchQuoteAgentMissionLineServiceOutput,
  StageQuoteAgentMissionLinesServiceOutput,
} from '../../agent-missions/agent-mission.service';

const OWNER = Object.freeze({
  companyId: 'company-1',
  ownerUserId: 'owner-1',
});
const PROOF = Object.freeze({
  protocolVersion: 1,
  subjectHashCandidates: Object.freeze(['a'.repeat(64)]),
  principalBindingHash: 'b'.repeat(64),
  capabilityHash: 'c'.repeat(64),
});
const PROOF_V2 = Object.freeze({ ...PROOF, protocolVersion: 2 });
const SESSION_ID = '20000000-0000-4000-8000-000000000001';
const TURN_ID = '10000000-0000-4000-8000-000000000001';
const LINE_ARGUMENTS = Object.freeze({
  service_reference: 'Main-d’œuvre plomberie',
  category_hint: 'labor',
  quantity_decimal: '2',
  unit_reference: 'heure',
  unit_price_decimal: '55',
  currency: 'EUR',
  price_basis: 'per_unit',
  vat_rate_hint: null,
});
const LINE_CANDIDATE = Object.freeze({
  serviceReference: 'Main-d’œuvre plomberie',
  categoryHint: 'labor',
  quantityDecimal: '2',
  unitReference: 'heure',
  unitPriceDecimal: '55',
  currency: 'EUR',
  priceBasis: 'per_unit',
  vatRateHint: null,
});
const EMPTY_PRESENTATION = Object.freeze({
  schema: 'bob.agent-mission.quote-presentation',
  version: 1,
  requiredFact: null,
  pendingLine: null,
  decision: null,
  catalogueChoices: Object.freeze([]),
  freeLineChoiceId: null,
  proposalStatus: Object.freeze({ kind: 'absent' }),
  proposal: null,
}) satisfies QuoteAgentMissionPresentationV1;

function plannerResumeForSnapshot(
  snapshot: {
    readonly mission: AgentMissionViewV1 | null;
    readonly presentation: QuoteAgentMissionPresentationV1 | null;
  },
): QuoteAgentMissionPlannerResumeV2 {
  if (snapshot.mission === null || snapshot.presentation === null) {
    return Object.freeze({
      resume: Object.freeze({ mission: null, presentation: null }),
      currentLine: null,
      confirmedLineCount: 0,
      pendingLineCount: 0,
    });
  }
  const draft = snapshot.mission.payload.draft;
  if (draft === null) throw new Error('fixture mission V2 sans brouillon');
  const customerDecision = snapshot.mission.payload.decision?.kind === 'customer'
    ? snapshot.mission.payload.decision
    : null;
  const resume = Object.freeze({
    mission: Object.freeze({
      id: snapshot.mission.id,
      status: snapshot.mission.status === 'active' ? 'active' : 'expired',
      phase: snapshot.mission.phase,
      revision: snapshot.mission.revision,
      actionable: snapshot.mission.actionable,
      draft: Object.freeze({ ...draft }),
      idleExpiresAt: snapshot.mission.idleExpiresAt,
      hardExpiresAt: snapshot.mission.hardExpiresAt,
    }),
    draft: Object.freeze({
      ...draft,
      step:
        snapshot.mission.phase === 'awaiting_customer'
        || snapshot.mission.phase === 'awaiting_customer_choice'
          ? ('client' as const)
          : ('lignes' as const),
    }),
    customerChoices: Object.freeze(
      customerDecision?.candidates.map((candidate, index) => Object.freeze({
        status: 'available' as const,
        choiceId: candidate.choiceId,
        label: `Client ${index + 1}`,
      })) ?? [],
    ),
    presentation: snapshot.presentation,
  });
  const pending = snapshot.presentation.pendingLine;
  return Object.freeze({
    resume,
    currentLine: pending === null
      ? null
      : Object.freeze({
          pendingLineId: pending.pendingLineId,
          expectedWorkRevision: pending.expectedWorkRevision,
          serviceReference: 'Main-d’œuvre plomberie',
          category: 'labor' as const,
          quantityMilli: 2_000,
          unit: 'heure',
          unitPriceCents:
            snapshot.mission.phase === 'awaiting_line_details' ? null : 5_500,
          requestedVatRate: 20 as const,
          priceBasis:
            snapshot.mission.phase === 'awaiting_line_details'
              ? null
              : 'per_unit' as const,
          housingOlderThan2y: null,
          energyRenovation: null,
        }),
    confirmedLineCount: 0,
    pendingLineCount: pending === null ? 0 : 1,
  });
}

function presentationForMission(
  value: AgentMissionViewV1 | null,
): QuoteAgentMissionPresentationV1 | null {
  if (value === null) return null;
  const decision = value.payload.decision;
  if (value.phase === 'awaiting_catalogue_choice' && decision?.kind === 'catalogue') {
    return Object.freeze({
      ...EMPTY_PRESENTATION,
      pendingLine: Object.freeze({
        pendingLineId: decision.pendingLineId,
        expectedWorkRevision: decision.expectedWorkRevision,
      }),
      decision: Object.freeze({
        kind: decision.kind,
        decisionId: decision.decisionId,
        choiceSetRevision: decision.choiceSetRevision,
        pendingLineId: decision.pendingLineId,
        expectedDraft: decision.expectedDraft,
        expectedWorkRevision: decision.expectedWorkRevision,
        choices: Object.freeze(decision.candidates.map((candidate) => Object.freeze({
          choiceId: candidate.choiceId,
          catalogueItemId: candidate.catalogueItemId,
          expectedCatalogueRevision: candidate.expectedCatalogueRevision,
        }))),
        freeLineChoiceId: decision.freeLineChoiceId,
        choiceSetHash: decision.choiceSetHash,
      }),
      catalogueChoices: Object.freeze(decision.candidates.map((candidate, index) => (
        Object.freeze({
          choiceId: candidate.choiceId,
          available: true,
          label: `Prestation ${index + 1}`,
          category: 'labor' as const,
          unit: 'heure',
          unitPriceCents: 5_500,
          vatRate: 20 as const,
        })
      ))),
      freeLineChoiceId: decision.freeLineChoiceId,
    });
  }
  if (value.phase === 'awaiting_line_details') {
    return Object.freeze({
      ...EMPTY_PRESENTATION,
      requiredFact: 'unit_price',
      pendingLine: Object.freeze({
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        expectedWorkRevision: 2,
      }),
    });
  }
  if (value.phase === 'awaiting_line_confirmation' && decision?.kind === 'line_confirmation') {
    return Object.freeze({
      ...EMPTY_PRESENTATION,
      pendingLine: Object.freeze({
        pendingLineId: decision.pendingLineId,
        expectedWorkRevision: decision.expectedWorkRevision,
      }),
      decision,
      proposalStatus: Object.freeze({ kind: 'available' }),
      proposal: Object.freeze({
        proposalId: decision.proposalId,
        diffHash: decision.diffHash,
        diff: Object.freeze({
          kind: 'append_line',
          before: Object.freeze({
            contentRevision: decision.expectedDraft.contentRevision,
            lineCount: 0,
            totalHtCents: 0,
          }),
          after: Object.freeze({
            contentRevision: decision.expectedDraft.contentRevision + 1,
            lineCount: 1,
            totalHtCents: 11_000,
          }),
        }),
        line: Object.freeze({
          label: 'Main-d’œuvre plomberie',
          category: 'labor',
          qty: 2,
          unitPriceHT: 5_500,
          vatRate: 20,
          unit: 'heures',
        }),
        catalogue: Object.freeze({
          itemId: 'catalogue-first',
          revision: 3,
          label: 'Heure de main-d’œuvre plomberie',
        }),
      }),
    });
  }
  return EMPTY_PRESENTATION;
}

function llm(call: LlmToolCall): LlmPort {
  return {
    id: 'test',
    complete: vi.fn(async () => ({
      text: null,
      toolCalls: [call],
      model: 'gpt-test',
    })),
    generate: vi.fn(async () => ({ text: '', model: 'gpt-test' })),
    health: vi.fn(async () => ({ healthy: true })),
  };
}

function toolCall(
  action:
    | 'start_quote_creation'
    | 'set_customer_reference'
    | 'select_presented_customer'
    | 'unrelated',
  customerReference: string | null,
  choiceOrdinal: number | null,
  extra: Readonly<Record<string, unknown>> = {},
): LlmToolCall {
  return {
    name: 'mettre_a_jour_mission_devis',
    arguments: {
      action,
      customer_reference: customerReference,
      choice_ordinal: choiceOrdinal,
      ...extra,
    },
  };
}

function toolCallV2(operation: Readonly<Record<string, unknown>>): LlmToolCall {
  return {
    name: 'mettre_a_jour_mission_devis_v2',
    arguments: { operations: [operation] },
  };
}

function mission(
  overrides: Partial<AgentMissionViewV1> = {},
): AgentMissionViewV1 {
  return {
    id: '30000000-0000-4000-8000-000000000001',
    kind: 'quote_creation',
    status: 'active',
    actionable: true,
    phase: 'awaiting_quote_screen',
    revision: 1,
    payloadVersion: 1,
    payload: {
      schema: 'bob.agent-mission.quote-creation',
      version: 1,
      draft: {
        sessionId: 'draft-session-1',
        slotRevision: 1,
        contentRevision: 0,
      },
      decision: null,
      stagedCustomerResolution: {
        kind: 'exact',
        customerId: 'customer-camping',
      },
    },
    currentBinding: null,
    idleExpiresAt: '2026-07-30T00:00:00.000Z',
    hardExpiresAt: '2026-08-05T00:00:00.000Z',
    terminalAt: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

function catalogueMission(): AgentMissionViewV1 {
  return mission({
    phase: 'awaiting_catalogue_choice',
    revision: 5,
    payload: {
      schema: 'bob.agent-mission.quote-creation',
      version: 1,
      draft: {
        sessionId: 'draft-session-1',
        slotRevision: 2,
        contentRevision: 1,
      },
      decision: {
        kind: 'catalogue',
        decisionId: '40000000-0000-4000-8000-000000000010',
        choiceSetRevision: 5,
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        expectedDraft: {
          sessionId: 'draft-session-1',
          slotRevision: 2,
          contentRevision: 1,
        },
        expectedWorkRevision: 2,
        candidates: [
          {
            choiceId: '50000000-0000-4000-8000-000000000010',
            catalogueItemId: 'catalogue-first',
            expectedCatalogueRevision: 3,
          },
          {
            choiceId: '50000000-0000-4000-8000-000000000011',
            catalogueItemId: 'catalogue-second',
            expectedCatalogueRevision: 7,
          },
        ],
        freeLineChoiceId: '50000000-0000-4000-8000-000000000012',
        choiceSetHash: 'e'.repeat(64),
      },
      stagedCustomerResolution: null,
    },
  });
}

function cataloguePresentationWithUnavailableOrdinal(
  value: AgentMissionViewV1,
  ordinal: number,
): QuoteAgentMissionPresentationV1 {
  const presentation = presentationForMission(value);
  if (presentation === null) throw new Error('catalogue presentation required');
  return Object.freeze({
    ...presentation,
    catalogueChoices: Object.freeze(
      presentation.catalogueChoices.map((choice, index) => (
        index + 1 === ordinal
          ? Object.freeze({
              ...choice,
              available: false,
              label: null,
              category: null,
              unit: null,
              unitPriceCents: null,
              vatRate: null,
            })
          : choice
      )),
    ),
  });
}

function lineConfirmationMission(): AgentMissionViewV1 {
  return mission({
    phase: 'awaiting_line_confirmation',
    revision: 8,
    payload: {
      schema: 'bob.agent-mission.quote-creation',
      version: 1,
      draft: {
        sessionId: 'draft-session-1',
        slotRevision: 2,
        contentRevision: 1,
      },
      decision: {
        kind: 'line_confirmation',
        decisionId: '40000000-0000-4000-8000-000000000020',
        choiceSetRevision: 8,
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        proposalId: '70000000-0000-4000-8000-000000000001',
        proposalRevision: 1,
        expectedDraft: {
          sessionId: 'draft-session-1',
          slotRevision: 2,
          contentRevision: 1,
        },
        expectedWorkRevision: 2,
        expectedCatalogue: {
          itemId: 'catalogue-first',
          revision: 3,
        },
        expectedVatContextDigest: 'd'.repeat(64),
        diffHash: 'f'.repeat(64),
        choices: [
          {
            choiceId: '50000000-0000-4000-8000-000000000020',
            action: 'confirm_line',
          },
          {
            choiceId: '50000000-0000-4000-8000-000000000021',
            action: 'edit_line',
          },
          {
            choiceId: '50000000-0000-4000-8000-000000000022',
            action: 'cancel_line',
          },
        ],
        choiceSetHash: 'e'.repeat(64),
      },
      stagedCustomerResolution: null,
    },
  });
}

function harness(input: {
  readonly call: LlmToolCall;
  readonly current?: AgentMissionViewV1 | null;
  readonly currentPresentation?: QuoteAgentMissionPresentationV1 | null;
  readonly currentAfterUnderstanding?: AgentMissionViewV1 | null;
  readonly currentPresentationAfterUnderstanding?:
    QuoteAgentMissionPresentationV1 | null;
  readonly currentAfterDecision?: AgentMissionViewV1 | null;
  readonly currentPresentationAfterDecision?:
    QuoteAgentMissionPresentationV1 | null;
  readonly started?: AgentMissionViewV1;
  readonly startFailure?: 'conflict' | 'line_limit_reached' | 'throws';
  readonly decided?: AgentMissionViewV1;
  readonly decisionOutcome?: 'selected' | 'invalidated' | 'presented' | 'not_found' | 'replayed';
  readonly replayEffect?: DecideQuoteAgentMissionOutput['effect'];
  readonly decisionFailure?: 'conflict' | 'line_limit_reached' | 'throws';
  readonly stageValue?: StageQuoteAgentMissionLinesServiceOutput;
  readonly stageFailure?: 'conflict' | 'line_limit_reached' | 'throws';
  readonly catalogueChoiceValue?:
    DecideQuoteAgentMissionCatalogueChoiceServiceOutput;
  readonly catalogueChoiceFailure?: 'conflict' | 'line_limit_reached' | 'throws';
  readonly patchValue?: PatchQuoteAgentMissionLineServiceOutput;
  readonly patchFailure?: 'conflict' | 'throws';
  readonly pendingLineCancellationValue?:
    CancelQuoteAgentMissionPendingLineServiceOutput;
  readonly pendingLineCancellationFailure?: 'conflict' | 'throws';
  readonly lineDecisionValue?: DecideQuoteAgentMissionLineProposalServiceOutput;
  readonly lineDecisionFailure?: 'conflict' | 'throws';
}) {
  let currentReadCount = 0;
  const getCurrent = vi.fn<RealtimeQuoteMissionGateway['getCurrent']>(async () => {
    const selected = currentReadCount > 0 && 'currentAfterDecision' in input
      ? input.currentAfterDecision ?? null
      : input.current ?? null;
    currentReadCount += 1;
    return {
      ok: true,
      value: { mission: selected },
    };
  });
  let currentV2ReadCount = 0;
  let lastV2Snapshot: {
    readonly mission: AgentMissionViewV1 | null;
    readonly presentation: QuoteAgentMissionPresentationV1 | null;
  } | null = null;
  const getCurrentV2 = vi.fn<
    RealtimeQuoteMissionGateway['getCurrentV2']
  >(async () => {
    const isUnderstandingRefresh = currentV2ReadCount === 1;
    const isPostDecisionRefresh = currentV2ReadCount >= 2;
    const selected = isPostDecisionRefresh
      ? (
          'currentAfterDecision' in input
            ? input.currentAfterDecision ?? null
            : input.decided ?? input.current ?? null
        )
      : isUnderstandingRefresh && 'currentAfterUnderstanding' in input
        ? input.currentAfterUnderstanding ?? null
        : input.current ?? null;
    const selectedPresentation = isPostDecisionRefresh
      ? (
          'currentPresentationAfterDecision' in input
            ? input.currentPresentationAfterDecision ?? null
            : presentationForMission(selected)
        )
      : isUnderstandingRefresh && 'currentPresentationAfterUnderstanding' in input
        ? input.currentPresentationAfterUnderstanding ?? null
        : 'currentPresentation' in input
          ? input.currentPresentation ?? null
          : presentationForMission(selected);
    currentV2ReadCount += 1;
    lastV2Snapshot = {
      mission: selected,
      presentation: selectedPresentation,
    };
    return {
      ok: true,
      value: lastV2Snapshot,
    };
  });
  const getCurrentPlannerResumeV2 = vi.fn<
    RealtimeQuoteMissionGateway['getCurrentPlannerResumeV2']
  >(async () => {
    if (lastV2Snapshot === null) {
      throw new Error('resume planner lu avant le snapshot capability');
    }
    return {
      ok: true,
      value: plannerResumeForSnapshot(lastV2Snapshot),
    };
  });
  const startFromVoiceTurn = vi.fn<RealtimeQuoteMissionGateway['startFromVoiceTurn']>(
    async () => {
      if (input.startFailure === 'throws') throw new Error('response lost');
      if (input.startFailure !== undefined) {
        return {
          ok: false,
          error: input.startFailure === 'line_limit_reached'
            ? {
                kind: 'conflict',
                entity: 'agent_mission_quote_draft',
                reason: 'line_limit_reached',
              }
            : {
                kind: 'conflict',
                entity: 'agent_mission',
                reason: 'stale_revision',
              },
        };
      }
      return {
        ok: true,
        value: {
          outcome: 'created',
          startOutcome: 'no_slot',
          mission: input.started ?? mission(),
        },
      };
    },
  );
  const decideFromVoiceTurn = vi.fn<
    RealtimeQuoteMissionGateway['decideFromVoiceTurn']
  >(async () => {
    if (input.decisionFailure === 'throws') {
      throw new Error('response lost');
    }
    if (input.decisionFailure === 'conflict') {
      return {
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission_decision',
          reason: 'revision_mismatch',
        },
      };
    }
    if (input.decisionFailure === 'line_limit_reached') {
      return {
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission_quote_draft',
          reason: 'line_limit_reached',
        },
      };
    }
    const outcome = input.decisionOutcome ?? 'selected';
    const missionView = input.decided ?? mission({
      phase: 'awaiting_lines',
      revision: 4,
      payload: {
        schema: 'bob.agent-mission.quote-creation',
        version: 1,
        draft: {
          sessionId: 'draft-session-1',
          slotRevision: 2,
          contentRevision: 1,
        },
        decision: null,
        stagedCustomerResolution: null,
      },
    });
    let value: DecideQuoteAgentMissionOutput;
    if (outcome === 'presented') {
      value = { outcome, effect: { kind: outcome, candidateCount: 2 }, mission: missionView };
    } else if (outcome === 'not_found') {
      value = { outcome, effect: { kind: outcome, result: 'none' }, mission: missionView };
    } else if (outcome === 'invalidated') {
      value = {
        outcome,
        effect: { kind: outcome, reason: 'candidate_unavailable' },
        mission: missionView,
      };
    } else if (outcome === 'replayed') {
      value = {
        outcome,
        effect: input.replayEffect ?? { kind: 'selected' },
        mission: missionView,
      };
    } else {
      value = { outcome, effect: { kind: outcome }, mission: missionView };
    }
    return {
      ok: true,
      value,
    };
  });
  const stageLinesFromVoiceTurn = vi.fn<
    RealtimeQuoteMissionGateway['stageLinesFromVoiceTurn']
  >(async () => {
    if (input.stageFailure === 'throws') throw new Error('response lost');
    if (input.stageFailure === 'conflict') {
      return {
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission',
          reason: 'stale_revision',
        },
      };
    }
    if (input.stageFailure === 'line_limit_reached') {
      return {
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission_quote_draft',
          reason: 'line_limit_reached',
        },
      };
    }
    const detailsMission = mission({ phase: 'awaiting_line_details', revision: 5 });
    return {
      ok: true,
      value: input.stageValue ?? {
        outcome: 'staged',
        mission: detailsMission,
        stagedCount: 1,
        firstQueueOrdinal: 1,
        lastQueueOrdinal: 1,
        continuation: {
          outcome: 'details_requested',
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          presentedChoiceCount: 0,
          requiredFact: 'unit_price',
          proposalId: null,
        },
        presentation: presentationForMission(detailsMission)!,
      },
    };
  });
  const decideCatalogueChoiceFromVoiceTurn = vi.fn<
    RealtimeQuoteMissionGateway['decideCatalogueChoiceFromVoiceTurn']
  >(async () => {
    if (input.catalogueChoiceFailure === 'throws') {
      throw new Error('response lost');
    }
    if (input.catalogueChoiceFailure === 'conflict') {
      return {
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission',
          reason: 'stale_revision',
        },
      };
    }
    if (input.catalogueChoiceFailure === 'line_limit_reached') {
      return {
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission_quote_draft',
          reason: 'line_limit_reached',
        },
      };
    }
    const detailsMission = mission({ phase: 'awaiting_line_details', revision: 7 });
    return {
      ok: true,
      value: input.catalogueChoiceValue ?? {
        outcome: 'selected',
        resolution: 'selected',
        invalidationReason: null,
        mission: detailsMission,
        continuation: {
          outcome: 'details_requested',
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          presentedChoiceCount: 0,
          requiredFact: 'unit_price',
          proposalId: null,
        },
        presentation: presentationForMission(detailsMission)!,
      },
    };
  });
  const patchLineFromVoiceTurn = vi.fn<
    RealtimeQuoteMissionGateway['patchLineFromVoiceTurn']
  >(async () => {
    if (input.patchFailure === 'throws') throw new Error('response lost');
    if (input.patchFailure === 'conflict') {
      return {
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission',
          reason: 'stale_revision',
        },
      };
    }
    const confirmationMission = lineConfirmationMission();
    return {
      ok: true,
      value: input.patchValue ?? {
        outcome: 'patched',
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        workRevisionAfter: 3,
        mission: confirmationMission,
        continuation: {
          outcome: 'proposal_presented',
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          presentedChoiceCount: 0,
          requiredFact: null,
          proposalId: '70000000-0000-4000-8000-000000000001',
        },
        presentation: presentationForMission(confirmationMission)!,
      },
    };
  });
  const cancelPendingLineFromVoiceTurn = vi.fn<
    RealtimeQuoteMissionGateway['cancelPendingLineFromVoiceTurn']
  >(async () => {
    if (input.pendingLineCancellationFailure === 'throws') {
      throw new Error('response lost');
    }
    if (input.pendingLineCancellationFailure === 'conflict') {
      return {
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission',
          reason: 'stale_revision',
        },
      };
    }
    const nextMission = mission({
      phase: 'awaiting_lines',
      revision: 8,
      payload: {
        schema: 'bob.agent-mission.quote-creation',
        version: 1,
        draft: {
          sessionId: 'draft-session-1',
          slotRevision: 2,
          contentRevision: 1,
        },
        decision: null,
        stagedCustomerResolution: null,
      },
    });
    return {
      ok: true,
      value: input.pendingLineCancellationValue ?? {
        outcome: 'cancelled',
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        mission: nextMission,
        continuation: {
          outcome: 'empty',
          pendingLineId: null,
          presentedChoiceCount: 0,
          requiredFact: null,
          proposalId: null,
        },
        presentation: presentationForMission(nextMission)!,
      },
    };
  });
  const decideLineProposalFromVoiceTurn = vi.fn<
    RealtimeQuoteMissionGateway['decideLineProposalFromVoiceTurn']
  >(async () => {
    if (input.lineDecisionFailure === 'throws') {
      throw new Error('response lost');
    }
    if (input.lineDecisionFailure === 'conflict') {
      return {
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission',
          reason: 'stale_revision',
        },
      };
    }
    const nextMission = mission({
      phase: 'awaiting_lines',
      revision: 10,
      payload: {
        schema: 'bob.agent-mission.quote-creation',
        version: 1,
        draft: {
          sessionId: 'draft-session-1',
          slotRevision: 3,
          contentRevision: 2,
        },
        decision: null,
        stagedCustomerResolution: null,
      },
    });
    return {
      ok: true,
      value: input.lineDecisionValue ?? {
        outcome: 'confirmed',
        invalidationReason: null,
        mission: nextMission,
        continuation: {
          outcome: 'empty',
          pendingLineId: null,
          presentedChoiceCount: 0,
          requiredFact: null,
          proposalId: null,
        },
        presentation: presentationForMission(nextMission)!,
      },
    };
  });
  const gateway: RealtimeQuoteMissionGateway = {
    getCurrent,
    getCurrentV2,
    getCurrentPlannerResumeV2,
    startFromVoiceTurn,
    decideFromVoiceTurn,
    stageLinesFromVoiceTurn,
    decideCatalogueChoiceFromVoiceTurn,
    patchLineFromVoiceTurn,
    cancelPendingLineFromVoiceTurn,
    decideLineProposalFromVoiceTurn,
  };
  const model = llm(input.call);
  const engine = new RealtimeQuoteMissionOrchestrator(gateway);
  const orchestrator = {
    run: async (
      request: RealtimeQuoteMissionOrchestrationInput,
    ): Promise<Awaited<ReturnType<typeof engine.runPlanned>>> => {
      const preparation = await engine.prepare(request);
      if (preparation.status === 'failed') return preparation;
      const planning = await planRealtimeSemanticTurn(model, {
        transcript: request.transcript,
        history: request.history.slice(-6),
        screen: null,
        quoteMission: preparation.prepared.semanticContext,
        hostManifest: {
          schema: 'bob.realtime-semantic-host-manifest',
          version: 1,
          globalToolNames: [],
        },
        missionCapabilities: preparation.prepared.availableCapabilities,
        locale: 'fr-FR',
        timeZone: null,
        now: '2026-07-30T12:00:00.000Z',
        signal: request.signal,
      });
      if (planning.status !== 'mission_frame') {
        return {
          status: 'failed',
          canonicalSpeech: planning.status === 'rejected'
            ? 'Je n’ai pas pu sécuriser cette demande. Rien n’a été exécuté. Reformule-la simplement.'
            : 'Ce tour ne relève pas de la mission devis.',
        };
      }
      return engine.runPlanned({
        request,
        prepared: preparation.prepared,
        frame: planning.frame,
      });
    },
  };
  return {
    orchestrator,
    engine,
    model,
    getCurrent,
    getCurrentV2,
    getCurrentPlannerResumeV2,
    startFromVoiceTurn,
    decideFromVoiceTurn,
    stageLinesFromVoiceTurn,
    decideCatalogueChoiceFromVoiceTurn,
    patchLineFromVoiceTurn,
    cancelPendingLineFromVoiceTurn,
    decideLineProposalFromVoiceTurn,
  };
}

function input(signal = new AbortController().signal) {
  return {
    authority: {
      owner: OWNER,
      proof: PROOF,
      realtimeSessionId: SESSION_ID,
    },
    turnId: TURN_ID,
    transcript: 'Fais un devis pour Camping les Pins',
    history: [],
    contextRevision: 4,
    contextDigest: 'f'.repeat(64),
    signal,
  };
}

function inputV2(
  signal = new AbortController().signal,
  history: readonly { readonly role: 'user' | 'bob'; readonly text: string }[] = [],
) {
  return {
    ...input(signal),
    authority: {
      owner: OWNER,
      proof: PROOF_V2,
      realtimeSessionId: SESSION_ID,
    },
    history,
  };
}

describe('RealtimeQuoteMissionOrchestrator', () => {
  it('persiste la mission et la référence client avant de rendre la navigation', async () => {
    const h = harness({
      call: toolCall('start_quote_creation', 'Camping les Pins', null),
    });

    const outcome = await h.orchestrator.run(input());

    expect(outcome).toEqual({
      status: 'ready',
      canonicalSpeech:
        'J’ai trouvé le client dans tes données. J’ouvre le devis et je poursuis dès que l’écran est prêt.',
      navigate: '/devis/new',
    });
    expect(h.startFromVoiceTurn).toHaveBeenCalledWith({
      authorization: { owner: OWNER, proof: PROOF },
      realtimeSessionId: SESSION_ID,
      turnId: TURN_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      customerReference: 'Camping les Pins',
      lines: [],
    });
    expect(h.getCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      h.startFromVoiceTurn.mock.invocationCallOrder[0]!,
    );
  });

  it('délègue uniquement un unrelated explicitement compris', async () => {
    const h = harness({
      call: toolCall('unrelated', null, null),
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech: 'Ce tour ne relève pas de la mission devis.',
    });
    expect(h.startFromVoiceTurn).not.toHaveBeenCalled();
  });

  it('échoue fermé sur des arguments LLM non exacts sans appeler le domaine', async () => {
    const h = harness({
      call: toolCall('start_quote_creation', 'Camping les Pins', null, {
        customerId: 'hallucinated-id',
      }),
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech:
        'Je n’ai pas pu sécuriser cette demande. Rien n’a été exécuté. Reformule-la simplement.',
    });
    expect(h.startFromVoiceTurn).not.toHaveBeenCalled();
  });

  it('résout une nouvelle référence client par le même use case durable sans renavigation', async () => {
    const h = harness({
      call: toolCall('set_customer_reference', 'Camping les Pins', null),
      current: mission({ phase: 'awaiting_customer' }),
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'Client confirmé. L’écran est à jour. Tu peux toucher Continuer à la main pour ajouter les prestations.',
      speechPurpose: 'action_result',
    });
    expect(h.decideFromVoiceTurn).toHaveBeenCalledWith({
      authorization: { owner: OWNER, proof: PROOF },
      missionId: '30000000-0000-4000-8000-000000000001',
      turnId: TURN_ID,
      realtimeSessionId: SESSION_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      expectedMissionRevision: 1,
      expectedDraftSessionId: 'draft-session-1',
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
      decision: {
        action: 'resolve_customer_reference',
        customerReference: 'Camping les Pins',
      },
      lines: [],
    });
    expect(h.startFromVoiceTurn).not.toHaveBeenCalled();
  });

  it('convertit un ordinal en choiceId persistant sans transmettre de customerId', async () => {
    const current = mission({
      phase: 'awaiting_customer_choice',
      revision: 3,
      payload: {
        schema: 'bob.agent-mission.quote-creation',
        version: 1,
        draft: {
          sessionId: 'draft-session-1',
          slotRevision: 1,
          contentRevision: 0,
        },
        decision: {
          kind: 'customer',
          decisionId: '40000000-0000-4000-8000-000000000001',
          choiceSetRevision: 3,
          candidates: [
            {
              choiceId: '50000000-0000-4000-8000-000000000001',
              customerId: 'customer-first',
            },
            {
              choiceId: '50000000-0000-4000-8000-000000000002',
              customerId: 'customer-second',
            },
          ],
          choiceSetHash: 'e'.repeat(64),
        },
        stagedCustomerResolution: null,
      },
    });
    const h = harness({
      call: toolCall('select_presented_customer', null, 2),
      current,
    });

    await expect(h.orchestrator.run(input())).resolves.toMatchObject({
      status: 'handled',
      speechPurpose: 'action_result',
    });
    expect(h.decideFromVoiceTurn).toHaveBeenCalledWith(expect.objectContaining({
      missionId: current.id,
      expectedMissionRevision: 3,
      decision: {
        action: 'choose_presented_option',
        decisionId: '40000000-0000-4000-8000-000000000001',
        choiceSetRevision: 3,
        choiceId: '50000000-0000-4000-8000-000000000002',
      },
    }));
    expect(h.decideFromVoiceTurn.mock.calls[0]?.[0].decision).not.toHaveProperty(
      'customerId',
    );
  });

  it('rend un choix structuré quand la résolution réelle reste ambiguë', async () => {
    const choices = mission({
      phase: 'awaiting_customer_choice',
      revision: 2,
      payload: {
        schema: 'bob.agent-mission.quote-creation',
        version: 1,
        draft: {
          sessionId: 'draft-session-1',
          slotRevision: 1,
          contentRevision: 0,
        },
        decision: {
          kind: 'customer',
          decisionId: '40000000-0000-4000-8000-000000000001',
          choiceSetRevision: 2,
          candidates: [
            {
              choiceId: '50000000-0000-4000-8000-000000000001',
              customerId: 'customer-first',
            },
            {
              choiceId: '50000000-0000-4000-8000-000000000002',
              customerId: 'customer-second',
            },
          ],
          choiceSetHash: 'e'.repeat(64),
        },
        stagedCustomerResolution: null,
      },
    });
    const h = harness({
      call: toolCall('set_customer_reference', 'Camping', null),
      current: mission({ phase: 'awaiting_customer' }),
      decided: choices,
      decisionOutcome: 'presented',
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'J’ai trouvé 2 clients possibles, affichés dans le même ordre. Dis-moi le premier, le deuxième, ou précise le nom.',
      speechPurpose: 'structured_choice',
    });
  });

  it('relit l’autorité quand le tap gagne la course et annonce l’état convergé', async () => {
    const h = harness({
      call: toolCall('set_customer_reference', 'Camping les Pins', null),
      current: mission({ phase: 'awaiting_customer' }),
      currentAfterDecision: mission({
        phase: 'awaiting_lines',
        revision: 4,
        payload: {
          schema: 'bob.agent-mission.quote-creation',
          version: 1,
          draft: {
            sessionId: 'draft-session-1',
            slotRevision: 2,
            contentRevision: 1,
          },
          decision: null,
          stagedCustomerResolution: null,
        },
      }),
      decisionFailure: 'conflict',
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'Le client est déjà confirmé. J’ai actualisé le devis avec l’état enregistré.',
      speechPurpose: 'action_result',
    });
    expect(h.getCurrent).toHaveBeenCalledTimes(2);
  });

  it('relit l’autorité après une réponse réseau perdue au lieu d’inventer un échec', async () => {
    const h = harness({
      call: toolCall('set_customer_reference', 'Camping les Pins', null),
      current: mission({ phase: 'awaiting_customer' }),
      currentAfterDecision: mission({
        phase: 'awaiting_lines',
        revision: 4,
        payload: {
          schema: 'bob.agent-mission.quote-creation',
          version: 1,
          draft: {
            sessionId: 'draft-session-1',
            slotRevision: 2,
            contentRevision: 1,
          },
          decision: null,
          stagedCustomerResolution: null,
        },
      }),
      decisionFailure: 'throws',
    });

    await expect(h.orchestrator.run(input())).resolves.toMatchObject({
      status: 'handled',
      canonicalSpeech:
        'Le client est déjà confirmé. J’ai actualisé le devis avec l’état enregistré.',
    });
    expect(h.getCurrent).toHaveBeenCalledTimes(2);
  });

  it('ne présente pas comme actuels les choix d’un replay devenu historique', async () => {
    const h = harness({
      call: toolCall('set_customer_reference', 'Camping', null),
      current: mission({ phase: 'awaiting_customer' }),
      decided: mission({
        phase: 'awaiting_lines',
        revision: 5,
        payload: {
          schema: 'bob.agent-mission.quote-creation',
          version: 1,
          draft: {
            sessionId: 'draft-session-1',
            slotRevision: 2,
            contentRevision: 1,
          },
          decision: null,
          stagedCustomerResolution: null,
        },
      }),
      decisionOutcome: 'replayed',
      replayEffect: { kind: 'presented', candidateCount: 2 },
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'Le client est déjà confirmé. J’ai actualisé le devis avec l’état enregistré.',
      speechPurpose: 'action_result',
    });
  });

  it('ne redélègue jamais au cerveau générique pendant une phase mission non actionnable', async () => {
    const h = harness({
      call: toolCall('unrelated', null, null),
      current: mission({ phase: 'awaiting_quote_screen' }),
    });

    await expect(h.orchestrator.run(input())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech:
        'Je n’ai pas pu sécuriser cette demande. Rien n’a été exécuté. Reformule-la simplement.',
    });
    expect(h.model.complete).toHaveBeenCalledOnce();
    expect(h.startFromVoiceTurn).not.toHaveBeenCalled();
  });

  it('V2 conserve client et ligne et fournit l’historique borné au planner unique', async () => {
    const h = harness({
      call: toolCallV2({
        kind: 'start_quote_creation',
        customer_reference: 'Camping les Pins',
        lines: [LINE_ARGUMENTS],
      }),
    });

    const outcome = await h.orchestrator.run(inputV2(
      new AbortController().signal,
      [{ role: 'bob', text: 'Historique récent utile au planner V2.' }],
    ));

    expect(outcome).toMatchObject({
      status: 'ready',
      navigate: '/devis/new',
    });
    expect(h.startFromVoiceTurn).toHaveBeenCalledWith({
      authorization: { owner: OWNER, proof: PROOF_V2 },
      realtimeSessionId: SESSION_ID,
      turnId: TURN_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      customerReference: 'Camping les Pins',
      lines: [LINE_CANDIDATE],
    });
    const llmMessages = vi.mocked(h.model.complete).mock.calls[0]?.[0];
    expect(JSON.stringify(llmMessages)).toContain(
      'Historique récent utile au planner V2.',
    );
  });

  it('V2 annonce aussi la capacité lors du démarrage sur un brouillon déjà plein', async () => {
    const h = harness({
      call: toolCallV2({
        kind: 'start_quote_creation',
        customer_reference: 'Camping les Pins',
        lines: [LINE_ARGUMENTS],
      }),
      startFailure: 'line_limit_reached',
    });

    await expect(h.orchestrator.run(inputV2())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'Ce devis contient déjà 100 lignes, soit la limite autorisée. Je n’ai ajouté aucune nouvelle ligne. Pour modifier ses lignes, arrête cette mission Bob : le brouillon restera enregistré et l’édition manuelle sera libérée.',
      speechPurpose: 'action_result',
    });
    expect(h.startFromVoiceTurn).toHaveBeenCalledOnce();
  });

  it('V2 stage la ligne puis rend uniquement le choix catalogue réellement scellé', async () => {
    const choices = catalogueMission();
    const h = harness({
      call: toolCallV2({
        kind: 'append_line_candidates',
        lines: [LINE_ARGUMENTS],
      }),
      current: mission({
        phase: 'awaiting_lines',
        revision: 3,
        payload: {
          schema: 'bob.agent-mission.quote-creation',
          version: 1,
          draft: {
            sessionId: 'draft-session-1',
            slotRevision: 2,
            contentRevision: 1,
          },
          decision: null,
          stagedCustomerResolution: null,
        },
      }),
      stageValue: {
        outcome: 'staged',
        mission: choices,
        stagedCount: 1,
        firstQueueOrdinal: 1,
        lastQueueOrdinal: 1,
        continuation: {
          outcome: 'choices_presented',
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          presentedChoiceCount: 3,
          requiredFact: null,
          proposalId: null,
        },
        presentation: presentationForMission(choices)!,
      },
    });

    await expect(h.orchestrator.run(inputV2())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'J’ai trouvé 2 prestations disponibles dans ton catalogue. Premier choix : « Prestation 1 », à 55 € hors taxes par heure. Deuxième choix : « Prestation 2 », à 55 € hors taxes par heure. Dernier choix : créer une ligne libre. Tu peux dire le premier, le deuxième, ou le choix que tu veux.',
      speechPurpose: 'structured_choice',
    });
    expect(h.stageLinesFromVoiceTurn).toHaveBeenCalledWith({
      authorization: { owner: OWNER, proof: PROOF_V2 },
      missionId: '30000000-0000-4000-8000-000000000001',
      turnId: TURN_ID,
      realtimeSessionId: SESSION_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      expectedMissionRevision: 3,
      expectedDraftSessionId: 'draft-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      lines: [LINE_CANDIDATE],
    });
  });

  it('V2 annonce la capacité autoritaire sans convergence ambiguë ni retry', async () => {
    const h = harness({
      call: toolCallV2({
        kind: 'append_line_candidates',
        lines: [LINE_ARGUMENTS],
      }),
      current: mission({
        phase: 'awaiting_lines',
        revision: 3,
        payload: {
          schema: 'bob.agent-mission.quote-creation',
          version: 1,
          draft: {
            sessionId: 'draft-session-1',
            slotRevision: 2,
            contentRevision: 100,
          },
          decision: null,
          stagedCustomerResolution: null,
        },
      }),
      stageFailure: 'line_limit_reached',
    });

    await expect(h.orchestrator.run(inputV2())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'Ce devis contient déjà 100 lignes, soit la limite autorisée. Je n’ai ajouté aucune nouvelle ligne. Pour modifier ses lignes, arrête cette mission Bob : le brouillon restera enregistré et l’édition manuelle sera libérée.',
      speechPurpose: 'action_result',
    });
    expect(h.stageLinesFromVoiceTurn).toHaveBeenCalledOnce();
    expect(h.getCurrentV2).toHaveBeenCalledTimes(2);
  });

  it('V2 annonce la capacité lors de la résolution client atomique avec lignes', async () => {
    const h = harness({
      call: toolCallV2({
        kind: 'set_customer_reference',
        customer_reference: 'Camping les Pins',
        lines: [LINE_ARGUMENTS],
      }),
      current: mission({
        phase: 'awaiting_customer',
        revision: 3,
        payload: {
          schema: 'bob.agent-mission.quote-creation',
          version: 1,
          draft: {
            sessionId: 'draft-session-1',
            slotRevision: 2,
            contentRevision: 100,
          },
          decision: null,
          stagedCustomerResolution: null,
        },
      }),
      decisionFailure: 'line_limit_reached',
    });

    await expect(h.orchestrator.run(inputV2())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'Ce devis contient déjà 100 lignes, soit la limite autorisée. Je n’ai ajouté aucune nouvelle ligne. Pour modifier ses lignes, arrête cette mission Bob : le brouillon restera enregistré et l’édition manuelle sera libérée.',
      speechPurpose: 'action_result',
    });
    expect(h.decideFromVoiceTurn).toHaveBeenCalledOnce();
    expect(h.getCurrentV2).toHaveBeenCalledTimes(2);
  });

  it('V2 résout l’ordinal catalogue vers le choiceId scellé sans transmettre itemId', async () => {
    const current = catalogueMission();
    const h = harness({
      call: toolCallV2({
        kind: 'select_presented_choice',
        ordinal: 2,
        lines: [LINE_ARGUMENTS],
      }),
      current,
    });

    await expect(h.orchestrator.run(inputV2())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech: 'Quel prix unitaire dois-je appliquer à cette ligne ?',
      speechPurpose: 'structured_choice',
    });
    expect(h.decideCatalogueChoiceFromVoiceTurn).toHaveBeenCalledWith({
      authorization: { owner: OWNER, proof: PROOF_V2 },
      missionId: current.id,
      turnId: TURN_ID,
      realtimeSessionId: SESSION_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      expectedMissionRevision: 5,
      expectedDraftSessionId: 'draft-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      decisionId: '40000000-0000-4000-8000-000000000010',
      choiceSetRevision: 5,
      pendingLineId: '60000000-0000-4000-8000-000000000001',
      expectedWorkRevision: 2,
      choiceId: '50000000-0000-4000-8000-000000000011',
      additionalLines: [LINE_CANDIDATE],
    });
    expect(
      h.decideCatalogueChoiceFromVoiceTurn.mock.calls[0]?.[0],
    ).not.toHaveProperty('catalogueItemId');
  });

  it('V2 annonce la capacité quand un choix catalogue transporte des lignes supplémentaires', async () => {
    const current = catalogueMission();
    const h = harness({
      call: toolCallV2({
        kind: 'select_presented_choice',
        ordinal: 2,
        lines: [LINE_ARGUMENTS],
      }),
      current,
      catalogueChoiceFailure: 'line_limit_reached',
    });

    await expect(h.orchestrator.run(inputV2())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'Ce devis contient déjà 100 lignes, soit la limite autorisée. Je n’ai ajouté aucune nouvelle ligne. Pour modifier ses lignes, arrête cette mission Bob : le brouillon restera enregistré et l’édition manuelle sera libérée.',
      speechPurpose: 'action_result',
    });
    expect(h.decideCatalogueChoiceFromVoiceTurn).toHaveBeenCalledOnce();
    expect(h.getCurrentV2).toHaveBeenCalledTimes(2);
  });

  it('V2 refuse sans mutation un ordinal catalogue devenu indisponible', async () => {
    const current = catalogueMission();
    const currentPresentation =
      cataloguePresentationWithUnavailableOrdinal(current, 1);
    const h = harness({
      call: toolCallV2({
        kind: 'select_presented_choice',
        ordinal: 1,
        lines: [],
      }),
      current,
      currentPresentation,
    });

    await expect(h.orchestrator.run(inputV2())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'La prestation numéro 1 n’est plus disponible dans ton catalogue. Rien n’a été sélectionné. Choisis une autre option affichée ou la ligne libre.',
      speechPurpose: 'structured_choice',
    });
    expect(h.decideCatalogueChoiceFromVoiceTurn).not.toHaveBeenCalled();
  });

  it('V2 mappe le dernier ordinal vers la ligne libre scellée', async () => {
    const current = catalogueMission();
    const h = harness({
      call: toolCallV2({
        kind: 'select_presented_choice',
        ordinal: 3,
        lines: [],
      }),
      current,
      catalogueChoiceValue: {
        outcome: 'selected',
        resolution: 'free',
        invalidationReason: null,
        mission: mission({ phase: 'awaiting_line_details', revision: 7 }),
        continuation: {
          outcome: 'details_requested',
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          presentedChoiceCount: 0,
          requiredFact: 'unit_price',
          proposalId: null,
        },
        presentation: EMPTY_PRESENTATION,
      },
    });

    await h.orchestrator.run(inputV2());
    expect(h.decideCatalogueChoiceFromVoiceTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        choiceId: '50000000-0000-4000-8000-000000000012',
        additionalLines: [],
      }),
    );
  });

  it('V2 répond au fait manquant avec le patch mono-champ et les fences fraîches', async () => {
    const current = mission({
      phase: 'awaiting_line_details',
      revision: 6,
      payload: {
        schema: 'bob.agent-mission.quote-creation',
        version: 1,
        draft: {
          sessionId: 'draft-session-1',
          slotRevision: 2,
          contentRevision: 1,
        },
        decision: null,
        stagedCustomerResolution: null,
      },
    });
    const h = harness({
      call: toolCallV2({
        kind: 'patch_pending_line',
        scope: 'answer_required_fact',
        patch: {
          field: 'unit_price',
          decimal: '55',
          currency: 'EUR',
          basis: 'per_unit',
        },
      }),
      current,
    });

    const outcome = await h.orchestrator.run(inputV2());

    expect(h.getCurrentV2).toHaveBeenCalledTimes(2);
    expect(h.model.complete).toHaveBeenCalledTimes(1);
    expect(h.patchLineFromVoiceTurn).toHaveBeenCalledTimes(1);
    const plannerMessages =
      vi.mocked(h.model.complete).mock.calls[0]?.[0] ?? [];
    const plannerContext = plannerMessages.at(-1)?.content ?? '';
    expect(plannerContext).toContain('"label":"Main-d’œuvre plomberie"');
    expect(plannerContext).toContain('"quantityDecimal":"2"');
    expect(plannerContext).toContain('"unit":"heure"');
    expect(plannerContext).toContain('"unitPriceDecimal":null');
    expect(plannerContext).toContain('"vatRate":"20"');
    expect(outcome).toMatchObject({
      status: 'handled',
      speechPurpose: 'structured_choice',
    });
    expect(outcome).toHaveProperty(
      'canonicalSpeech',
      expect.stringContaining('Main-d’œuvre plomberie'),
    );
    expect(outcome).toHaveProperty(
      'canonicalSpeech',
      expect.stringContaining('passerait de 0 € à 110 €'),
    );
    expect(outcome).toHaveProperty(
      'canonicalSpeech',
      expect.stringContaining('55\u00a0€ hors taxes par unité'),
    );
    expect(h.patchLineFromVoiceTurn).toHaveBeenCalledWith({
      authorization: { owner: OWNER, proof: PROOF_V2 },
      missionId: current.id,
      turnId: TURN_ID,
      realtimeSessionId: SESSION_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      expectedMissionRevision: 6,
      expectedDraftSessionId: 'draft-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      pendingLineId: '60000000-0000-4000-8000-000000000001',
      expectedWorkRevision: 2,
      scope: 'answer_required_fact',
      patch: {
        field: 'unit_price',
        decimal: '55',
        currency: 'EUR',
        basis: 'per_unit',
      },
    });
    expect(h.getCurrentV2).toHaveBeenCalledTimes(2);
    const modelInput = JSON.stringify(
      vi.mocked(h.model.complete).mock.calls[0]?.[0],
    );
    expect(modelInput).not.toContain(
      '60000000-0000-4000-8000-000000000001',
    );
    expect(modelInput).not.toContain('Heure de main-d’œuvre plomberie');
  });

  it('V2 refuse la mutation si la projection change pendant la compréhension', async () => {
    const current = mission({
      phase: 'awaiting_line_details',
      revision: 6,
      payload: {
        schema: 'bob.agent-mission.quote-creation',
        version: 1,
        draft: {
          sessionId: 'draft-session-1',
          slotRevision: 2,
          contentRevision: 1,
        },
        decision: null,
        stagedCustomerResolution: null,
      },
    });
    const changed = mission({
      phase: 'awaiting_line_details',
      revision: 7,
      payload: current.payload,
    });
    const changedPresentation = Object.freeze({
      ...presentationForMission(changed)!,
      pendingLine: Object.freeze({
        pendingLineId: '60000000-0000-4000-8000-000000000001',
        expectedWorkRevision: 3,
      }),
    });
    const h = harness({
      call: toolCallV2({
        kind: 'patch_pending_line',
        scope: 'answer_required_fact',
        patch: {
          field: 'unit_price',
          decimal: '55',
          currency: 'EUR',
          basis: 'per_unit',
        },
      }),
      current,
      currentAfterUnderstanding: changed,
      currentPresentationAfterUnderstanding: changedPresentation,
    });

    await expect(h.orchestrator.run(inputV2())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech: 'Quel prix unitaire dois-je appliquer à cette ligne ?',
      speechPurpose: 'structured_choice',
    });
    expect(h.patchLineFromVoiceTurn).not.toHaveBeenCalled();
    expect(h.getCurrentV2).toHaveBeenCalledTimes(2);
  });

  it('V2 annule une ligne encore incomplète avec les fences fraîches, sans choix inventé', async () => {
    const current = mission({
      phase: 'awaiting_line_details',
      revision: 6,
      payload: {
        schema: 'bob.agent-mission.quote-creation',
        version: 1,
        draft: {
          sessionId: 'draft-session-1',
          slotRevision: 2,
          contentRevision: 1,
        },
        decision: null,
        stagedCustomerResolution: null,
      },
    });
    const h = harness({
      call: toolCallV2({ kind: 'cancel_current_line' }),
      current,
    });

    const outcome = await h.orchestrator.run(inputV2());

    expect(outcome).toHaveProperty(
      'canonicalSpeech',
      expect.stringContaining(
        'La ligne est retirée de la mission. Le devis n’a pas été modifié.',
      ),
    );
    expect(h.cancelPendingLineFromVoiceTurn).toHaveBeenCalledWith({
      authorization: { owner: OWNER, proof: PROOF_V2 },
      missionId: current.id,
      turnId: TURN_ID,
      realtimeSessionId: SESSION_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      expectedMissionRevision: 6,
      expectedDraftSessionId: 'draft-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      pendingLineId: '60000000-0000-4000-8000-000000000001',
      expectedWorkRevision: 2,
    });
    expect(h.decideLineProposalFromVoiceTurn).not.toHaveBeenCalled();
    const modelInput = JSON.stringify(
      vi.mocked(h.model.complete).mock.calls[0]?.[0],
    );
    expect(modelInput).not.toContain(
      '60000000-0000-4000-8000-000000000001',
    );
  });

  it('V2 converge sur l’état réel si la réponse réseau de l’annulation est perdue', async () => {
    const current = mission({
      phase: 'awaiting_line_details',
      revision: 6,
      payload: {
        schema: 'bob.agent-mission.quote-creation',
        version: 1,
        draft: {
          sessionId: 'draft-session-1',
          slotRevision: 2,
          contentRevision: 1,
        },
        decision: null,
        stagedCustomerResolution: null,
      },
    });
    const cancelled = mission({
      phase: 'awaiting_lines',
      revision: 7,
      payload: current.payload,
    });
    const h = harness({
      call: toolCallV2({ kind: 'cancel_current_line' }),
      current,
      currentAfterDecision: cancelled,
      pendingLineCancellationFailure: 'throws',
    });

    await expect(h.orchestrator.run(inputV2())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'Les informations données sont conservées dans la mission. Je poursuis à partir de l’état réellement enregistré.',
      speechPurpose: 'action_result',
    });
    expect(h.cancelPendingLineFromVoiceTurn).toHaveBeenCalledOnce();
    expect(h.getCurrentV2).toHaveBeenCalledTimes(3);
  });

  it('V2 confirme avec le choiceId, le proposalId et tous les hashes relus', async () => {
    const current = lineConfirmationMission();
    const h = harness({
      call: toolCallV2({ kind: 'confirm_current_proposal' }),
      current,
    });

    const outcome = await h.orchestrator.run(inputV2());

    expect(outcome).toHaveProperty(
      'canonicalSpeech',
      expect.stringContaining('La ligne est ajoutée au devis.'),
    );
    expect(h.decideLineProposalFromVoiceTurn).toHaveBeenCalledWith({
      authorization: { owner: OWNER, proof: PROOF_V2 },
      missionId: current.id,
      turnId: TURN_ID,
      realtimeSessionId: SESSION_ID,
      contextRevision: 4,
      contextDigest: 'f'.repeat(64),
      expectedMissionRevision: 8,
      expectedDraftSessionId: 'draft-session-1',
      expectedDraftSlotRevision: 2,
      expectedDraftContentRevision: 1,
      decisionId: '40000000-0000-4000-8000-000000000020',
      choiceSetRevision: 8,
      choiceSetHash: 'e'.repeat(64),
      choiceId: '50000000-0000-4000-8000-000000000020',
      pendingLineId: '60000000-0000-4000-8000-000000000001',
      proposalId: '70000000-0000-4000-8000-000000000001',
      proposalRevision: 1,
      expectedWorkRevision: 2,
      expectedCatalogue: {
        itemId: 'catalogue-first',
        revision: 3,
      },
      diffHash: 'f'.repeat(64),
    });
    const modelInput = JSON.stringify(
      vi.mocked(h.model.complete).mock.calls[0]?.[0],
    );
    expect(modelInput).toContain('Main-d’œuvre plomberie');
    expect(modelInput).not.toContain(
      '70000000-0000-4000-8000-000000000001',
    );
  });

  it('V2 ne prononce jamais un faux succès quand une confirmation invalidée est rejouée', async () => {
    const current = lineConfirmationMission();
    const invalidatedMission = mission({
      phase: 'awaiting_line_details',
      revision: 9,
    });
    const h = harness({
      call: toolCallV2({ kind: 'confirm_current_proposal' }),
      current,
      lineDecisionValue: {
        outcome: 'replayed',
        invalidationReason: 'candidate_unavailable',
        mission: invalidatedMission,
        continuation: {
          outcome: 'details_requested',
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          presentedChoiceCount: 0,
          requiredFact: 'unit_price',
          proposalId: null,
        },
        presentation: presentationForMission(invalidatedMission)!,
      },
    });

    const outcome = await h.orchestrator.run(inputV2());

    expect(outcome).toEqual({
      status: 'handled',
      canonicalSpeech: 'Quel prix unitaire dois-je appliquer à cette ligne ?',
      speechPurpose: 'structured_choice',
    });
    expect(
      outcome.status === 'handled' ? outcome.canonicalSpeech : '',
    ).not.toContain('ajoutée');
  });

  it('V2 distingue modifier de supprimer et consomme le choix edit_line', async () => {
    const current = lineConfirmationMission();
    const editMission = mission({
      phase: 'awaiting_line_details',
      revision: 10,
      payload: {
        schema: 'bob.agent-mission.quote-creation',
        version: 1,
        draft: {
          sessionId: 'draft-session-1',
          slotRevision: 2,
          contentRevision: 1,
        },
        decision: null,
        stagedCustomerResolution: null,
      },
    });
    const editPresentation = Object.freeze({
      ...presentationForMission(editMission)!,
      requiredFact: null,
    });
    const h = harness({
      call: toolCallV2({ kind: 'reject_current_proposal' }),
      current,
      lineDecisionValue: {
        outcome: 'edit_requested',
        invalidationReason: null,
        mission: editMission,
        continuation: {
          outcome: 'details_requested',
          pendingLineId: '60000000-0000-4000-8000-000000000001',
          presentedChoiceCount: 0,
          requiredFact: null,
          proposalId: null,
        },
        presentation: editPresentation,
      },
    });

    const outcome = await h.orchestrator.run(inputV2());

    expect(outcome).toHaveProperty(
      'canonicalSpeech',
      expect.stringContaining('La ligne reste dans la mission'),
    );
    expect(
      h.decideLineProposalFromVoiceTurn.mock.calls[0]?.[0].choiceId,
    ).toBe('50000000-0000-4000-8000-000000000021');
  });

  it('V2 annule seulement la ligne courante avec le choix cancel_line', async () => {
    const current = lineConfirmationMission();
    const nextMission = mission({
      phase: 'awaiting_lines',
      revision: 10,
      payload: {
        schema: 'bob.agent-mission.quote-creation',
        version: 1,
        draft: {
          sessionId: 'draft-session-1',
          slotRevision: 2,
          contentRevision: 1,
        },
        decision: null,
        stagedCustomerResolution: null,
      },
    });
    const h = harness({
      call: toolCallV2({ kind: 'cancel_current_line' }),
      current,
      lineDecisionValue: {
        outcome: 'cancelled',
        invalidationReason: null,
        mission: nextMission,
        continuation: {
          outcome: 'empty',
          pendingLineId: null,
          presentedChoiceCount: 0,
          requiredFact: null,
          proposalId: null,
        },
        presentation: presentationForMission(nextMission)!,
      },
    });

    const outcome = await h.orchestrator.run(inputV2());

    expect(outcome).toHaveProperty(
      'canonicalSpeech',
      expect.stringContaining('La ligne est retirée de la mission'),
    );
    expect(
      h.decideLineProposalFromVoiceTurn.mock.calls[0]?.[0].choiceId,
    ).toBe('50000000-0000-4000-8000-000000000022');
  });

  it('V2 relit une réponse perdue avec sa projection V2, jamais le langage M1-C', async () => {
    const h = harness({
      call: toolCallV2({
        kind: 'append_line_candidates',
        lines: [LINE_ARGUMENTS],
      }),
      current: mission({
        phase: 'awaiting_lines',
        payload: {
          schema: 'bob.agent-mission.quote-creation',
          version: 1,
          draft: {
            sessionId: 'draft-session-1',
            slotRevision: 2,
            contentRevision: 1,
          },
          decision: null,
          stagedCustomerResolution: null,
        },
      }),
      currentAfterDecision: catalogueMission(),
      stageFailure: 'throws',
    });

    await expect(h.orchestrator.run(inputV2())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'J’ai trouvé 2 prestations disponibles dans ton catalogue. Premier choix : « Prestation 1 », à 55 € hors taxes par heure. Deuxième choix : « Prestation 2 », à 55 € hors taxes par heure. Dernier choix : créer une ligne libre. Tu peux dire le premier, le deuxième, ou le choix que tu veux.',
      speechPurpose: 'structured_choice',
    });
    expect(h.getCurrentV2).toHaveBeenCalledTimes(3);
  });

  it('V2 décrit honnêtement les options catalogue indisponibles après convergence', async () => {
    const converged = catalogueMission();
    const h = harness({
      call: toolCallV2({
        kind: 'append_line_candidates',
        lines: [LINE_ARGUMENTS],
      }),
      current: mission({
        phase: 'awaiting_lines',
        payload: {
          schema: 'bob.agent-mission.quote-creation',
          version: 1,
          draft: {
            sessionId: 'draft-session-1',
            slotRevision: 2,
            contentRevision: 1,
          },
          decision: null,
          stagedCustomerResolution: null,
        },
      }),
      currentAfterDecision: converged,
      currentPresentationAfterDecision:
        cataloguePresentationWithUnavailableOrdinal(converged, 1),
      stageFailure: 'throws',
    });

    await expect(h.orchestrator.run(inputV2())).resolves.toEqual({
      status: 'handled',
      canonicalSpeech:
        'J’ai trouvé 1 prestation disponible dans ton catalogue. Premier choix : cette prestation n’est plus disponible. Deuxième choix : « Prestation 2 », à 55 € hors taxes par heure. Dernier choix : créer une ligne libre. Tu peux dire le premier, le deuxième, ou le choix que tu veux.',
      speechPurpose: 'structured_choice',
    });
  });

  it('propage l’interruption sans publier de réponse ni mutation', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({
      call: toolCall('start_quote_creation', null, null),
    });

    await expect(h.orchestrator.run(input(controller.signal))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(h.getCurrent).not.toHaveBeenCalled();
    expect(h.getCurrentV2).not.toHaveBeenCalled();
    expect(h.startFromVoiceTurn).not.toHaveBeenCalled();
  });
});
