import { type ElementType, type ReactNode } from 'react';
import { t } from '@bob/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import {
  ConversationTimeZoneSheet,
  type ConversationTimeZoneSheetProps,
} from './ConversationTimeZoneSheet';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
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
    Sheet: (props: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('Sheet', props, props.children),
    font: () => ({ fontFamily: 'MockFont' }),
    useTheme: () => ({
      colors: {
        ink900: '#ink900',
        ink600: '#ink600',
        slate500: '#slate500',
      },
      controls: {
        segmentedTrack: '#track',
        cardBorder: '#border',
      },
      semantic: {
        ai: '#ai',
        aiBg: '#aiBg',
        aiInk: '#aiInk',
        danger: '#danger',
      },
      personality: 'pro',
      radius: { pill: 999 },
    }),
  };
});

const HOST_BUTTON = 'Button' as unknown as ElementType;
const HOST_SHEET = 'Sheet' as unknown as ElementType;
const HOST_TEXT = 'Text' as unknown as ElementType;
const HOST_TEXT_INPUT = 'TextInput' as unknown as ElementType;
const HOST_PRESSABLE = 'Pressable' as unknown as ElementType;

function renderSheet(
  state: ConversationTimeZoneSheetProps['state'],
): {
  readonly renderer: ReactTestRenderer;
  readonly onConfirm: ReturnType<typeof vi.fn>;
  readonly onRedetect: ReturnType<typeof vi.fn>;
  readonly onCancel: ReturnType<typeof vi.fn>;
} {
  const onConfirm = vi.fn();
  const onRedetect = vi.fn();
  const onCancel = vi.fn();
  return {
    renderer: create(
      <ConversationTimeZoneSheet
        state={state}
        onConfirm={onConfirm}
        onRedetect={onRedetect}
        onCancel={onCancel}
      />,
    ),
    onConfirm,
    onRedetect,
    onCancel,
  };
}

const choosing = (
  over: Partial<NonNullable<ConversationTimeZoneSheetProps['state']>> = {},
): NonNullable<ConversationTimeZoneSheetProps['state']> => ({
  phase: 'choosing',
  suggestedTimeZone: 'Europe/Paris',
  detectionRevision: 1,
  issue: null,
  ...over,
});

describe('ConversationTimeZoneSheet — confirmation explicite avant Bob Live', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (renderer !== null) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
  });

  it('sélectionne la suggestion et transmet exactement le fuseau au CTA', async () => {
    let harness!: ReturnType<typeof renderSheet>;
    await act(async () => {
      harness = renderSheet(choosing());
      renderer = harness.renderer;
    });

    const sheet = renderer!.root.findByType(HOST_SHEET);
    expect(sheet.props.visible).toBe(true);
    const confirm = renderer!.root.findAllByType(HOST_BUTTON)[0];
    expect(confirm?.props).toMatchObject({
      title: t('agent.global.timeZoneConfirm', {
        personality: 'pro',
        params: { timeZone: 'Europe/Paris' },
      }),
      disabled: false,
      loading: false,
    });
    await act(async () => confirm?.props.onPress());
    expect(harness.onConfirm).toHaveBeenCalledWith('Europe/Paris');

    await act(async () => sheet.props.onClose());
    expect(harness.onCancel).toHaveBeenCalledOnce();
  });

  it('reste utilisable sans détection : recherche puis sélection manuelle', async () => {
    let harness!: ReturnType<typeof renderSheet>;
    await act(async () => {
      harness = renderSheet(choosing({
        suggestedTimeZone: null,
        issue: 'detection_unavailable',
      }));
      renderer = harness.renderer;
    });

    const confirmBefore = renderer!.root.findAllByType(HOST_BUTTON)[0];
    expect(confirmBefore?.props.disabled).toBe(true);
    const input = renderer!.root.findByType(HOST_TEXT_INPUT);
    await act(async () => input.props.onChangeText('Cayenne'));
    const cayenne = renderer!.root.findAllByType(HOST_PRESSABLE).find(
      (node) => node.props.accessibilityLabel === 'America/Cayenne',
    );
    expect(cayenne).toBeDefined();
    await act(async () => cayenne?.props.onPress());

    const confirmAfter = renderer!.root.findAllByType(HOST_BUTTON)[0];
    expect(confirmAfter?.props.disabled).toBe(false);
    await act(async () => confirmAfter?.props.onPress());
    expect(harness.onConfirm).toHaveBeenCalledWith('America/Cayenne');

    const detectionInfo = renderer!.root.findAll(
      (node: ReactTestInstance) =>
        node.type === HOST_TEXT
        && node.children.join('').includes('détection est indisponible'),
    );
    expect(detectionInfo).toHaveLength(1);
  });

  it('relance explicitement la détection sans démarrer Bob', async () => {
    let harness!: ReturnType<typeof renderSheet>;
    await act(async () => {
      harness = renderSheet(choosing({ suggestedTimeZone: null }));
      renderer = harness.renderer;
    });

    const redetect = renderer!.root.findAllByType(HOST_BUTTON)[1];
    await act(async () => redetect?.props.onPress());
    expect(harness.onRedetect).toHaveBeenCalledOnce();
    expect(harness.onConfirm).not.toHaveBeenCalled();
  });

  it('verrouille fermeture, recherche, choix et boutons pendant la sauvegarde', async () => {
    let harness!: ReturnType<typeof renderSheet>;
    await act(async () => {
      harness = renderSheet(choosing({ phase: 'saving' }));
      renderer = harness.renderer;
    });

    const sheet = renderer!.root.findByType(HOST_SHEET);
    expect(sheet.props.closeBusy).toBe(true);
    await act(async () => sheet.props.onClose());
    expect(harness.onCancel).not.toHaveBeenCalled();

    expect(renderer!.root.findByType(HOST_TEXT_INPUT).props.editable).toBe(false);
    expect(
      renderer!.root.findAllByType(HOST_PRESSABLE)
        .every((option) => option.props.disabled === true),
    ).toBe(true);
    expect(
      renderer!.root.findAllByType(HOST_BUTTON)
        .every((button) => button.props.disabled === true),
    ).toBe(true);
    expect(renderer!.root.findAllByType(HOST_BUTTON)[0]?.props.loading).toBe(true);
  });

  it('garde la sélection et rend l’erreur réseau relançable', async () => {
    let harness!: ReturnType<typeof renderSheet>;
    await act(async () => {
      harness = renderSheet(choosing({ issue: 'confirmation_failed' }));
      renderer = harness.renderer;
    });

    const alerts = renderer!.root.findAll(
      (node: ReactTestInstance) =>
        node.type === HOST_TEXT && node.props.accessibilityRole === 'alert',
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.children.join('')).toBe(
      t('agent.global.timeZoneError', { personality: 'pro' }),
    );
    const confirm = renderer!.root.findAllByType(HOST_BUTTON)[0];
    expect(confirm?.props.disabled).toBe(false);
    await act(async () => confirm?.props.onPress());
    expect(harness.onConfirm).toHaveBeenCalledWith('Europe/Paris');
  });
});
