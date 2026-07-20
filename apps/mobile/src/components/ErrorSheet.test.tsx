import { type ElementType, type ReactNode } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { useErrorSheet } from './ErrorSheet';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const theme = vi.hoisted(() => ({
  colors: { ink900: '#ink900', slate500: '#slate500' },
}));

vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
}));

vi.mock('@bob/ui', async () => {
  const { createElement } = await import('react');
  return {
    Button: (props: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('Button', props, props.title as string),
    Sheet: (props: Record<string, unknown> & { children?: ReactNode }) =>
      props.visible ? createElement('Sheet', props, props.children) : null,
    font: () => ({ fontFamily: 'MockFont' }),
    useTheme: () => theme,
  };
});

const HOST_SHEET = 'Sheet' as unknown as ElementType;
const HOST_BUTTON = 'Button' as unknown as ElementType;
const HOST_TEXT = 'Text' as unknown as ElementType;

type Harness = ReturnType<typeof useErrorSheet>;

function Host({ onReady }: { readonly onReady: (harness: Harness) => void }) {
  const harness = useErrorSheet();
  onReady(harness);
  return <>{harness.errorSheet}</>;
}

function textContent(instance: ReactTestInstance): string[] {
  return instance
    .findAllByType(HOST_TEXT)
    .map((node) => (Array.isArray(node.children) ? node.children.join('') : ''));
}

describe('useErrorSheet', () => {
  let renderer: ReactTestRenderer | null;
  let harness: Harness | null;

  beforeEach(async () => {
    renderer = null;
    harness = null;
    await act(async () => {
      renderer = create(
        <Host
          onReady={(value) => {
            harness = value;
          }}
        />,
      );
    });
  });

  afterEach(async () => {
    if (renderer !== null) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
  });

  it('reste invisible tant qu’aucune erreur n’est signalée', () => {
    expect(renderer!.root.findAllByType(HOST_SHEET)).toHaveLength(0);
  });

  it('affiche titre + message EXACTS dans une feuille @bob/ui, et OK la referme', async () => {
    await act(async () => {
      harness!.showError('Aperçu indisponible', 'La preuve comptable reçue est incohérente.');
    });

    const sheet = renderer!.root.findByType(HOST_SHEET);
    expect(sheet.props).toMatchObject({
      visible: true,
      accessibilityLabel: 'Aperçu indisponible',
    });
    expect(textContent(sheet)).toEqual([
      'Aperçu indisponible',
      'La preuve comptable reçue est incohérente.',
    ]);

    const okButton = renderer!.root.findByType(HOST_BUTTON);
    expect(okButton.props.title).toBe('OK');
    await act(async () => okButton.props.onPress());
    expect(renderer!.root.findAllByType(HOST_SHEET)).toHaveLength(0);
  });

  it('accepte un titre seul (pas de message vide rendu)', async () => {
    await act(async () => {
      harness!.showError('Oups');
    });
    expect(textContent(renderer!.root.findByType(HOST_SHEET))).toEqual(['Oups']);
  });

  it('onDismiss ne part qu’À la fermeture, une seule fois (fermeture scrim comprise)', async () => {
    const onDismiss = vi.fn();
    await act(async () => {
      harness!.showError('Oups', 'Réessaie.', onDismiss);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    // Fermeture par le scrim (onClose du Sheet) — même chemin que le bouton OK.
    const sheet = renderer!.root.findByType(HOST_SHEET);
    await act(async () => sheet.props.onClose());
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // Une nouvelle erreur SANS onDismiss ne rejoue jamais l'ancien callback.
    await act(async () => {
      harness!.showError('Oups');
    });
    await act(async () => renderer!.root.findByType(HOST_SHEET).props.onClose());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('une nouvelle erreur remplace la précédente (la dernière gagne)', async () => {
    await act(async () => {
      harness!.showError('Aperçu indisponible', 'Premier message.');
    });
    await act(async () => {
      harness!.showError('Facture actualisée', 'Le reste dû a changé.');
    });
    const sheet = renderer!.root.findByType(HOST_SHEET);
    expect(textContent(sheet)).toEqual(['Facture actualisée', 'Le reste dû a changé.']);
  });
});
