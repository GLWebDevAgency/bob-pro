import { describe, expect, it, vi } from 'vitest';
import {
  ContractRenameReloadCoordinator,
  type ContractRenameRefetchResult,
} from './contract-rename-reload';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function result(input: {
  id?: string;
  revision?: number;
  label?: string;
  isError?: boolean;
  error?: unknown;
  withData?: boolean;
} = {}): ContractRenameRefetchResult {
  return {
    isError: input.isError ?? false,
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.withData === false
      ? {}
      : {
          data: {
            contract: {
              id: input.id ?? 'contract-1',
              revision: input.revision ?? 2,
              label: input.label ?? 'Nom à jour',
            },
          },
        }),
  };
}

const base = {
  contractId: 'contract-1',
  minimumRevision: 2,
};

describe('ContractRenameReloadCoordinator — preuve autoritative et single-flight', () => {
  it('ne conclut rien avant le réseau et mutualise deux sorties simultanées', async () => {
    const network = deferred<ContractRenameRefetchResult>();
    const refetch = vi.fn(() => network.promise);
    const coordinator = new ContractRenameReloadCoordinator();

    const first = coordinator.reload({ ...base, refetch });
    const second = coordinator.reload({ ...base, refetch });

    expect(coordinator.isRunning).toBe(true);
    expect(first).toBe(second);
    expect(refetch).toHaveBeenCalledTimes(1);

    network.resolve(result());
    await expect(first).resolves.toEqual({
      kind: 'reloaded',
      contract: { id: 'contract-1', revision: 2, label: 'Nom à jour' },
    });
    expect(coordinator.isRunning).toBe(false);
  });

  it('refuse une ancienne data conservée par React Query quand isError=true', async () => {
    const coordinator = new ContractRenameReloadCoordinator();
    await expect(
      coordinator.reload({
        ...base,
        refetch: async () => result({ isError: true, revision: 1 }),
      }),
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  it('distingue le not_found exact du contrat : état terminal, jamais un retry réseau', async () => {
    const coordinator = new ContractRenameReloadCoordinator();
    await expect(
      coordinator.reload({
        ...base,
        refetch: async () =>
          result({
            isError: true,
            error: {
              kind: 'not_found',
              entity: 'maintenance_contract',
              id: 'contract-1',
            },
          }),
      }),
    ).resolves.toEqual({ kind: 'missing' });
  });

  it('distingue aussi le not_found exact quand le client rejette directement', async () => {
    const coordinator = new ContractRenameReloadCoordinator();
    await expect(
      coordinator.reload({
        ...base,
        refetch: async () => {
          throw {
            kind: 'not_found',
            entity: 'maintenance_contract',
            id: 'contract-1',
          };
        },
      }),
    ).resolves.toEqual({ kind: 'missing' });
  });

  it.each([
    [
      'une autre entité',
      { kind: 'not_found', entity: 'customer', id: 'contract-1' },
    ],
    [
      'un autre contrat',
      { kind: 'not_found', entity: 'maintenance_contract', id: 'contract-2' },
    ],
  ])('ne traite pas %s comme une suppression du contrat affiché', async (_label, error) => {
    const coordinator = new ContractRenameReloadCoordinator();
    await expect(
      coordinator.reload({
        ...base,
        refetch: async () => result({ isError: true, error }),
      }),
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  it.each([
    ['donnée absente', result({ withData: false })],
    ['mauvais contrat', result({ id: 'contract-2' })],
    ['même ancienne révision', result({ revision: 1 })],
    ['révision non entière', result({ revision: 2.5 })],
  ])('refuse %s', async (_label, refetchResult) => {
    const coordinator = new ContractRenameReloadCoordinator();
    await expect(
      coordinator.reload({ ...base, refetch: async () => refetchResult }),
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  it('transforme un rejet en indisponibilité puis autorise un vrai retry', async () => {
    const coordinator = new ContractRenameReloadCoordinator();
    await expect(
      coordinator.reload({
        ...base,
        refetch: async () => {
          throw new Error('offline');
        },
      }),
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(coordinator.isRunning).toBe(false);

    await expect(
      coordinator.reload({ ...base, refetch: async () => result({ revision: 3 }) }),
    ).resolves.toMatchObject({ kind: 'reloaded', contract: { revision: 3 } });
  });
});
