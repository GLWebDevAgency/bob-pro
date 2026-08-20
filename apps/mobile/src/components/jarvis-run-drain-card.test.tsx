import type { ElementType, ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { JarvisRunView } from '@bob/api-client';

import type {
  JarvisRunCall,
  JarvisRunCoordinator,
  JarvisRunPorts,
} from '../agent/jarvis-run-coordinator';
import { JarvisRunDrainCard } from './jarvis-run-drain-card';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }));
vi.mock('@bob/ui', async () => {
  const { createElement } = await import('react');
  return {
    Button: (props: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('Button', props, props.title as string),
    Card: (props: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('Card', props, props.children),
    font: () => ({ fontFamily: 'MockFont' }),
    useTheme: () => ({ colors: { ink900: '#ink900', slate500: '#slate500' } }),
  };
});

const HOST_BUTTON = 'Button' as unknown as ElementType;
const HOST_TEXT = 'Text' as unknown as ElementType;
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const PORTS: JarvisRunPorts = { submitCommand: vi.fn() };

function run(overrides: Partial<JarvisRunView> = {}): JarvisRunView {
  return {
    runId: RUN_ID,
    kind: 'single_business_action',
    definitionVersion: 1,
    actionReference: { actionId: 'relance-envoyer', actionVersion: 3 },
    status: 'active',
    revision: 4,
    nextWakeAt: null,
    terminalAt: null,
    ...overrides,
  };
}

function coordinator(cancel: () => Promise<JarvisRunCall>) {
  return { cancel: vi.fn(cancel) };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly settle: (value: T) => void } {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function buttons(renderer: ReactTestRenderer) {
  return Object.fromEntries(
    renderer.root.findAllByType(HOST_BUTTON).map((node) => [node.props.title as string, node.props]),
  );
}

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(HOST_TEXT)
    .flatMap((node) => node.children)
    .filter((value): value is string => typeof value === 'string');
}

async function render(
  runView: JarvisRunView,
  cancel: () => Promise<JarvisRunCall>,
  refreshFailed = false,
) {
  const cancelCoordinator = coordinator(cancel);
  const refresh = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <JarvisRunDrainCard
        run={runView}
        coordinator={cancelCoordinator as unknown as JarvisRunCoordinator}
        ports={PORTS}
        refreshFailed={refreshFailed}
        onAuthoritativeRefresh={refresh}
      />,
    );
  });
  return { renderer, cancelCoordinator, refresh };
}

describe('JarvisRunDrainCard — pouvoirs bornés du drain tactile U1-k', () => {
  it('ne fait rien au montage et Réessayer relit sans mutation', async () => {
    const { renderer, cancelCoordinator, refresh } = await render(run(), async () => ({
      status: 'invalid_response',
    }));

    expect(Object.keys(buttons(renderer))).toEqual(['Réessayer', 'Annuler la demande']);
    expect(cancelCoordinator.cancel).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      const responderEvent = { nativeEvent: { timestamp: 42 } };
      (buttons(renderer).Réessayer?.onPress as (event: unknown) => void)(responderEvent);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith();
    expect(cancelCoordinator.cancel).not.toHaveBeenCalled();
  });

  it('annule avec le run exact puis relit seulement après le reçu', async () => {
    const runView = run();
    const { renderer, cancelCoordinator, refresh } = await render(runView, async () => ({
      status: 'completed',
      value: {
        outcome: 'admitted',
        run: { ...runView, revision: 5 },
        presentation: null,
        eventSequence: 8,
      },
    }));

    await act(async () => {
      (buttons(renderer)['Annuler la demande']?.onPress as () => void)();
    });
    expect(cancelCoordinator.cancel).toHaveBeenCalledWith(runView, PORTS);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({
      outcome: 'admitted',
      run: { ...runView, revision: 5 },
      presentation: null,
      eventSequence: 8,
    });
  });

  it('partage le vol UI : un double tap ne soumet qu’une annulation', async () => {
    const pending = deferred<JarvisRunCall>();
    const { renderer, cancelCoordinator, refresh } = await render(run(), () => pending.promise);

    await act(async () => {
      (buttons(renderer)['Annuler la demande']?.onPress as () => void)();
      (buttons(renderer)['Annuler la demande']?.onPress as () => void)();
    });
    expect(cancelCoordinator.cancel).toHaveBeenCalledTimes(1);
    expect(buttons(renderer)['Annuler la demande']?.disabled).toBe(true);

    await act(async () => {
      pending.settle({ status: 'invalid_response' });
      await pending.promise;
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(texts(renderer)).toContain(
      'Bob n’a pas pu enregistrer l’annulation. Relisez la demande avant de réessayer.',
    );
  });

  it('action absente, annulation en cours ou terminal ⇒ bouton honnêtement fermé, zéro réseau', async () => {
    const absent = await render(run({ actionReference: null }), async () => ({
      status: 'invalid_response',
    }));
    const absentButton = buttons(absent.renderer)['Annuler la demande'];
    expect(absentButton?.disabled).toBe(true);
    expect(absentButton?.accessibilityLabel).toContain('identité');
    await act(async () => {
      (absentButton?.onPress as () => void)();
    });
    expect(absent.cancelCoordinator.cancel).not.toHaveBeenCalled();

    const cancelling = await render(run({ status: 'cancelling' }), async () => ({
      status: 'invalid_response',
    }));
    const cancellingButton = buttons(cancelling.renderer)['Annuler la demande'];
    expect(cancellingButton?.disabled).toBe(true);
    expect(cancellingButton?.accessibilityLabel).toContain('déjà en cours');
    expect(texts(cancelling.renderer)).toContain(
      'L’annulation est déjà en cours. Relisez la demande pour connaître son état.',
    );
    expect(cancelling.cancelCoordinator.cancel).not.toHaveBeenCalled();

    const terminal = await render(
      run({
        actionReference: null,
        status: 'completed',
        terminalAt: '2026-08-20T20:00:00.000Z',
      }),
      async () => ({ status: 'invalid_response' }),
    );
    const terminalButton = buttons(terminal.renderer)['Annuler la demande'];
    expect(terminalButton?.disabled).toBe(true);
    expect(terminalButton?.accessibilityLabel).toContain('déjà terminée');
    expect(texts(terminal.renderer)).toContain('État de la demande Bob');
    expect(texts(terminal.renderer)).not.toContain('Demande Bob en cours');
    expect(texts(terminal.renderer)).toContain(
      'Cette demande est déjà terminée. Relisez l’écran pour mettre à jour son affichage.',
    );
    await act(async () => {
      (terminalButton?.onPress as () => void)();
    });
    expect(terminal.cancelCoordinator.cancel).not.toHaveBeenCalled();
  });

  it('conflit ou relecture échouée restent honnêtes et convergent par relecture', async () => {
    const { renderer, refresh } = await render(
      run(),
      async () => ({
        status: 'failed',
        error: { kind: 'conflict', entity: 'jarvis_run', reason: 'stale_revision' },
      }),
      true,
    );
    expect(texts(renderer)).toContain(
      'La dernière relecture a échoué. Les contrôles déjà vérifiés restent affichés.',
    );

    await act(async () => {
      (buttons(renderer)['Annuler la demande']?.onPress as () => void)();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
