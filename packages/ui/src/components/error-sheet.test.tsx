/**
 * useErrorSheet — comportement du composant PROMU (Lot 0). Suite PORTÉE 1:1 depuis
 * apps/mobile/src/components/ErrorSheet.test.tsx (le composant a déménagé, ses preuves
 * avec lui — côté mobile ne reste que le test d'iso-rendu/réexport), plus la face 2 faces
 * `showErrorFacts` du lot. Sheet/Button/ErrorNotice sont des doublures string : seuls le
 * séquencement (visible, onDismiss, remplacement) et le contenu transmis importent ici.
 */
import { type ElementType, type ReactNode } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { useErrorSheet } from './error-sheet';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const theme = vi.hoisted(() => ({
  colors: { ink900: '#ink900', slate500: '#slate500' },
}));

vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
}));

vi.mock('../theme', () => ({
  font: () => ({ fontFamily: 'MockFont' }),
  useTheme: () => theme,
}));

vi.mock('./sheet', async () => {
  const { createElement } = await import('react');
  return {
    Sheet: (props: Record<string, unknown> & { children?: ReactNode }) =>
      props['visible'] ? createElement('Sheet', props, props.children) : null,
  };
});

vi.mock('./button', async () => {
  const { createElement } = await import('react');
  return {
    Button: (props: Record<string, unknown> & { title?: string }) =>
      createElement('Button', props, props.title),
  };
});

vi.mock('./error-notice', async () => {
  const { createElement } = await import('react');
  return {
    ErrorNotice: (props: Record<string, unknown>) => createElement('ErrorNotice', props),
  };
});

const HOST_SHEET = 'Sheet' as unknown as ElementType;
const HOST_BUTTON = 'Button' as unknown as ElementType;
const HOST_TEXT = 'Text' as unknown as ElementType;
const HOST_NOTICE = 'ErrorNotice' as unknown as ElementType;

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

  it('showErrorFacts (Lot 0) : la feuille porte l’ErrorNotice 2 faces avec code + corrélation', async () => {
    const onShareReport = vi.fn();
    await act(async () => {
      harness!.showErrorFacts('Classement impossible', {
        message: 'Le document n’a pas pu être classé.',
        code: 'BOB-DOC-500',
        correlationId: '98f73810-1111-4222-8333-444455556666',
        kind: 'unavailable',
        at: '2026-08-02T10:00:00.000Z',
        onShareReport,
      });
    });

    const sheet = renderer!.root.findByType(HOST_SHEET);
    // Témoin : le titre reste le header de la feuille.
    expect(textContent(sheet)).toEqual(['Classement impossible']);
    const notice = sheet.findByType(HOST_NOTICE);
    expect(notice.props).toMatchObject({
      message: 'Le document n’a pas pu être classé.',
      code: 'BOB-DOC-500',
      correlationId: '98f73810-1111-4222-8333-444455556666',
      kind: 'unavailable',
      at: '2026-08-02T10:00:00.000Z',
      onShareReport,
    });
    // Le bouton OK referme aussi la face 2 faces.
    await act(async () => sheet.findByType(HOST_BUTTON).props.onPress());
    expect(renderer!.root.findAllByType(HOST_SHEET)).toHaveLength(0);
  });

  it('showErrorFacts remplace un showError précédent (jamais d’empilement)', async () => {
    await act(async () => {
      harness!.showError('Oups', 'Réessaie.');
    });
    await act(async () => {
      harness!.showErrorFacts('Classement impossible', {
        message: 'Le document n’a pas pu être classé.',
        code: 'BOB-DOC-500',
      });
    });
    const sheet = renderer!.root.findByType(HOST_SHEET);
    expect(textContent(sheet)).toEqual(['Classement impossible']);
    expect(sheet.findAllByType(HOST_NOTICE)).toHaveLength(1);
  });
});
