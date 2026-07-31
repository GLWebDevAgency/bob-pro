import { describe, expect, it, vi } from 'vitest';
import {
  ok,
  type AcknowledgeQuoteScreenOutput,
  type AgentMissionViewV1,
  type CancelQuoteAgentMissionOutput,
  type DecideQuoteAgentMissionOutput,
  type QuoteAgentMissionPresentationV1,
} from '@bob/core';
import {
  REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
  REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
  type RealtimeAgentMissionCatalogueChoiceOutput,
  type RealtimeAgentMissionCancelPendingQuoteLineOutput,
  type RealtimeAgentMissionLineProposalDecisionOutput,
  type RealtimeAgentMissionPatchQuoteLineOutput,
  type RealtimeAgentMissionSession,
  type RealtimeAgentMissionStageQuoteLinesOutput,
} from '@bob/api-client';
import {
  AgentMissionRuntimeOwner,
  FencedAgentMissionRuntimeActions,
  type AgentMissionCatalogueChoiceInput,
  type AgentMissionCancelPendingQuoteLineInput,
  type AgentMissionLineProposalDecisionInput,
  type AgentMissionPatchQuoteLineInput,
  type AgentMissionRuntimeCapture,
  type AgentMissionStageQuoteLinesInput,
} from './agent-mission-runtime';

function session(
  id: string,
  disposals: string[],
  protocolVersion:
    | typeof REALTIME_AGENT_MISSION_PROTOCOL_VERSION
    | typeof REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION =
      REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
): RealtimeAgentMissionSession {
  let disposed = false;
  const unused = async (): Promise<never> => {
    throw new Error('unused_agent_mission_method');
  };
  return {
    protocolVersion,
    realtimeSessionId: id,
    get disposed() {
      return disposed;
    },
    getCurrentQuoteCreation: unused,
    startQuoteCreation: unused,
    cancelQuoteCreation: unused,
    acknowledgeQuoteScreen: unused,
    decideQuoteCreation: unused,
    stageQuoteLines: unused,
    decideQuoteCatalogueChoice: unused,
    patchQuoteLine: unused,
    cancelPendingQuoteLine: unused,
    decideQuoteLineProposal: unused,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      disposals.push(id);
    },
  } as unknown as RealtimeAgentMissionSession;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const PRESENTATION = {
  schema: 'bob.agent-mission.quote-presentation',
  version: 1,
  requiredFact: null,
  pendingLine: null,
  decision: null,
  catalogueChoices: [],
  freeLineChoiceId: null,
  proposalStatus: { kind: 'absent' as const },
  proposal: null,
} as const satisfies QuoteAgentMissionPresentationV1;

const V2_REALTIME_ID = 'a0000000-0000-4000-8000-000000000001';
const V2_MISSION_ID = 'a0000000-0000-4000-8000-000000000002';
const V2_COMMAND_ID = 'a0000000-0000-4000-8000-000000000003';
const V2_PENDING_LINE_ID = 'a0000000-0000-4000-8000-000000000004';
const V2_DECISION_ID = 'a0000000-0000-4000-8000-000000000005';
const V2_CHOICE_ID = 'a0000000-0000-4000-8000-000000000006';
const V2_PROPOSAL_ID = 'a0000000-0000-4000-8000-000000000007';
const V2_SCREEN_ID = 'devis-new:v2';

function v2Mission(id = V2_MISSION_ID): AgentMissionViewV1 {
  return { id } as unknown as AgentMissionViewV1;
}

const V2_COMMON = Object.freeze({
  missionId: V2_MISSION_ID,
  commandId: V2_COMMAND_ID,
  expectedMissionRevision: 5,
  expectedDraftSessionId: 'draft-v2',
  expectedDraftSlotRevision: 3,
  expectedDraftContentRevision: 2,
  expectedScreenInstanceId: V2_SCREEN_ID,
});

const V2_STAGE_INPUT = {
  ...V2_COMMON,
  lines: [{
    serviceReference: 'Main-d’œuvre plomberie',
    categoryHint: 'labor',
    quantityDecimal: '2',
    unitReference: 'heure',
    unitPriceDecimal: '55',
    currency: 'EUR',
    priceBasis: 'per_unit',
    vatRateHint: '20',
  }] as const,
} as const satisfies AgentMissionStageQuoteLinesInput;

const V2_CATALOGUE_INPUT = {
  ...V2_COMMON,
  decisionId: V2_DECISION_ID,
  choiceSetRevision: 5,
  pendingLineId: V2_PENDING_LINE_ID,
  expectedWorkRevision: 2,
  choiceId: V2_CHOICE_ID,
  additionalLines: [],
} as const satisfies AgentMissionCatalogueChoiceInput;

const V2_PATCH_INPUT = {
  ...V2_COMMON,
  pendingLineId: V2_PENDING_LINE_ID,
  expectedWorkRevision: 3,
  scope: 'explicit_correction',
  patch: {
    field: 'unit_price',
    decimal: '60',
    currency: 'EUR',
    basis: 'per_unit',
  } as const,
} as const satisfies AgentMissionPatchQuoteLineInput;

const V2_CANCEL_PENDING_INPUT = {
  ...V2_COMMON,
  pendingLineId: V2_PENDING_LINE_ID,
  expectedWorkRevision: 3,
} as const satisfies AgentMissionCancelPendingQuoteLineInput;

const V2_PROPOSAL_INPUT = {
  ...V2_COMMON,
  decisionId: V2_DECISION_ID,
  choiceSetRevision: 5,
  choiceSetHash: 'a'.repeat(64),
  choiceId: V2_CHOICE_ID,
  pendingLineId: V2_PENDING_LINE_ID,
  proposalId: V2_PROPOSAL_ID,
  proposalRevision: 1,
  expectedWorkRevision: 4,
  expectedCatalogue: null,
  diffHash: 'b'.repeat(64),
} as const satisfies AgentMissionLineProposalDecisionInput;

describe('AgentMissionRuntimeOwner', () => {
  it('transfère move-only, remplace en disposant l’ancien une fois et fence sa génération', () => {
    const disposals: string[] = [];
    const owner = new AgentMissionRuntimeOwner();
    const firstId = '10000000-0000-4000-8000-000000000001';
    const secondId = '10000000-0000-4000-8000-000000000002';
    const first = session(firstId, disposals);
    const second = session(secondId, disposals);

    expect(owner.adopt(first)).toBe(true);
    const stale = owner.capture() as AgentMissionRuntimeCapture;
    expect(owner.adopt(first)).toBe(true);
    expect(disposals).toEqual([]);

    expect(owner.adopt(second)).toBe(true);
    expect(disposals).toEqual([firstId]);
    expect(owner.isCurrent(stale)).toBe(false);
    expect(owner.capture()?.session).toBe(second);

    owner.dispose();
    owner.dispose();
    expect(disposals).toEqual([firstId, secondId]);
  });

  it('ne publie un contexte qu’après confirmation exacte de la session possédée', () => {
    const owner = new AgentMissionRuntimeOwner();
    const currentId = '20000000-0000-4000-8000-000000000001';
    const current = session(currentId, []);
    owner.adopt(current);

    expect(owner.confirmContext('20000000-0000-4000-8000-000000000002', {
      sessionHandle: currentId,
      contextRevision: 3,
      contextDigest: 'a'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: 'quote-screen-1' },
      entities: [],
      capabilities: ['screen.read'],
    })).toBe(false);
    expect(owner.snapshot().confirmedContext).toBeNull();

    expect(owner.confirmContext(currentId, {
      sessionHandle: currentId,
      contextRevision: 3,
      contextDigest: 'a'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: 'quote-screen-1' },
      entities: [],
      capabilities: ['screen.read'],
    })).toBe(true);
    expect(owner.snapshot().confirmedContext).toEqual({
      realtimeSessionId: currentId,
      revision: 3,
      digest: 'a'.repeat(64),
      screen: {
        name: '/devis/new',
        instanceId: 'quote-screen-1',
      },
    });
    const revisionThree = owner.capture() as AgentMissionRuntimeCapture;
    expect(owner.isCurrent(revisionThree)).toBe(true);

    owner.invalidateContext('20000000-0000-4000-8000-000000000002');
    expect(owner.snapshot().confirmedContext).not.toBeNull();
    owner.invalidateContext(currentId);
    expect(owner.snapshot().confirmedContext).toBeNull();
    expect(owner.isCurrent(revisionThree)).toBe(false);

    expect(owner.confirmContext(currentId, {
      sessionHandle: currentId,
      contextRevision: 4,
      contextDigest: 'b'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: 'quote-screen-2' },
      entities: [],
      capabilities: ['screen.read'],
    })).toBe(true);
    const revisionFour = owner.capture() as AgentMissionRuntimeCapture;
    expect(owner.isCurrent(revisionFour)).toBe(true);
    expect(owner.isCurrent(revisionThree)).toBe(false);

    expect(owner.confirmContext(currentId, {
      sessionHandle: currentId,
      contextRevision: 3,
      contextDigest: 'c'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: 'quote-screen-rollback' },
      entities: [],
      capabilities: ['screen.read'],
    })).toBe(false);
    expect(owner.confirmContext(currentId, {
      sessionHandle: currentId,
      contextRevision: 4,
      contextDigest: 'b'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: 'quote-screen-divergent' },
      entities: [],
      capabilities: ['screen.read'],
    })).toBe(false);
    expect(owner.snapshot().confirmedContext).toEqual(revisionFour.confirmedContext);
  });

  it('publie un terminal une seule fois, fence les lectures en vol et refuse une contradiction', () => {
    const owner = new AgentMissionRuntimeOwner();
    const currentId = '21000000-0000-4000-8000-000000000001';
    const turnId = '21000000-0000-4000-8000-000000000002';
    owner.adopt(session(currentId, []));
    const beforeSettlement = owner.capture() as AgentMissionRuntimeCapture;
    const snapshots: ReturnType<AgentMissionRuntimeOwner['snapshot']>[] = [];
    owner.subscribe((snapshot) => snapshots.push(snapshot));

    expect(owner.settleTurn(currentId, { turnId, status: 'done' })).toBe(true);
    expect(owner.isCurrent(beforeSettlement)).toBe(false);
    expect(owner.snapshot().lastTurnSettlement).toEqual({ turnId, status: 'done' });
    const generationAfterFirst = owner.snapshot().generation;
    const publicationCountAfterFirst = snapshots.length;

    expect(owner.settleTurn(currentId, { turnId, status: 'done' })).toBe(true);
    expect(owner.snapshot().generation).toBe(generationAfterFirst);
    expect(snapshots).toHaveLength(publicationCountAfterFirst);
    expect(owner.settleTurn(currentId, { turnId, status: 'cancelled' })).toBe(false);
    expect(owner.settleTurn(
      '21000000-0000-4000-8000-000000000099',
      { turnId: '21000000-0000-4000-8000-000000000003', status: 'failed' },
    )).toBe(false);
  });

  it('libère move-only la capability terminalisée et fence toutes les captures', () => {
    const disposals: string[] = [];
    const owner = new AgentMissionRuntimeOwner();
    const currentId = '22000000-0000-4000-8000-000000000001';
    owner.adopt(session(currentId, disposals));
    const capture = owner.capture() as AgentMissionRuntimeCapture;

    expect(owner.release('22000000-0000-4000-8000-000000000099')).toBe(false);
    expect(owner.release(currentId)).toBe(true);
    expect(owner.release(currentId)).toBe(false);
    expect(disposals).toEqual([currentId]);
    expect(owner.capture()).toBeNull();
    expect(owner.isCurrent(capture)).toBe(false);
    expect(owner.snapshot()).toMatchObject({
      realtimeSessionId: null,
      confirmedContext: null,
      lastTurnSettlement: null,
    });
  });

  it('fence synchroniquement les captures pendant un démontage puis survit au cycle Strict Effects', () => {
    const disposals: string[] = [];
    const owner = new AgentMissionRuntimeOwner();
    const id = '30000000-0000-4000-8000-000000000003';
    const current = session(id, disposals);
    expect(owner.adopt(current)).toBe(true);
    const beforeCleanup = owner.capture() as AgentMissionRuntimeCapture;

    owner.deactivate();
    expect(owner.capture()).toBeNull();
    expect(owner.isCurrent(beforeCleanup)).toBe(false);
    expect(disposals).toEqual([]);

    expect(owner.activate()).toBe(true);
    expect(owner.capture()?.session).toBe(current);
    expect(owner.isCurrent(beforeCleanup)).toBe(false);

    owner.dispose();
    expect(disposals).toEqual([id]);
    expect(owner.activate()).toBe(false);
  });

  it('refuse un handle détruit et toute adoption après démontage sans toucher au candidat', () => {
    const disposals: string[] = [];
    const owner = new AgentMissionRuntimeOwner();
    const alreadyDisposed = session('30000000-0000-4000-8000-000000000001', disposals);
    alreadyDisposed.dispose();

    expect(owner.adopt(alreadyDisposed)).toBe(false);
    owner.dispose();
    const late = session('30000000-0000-4000-8000-000000000002', disposals);
    expect(owner.adopt(late)).toBe(false);
    expect(late.disposed).toBe(false);
  });

  it('n’expose aucune lecture écran avant le contexte devis exact', async () => {
    const owner = new AgentMissionRuntimeOwner();
    const id = '50000000-0000-4000-8000-000000000001';
    const candidate = session(id, []);
    const getCurrentQuoteCreation = vi.fn(candidate.getCurrentQuoteCreation);
    Object.assign(candidate, { getCurrentQuoteCreation });
    owner.adopt(candidate);
    const actions = new FencedAgentMissionRuntimeActions(owner);

    await expect(
      actions.readCurrentQuoteCreation('devis-new:expected'),
    ).resolves.toEqual({ status: 'context_unconfirmed' });
    expect(getCurrentQuoteCreation).not.toHaveBeenCalled();
  });

  it('partage une lecture identique en vol puis rejette sa réponse après invalidation', async () => {
    const owner = new AgentMissionRuntimeOwner();
    const id = '50000000-0000-4000-8000-000000000002';
    const gate = deferred<ReturnType<typeof ok<{ readonly mission: null }>>>();
    const candidate = session(id, []);
    const getCurrentQuoteCreation = vi.fn(() => gate.promise);
    Object.assign(candidate, { getCurrentQuoteCreation });
    owner.adopt(candidate);
    owner.confirmContext(id, {
      sessionHandle: id,
      contextRevision: 2,
      contextDigest: 'd'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: 'devis-new:2' },
      entities: [],
      capabilities: ['screen.read'],
    });
    const actions = new FencedAgentMissionRuntimeActions(owner);

    const first = actions.readCurrentQuoteCreation('devis-new:2');
    const second = actions.readCurrentQuoteCreation('devis-new:2');
    expect(first).toBe(second);
    expect(getCurrentQuoteCreation).toHaveBeenCalledOnce();

    owner.invalidateContext(id);
    gate.resolve(ok({ mission: null }));
    await expect(first).resolves.toEqual({ status: 'stale' });
    await expect(second).resolves.toEqual({ status: 'stale' });
  });

  it('injecte le fence privé dans l’ACK et refuse un receipt incohérent', async () => {
    const owner = new AgentMissionRuntimeOwner();
    const id = '50000000-0000-4000-8000-000000000003';
    const missionId = '60000000-0000-4000-8000-000000000001';
    const commandId = '70000000-0000-4000-8000-000000000001';
    const acknowledgeQuoteScreen = vi.fn();
    const candidate = session(id, []);
    Object.assign(candidate, { acknowledgeQuoteScreen });
    owner.adopt(candidate);
    owner.confirmContext(id, {
      sessionHandle: id,
      contextRevision: 4,
      contextDigest: 'e'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: 'devis-new:4' },
      entities: [],
      capabilities: ['screen.read'],
    });
    const output = {
      outcome: 'acknowledged',
      receipt: {
        ackCommandId: commandId,
        missionId,
        missionRevisionAfter: 3,
        realtimeSessionId: id,
        contextRevision: 4,
        contextDigest: 'e'.repeat(64),
        occurredAt: '2026-07-29T00:00:00.000Z',
      },
      mission: { id: missionId },
    } as unknown as AcknowledgeQuoteScreenOutput;
    acknowledgeQuoteScreen.mockResolvedValue(ok(output));
    const actions = new FencedAgentMissionRuntimeActions(owner);
    const input = {
      missionId,
      commandId,
      expectedMissionRevision: 2,
      draft: {
        sessionId: 'draft-1',
        slotRevision: 3,
        contentRevision: 0,
      },
      expectedScreenInstanceId: 'devis-new:4',
    } as const;

    await expect(actions.acknowledgeQuoteScreen(input)).resolves.toEqual({
      status: 'completed',
      value: { ...output, presentation: null },
    });
    expect(acknowledgeQuoteScreen).toHaveBeenCalledWith({
      missionId,
      commandId,
      expectedMissionRevision: 2,
      contextRevision: 4,
      contextDigest: 'e'.repeat(64),
      draftSessionId: 'draft-1',
      expectedDraftSlotRevision: 3,
      expectedDraftContentRevision: 0,
    });

    acknowledgeQuoteScreen.mockResolvedValueOnce(ok({
      ...output,
      receipt: { ...output.receipt, contextRevision: 5 },
    } as AcknowledgeQuoteScreenOutput));
    await expect(actions.acknowledgeQuoteScreen({
      ...input,
      commandId: '70000000-0000-4000-8000-000000000002',
    })).resolves.toEqual({ status: 'invalid_response' });
  });

  it('transmet une décision exacte sans exposer le fence ni accepter une autre mission', async () => {
    const owner = new AgentMissionRuntimeOwner();
    const id = '80000000-0000-4000-8000-000000000001';
    const missionId = '80000000-0000-4000-8000-000000000002';
    const candidate = session(id, []);
    const decideQuoteCreation = vi.fn();
    Object.assign(candidate, { decideQuoteCreation });
    owner.adopt(candidate);
    owner.confirmContext(id, {
      sessionHandle: id,
      contextRevision: 5,
      contextDigest: 'f'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: 'devis-new:decision' },
      entities: [],
      capabilities: ['screen.read'],
    });
    const output = {
      outcome: 'selected',
      effect: { kind: 'selected' },
      mission: { id: missionId },
    } as unknown as DecideQuoteAgentMissionOutput;
    decideQuoteCreation.mockResolvedValue(ok(output));
    const actions = new FencedAgentMissionRuntimeActions(owner);
    const input = {
      missionId,
      action: 'select_screen_customer',
      commandId: '80000000-0000-4000-8000-000000000003',
      expectedMissionRevision: 2,
      expectedDraftSessionId: 'draft-1',
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
      customerId: 'customer-camping',
      expectedScreenInstanceId: 'devis-new:decision',
    } as const;

    await expect(actions.decideQuoteCreation(input)).resolves.toEqual({
      status: 'completed',
      value: { ...output, presentation: null },
    });
    expect(decideQuoteCreation).toHaveBeenCalledWith({
      missionId,
      action: 'select_screen_customer',
      commandId: '80000000-0000-4000-8000-000000000003',
      expectedMissionRevision: 2,
      expectedDraftSessionId: 'draft-1',
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
      customerId: 'customer-camping',
    });

    decideQuoteCreation.mockResolvedValueOnce(ok({
      ...output,
      mission: { id: '80000000-0000-4000-8000-000000000099' },
    } as DecideQuoteAgentMissionOutput));
    await expect(actions.decideQuoteCreation({
      ...input,
      commandId: '80000000-0000-4000-8000-000000000004',
    })).resolves.toEqual({ status: 'invalid_response' });
  });

  it('libère manuellement avec le motif exact et refuse une mission non terminale', async () => {
    const owner = new AgentMissionRuntimeOwner();
    const id = '90000000-0000-4000-8000-000000000001';
    const missionId = '90000000-0000-4000-8000-000000000002';
    const cancelQuoteCreation = vi.fn();
    const candidate = session(id, []);
    Object.assign(candidate, { cancelQuoteCreation });
    owner.adopt(candidate);
    owner.confirmContext(id, {
      sessionHandle: id,
      contextRevision: 6,
      contextDigest: 'a'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: 'devis-new:handoff' },
      entities: [],
      capabilities: ['screen.read'],
    });
    const output = {
      outcome: 'cancelled',
      mission: {
        id: missionId,
        status: 'cancelled',
        actionable: false,
      },
    } as unknown as CancelQuoteAgentMissionOutput;
    cancelQuoteCreation.mockResolvedValue(ok(output));
    const actions = new FencedAgentMissionRuntimeActions(owner);
    const input = {
      missionId,
      commandId: '90000000-0000-4000-8000-000000000003',
      expectedMissionRevision: 4,
      expectedScreenInstanceId: 'devis-new:handoff',
    } as const;

    await expect(actions.manualHandoffQuoteCreation(input)).resolves.toEqual({
      status: 'completed',
      value: output,
    });
    expect(cancelQuoteCreation).toHaveBeenCalledWith({
      missionId,
      commandId: input.commandId,
      expectedMissionRevision: 4,
      reason: 'manual_handoff',
    });

    await expect(actions.abandonQuoteCreation({
      ...input,
      commandId: '90000000-0000-4000-8000-000000000004',
    })).resolves.toEqual({
      status: 'completed',
      value: output,
    });
    expect(cancelQuoteCreation).toHaveBeenLastCalledWith({
      missionId,
      commandId: '90000000-0000-4000-8000-000000000004',
      expectedMissionRevision: 4,
      reason: 'user_cancelled',
    });

    cancelQuoteCreation.mockResolvedValueOnce(ok({
      ...output,
      mission: {
        ...output.mission,
        status: 'active',
        actionable: true,
      },
    } as typeof output));
    await expect(actions.manualHandoffQuoteCreation({
      ...input,
      commandId: '90000000-0000-4000-8000-000000000005',
    })).resolves.toEqual({ status: 'invalid_response' });
  });

  it('refuse les cinq commandes ligne V2 sur une capability V1 avant tout réseau', async () => {
    const owner = new AgentMissionRuntimeOwner();
    const candidate = session(V2_REALTIME_ID, []);
    const stageQuoteLines = vi.fn();
    const decideQuoteCatalogueChoice = vi.fn();
    const patchQuoteLine = vi.fn();
    const cancelPendingQuoteLine = vi.fn();
    const decideQuoteLineProposal = vi.fn();
    Object.assign(candidate, {
      stageQuoteLines,
      decideQuoteCatalogueChoice,
      patchQuoteLine,
      cancelPendingQuoteLine,
      decideQuoteLineProposal,
    });
    owner.adopt(candidate);
    owner.confirmContext(V2_REALTIME_ID, {
      sessionHandle: V2_REALTIME_ID,
      contextRevision: 7,
      contextDigest: 'c'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: V2_SCREEN_ID },
      entities: [],
      capabilities: ['screen.read'],
    });
    const actions = new FencedAgentMissionRuntimeActions(owner);

    await expect(actions.stageQuoteLines(V2_STAGE_INPUT))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(actions.decideQuoteCatalogueChoice(V2_CATALOGUE_INPUT))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(actions.patchQuoteLine(V2_PATCH_INPUT))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(actions.cancelPendingQuoteLine(V2_CANCEL_PENDING_INPUT))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(actions.decideQuoteLineProposal(V2_PROPOSAL_INPUT))
      .resolves.toEqual({ status: 'unavailable' });
    expect(stageQuoteLines).not.toHaveBeenCalled();
    expect(decideQuoteCatalogueChoice).not.toHaveBeenCalled();
    expect(patchQuoteLine).not.toHaveBeenCalled();
    expect(cancelPendingQuoteLine).not.toHaveBeenCalled();
    expect(decideQuoteLineProposal).not.toHaveBeenCalled();
  });

  it('transmet les cinq commandes V2 sans le fence écran et conserve leur présentation', async () => {
    const owner = new AgentMissionRuntimeOwner();
    const candidate = session(
      V2_REALTIME_ID,
      [],
      REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
    );
    const continuation = {
      outcome: 'stable',
      pendingLineId: V2_PENDING_LINE_ID,
      presentedChoiceCount: 0,
      requiredFact: null,
      proposalId: null,
    } as const;
    const stageOutput = {
      outcome: 'staged',
      mission: v2Mission(),
      continuation,
      presentation: PRESENTATION,
    } as unknown as RealtimeAgentMissionStageQuoteLinesOutput;
    const catalogueOutput = {
      outcome: 'selected',
      resolution: 'selected',
      invalidationReason: null,
      mission: v2Mission(),
      continuation,
      presentation: PRESENTATION,
    } as RealtimeAgentMissionCatalogueChoiceOutput;
    const patchOutput = {
      outcome: 'patched',
      pendingLineId: V2_PENDING_LINE_ID,
      workRevisionAfter: 4,
      mission: v2Mission(),
      continuation,
      presentation: PRESENTATION,
    } as RealtimeAgentMissionPatchQuoteLineOutput;
    const cancelPendingOutput = {
      outcome: 'cancelled',
      pendingLineId: V2_PENDING_LINE_ID,
      mission: v2Mission(),
      continuation,
      presentation: PRESENTATION,
    } as RealtimeAgentMissionCancelPendingQuoteLineOutput;
    const proposalOutput = {
      outcome: 'confirmed',
      invalidationReason: null,
      mission: v2Mission(),
      continuation,
      presentation: PRESENTATION,
    } as RealtimeAgentMissionLineProposalDecisionOutput;
    const stageQuoteLines = vi.fn(async (_input: unknown) => ok(stageOutput));
    const decideQuoteCatalogueChoice = vi.fn(
      async (_input: unknown) => ok(catalogueOutput),
    );
    const patchQuoteLine = vi.fn(async (_input: unknown) => ok(patchOutput));
    const cancelPendingQuoteLine = vi.fn(
      async (_input: unknown) => ok(cancelPendingOutput),
    );
    const decideQuoteLineProposal = vi.fn(
      async (_input: unknown) => ok(proposalOutput),
    );
    Object.assign(candidate, {
      stageQuoteLines,
      decideQuoteCatalogueChoice,
      patchQuoteLine,
      cancelPendingQuoteLine,
      decideQuoteLineProposal,
    });
    owner.adopt(candidate);
    owner.confirmContext(V2_REALTIME_ID, {
      sessionHandle: V2_REALTIME_ID,
      contextRevision: 8,
      contextDigest: 'd'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: V2_SCREEN_ID },
      entities: [],
      capabilities: ['screen.read'],
    });
    const actions = new FencedAgentMissionRuntimeActions(owner);

    await expect(actions.stageQuoteLines(V2_STAGE_INPUT)).resolves.toEqual({
      status: 'completed',
      value: stageOutput,
    });
    await expect(actions.decideQuoteCatalogueChoice(V2_CATALOGUE_INPUT))
      .resolves.toEqual({ status: 'completed', value: catalogueOutput });
    await expect(actions.patchQuoteLine(V2_PATCH_INPUT)).resolves.toEqual({
      status: 'completed',
      value: patchOutput,
    });
    await expect(actions.cancelPendingQuoteLine(V2_CANCEL_PENDING_INPUT))
      .resolves.toEqual({
        status: 'completed',
        value: cancelPendingOutput,
      });
    await expect(actions.decideQuoteLineProposal(V2_PROPOSAL_INPUT))
      .resolves.toEqual({ status: 'completed', value: proposalOutput });
    for (const call of [
      stageQuoteLines.mock.calls[0],
      decideQuoteCatalogueChoice.mock.calls[0],
      patchQuoteLine.mock.calls[0],
      cancelPendingQuoteLine.mock.calls[0],
      decideQuoteLineProposal.mock.calls[0],
    ]) {
      expect(call?.[0]).not.toHaveProperty('expectedScreenInstanceId');
    }
  });

  it('partage un staging V2 identique puis fence sa réponse après navigation', async () => {
    const owner = new AgentMissionRuntimeOwner();
    const candidate = session(
      V2_REALTIME_ID,
      [],
      REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
    );
    const output = {
      mission: v2Mission(),
      continuation: {
        outcome: 'stable',
        pendingLineId: V2_PENDING_LINE_ID,
        presentedChoiceCount: 0,
        requiredFact: null,
        proposalId: null,
      },
      presentation: PRESENTATION,
    } as unknown as RealtimeAgentMissionStageQuoteLinesOutput;
    const gate = deferred<ReturnType<typeof ok<typeof output>>>();
    const stageQuoteLines = vi.fn((_input: unknown) => gate.promise);
    Object.assign(candidate, { stageQuoteLines });
    owner.adopt(candidate);
    owner.confirmContext(V2_REALTIME_ID, {
      sessionHandle: V2_REALTIME_ID,
      contextRevision: 9,
      contextDigest: 'e'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: V2_SCREEN_ID },
      entities: [],
      capabilities: ['screen.read'],
    });
    const actions = new FencedAgentMissionRuntimeActions(owner);

    const first = actions.stageQuoteLines(V2_STAGE_INPUT);
    const doubled = actions.stageQuoteLines(V2_STAGE_INPUT);
    expect(first).toBe(doubled);
    expect(stageQuoteLines).toHaveBeenCalledOnce();
    owner.invalidateContext(V2_REALTIME_ID);
    gate.resolve(ok(output));
    await expect(first).resolves.toEqual({ status: 'stale' });
    await expect(doubled).resolves.toEqual({ status: 'stale' });
  });
});
