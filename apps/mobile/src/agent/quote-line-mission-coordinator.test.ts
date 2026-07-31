import { describe, expect, it, vi } from 'vitest';
import type {
  AgentMissionViewV1,
  QuoteAgentMissionPresentationV1,
} from '@bob/core';
import type { AgentMissionRuntimeActions } from './agent-mission-runtime';
import {
  QuoteLineMissionCoordinator,
  type QuoteLineMissionFrame,
} from './quote-line-mission-coordinator';
import { AgentMissionCommandIdRegistry } from './agent-mission-command-id-registry';

const MISSION_ID = '10000000-0000-4000-8000-000000000001';
const COMMAND_ID = '20000000-0000-4000-8000-000000000001';
const PENDING_ID = '30000000-0000-4000-8000-000000000001';
const DECISION_ID = '40000000-0000-4000-8000-000000000001';
const CHOICE_ID = '50000000-0000-4000-8000-000000000001';
const FREE_CHOICE_ID = '50000000-0000-4000-8000-000000000002';
const PROPOSAL_ID = '60000000-0000-4000-8000-000000000001';
const SCREEN_ID = 'devis-new:mission-v2';

function mission(phase: AgentMissionViewV1['phase']): AgentMissionViewV1 {
  return {
    id: MISSION_ID,
    kind: 'quote_creation',
    status: 'active',
    actionable: true,
    phase,
    revision: 7,
    payloadVersion: 1,
    payload: {
      schema: 'bob.agent-mission.quote-creation',
      version: 1,
      draft: {
        sessionId: 'quote-draft-session',
        slotRevision: 4,
        contentRevision: 3,
      },
      decision: null,
      stagedCustomerResolution: null,
    },
  } as AgentMissionViewV1;
}

function presentation(
  value: Partial<QuoteAgentMissionPresentationV1> = {},
): QuoteAgentMissionPresentationV1 {
  return {
    schema: 'bob.agent-mission.quote-presentation',
    version: 1,
    requiredFact: null,
    pendingLine: null,
    decision: null,
    catalogueChoices: [],
    freeLineChoiceId: null,
    proposalStatus: { kind: 'absent' },
    proposal: null,
    ...value,
  };
}

function frame(
  phase: AgentMissionViewV1['phase'],
  value: Partial<QuoteAgentMissionPresentationV1> = {},
): QuoteLineMissionFrame {
  return {
    mission: mission(phase),
    presentation: presentation(value),
    expectedScreenInstanceId: SCREEN_ID,
  };
}

describe('QuoteLineMissionCoordinator — parité toucher/voix V2', () => {
  it('stage la même ligne avec une commande stable au retry', async () => {
    const stageQuoteLines = vi.fn<
      AgentMissionRuntimeActions['stageQuoteLines']
    >(async () => ({ status: 'unavailable' }));
    const coordinator = new QuoteLineMissionCoordinator(() => COMMAND_ID);
    const lines = [{
      serviceReference: 'Main-d’œuvre plomberie',
      categoryHint: 'labor' as const,
      quantityDecimal: '2',
      unitReference: 'heure',
      unitPriceDecimal: '55',
      currency: 'EUR' as const,
      priceBasis: 'per_unit' as const,
      vatRateHint: null,
    }];

    await coordinator.stage(frame('awaiting_lines'), lines, { stageQuoteLines });
    await coordinator.stage(frame('awaiting_lines'), lines, { stageQuoteLines });

    expect(stageQuoteLines).toHaveBeenCalledTimes(2);
    expect(stageQuoteLines.mock.calls[0]?.[0]).toEqual({
      missionId: MISSION_ID,
      commandId: COMMAND_ID,
      expectedMissionRevision: 7,
      expectedDraftSessionId: 'quote-draft-session',
      expectedDraftSlotRevision: 4,
      expectedDraftContentRevision: 3,
      expectedScreenInstanceId: SCREEN_ID,
      lines,
    });
    expect(stageQuoteLines.mock.calls[1]?.[0].commandId).toBe(COMMAND_ID);
  });

  it('conserve le commandId après démontage et recréation de la surface', async () => {
    const firstCommandId = '20000000-0000-4000-8000-000000000010';
    const unexpectedCommandId = '20000000-0000-4000-8000-000000000011';
    const createFirst = vi.fn(() => firstCommandId);
    const createAfterRemount = vi.fn(() => unexpectedCommandId);
    const registry = new AgentMissionCommandIdRegistry();
    const stageQuoteLines = vi.fn<
      AgentMissionRuntimeActions['stageQuoteLines']
    >(async () => ({ status: 'unavailable' }));
    const lines = [{
      serviceReference: 'Entretien vitrines',
      categoryHint: 'labor' as const,
      quantityDecimal: '2',
      unitReference: 'heure',
      unitPriceDecimal: '55',
      currency: 'EUR' as const,
      priceBasis: 'per_unit' as const,
      vatRateHint: null,
    }];

    await new QuoteLineMissionCoordinator(createFirst, registry)
      .stage(frame('awaiting_lines'), lines, { stageQuoteLines });
    await new QuoteLineMissionCoordinator(createAfterRemount, registry)
      .stage(frame('awaiting_lines'), lines, { stageQuoteLines });

    expect(stageQuoteLines).toHaveBeenCalledTimes(2);
    expect(stageQuoteLines.mock.calls[0]?.[0].commandId).toBe(firstCommandId);
    expect(stageQuoteLines.mock.calls[1]?.[0].commandId).toBe(firstCommandId);
    expect(createFirst).toHaveBeenCalledTimes(1);
    expect(createAfterRemount).not.toHaveBeenCalled();
  });

  it('n’accepte qu’un choix catalogue réellement scellé', async () => {
    const decideQuoteCatalogueChoice = vi.fn<
      AgentMissionRuntimeActions['decideQuoteCatalogueChoice']
    >(async () => ({ status: 'unavailable' }));
    const coordinator = new QuoteLineMissionCoordinator(() => COMMAND_ID);
    const current = frame('awaiting_catalogue_choice', {
      pendingLine: { pendingLineId: PENDING_ID, expectedWorkRevision: 2 },
      decision: {
        kind: 'catalogue',
        decisionId: DECISION_ID,
        choiceSetRevision: 7,
        pendingLineId: PENDING_ID,
        expectedDraft: {
          sessionId: 'quote-draft-session',
          slotRevision: 4,
          contentRevision: 3,
        },
        expectedWorkRevision: 2,
        choices: [{
          choiceId: CHOICE_ID,
          catalogueItemId: 'catalogue-labor',
          expectedCatalogueRevision: 5,
        }],
        freeLineChoiceId: FREE_CHOICE_ID,
        choiceSetHash: 'a'.repeat(64),
      },
    });

    await expect(coordinator.chooseCatalogue(
      current,
      '50000000-0000-4000-8000-000000000099',
      { decideQuoteCatalogueChoice },
    )).resolves.toEqual({ status: 'invalid_response' });
    expect(decideQuoteCatalogueChoice).not.toHaveBeenCalled();

    await coordinator.chooseCatalogue(
      current,
      CHOICE_ID,
      { decideQuoteCatalogueChoice },
    );
    expect(decideQuoteCatalogueChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionId: DECISION_ID,
        pendingLineId: PENDING_ID,
        choiceId: CHOICE_ID,
        additionalLines: [],
      }),
    );
  });

  it('refuse une réponse qui ne correspond pas au fait demandé', async () => {
    const patchQuoteLine = vi.fn<
      AgentMissionRuntimeActions['patchQuoteLine']
    >(async () => ({ status: 'unavailable' }));
    const coordinator = new QuoteLineMissionCoordinator(() => COMMAND_ID);
    const current = frame('awaiting_line_details', {
      requiredFact: 'unit_price',
      pendingLine: { pendingLineId: PENDING_ID, expectedWorkRevision: 3 },
    });

    await expect(coordinator.patch(
      current,
      'answer_required_fact',
      { field: 'quantity', decimal: '2' },
      { patchQuoteLine },
    )).resolves.toEqual({ status: 'invalid_response' });
    expect(patchQuoteLine).not.toHaveBeenCalled();

    await coordinator.patch(
      current,
      'answer_required_fact',
      {
        field: 'unit_price',
        decimal: '55',
        currency: 'EUR',
        basis: 'per_unit',
      },
      { patchQuoteLine },
    );
    expect(patchQuoteLine).toHaveBeenCalledWith(expect.objectContaining({
      pendingLineId: PENDING_ID,
      expectedWorkRevision: 3,
      scope: 'answer_required_fact',
    }));
  });

  it('annule seulement la ligne incomplète avec une commande stable au retry', async () => {
    const cancelPendingQuoteLine = vi.fn<
      AgentMissionRuntimeActions['cancelPendingQuoteLine']
    >(async () => ({ status: 'unavailable' }));
    const coordinator = new QuoteLineMissionCoordinator(() => COMMAND_ID);
    const current = frame('awaiting_line_details', {
      requiredFact: 'unit_price',
      pendingLine: { pendingLineId: PENDING_ID, expectedWorkRevision: 3 },
      decision: null,
    });

    await coordinator.cancelPending(current, { cancelPendingQuoteLine });
    await coordinator.cancelPending(current, { cancelPendingQuoteLine });

    expect(cancelPendingQuoteLine).toHaveBeenCalledTimes(2);
    expect(cancelPendingQuoteLine).toHaveBeenNthCalledWith(1, {
      missionId: MISSION_ID,
      commandId: COMMAND_ID,
      expectedMissionRevision: 7,
      expectedDraftSessionId: 'quote-draft-session',
      expectedDraftSlotRevision: 4,
      expectedDraftContentRevision: 3,
      expectedScreenInstanceId: SCREEN_ID,
      pendingLineId: PENDING_ID,
      expectedWorkRevision: 3,
    });
    expect(cancelPendingQuoteLine.mock.calls[1]?.[0].commandId).toBe(COMMAND_ID);

    await expect(coordinator.cancelPending(
      frame('awaiting_line_confirmation', {
        pendingLine: { pendingLineId: PENDING_ID, expectedWorkRevision: 3 },
      }),
      { cancelPendingQuoteLine },
    )).resolves.toEqual({ status: 'invalid_response' });
    expect(cancelPendingQuoteLine).toHaveBeenCalledTimes(2);
  });

  it('résout le geste de confirmation vers le choiceId scellé correspondant', async () => {
    const decideQuoteLineProposal = vi.fn<
      AgentMissionRuntimeActions['decideQuoteLineProposal']
    >(async () => ({ status: 'unavailable' }));
    const coordinator = new QuoteLineMissionCoordinator(() => COMMAND_ID);
    const editChoiceId = '50000000-0000-4000-8000-000000000003';
    const cancelChoiceId = '50000000-0000-4000-8000-000000000004';
    const current = frame('awaiting_line_confirmation', {
      pendingLine: { pendingLineId: PENDING_ID, expectedWorkRevision: 4 },
      proposalStatus: { kind: 'available' },
      proposal: {
        proposalId: PROPOSAL_ID,
        diffHash: 'b'.repeat(64),
        diff: {
          kind: 'append_line',
          before: {
            contentRevision: 3,
            lineCount: 0,
            totalHtCents: 0,
          },
          after: {
            contentRevision: 4,
            lineCount: 1,
            totalHtCents: 11_000,
          },
        },
        line: {
          label: 'Main-d’œuvre plomberie',
          category: 'labor',
          qty: 2,
          unitPriceHT: 5_500,
          vatRate: 20,
          unit: 'heure',
        },
        catalogue: null,
      },
      decision: {
        kind: 'line_confirmation',
        decisionId: DECISION_ID,
        choiceSetRevision: 7,
        pendingLineId: PENDING_ID,
        proposalId: PROPOSAL_ID,
        proposalRevision: 1,
        expectedDraft: {
          sessionId: 'quote-draft-session',
          slotRevision: 4,
          contentRevision: 3,
        },
        expectedWorkRevision: 4,
        expectedCatalogue: null,
        expectedVatContextDigest: 'c'.repeat(64),
        diffHash: 'b'.repeat(64),
        choices: [
          { choiceId: CHOICE_ID, action: 'confirm_line' },
          { choiceId: editChoiceId, action: 'edit_line' },
          { choiceId: cancelChoiceId, action: 'cancel_line' },
        ],
        choiceSetHash: 'd'.repeat(64),
      },
    });

    await coordinator.decideProposal(
      current,
      'confirm_line',
      { decideQuoteLineProposal },
    );
    expect(decideQuoteLineProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        choiceId: CHOICE_ID,
        proposalId: PROPOSAL_ID,
        choiceSetHash: 'd'.repeat(64),
        diffHash: 'b'.repeat(64),
      }),
    );

    const stale = frame('awaiting_line_confirmation', {
      pendingLine: { pendingLineId: PENDING_ID, expectedWorkRevision: 4 },
      proposalStatus: {
        kind: 'stale',
        reason: 'catalogue_changed',
      },
      proposal: null,
      decision: current.presentation.decision,
    });
    await coordinator.decideProposal(
      stale,
      'edit_line',
      { decideQuoteLineProposal },
    );
    await coordinator.decideProposal(
      stale,
      'cancel_line',
      { decideQuoteLineProposal },
    );
    await expect(coordinator.decideProposal(
      stale,
      'confirm_line',
      { decideQuoteLineProposal },
    )).resolves.toEqual({ status: 'invalid_response' });

    expect(decideQuoteLineProposal).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        choiceId: editChoiceId,
        proposalId: PROPOSAL_ID,
        diffHash: 'b'.repeat(64),
      }),
    );
    expect(decideQuoteLineProposal).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        choiceId: cancelChoiceId,
        proposalId: PROPOSAL_ID,
        diffHash: 'b'.repeat(64),
      }),
    );
    expect(decideQuoteLineProposal).toHaveBeenCalledTimes(3);
  });
});
