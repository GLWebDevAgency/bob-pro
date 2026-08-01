import { type ElementType, type ReactNode } from 'react';
import { t } from '@bob/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { RealtimeDiagnosticTraceSheet } from './RealtimeDiagnosticTraceSheet';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }));
vi.mock('./icons', () => ({ SparkIcon: 'SparkIcon' }));
vi.mock('@bob/ui', async () => {
  const { createElement } = await import('react');
  return {
    Button: (props: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('Button', props, props.title as string),
    Sheet: (props: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('Sheet', props, props.children),
    font: () => ({ fontFamily: 'MockFont' }),
    useTheme: () => ({
      colors: { ink900: '#ink900', ink600: '#ink600' },
      semantic: { aiBg: '#aiBg', aiInk: '#aiInk' },
      personality: 'pro',
      radius: { pill: 999 },
    }),
  };
});

const HOST_BUTTON = 'Button' as unknown as ElementType;
const HOST_SHEET = 'Sheet' as unknown as ElementType;
const HOST_TEXT = 'Text' as unknown as ElementType;

describe('RealtimeDiagnosticTraceSheet — consentement avant microphone', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (renderer !== null) await act(async () => renderer?.unmount());
    renderer = null;
  });

  it('affiche la durée venue du serveur et ne consent que par le CTA explicite', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    await act(async () => {
      renderer = create(
        <RealtimeDiagnosticTraceSheet
          disclosure={{ enabled: true, retentionDays: 30, purpose: 'staging_quality' }}
          confirmationPending
          onConfirm={onConfirm}
          onCancel={onCancel}
        />,
      );
    });

    const sheet = renderer!.root.findByType(HOST_SHEET);
    expect(sheet.props.visible).toBe(true);
    const body = renderer!.root.findAllByType(HOST_TEXT)[1];
    expect(body?.children.join('')).toBe(
      t('agent.global.diagnosticTrace', {
        personality: 'pro',
        params: { retentionDays: 30 },
      }),
    );
    const [confirm, cancel] = renderer!.root.findAllByType(HOST_BUTTON);
    await act(async () => confirm?.props.onPress());
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => cancel?.props.onPress());
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('reste fermé sans disclosure ou après résolution de la décision', async () => {
    await act(async () => {
      renderer = create(
        <RealtimeDiagnosticTraceSheet
          disclosure={null}
          confirmationPending
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });
    expect(renderer!.root.findByType(HOST_SHEET).props.visible).toBe(false);

    await act(async () => {
      renderer!.update(
        <RealtimeDiagnosticTraceSheet
          disclosure={{ enabled: true, retentionDays: 30, purpose: 'staging_quality' }}
          confirmationPending={false}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });
    expect(renderer!.root.findByType(HOST_SHEET).props.visible).toBe(false);
  });

  it('traite la fermeture système comme un refus explicite', async () => {
    const onCancel = vi.fn();
    await act(async () => {
      renderer = create(
        <RealtimeDiagnosticTraceSheet
          disclosure={{ enabled: true, retentionDays: 30, purpose: 'staging_quality' }}
          confirmationPending
          onConfirm={vi.fn()}
          onCancel={onCancel}
        />,
      );
    });
    await act(async () => renderer!.root.findByType(HOST_SHEET).props.onClose());
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
