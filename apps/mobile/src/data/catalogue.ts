import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CatalogueItemView, CatalogueItemWriteInput, CataloguePrestation } from '@bob/core';
import {
  CatalogueLegacyMigrator,
  LEGACY_CATALOGUE_ASYNC_STORAGE_KEY,
  type LegacyCatalogueProtection,
} from './catalogue-legacy-migrator';
import { createSecureCatalogueKeyValueStore } from './catalogue-secure-store';
import { useBobClient } from './client';
import { catalogueDataMode, type CatalogueDataMode } from './catalogue-data-state';

/**
 * Catalogue propriétaire : PostgreSQL/RLS est l'unique autorité métier. AsyncStorage n'est lu
 * que par la quarantaine legacy ci-dessous ; son contenu n'est jamais fusionné ni rendu.
 */

const storageRuntime = {
  sha256: (value: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
};
const secureKeyValue = createSecureCatalogueKeyValueStore();
const legacyMigrator = new CatalogueLegacyMigrator(
  {
    get: (key) => AsyncStorage.getItem(key),
    remove: (key) => AsyncStorage.removeItem(key),
  },
  secureKeyValue,
  { ...storageRuntime, now: () => Date.now() },
);

const legacyProtectionQueryKey = [
  'catalogue',
  'legacy-protection',
  LEGACY_CATALOGUE_ASYNC_STORAGE_KEY,
] as const;

/**
 * Archive device-scoped non attribuée : aucune donnée n'est rendue ni fusionnée au catalogue.
 * `prepare` la retire d'AsyncStorage en clair seulement après vérification du coffre chiffré.
 */
export function useLegacyCatalogueProtection() {
  return useQuery<LegacyCatalogueProtection>({
    queryKey: legacyProtectionQueryKey,
    queryFn: () => legacyMigrator.prepare(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useDiscardLegacyCatalogue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => legacyMigrator.discard(),
    onSuccess: () =>
      queryClient.setQueryData<LegacyCatalogueProtection>(legacyProtectionQueryKey, {
        kind: 'none',
      }),
  });
}

export interface RemoteCataloguePrestation extends CataloguePrestation {
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toPrestation(item: CatalogueItemView): RemoteCataloguePrestation {
  return {
    ...item,
    source: 'perso',
    indicative: false,
  };
}

export interface CatalogueState {
  /** Prestations validées du propriétaire — aucune suggestion ou valeur de démonstration. */
  prestations: RemoteCataloguePrestation[];
  isLoading: boolean;
  isRefetching: boolean;
  isError: boolean;
  /** Distingue une vraie liste vide d'une query qui n'a encore livré aucune réponse serveur. */
  hasData: boolean;
  mode: CatalogueDataMode;
  refetch: () => void;
}

/**
 * Catalogue du propriétaire, validé par le use case pur. `trade` reste transmis au contrat
 * de vue mais ne déclenche aucun tarif ni aucune prestation implicite.
 */
export function useCatalogue(): CatalogueState {
  const client = useBobClient();
  const query = useQuery({
    queryKey: ['catalogue', 'server', client.companyId],
    queryFn: async () => {
      const result = await client.listCatalogueItems();
      if (!result.ok) throw result.error;
      return result.value.map(toPrestation);
    },
  });

  const hasData = query.data !== undefined;
  return {
    prestations: query.data ?? [],
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    isError: query.isError,
    hasData,
    mode: catalogueDataMode({ hasData, isLoading: query.isLoading, isError: query.isError }),
    refetch: () => void query.refetch(),
  };
}

export type SaveCatalogueItemInput =
  | { readonly mode: 'create'; readonly item: CatalogueItemWriteInput }
  | {
      readonly mode: 'update';
      readonly itemId: string;
      readonly expectedRevision: number;
      readonly item: CatalogueItemWriteInput;
    };

/** Écriture exclusivement serveur ; le cache React Query n'est jamais l'autorité. */
export function useUpsertPrestation() {
  const qc = useQueryClient();
  const client = useBobClient();
  const qk = ['catalogue', 'server', client.companyId] as const;
  return useMutation({
    mutationFn: async (input: SaveCatalogueItemInput) => {
      const result = input.mode === 'create'
        ? await client.createCatalogueItem(input.item)
        : await client.updateCatalogueItem(input);
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk }),
  });
}

export function useDeletePrestation() {
  const qc = useQueryClient();
  const client = useBobClient();
  const qk = ['catalogue', 'server', client.companyId] as const;
  return useMutation({
    mutationFn: async (input: { itemId: string; expectedRevision: number }) => {
      const result = await client.deleteCatalogueItem(input);
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk }),
  });
}
