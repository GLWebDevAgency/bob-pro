import { describe, expect, it } from 'vitest';
import { deriveCustomerContractsCardState } from './customer-contracts-card-state';

describe('deriveCustomerContractsCardState — vérité autoritative du parcours ciblé', () => {
  it('attend le premier chargement sans donnée', () => {
    expect(
      deriveCustomerContractsCardState({
        ensureVisible: true,
        isError: false,
        isPending: true,
        isFetching: true,
      }),
    ).toBe('loading');
  });

  it('laisse le rendu ordinaire utiliser son cache pendant une revalidation', () => {
    expect(
      deriveCustomerContractsCardState({
        ensureVisible: false,
        isError: false,
        isPending: false,
        isFetching: true,
      }),
    ).toBe('ready');
  });

  it('garde le parcours ciblé en chargement avec un cache filtré tant que le refetch tourne', () => {
    expect(
      deriveCustomerContractsCardState({
        ensureVisible: true,
        isError: false,
        isPending: false,
        isFetching: true,
      }),
    ).toBe('loading');
  });

  it('publie l’erreur si la revalidation ciblée échoue après le cache filtré', () => {
    expect(
      deriveCustomerContractsCardState({
        ensureVisible: true,
        isError: true,
        isPending: false,
        isFetching: false,
      }),
    ).toBe('error');
  });
});
