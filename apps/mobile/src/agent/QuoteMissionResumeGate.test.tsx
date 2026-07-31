import { type ElementType, type ReactNode } from 'react';
import { t } from '@bob/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  create,
  type ReactTestRenderer,
} from 'react-test-renderer';
import {
  QuoteMissionResumeGate,
  type QuoteMissionResumeGateProps,
} from './QuoteMissionResumeGate';
import type {
  PresentQuoteAgentMissionResumeView,
} from './agent-mission-recovery-state';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('../components/icons', () => ({ CloseIcon: 'CloseIcon' }));
vi.mock('@bob/ui', async () => {
  const { createElement } = await import('react');
  return {
    Button: (props: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('Button', props, props.title as string),
    font: () => ({ fontFamily: 'MockFont' }),
    useTheme: () => ({
      colors: {
        bg: '#bg',
        ink900: '#ink900',
        ink600: '#ink600',
        slate500: '#slate500',
      },
      semantic: {
        ai: '#ai',
        aiBg: '#aiBg',
        danger: '#danger',
      },
      controls: { segmentedTrack: '#track' },
      radius: { pill: 999 },
    }),
  };
});

const HOST_BUTTON = 'Button' as unknown as ElementType;
const HOST_PRESSABLE = 'Pressable' as unknown as ElementType;
const PERSONALITY = 'pro' as const;

function recovery(
  status: 'active' | 'expired',
): PresentQuoteAgentMissionResumeView {
  return {
    protocolVersion: 2,
    mission: {
      id: '10000000-0000-4000-8000-000000000001',
      status,
      phase: 'awaiting_line_details',
      revision: 9,
      actionable: status === 'active',
      draft: {
        sessionId: 'draft-session',
        slotRevision: 7,
        contentRevision: 4,
      },
      idleExpiresAt: '2026-07-30T12:10:00.000Z',
      hardExpiresAt: '2026-07-30T13:00:00.000Z',
    },
    draft: {
      sessionId: 'draft-session',
      slotRevision: 7,
      contentRevision: 4,
      step: 'lignes',
    },
    customerChoices: [],
    presentation: {
      schema: 'bob.agent-mission.quote-presentation',
      version: 1,
      requiredFact: 'unit_price',
      pendingLine: {
        pendingLineId: '20000000-0000-4000-8000-000000000001',
        expectedWorkRevision: 4,
      },
      decision: null,
      catalogueChoices: [],
      freeLineChoiceId: null,
      proposalStatus: { kind: 'absent' },
      proposal: null,
    },
  } as PresentQuoteAgentMissionResumeView;
}

function renderGate(
  overrides: Partial<QuoteMissionResumeGateProps> = {},
): {
  readonly renderer: ReactTestRenderer;
  readonly onResume: ReturnType<typeof vi.fn>;
  readonly onLeave: ReturnType<typeof vi.fn>;
  readonly onClose: ReturnType<typeof vi.fn>;
} {
  const onResume = vi.fn();
  const onLeave = vi.fn();
  const onClose = vi.fn();
  return {
    renderer: create(
      <QuoteMissionResumeGate
        recovery={recovery('active')}
        pending={false}
        failed={false}
        personality={PERSONALITY}
        topInset={10}
        bottomInset={12}
        onResume={onResume}
        onLeave={onLeave}
        onClose={onClose}
        {...overrides}
      />,
    ),
    onResume,
    onLeave,
    onClose,
  };
}

describe('QuoteMissionResumeGate — geste explicite et expiration honnête', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (renderer !== null) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
  });

  it('ne parle, ne navigue et ne reprend rien au montage', async () => {
    let harness!: ReturnType<typeof renderGate>;
    await act(async () => {
      harness = renderGate();
      renderer = harness.renderer;
    });
    expect(harness.onResume).not.toHaveBeenCalled();
    expect(harness.onLeave).not.toHaveBeenCalled();
    expect(harness.onClose).not.toHaveBeenCalled();
  });

  it('reprend seulement après le CTA explicite et désarme le double tap en attente', async () => {
    let harness!: ReturnType<typeof renderGate>;
    await act(async () => {
      harness = renderGate({ pending: false });
      renderer = harness.renderer;
    });
    let button = renderer!.root.findByType(HOST_BUTTON);
    expect(button.props.disabled).toBe(false);
    await act(async () => button.props.onPress());
    expect(harness.onResume).toHaveBeenCalledOnce();

    await act(async () => {
      renderer?.update(
        <QuoteMissionResumeGate
          recovery={recovery('active')}
          pending
          failed={false}
          personality={PERSONALITY}
          topInset={10}
          bottomInset={12}
          onResume={harness.onResume}
          onLeave={harness.onLeave}
          onClose={harness.onClose}
        />,
      );
    });
    button = renderer!.root.findByType(HOST_BUTTON);
    expect(button.props).toMatchObject({
      title: t('devis.mission.resumeLoading', { personality: PERSONALITY }),
      disabled: true,
      loading: true,
    });
    expect(harness.onResume).toHaveBeenCalledOnce();
    expect(harness.onLeave).not.toHaveBeenCalled();
  });

  it('une mission expirée ferme honnêtement sans promettre une relance automatique', async () => {
    let harness!: ReturnType<typeof renderGate>;
    await act(async () => {
      harness = renderGate({ recovery: recovery('expired'), pending: false });
      renderer = harness.renderer;
    });
    const button = renderer!.root.findByType(HOST_BUTTON);
    expect(button.props.title).toBe('Fermer sans modifier');
    expect(button.props).toMatchObject({
      title: t('devis.mission.resumeExpiredAction', { personality: PERSONALITY }),
      accessibilityLabel: t('devis.mission.resumeExpiredAction', {
        personality: PERSONALITY,
      }),
      disabled: false,
      loading: false,
    });
    await act(async () => button.props.onPress());
    expect(harness.onLeave).toHaveBeenCalledOnce();
    expect(harness.onResume).not.toHaveBeenCalled();

    const close = renderer!.root.findByType(HOST_PRESSABLE);
    expect(close.props.accessibilityRole).toBe('button');
  });
});
