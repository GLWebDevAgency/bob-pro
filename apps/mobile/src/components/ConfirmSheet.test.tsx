import { useEffect, type ElementType, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ConfirmProvider, type ConfirmRequest, useConfirm } from './ConfirmSheet';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const theme = vi.hoisted(() => ({
  colors: {
    ink900: '#ink900',
    ink800: '#ink800',
    slate500: '#slate500',
    surface: '#surface',
    line: '#line',
  },
  semantic: { danger: '#danger', ai: '#ai' },
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('@bob/ui', async () => {
  const { createElement } = await import('react');
  return {
    Button: (props: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('Button', props, props.title as string),
    Card: (props: Record<string, unknown> & { children?: ReactNode }) =>
      createElement('Card', props, props.children),
    Sheet: (props: Record<string, unknown> & { children?: ReactNode }) =>
      props.visible ? createElement('Sheet', props, props.children) : null,
    font: () => ({ fontFamily: 'MockFont' }),
    useTheme: () => theme,
  };
});

const TAP_REQUEST: ConfirmRequest = {
  title: 'Émettre la facture',
  message: 'Vérifie les changements.',
  challenge: { kind: 'tap' },
};

const HOST_BUTTON = 'Button' as unknown as ElementType;
const HOST_SHEET = 'Sheet' as unknown as ElementType;

function ConfirmCapture({
  onReady,
}: {
  readonly onReady: (confirm: ReturnType<typeof useConfirm>) => void;
}) {
  const confirm = useConfirm();
  useEffect(() => onReady(confirm), [confirm, onReady]);
  return null;
}

function findButton(renderer: ReactTestRenderer, title: string): ReactTestInstance {
  const button = renderer.root
    .findAllByType(HOST_BUTTON)
    .find((candidate) => candidate.props.title === title);
  if (!button) throw new Error(`Bouton introuvable : ${title}`);
  return button;
}

describe('ConfirmProvider + ConfirmSheet', () => {
  let renderer: ReactTestRenderer | null;
  let confirm: ReturnType<typeof useConfirm> | null;

  beforeEach(async () => {
    renderer = null;
    confirm = null;
    const capture = (value: ReturnType<typeof useConfirm>): void => {
      confirm = value;
    };
    await act(async () => {
      renderer = create(
        <ConfirmProvider>
          <ConfirmCapture onReady={capture} />
        </ConfirmProvider>,
      );
    });
  });

  afterEach(async () => {
    if (renderer !== null) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
  });

  it('rend la Sheet canonique et confirme une demande tap exactement une fois', async () => {
    if (!renderer || !confirm) throw new Error('Harness incomplet');
    let resultPromise!: Promise<boolean>;
    await act(async () => {
      resultPromise = confirm?.(TAP_REQUEST) ?? Promise.resolve(false);
    });

    const sheet = renderer.root.findByType(HOST_SHEET);
    expect(sheet.props).toMatchObject({
      accessibilityLabel: 'Émettre la facture',
      closeAccessibilityLabel: 'Annuler et fermer',
      visible: true,
    });
    const confirmButton = findButton(renderer, 'Confirmer');
    expect(confirmButton.props).toMatchObject({ disabled: false, variant: 'primary' });

    await act(async () => confirmButton.props.onPress());
    await expect(resultPromise).resolves.toBe(true);
    expect(renderer.root.findAllByType(HOST_SHEET)).toHaveLength(0);
  });

  it('garde le challenge montant désarmé jusqu’à la case explicite', async () => {
    if (!renderer || !confirm) throw new Error('Harness incomplet');
    let resultPromise!: Promise<boolean>;
    await act(async () => {
      resultPromise =
        confirm?.({
          title: 'Enregistrer le paiement',
          challenge: { kind: 'amount', expectedCents: 132_000 },
        }) ?? Promise.resolve(false);
    });

    expect(findButton(renderer, 'Confirmer').props.disabled).toBe(true);
    const checkbox = renderer.root.findByProps({ accessibilityRole: 'checkbox' });
    expect(checkbox.props.accessibilityLabel).toContain('Je confirme encaisser');
    expect(checkbox.props.accessibilityState).toEqual({ checked: false });

    await act(async () => checkbox.props.onPress());
    expect(
      renderer.root.findByProps({ accessibilityRole: 'checkbox' }).props.accessibilityState,
    ).toEqual({
      checked: true,
    });
    const confirmButton = findButton(renderer, 'Confirmer');
    expect(confirmButton.props.disabled).toBe(false);
    await act(async () => confirmButton.props.onPress());
    await expect(resultPromise).resolves.toBe(true);
  });

  it('rend le challenge fiscal dangereux et ne réutilise jamais son consentement', async () => {
    if (!renderer || !confirm) throw new Error('Harness incomplet');
    const fiscalRequest: ConfirmRequest = {
      title: 'Émettre définitivement',
      challenge: { kind: 'fiscal', reason: 'Numérotation légale irréversible' },
    };
    let firstPromise!: Promise<boolean>;
    await act(async () => {
      firstPromise = confirm?.(fiscalRequest) ?? Promise.resolve(false);
    });
    expect(findButton(renderer, 'Confirmer').props).toMatchObject({
      disabled: true,
      variant: 'danger',
    });
    const firstCheckbox = renderer.root.findByProps({ accessibilityRole: 'checkbox' });
    await act(async () => firstCheckbox.props.onPress());
    expect(findButton(renderer, 'Confirmer').props.disabled).toBe(false);
    await act(async () => findButton(renderer!, 'Annuler').props.onPress());
    await expect(firstPromise).resolves.toBe(false);

    let secondPromise!: Promise<boolean>;
    await act(async () => {
      secondPromise = confirm?.(fiscalRequest) ?? Promise.resolve(false);
    });
    expect(
      renderer.root.findByProps({ accessibilityRole: 'checkbox' }).props.accessibilityState,
    ).toEqual({
      checked: false,
    });
    expect(findButton(renderer, 'Confirmer').props.disabled).toBe(true);
    await act(async () => renderer!.root.findByType(HOST_SHEET).props.onClose());
    await expect(secondPromise).resolves.toBe(false);
  });

  it('refuse une demande concurrente et ignore une fermeture tardive de la demande précédente', async () => {
    if (!renderer || !confirm) throw new Error('Harness incomplet');
    let firstPromise!: Promise<boolean>;
    let refusedPromise!: Promise<boolean>;
    await act(async () => {
      firstPromise = confirm?.(TAP_REQUEST) ?? Promise.resolve(false);
      refusedPromise =
        confirm?.({ title: 'Demande concurrente', challenge: { kind: 'tap' } }) ??
        Promise.resolve(true);
    });
    await expect(refusedPromise).resolves.toBe(false);

    const staleClose = renderer.root.findByType(HOST_SHEET).props.onClose as () => void;
    await act(async () => findButton(renderer!, 'Confirmer').props.onPress());
    await expect(firstPromise).resolves.toBe(true);

    let nextPromise!: Promise<boolean>;
    await act(async () => {
      nextPromise =
        confirm?.({ title: 'Demande suivante', challenge: { kind: 'tap' } }) ??
        Promise.resolve(false);
    });
    await act(async () => staleClose());
    expect(renderer.root.findByType(HOST_SHEET).props.accessibilityLabel).toBe('Demande suivante');

    await act(async () => findButton(renderer!, 'Confirmer').props.onPress());
    await expect(nextPromise).resolves.toBe(true);
  });

  it('résout fail-closed une confirmation encore ouverte au démontage', async () => {
    if (!renderer || !confirm) throw new Error('Harness incomplet');
    let resultPromise!: Promise<boolean>;
    await act(async () => {
      resultPromise = confirm?.(TAP_REQUEST) ?? Promise.resolve(true);
    });
    await act(async () => renderer?.unmount());
    renderer = null;
    await expect(resultPromise).resolves.toBe(false);
  });
});
