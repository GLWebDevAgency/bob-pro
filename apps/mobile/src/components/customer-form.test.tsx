import type { ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyLookupResult } from '@bob/core';
import { CustomerForm, type CustomerFormInitial } from './customer-form';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hooks = vi.hoisted(() => ({
  lookup: {
    mutate: vi.fn(),
    isPending: false,
  },
  search: {
    mutate: vi.fn(),
    reset: vi.fn(),
    variables: null as string | null,
    isSuccess: false,
    data: undefined,
  },
}));

const theme = vi.hoisted(() => ({
  colors: {
    ink800: '#ink800',
    slate500: '#slate500',
    slate400: '#slate400',
    slate300: '#slate300',
    lineSoft: '#lineSoft',
  },
  semantic: {
    danger: '#danger',
    success: '#success',
    warning: '#warning',
    warningBg: '#warningBg',
  },
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('../data/hooks', () => ({
  useLookupCompany: () => hooks.lookup,
  useSearchAddress: () => hooks.search,
}));
vi.mock('@bob/ui', async () => {
  const { createElement } = await import('react');
  return {
    Button: ({ title, ...props }: { title: string }) =>
      createElement('Button', { ...props, title }),
    Chip: ({ label, ...props }: { label: string }) =>
      createElement('Chip', { ...props, label }),
    Skeleton: (props: Record<string, unknown>) => createElement('Skeleton', props),
    font: () => ({ fontFamily: 'MockFont' }),
    useTheme: () => theme,
  };
});

const HOST_BUTTON = 'Button' as unknown as ElementType;
const HOST_TEXT_INPUT = 'TextInput' as unknown as ElementType;

const INITIAL: CustomerFormInitial = {
  type: 'b2b',
  firstName: '',
  lastName: '',
  companyName: 'Ancienne société',
  siren: '732829320',
  siret: '73282932000074',
  tvaIntracom: 'FR44732829320',
  contactName: '',
  email: '',
  phone: '',
  address: { line1: '1 ANCIENNE RUE', zip: '75001', city: 'PARIS' },
  addressLabel: '1 ANCIENNE RUE, 75001 PARIS',
};

const FOUND: CompanyLookupResult = {
  siren: '451321335',
  siret: '45132133501021',
  denomination: 'CARREFOUR HYPERMARCHES',
  nafApe: '68.20B',
  trade: null,
  natureJuridiqueCode: '5710',
  legalForm: 'SAS',
  dateCreation: '2000-01-03',
  address: null,
  tvaIntracom: 'FR90451321335',
  etatAdministratif: 'F',
  rge: false,
};

function input(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType(HOST_TEXT_INPUT).find(
    (node) => node.props.accessibilityLabel === label,
  );
}

function button(renderer: ReactTestRenderer, title: string) {
  return renderer.root.findAllByType(HOST_BUTTON).find((node) => node.props.title === title);
}

describe('CustomerForm — identité établissement atomique', () => {
  beforeEach(() => {
    hooks.lookup.mutate.mockReset();
    hooks.search.mutate.mockReset();
    hooks.search.reset.mockReset();
  });

  it('efface l ancienne adresse, conserve le SIRET et annonce F après un lookup sans adresse', async () => {
    const onSubmit = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <CustomerForm
          personality="pro"
          initial={INITIAL}
          submitLabel="Enregistrer"
          submitting={false}
          errorMessage={null}
          onSubmit={onSubmit}
        />,
      );
    });

    const siretInput = input(renderer, 'SIRET');
    expect(siretInput).toBeDefined();
    await act(async () => {
      siretInput?.props.onChangeText(FOUND.siret);
    });
    await act(async () => {
      button(renderer, 'Rechercher')?.props.onPress();
    });
    const callbacks = hooks.lookup.mutate.mock.calls.at(-1)?.[1] as {
      onSuccess: (result: CompanyLookupResult) => void;
    };
    await act(async () => {
      callbacks.onSuccess(FOUND);
    });

    expect(input(renderer, 'Adresse')?.props.value).toBe('');
    expect(
      renderer.root.findByProps({
        accessibilityRole: 'alert',
        accessibilityLiveRegion: 'polite',
      }),
    ).toBeDefined();

    await act(async () => {
      button(renderer, 'Enregistrer')?.props.onPress();
    });
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: FOUND.denomination,
        siren: FOUND.siren,
        siret: FOUND.siret,
        address: { line1: '', zip: '', city: '' },
      }),
    );
  });

  it('ignore la réponse A après que l utilisateur a saisi B', async () => {
    const onSubmit = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <CustomerForm
          personality="pro"
          initial={INITIAL}
          submitLabel="Enregistrer"
          submitting={false}
          errorMessage={null}
          onSubmit={onSubmit}
        />,
      );
    });
    const siretInput = input(renderer, 'SIRET');
    await act(async () => {
      siretInput?.props.onChangeText(FOUND.siret);
    });
    await act(async () => {
      button(renderer, 'Rechercher')?.props.onPress();
    });
    const callbacks = hooks.lookup.mutate.mock.calls.at(-1)?.[1] as {
      onSuccess: (result: CompanyLookupResult) => void;
    };
    await act(async () => {
      siretInput?.props.onChangeText('73282932000074');
      callbacks.onSuccess(FOUND);
    });

    expect(input(renderer, 'Raison sociale')?.props.value).toBe(
      INITIAL.companyName,
    );
    expect(input(renderer, 'Adresse')?.props.value).toBe(INITIAL.addressLabel);
    await act(async () => {
      button(renderer, 'Enregistrer')?.props.onPress();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
