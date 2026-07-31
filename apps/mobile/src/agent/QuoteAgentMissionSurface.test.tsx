import { type ElementType, type ReactNode } from 'react';
import {
  computeQuoteMissionCatalogueChoiceSetHash,
  computeQuoteMissionLineConfirmationChoiceSetHash,
  type AgentMissionViewV1,
  type QuoteAgentMissionPresentationV1,
} from '@bob/core';
import { t } from '@bob/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import {
  QuoteAgentMissionSurface,
  type QuoteAgentMissionSurfaceProps,
} from './QuoteAgentMissionSurface';
import { QuoteLineMissionCoordinator } from './quote-line-mission-coordinator';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const announceForAccessibility = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility },
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('@bob/ui', async () => {
  const { createElement } = await import('react');
  return {
    Button: (props: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('Button', props, props.title as string),
    Card: (props: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('Card', props, props.children),
    Chip: (props: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('Chip', props, props.label as string),
    MoneyText: (props: Record<string, unknown>) =>
      createElement('MoneyText', props),
    font: () => ({ fontFamily: 'MockFont' }),
    useTheme: () => ({
      colors: {
        ink900: '#ink900',
        ink800: '#ink800',
        slate500: '#slate500',
        slate400: '#slate400',
        lineSoft: '#lineSoft',
      },
      semantic: {
        ai: '#ai',
        aiBg: '#aiBg',
        aiInk: '#aiInk',
        warning: '#warning',
        danger: '#danger',
      },
      controls: {
        cardBorder: '#cardBorder',
      },
      radius: {
        squircle: 14,
        cardLg: 18,
      },
    }),
  };
});

const HOST_ACTIVITY = 'ActivityIndicator' as unknown as ElementType;
const HOST_BUTTON = 'Button' as unknown as ElementType;
const HOST_CHIP = 'Chip' as unknown as ElementType;
const HOST_PRESSABLE = 'Pressable' as unknown as ElementType;
const HOST_TEXT = 'Text' as unknown as ElementType;
const HOST_TEXT_INPUT = 'TextInput' as unknown as ElementType;
const HOST_VIEW = 'View' as unknown as ElementType;

const PERSONALITY = 'pro' as const;
const SCREEN_ID = 'devis-new:draft-session:7:4:lignes';
const MISSION_ID = '10000000-0000-4000-8000-000000000001';
const PENDING_LINE_ID = '20000000-0000-4000-8000-000000000001';
const DECISION_ID = '30000000-0000-4000-8000-000000000001';
const CATALOGUE_CHOICE_ID = '40000000-0000-4000-8000-000000000001';
const FREE_LINE_CHOICE_ID = '40000000-0000-4000-8000-000000000002';
const PROPOSAL_ID = '50000000-0000-4000-8000-000000000001';
const CONFIRM_CHOICE_ID = '60000000-0000-4000-8000-000000000001';
const EDIT_CHOICE_ID = '60000000-0000-4000-8000-000000000002';
const CANCEL_CHOICE_ID = '60000000-0000-4000-8000-000000000003';
const COMMAND_ID = '70000000-0000-4000-8000-000000000001';
const CATALOGUE_ITEM_ID = 'catalogue-labour-plumbing';
const VAT_DIGEST = 'e'.repeat(64);
const DIFF_HASH = 'f'.repeat(64);
const DRAFT = {
  sessionId: 'draft-session',
  slotRevision: 7,
  contentRevision: 4,
} as const;

type ReadyV2 = QuoteAgentMissionSurfaceProps['state'];
type SurfaceActions = QuoteAgentMissionSurfaceProps['actions'];

function value<T>(result: { readonly ok: true; readonly value: T } | {
  readonly ok: false;
}): T {
  if (!result.ok) throw new Error('Fixture de décision invalide');
  return result.value;
}

function mission(
  phase: AgentMissionViewV1['phase'],
  revision = 9,
): AgentMissionViewV1 {
  return {
    id: MISSION_ID,
    kind: 'quote_creation',
    status: 'active',
    actionable: true,
    phase,
    revision,
    payloadVersion: 1,
    payload: {
      schema: 'bob.agent-mission.quote-creation',
      version: 1,
      draft: DRAFT,
      decision: null,
      stagedCustomerResolution: null,
    },
    currentBinding: {
      realtimeSessionId: '80000000-0000-4000-8000-000000000001',
      contextRevision: 6,
      contextDigest: 'a'.repeat(64),
      screenName: '/devis/new',
      screenInstanceId: SCREEN_ID,
      acknowledgedAt: '2026-07-30T12:00:00.000Z',
    },
    idleExpiresAt: '2026-07-30T12:10:00.000Z',
    hardExpiresAt: '2026-07-30T13:00:00.000Z',
    terminalAt: null,
    createdAt: '2026-07-30T12:00:00.000Z',
    updatedAt: '2026-07-30T12:00:00.000Z',
  } as AgentMissionViewV1;
}

function cataloguePresentation(): QuoteAgentMissionPresentationV1 {
  const choice = {
    choiceId: CATALOGUE_CHOICE_ID,
    catalogueItemId: CATALOGUE_ITEM_ID,
    expectedCatalogueRevision: 5,
  };
  const choiceSetHash = value(computeQuoteMissionCatalogueChoiceSetHash({
    missionId: MISSION_ID,
    choiceSetRevision: 7,
    decisionId: DECISION_ID,
    pendingLineId: PENDING_LINE_ID,
    expectedDraft: DRAFT,
    expectedWorkRevision: 4,
    candidates: [choice],
    freeLineChoiceId: FREE_LINE_CHOICE_ID,
  }));
  return {
    schema: 'bob.agent-mission.quote-presentation',
    version: 1,
    requiredFact: null,
    pendingLine: {
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision: 4,
    },
    decision: {
      kind: 'catalogue',
      decisionId: DECISION_ID,
      choiceSetRevision: 7,
      choiceSetHash,
      pendingLineId: PENDING_LINE_ID,
      expectedDraft: DRAFT,
      expectedWorkRevision: 4,
      choices: [choice],
      freeLineChoiceId: FREE_LINE_CHOICE_ID,
    },
    catalogueChoices: [{
      choiceId: CATALOGUE_CHOICE_ID,
      available: true,
      label: 'Heure de main-d’œuvre plomberie',
      category: 'labor',
      unit: 'heure',
      unitPriceCents: 5_500,
      vatRate: 20,
    }],
    freeLineChoiceId: FREE_LINE_CHOICE_ID,
    proposalStatus: { kind: 'absent' },
    proposal: null,
  };
}

function proposalPresentation(): QuoteAgentMissionPresentationV1 {
  const choices = [
    { choiceId: CONFIRM_CHOICE_ID, action: 'confirm_line' as const },
    { choiceId: EDIT_CHOICE_ID, action: 'edit_line' as const },
    { choiceId: CANCEL_CHOICE_ID, action: 'cancel_line' as const },
  ] as const;
  const expectedCatalogue = {
    itemId: CATALOGUE_ITEM_ID,
    revision: 5,
  } as const;
  const choiceSetHash = value(computeQuoteMissionLineConfirmationChoiceSetHash({
    missionId: MISSION_ID,
    choiceSetRevision: 7,
    decisionId: DECISION_ID,
    pendingLineId: PENDING_LINE_ID,
    proposalId: PROPOSAL_ID,
    proposalRevision: 1,
    expectedDraft: DRAFT,
    expectedWorkRevision: 4,
    expectedCatalogue,
    expectedVatContextDigest: VAT_DIGEST,
    diffHash: DIFF_HASH,
    choices,
  }));
  return {
    schema: 'bob.agent-mission.quote-presentation',
    version: 1,
    requiredFact: null,
    pendingLine: {
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision: 4,
    },
    decision: {
      kind: 'line_confirmation',
      decisionId: DECISION_ID,
      choiceSetRevision: 7,
      choiceSetHash,
      pendingLineId: PENDING_LINE_ID,
      proposalId: PROPOSAL_ID,
      proposalRevision: 1,
      expectedDraft: DRAFT,
      expectedWorkRevision: 4,
      expectedCatalogue,
      expectedVatContextDigest: VAT_DIGEST,
      diffHash: DIFF_HASH,
      choices,
    },
    catalogueChoices: [],
    freeLineChoiceId: null,
    proposalStatus: { kind: 'available' },
    proposal: {
      proposalId: PROPOSAL_ID,
      diffHash: DIFF_HASH,
      diff: {
        kind: 'append_line',
        before: {
          contentRevision: DRAFT.contentRevision,
          lineCount: 0,
          totalHtCents: 0,
        },
        after: {
          contentRevision: DRAFT.contentRevision + 1,
          lineCount: 1,
          totalHtCents: 11_000,
        },
      },
      line: {
        label: 'Main-d’œuvre plomberie',
        category: 'labor',
        qty: 2,
        unit: 'heures',
        unitPriceHT: 5_500,
        vatRate: 20,
      },
      catalogue: {
        itemId: CATALOGUE_ITEM_ID,
        revision: 5,
        label: 'Heure de main-d’œuvre plomberie',
      },
    },
  };
}

function emptyActions(overrides: Partial<SurfaceActions> = {}): SurfaceActions {
  return {
    stageQuoteLines: vi.fn(),
    decideQuoteCatalogueChoice: vi.fn(),
    patchQuoteLine: vi.fn(),
    cancelPendingQuoteLine: vi.fn(),
    decideQuoteLineProposal: vi.fn(),
    ...overrides,
  } as SurfaceActions;
}

function state(
  phase: AgentMissionViewV1['phase'],
  presentation: QuoteAgentMissionPresentationV1,
): ReadyV2 {
  return {
    phase: 'ready',
    protocolVersion: 2,
    mission: mission(phase),
    customerChoices: [],
    presentation,
  };
}

function renderSurface(input: {
  readonly state: ReadyV2;
  readonly actions?: SurfaceActions;
  readonly coordinator?: QuoteLineMissionCoordinator;
  readonly confirmedLines?: QuoteAgentMissionSurfaceProps['confirmedLines'];
  readonly onAuthoritativeRefresh?: () => void;
  readonly onAbandonMission?: QuoteAgentMissionSurfaceProps['onAbandonMission'];
}): ReactTestRenderer {
  return create(
    <QuoteAgentMissionSurface
      state={input.state}
      expectedScreenInstanceId={SCREEN_ID}
      actions={input.actions ?? emptyActions()}
      coordinator={input.coordinator ?? new QuoteLineMissionCoordinator(() => COMMAND_ID)}
      personality={PERSONALITY}
      confirmedLines={input.confirmedLines ?? []}
      onAuthoritativeRefresh={input.onAuthoritativeRefresh ?? vi.fn()}
      onAbandonMission={input.onAbandonMission ?? (async () => 'dismissed')}
    />,
  );
}

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) =>
    typeof child === 'string' ? child : textContent(child)).join('');
}

function allText(renderer: ReactTestRenderer): string {
  return renderer.root.findAllByType(HOST_TEXT).map(textContent).join(' | ');
}

function findButton(renderer: ReactTestRenderer, title: string): ReactTestInstance {
  const button = renderer.root.findAllByType(HOST_BUTTON)
    .find((candidate) => candidate.props.title === title);
  if (!button) throw new Error(`Bouton introuvable : ${title}`);
  return button;
}

function findPressableByLabel(
  renderer: ReactTestRenderer,
  label: string,
): ReactTestInstance {
  const pressable = renderer.root.findAllByType(HOST_PRESSABLE)
    .find((candidate) => candidate.props.accessibilityLabel === label);
  if (!pressable) throw new Error(`Pressable introuvable : ${label}`);
  return pressable;
}

function findChip(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const chip = renderer.root.findAllByType(HOST_CHIP)
    .find((candidate) => candidate.props.label === label);
  if (!chip) throw new Error(`Chip introuvable : ${label}`);
  return chip;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPress(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('QuoteAgentMissionSurface — parité voix et toucher', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    announceForAccessibility.mockReset();
    if (renderer !== null) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
  });

  it('rend les faits catalogue réels et rejoue le même commandId après erreur visible', async () => {
    let attempt = 0;
    const decideQuoteCatalogueChoice = vi.fn<
      SurfaceActions['decideQuoteCatalogueChoice']
    >(async () => {
      attempt += 1;
      return attempt === 1
        ? {
            status: 'failed' as const,
            error: {
              kind: 'dependency' as const,
              port: 'agent_mission',
              cause: 'temporary_unavailable',
            },
          }
        : {
            status: 'completed' as const,
            value: {} as never,
          };
    });
    const actions = emptyActions({ decideQuoteCatalogueChoice });
    const createCommandId = vi.fn(() => COMMAND_ID);
    const coordinator = new QuoteLineMissionCoordinator(createCommandId);
    const refresh = vi.fn();
    const ready = state('awaiting_catalogue_choice', cataloguePresentation());
    await act(async () => {
      renderer = renderSurface({
        state: ready,
        actions,
        coordinator,
        onAuthoritativeRefresh: refresh,
      });
    });

    const catalogueChoice = renderer!.root.findAllByType(HOST_PRESSABLE)
      .find((candidate) =>
        String(candidate.props.accessibilityLabel)
          .includes('Heure de main-d’œuvre plomberie'));
    if (!catalogueChoice) throw new Error('Choix catalogue réel introuvable');
    expect(catalogueChoice.props).toMatchObject({
      accessibilityRole: 'button',
      accessibilityState: { disabled: false },
    });
    const accessibilityLabel = String(catalogueChoice.props.accessibilityLabel);
    expect(accessibilityLabel).toContain('Choix 1');
    expect(accessibilityLabel).toContain('Main d’œuvre');
    expect(accessibilityLabel).toContain('55,00');
    expect(accessibilityLabel).toContain('heure');
    expect(accessibilityLabel).toContain('TVA 20 %');
    expect(allText(renderer!)).toContain('Heure de main-d’œuvre plomberie');
    expect(allText(renderer!)).toContain('Main d’œuvre');
    expect(allText(renderer!)).toContain('55,00');
    expect(allText(renderer!)).toContain('heure');
    expect(allText(renderer!)).toContain('TVA 20 %');

    await flushPress(catalogueChoice.props.onPress);
    expect(refresh).not.toHaveBeenCalled();
    expect(allText(renderer!)).toContain('même commande idempotente');
    expect(findButton(
      renderer!,
      t('devis.mission.line.retry', { personality: PERSONALITY }),
    )).toBeDefined();

    await act(async () => {
      renderer?.update(
        <QuoteAgentMissionSurface
          state={ready}
          expectedScreenInstanceId={SCREEN_ID}
          actions={actions}
          coordinator={coordinator}
          personality={PERSONALITY}
          confirmedLines={[]}
          onAuthoritativeRefresh={refresh}
          onAbandonMission={async () => 'dismissed'}
        />,
      );
    });
    expect(allText(renderer!)).toContain('même commande idempotente');

    await flushPress(
      findButton(
        renderer!,
        t('devis.mission.line.retry', { personality: PERSONALITY }),
      ).props.onPress,
    );
    expect(decideQuoteCatalogueChoice).toHaveBeenCalledTimes(2);
    expect(createCommandId).toHaveBeenCalledOnce();
    expect(decideQuoteCatalogueChoice.mock.calls[0]?.[0]).toEqual(
      decideQuoteCatalogueChoice.mock.calls[1]?.[0],
    );
    expect(decideQuoteCatalogueChoice).toHaveBeenLastCalledWith({
      missionId: MISSION_ID,
      commandId: COMMAND_ID,
      expectedMissionRevision: 9,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: DRAFT.slotRevision,
      expectedDraftContentRevision: DRAFT.contentRevision,
      expectedScreenInstanceId: SCREEN_ID,
      decisionId: DECISION_ID,
      choiceSetRevision: 7,
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision: 4,
      choiceId: CATALOGUE_CHOICE_ID,
      additionalLines: [],
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'devis.mission.line.confirm' as const,
      'confirm_line' as const,
      CONFIRM_CHOICE_ID,
      'button' as const,
    ],
    [
      'devis.mission.line.modify' as const,
      'edit_line' as const,
      EDIT_CHOICE_ID,
      'button' as const,
    ],
    [
      'devis.mission.line.cancel' as const,
      'cancel_line' as const,
      CANCEL_CHOICE_ID,
      'pressable' as const,
    ],
  ])(
    'transmet les fences scellées pour %s',
    async (labelKey, _action, expectedChoiceId, host) => {
      const decideQuoteLineProposal = vi.fn<
        SurfaceActions['decideQuoteLineProposal']
      >(async () => ({
        status: 'completed' as const,
        value: {} as never,
      }));
      const actions = emptyActions({ decideQuoteLineProposal });
      const presentation = proposalPresentation();
      if (presentation.decision?.kind !== 'line_confirmation') {
        throw new Error('Décision de confirmation absente');
      }
      await act(async () => {
        renderer = renderSurface({
          state: state('awaiting_line_confirmation', presentation),
          actions,
        });
      });
      const label = t(labelKey, { personality: PERSONALITY });
      const actionNode = host === 'button'
        ? findButton(renderer!, label)
        : findPressableByLabel(renderer!, label);

      await flushPress(actionNode.props.onPress);

      expect(decideQuoteLineProposal).toHaveBeenCalledWith({
        missionId: MISSION_ID,
        commandId: COMMAND_ID,
        expectedMissionRevision: 9,
        expectedDraftSessionId: DRAFT.sessionId,
        expectedDraftSlotRevision: DRAFT.slotRevision,
        expectedDraftContentRevision: DRAFT.contentRevision,
        expectedScreenInstanceId: SCREEN_ID,
        decisionId: DECISION_ID,
        choiceSetRevision: 7,
        choiceSetHash: presentation.decision.choiceSetHash,
        choiceId: expectedChoiceId,
        pendingLineId: PENDING_LINE_ID,
        proposalId: PROPOSAL_ID,
        proposalRevision: 1,
        expectedWorkRevision: 4,
        expectedCatalogue: {
          itemId: CATALOGUE_ITEM_ID,
          revision: 5,
        },
        diffHash: DIFF_HASH,
      });
    },
  );

  it('annule au toucher une ligne encore incomplète avec le même contrat que la voix', async () => {
    const cancelPendingQuoteLine = vi.fn<
      SurfaceActions['cancelPendingQuoteLine']
    >(async () => ({
      status: 'completed' as const,
      value: {} as never,
    }));
    const actions = emptyActions({ cancelPendingQuoteLine });
    const presentation: QuoteAgentMissionPresentationV1 = {
      schema: 'bob.agent-mission.quote-presentation',
      version: 1,
      requiredFact: 'unit_price',
      pendingLine: {
        pendingLineId: PENDING_LINE_ID,
        expectedWorkRevision: 4,
      },
      decision: null,
      catalogueChoices: [],
      freeLineChoiceId: null,
      proposalStatus: { kind: 'absent' },
      proposal: null,
    };
    await act(async () => {
      renderer = renderSurface({
        state: state('awaiting_line_details', presentation),
        actions,
      });
    });

    await flushPress(findButton(
      renderer!,
      t('devis.mission.line.cancel', { personality: PERSONALITY }),
    ).props.onPress);

    expect(cancelPendingQuoteLine).toHaveBeenCalledWith({
      missionId: MISSION_ID,
      commandId: COMMAND_ID,
      expectedMissionRevision: 9,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: DRAFT.slotRevision,
      expectedDraftContentRevision: DRAFT.contentRevision,
      expectedScreenInstanceId: SCREEN_ID,
      pendingLineId: PENDING_LINE_ID,
      expectedWorkRevision: 4,
    });
    expect(actions.decideQuoteLineProposal).not.toHaveBeenCalled();
  });

  it('rend le diff autoritaire avant/après avec pluriels et résumé accessible', async () => {
    await act(async () => {
      renderer = renderSurface({
        state: state('awaiting_line_confirmation', proposalPresentation()),
      });
    });

    const text = allText(renderer!);
    expect(text).toContain(
      t('devis.mission.line.diffBefore', { personality: PERSONALITY }),
    );
    expect(text).toContain(
      t('devis.mission.line.diffAfter', { personality: PERSONALITY }),
    );
    expect(text).toContain('0 lignes');
    expect(text).toContain('1 ligne');
    expect(text).toContain('0,00');
    expect(text).toContain('110,00');
    const summary = renderer!.root.findAllByType(HOST_VIEW)
      .find((candidate) => candidate.props.accessibilityRole === 'summary');
    expect(summary?.props.accessibilityLabel).toContain('Avant validation');
    expect(summary?.props.accessibilityLabel).toContain('Après validation');
    expect(summary?.props.accessibilityLabel).toContain('110,00');
  });

  it('présente une tête queued comme finalisation sans formulaire ni effet au montage', async () => {
    const actions = emptyActions();
    const presentation: QuoteAgentMissionPresentationV1 = {
      schema: 'bob.agent-mission.quote-presentation',
      version: 1,
      requiredFact: null,
      pendingLine: {
        pendingLineId: PENDING_LINE_ID,
        expectedWorkRevision: 5,
      },
      decision: null,
      catalogueChoices: [],
      freeLineChoiceId: null,
      proposalStatus: { kind: 'absent' },
      proposal: null,
    };
    await act(async () => {
      renderer = renderSurface({
        state: state('awaiting_lines', presentation),
        actions,
      });
    });

    expect(allText(renderer!)).toContain(
      t('devis.mission.line.finishingTitle', { personality: PERSONALITY }),
    );
    expect(renderer!.root.findByType(HOST_ACTIVITY).props).toMatchObject({
      accessibilityRole: 'progressbar',
      accessibilityLabel: t('devis.mission.line.finishingTitle', {
        personality: PERSONALITY,
      }),
    });
    expect(renderer!.root.findAllByType(HOST_TEXT_INPUT)).toHaveLength(0);
    expect(renderer!.root.findAllByType(HOST_BUTTON).some(
      (button) =>
        button.props.title
        === t('devis.mission.line.add', { personality: PERSONALITY }),
    )).toBe(false);
    expect(actions.stageQuoteLines).not.toHaveBeenCalled();
    expect(actions.decideQuoteCatalogueChoice).not.toHaveBeenCalled();
    expect(actions.patchQuoteLine).not.toHaveBeenCalled();
    expect(actions.decideQuoteLineProposal).not.toHaveBeenCalled();
  });

  it('conserve la saisie disponible à quatre-vingt-dix-neuf lignes', async () => {
    const presentation: QuoteAgentMissionPresentationV1 = {
      ...cataloguePresentation(),
      pendingLine: null,
      decision: null,
      catalogueChoices: [],
      freeLineChoiceId: null,
    };
    const confirmedLines = Array.from({ length: 99 }, (_, index) => ({
      label: `Prestation ${index + 1}`,
      category: 'labor' as const,
      qty: 1,
      unit: 'heure',
      unitPriceHT: 100,
      vatRate: 20,
    }));

    await act(async () => {
      renderer = renderSurface({
        state: state('awaiting_lines', presentation),
        confirmedLines,
      });
    });

    expect(renderer!.root.findAllByType(HOST_TEXT_INPUT).length).toBeGreaterThan(0);
    expect(findButton(
      renderer!,
      t('devis.mission.line.add', { personality: PERSONALITY }),
    )).toBeDefined();
    expect(allText(renderer!)).not.toContain(
      t('devis.mission.line.limitTitle', { personality: PERSONALITY }),
    );
  });

  it('ferme honnêtement la saisie manuelle quand le brouillon contient cent lignes', async () => {
    const actions = emptyActions();
    const presentation: QuoteAgentMissionPresentationV1 = {
      ...cataloguePresentation(),
      pendingLine: null,
      decision: null,
      catalogueChoices: [],
      freeLineChoiceId: null,
    };
    const confirmedLines = Array.from({ length: 100 }, (_, index) => ({
      label: `Prestation ${index + 1}`,
      category: 'labor' as const,
      qty: 1,
      unit: 'heure',
      unitPriceHT: 100,
      vatRate: 20,
    }));

    await act(async () => {
      renderer = renderSurface({
        state: state('awaiting_lines', presentation),
        actions,
        confirmedLines,
      });
    });

    expect(allText(renderer!)).toContain(
      t('devis.mission.line.limitTitle', { personality: PERSONALITY }),
    );
    expect(allText(renderer!)).toContain('100 lignes');
    expect(renderer!.root.findAllByType(HOST_TEXT_INPUT)).toHaveLength(0);
    expect(renderer!.root.findAllByType(HOST_BUTTON).some(
      (button) =>
        button.props.title
        === t('devis.mission.line.add', { personality: PERSONALITY }),
    )).toBe(false);
    expect(findButton(
      renderer!,
      t('devis.mission.line.abandonAction', { personality: PERSONALITY }),
    )).toBeDefined();
    expect(actions.stageQuoteLines).not.toHaveBeenCalled();
  });

  it('distingue une confirmation refusée d’un échec d’abandon', async () => {
    const ready = state('awaiting_lines', {
      ...cataloguePresentation(),
      pendingLine: null,
      decision: null,
      catalogueChoices: [],
      freeLineChoiceId: null,
    });
    const abandonLabel = t('devis.mission.line.abandonAction', {
      personality: PERSONALITY,
    });
    await act(async () => {
      renderer = renderSurface({
        state: ready,
        onAbandonMission: async () => 'dismissed',
      });
    });
    await flushPress(findPressableByLabel(renderer!, abandonLabel).props.onPress);
    expect(allText(renderer!)).not.toContain(
      t('devis.mission.line.abandonError', { personality: PERSONALITY }),
    );

    await act(async () => {
      renderer?.update(
        <QuoteAgentMissionSurface
          state={ready}
          expectedScreenInstanceId={SCREEN_ID}
          actions={emptyActions()}
          coordinator={new QuoteLineMissionCoordinator(() => COMMAND_ID)}
          personality={PERSONALITY}
          confirmedLines={[]}
          onAuthoritativeRefresh={vi.fn()}
          onAbandonMission={async () => 'failed'}
        />,
      );
    });
    await flushPress(findPressableByLabel(renderer!, abandonLabel).props.onPress);
    expect(allText(renderer!)).toContain(
      t('devis.mission.line.abandonError', { personality: PERSONALITY }),
    );
  });

  it('n’envoie qu’un abandon sur un double tap et déverrouille après la réponse', async () => {
    const flight = deferred<'dismissed'>();
    const onAbandonMission = vi.fn(() => flight.promise);
    const ready = state('awaiting_lines', {
      ...cataloguePresentation(),
      pendingLine: null,
      decision: null,
      catalogueChoices: [],
      freeLineChoiceId: null,
    });
    const abandonLabel = t('devis.mission.line.abandonAction', {
      personality: PERSONALITY,
    });
    await act(async () => {
      renderer = renderSurface({ state: ready, onAbandonMission });
    });
    const abandon = findPressableByLabel(renderer!, abandonLabel);

    await act(async () => {
      abandon.props.onPress();
      abandon.props.onPress();
      await Promise.resolve();
    });

    expect(onAbandonMission).toHaveBeenCalledOnce();
    expect(findPressableByLabel(renderer!, abandonLabel).props).toMatchObject({
      disabled: true,
      accessibilityState: { disabled: true },
    });

    await act(async () => {
      flight.resolve('dismissed');
      await flight.promise;
    });
    expect(findPressableByLabel(renderer!, abandonLabel).props).toMatchObject({
      disabled: false,
      accessibilityState: { disabled: false },
    });
  });

  it('applique une exclusion unique entre action et abandon dans les deux sens', async () => {
    const actionFlight = deferred<Awaited<
      ReturnType<SurfaceActions['decideQuoteCatalogueChoice']>
    >>();
    const abandonFlight = deferred<'dismissed'>();
    const decideQuoteCatalogueChoice = vi.fn(() => actionFlight.promise);
    const onAbandonMission = vi.fn(() => abandonFlight.promise);
    const actions = emptyActions({ decideQuoteCatalogueChoice });
    const ready = state('awaiting_catalogue_choice', cataloguePresentation());
    const abandonLabel = t('devis.mission.line.abandonAction', {
      personality: PERSONALITY,
    });
    await act(async () => {
      renderer = renderSurface({
        state: ready,
        actions,
        onAbandonMission,
      });
    });
    const catalogueChoice = renderer!.root.findAllByType(HOST_PRESSABLE)
      .find((candidate) =>
        String(candidate.props.accessibilityLabel)
          .includes('Heure de main-d’œuvre plomberie'));
    if (!catalogueChoice) throw new Error('Choix catalogue réel introuvable');

    await act(async () => {
      catalogueChoice.props.onPress();
      findPressableByLabel(renderer!, abandonLabel).props.onPress();
      await Promise.resolve();
    });
    expect(decideQuoteCatalogueChoice).toHaveBeenCalledOnce();
    expect(onAbandonMission).not.toHaveBeenCalled();
    await act(async () => {
      actionFlight.resolve({
        status: 'completed',
        value: {} as never,
      });
      await actionFlight.promise;
    });

    const secondAbandonFlight = deferred<'dismissed'>();
    onAbandonMission.mockImplementationOnce(() => secondAbandonFlight.promise);
    await act(async () => {
      findPressableByLabel(renderer!, abandonLabel).props.onPress();
      catalogueChoice.props.onPress();
      await Promise.resolve();
    });
    expect(onAbandonMission).toHaveBeenCalledOnce();
    expect(decideQuoteCatalogueChoice).toHaveBeenCalledOnce();
    await act(async () => {
      secondAbandonFlight.resolve('dismissed');
      await secondAbandonFlight.promise;
    });
  });

  it('expose les choix binaires comme un radiogroup avec leur état coché', async () => {
    const presentation: QuoteAgentMissionPresentationV1 = {
      schema: 'bob.agent-mission.quote-presentation',
      version: 1,
      requiredFact: 'housing_older_than_2y',
      pendingLine: {
        pendingLineId: PENDING_LINE_ID,
        expectedWorkRevision: 4,
      },
      decision: null,
      catalogueChoices: [],
      freeLineChoiceId: null,
      proposalStatus: { kind: 'absent' },
      proposal: null,
    };
    await act(async () => {
      renderer = renderSurface({
        state: state('awaiting_line_details', presentation),
      });
    });

    const yes = findButton(
      renderer!,
      t('devis.mission.line.yes', { personality: PERSONALITY }),
    );
    const no = findButton(
      renderer!,
      t('devis.mission.line.no', { personality: PERSONALITY }),
    );
    expect(yes.props).toMatchObject({
      accessibilityRole: 'radio',
      accessibilityState: { checked: false },
    });
    expect(no.props).toMatchObject({
      accessibilityRole: 'radio',
      accessibilityState: { checked: false },
    });
    expect(renderer!.root.findAllByType(HOST_VIEW).some(
      (view) => view.props.accessibilityRole === 'radiogroup',
    )).toBe(true);

    await act(async () => yes.props.onPress());

    expect(findButton(
      renderer!,
      t('devis.mission.line.yes', { personality: PERSONALITY }),
    ).props.accessibilityState).toEqual({ checked: true });
  });

  it('rend champs, chips et boutons inertes pendant une mutation puis les réactive', async () => {
    const patchFlight = deferred<Awaited<
      ReturnType<SurfaceActions['patchQuoteLine']>
    >>();
    const patchQuoteLine = vi.fn(() => patchFlight.promise);
    const presentation: QuoteAgentMissionPresentationV1 = {
      schema: 'bob.agent-mission.quote-presentation',
      version: 1,
      requiredFact: null,
      pendingLine: {
        pendingLineId: PENDING_LINE_ID,
        expectedWorkRevision: 4,
      },
      decision: null,
      catalogueChoices: [],
      freeLineChoiceId: null,
      proposalStatus: { kind: 'absent' },
      proposal: null,
    };
    await act(async () => {
      renderer = renderSurface({
        state: state('awaiting_line_details', presentation),
        actions: emptyActions({ patchQuoteLine }),
      });
    });
    const input = renderer!.root.findByType(HOST_TEXT_INPUT);
    await act(async () => {
      input.props.onChangeText('55');
    });
    const submit = findButton(
      renderer!,
      t('devis.mission.line.submit', { personality: PERSONALITY }),
    );
    const categoryChip = findChip(
      renderer!,
      t('devis.mission.line.fact.category', { personality: PERSONALITY }),
    );
    expect(categoryChip.props.accessibilityRole).toBe('radio');

    await act(async () => {
      submit.props.onPress();
      await Promise.resolve();
    });

    expect(patchQuoteLine).toHaveBeenCalledOnce();
    expect(renderer!.root.findByType(HOST_TEXT_INPUT).props).toMatchObject({
      editable: false,
      accessibilityState: { disabled: true },
      value: '55',
    });
    expect(findChip(
      renderer!,
      t('devis.mission.line.fact.category', { personality: PERSONALITY }),
    ).props.disabled).toBe(true);
    expect(findButton(
      renderer!,
      t('devis.mission.line.submit', { personality: PERSONALITY }),
    ).props.disabled).toBe(true);

    await act(async () => {
      renderer!.root.findByType(HOST_TEXT_INPUT).props.onChangeText('66');
      categoryChip.props.onPress();
    });
    expect(renderer!.root.findByType(HOST_TEXT_INPUT).props.value).toBe('55');
    expect(findChip(
      renderer!,
      t('devis.mission.line.fact.category', { personality: PERSONALITY }),
    ).props.active).toBe(false);

    await act(async () => {
      patchFlight.resolve({
        status: 'completed',
        value: {} as never,
      });
      await patchFlight.promise;
    });
    expect(renderer!.root.findByType(HOST_TEXT_INPUT).props.editable).toBe(true);
    expect(findChip(
      renderer!,
      t('devis.mission.line.fact.category', { personality: PERSONALITY }),
    ).props.disabled).toBe(false);
  });
});
