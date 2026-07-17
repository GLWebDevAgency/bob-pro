import { useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deriveCatalogue, type CataloguePrestation, type CustomPrestation } from '@bob/core';
import { useAuth } from './auth';
import { useProfile } from './hooks';
import {
  CATALOGUE_STORAGE_SCHEMA_VERSION,
  ScopedCatalogueStore,
  resolveCatalogueStorageIdentity,
  type CatalogueStorageIdentity,
  type CatalogueStorageSnapshot,
} from './catalogue-storage';
import {
  CatalogueLegacyMigrator,
  LEGACY_CATALOGUE_ASYNC_STORAGE_KEY,
  type LegacyCatalogueProtection,
} from './catalogue-legacy-migrator';
import { createSecureCatalogueKeyValueStore } from './catalogue-secure-store';
import { companyIdFromAppMetadata } from './tenant-identity';

/**
 * Prestations PERSONNELLES de l'artisan (claim C27) — persistance LOCALE typée.
 *
 * AUCUN endpoint serveur (vérifié packages/api-client/src/client.ts : l'interface BobClient
 * n'expose rien pour un catalogue de prestations) → AsyncStorage cloisonné par identité signée.
 * L'enveloppe est validée champ à champ et révisionnée ; une corruption ou une identité
 * incomplète échoue fermée au lieu de présenter le catalogue d'un autre compte.
 *
 * TODO(serveur) : quand l'API exposera GET/PUT /catalogue/prestations (company-scoped),
 * basculer ce module sur BobClient (pattern C40) et migrer les prestations locales au premier
 * démarrage connecté — les ids `perso-*` restent valides comme clés de fusion.
 */

const storageRuntime = {
  sha256: (value: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
};
const secureKeyValue = createSecureCatalogueKeyValueStore();
const store = new ScopedCatalogueStore(secureKeyValue, storageRuntime);
const legacyMigrator = new CatalogueLegacyMigrator(
  {
    get: (key) => AsyncStorage.getItem(key),
    remove: (key) => AsyncStorage.removeItem(key),
  },
  secureKeyValue,
  { ...storageRuntime, now: () => Date.now() },
);

function queryKey(identity: CatalogueStorageIdentity) {
  return [
    'catalogue',
    'perso',
    CATALOGUE_STORAGE_SCHEMA_VERSION,
    identity.mode,
    identity.companyId,
    identity.userId,
  ] as const;
}

function useCatalogueStorageIdentity(): CatalogueStorageIdentity {
  const { session } = useAuth();
  const authenticatedUserId = session?.user.id ?? null;
  const authenticatedCompanyId = companyIdFromAppMetadata(session?.user.app_metadata);
  return useMemo(
    () =>
      resolveCatalogueStorageIdentity({
        authenticatedCompanyId,
        authenticatedUserId,
      }),
    [authenticatedCompanyId, authenticatedUserId],
  );
}

export function newPrestationId(): string {
  return `perso-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function getCustomPrestations(
  identity: CatalogueStorageIdentity,
): Promise<readonly CustomPrestation[]> {
  return (await store.load(identity)).prestations;
}

export async function getCustomCatalogueSnapshot(
  identity: CatalogueStorageIdentity,
): Promise<CatalogueStorageSnapshot> {
  return store.load(identity);
}

/** Prestations perso brutes (pour la voix C20 : SEULS les prix de l'artisan chiffrent). */
export function useCustomPrestations() {
  const identity = useCatalogueStorageIdentity();
  return useQuery({
    queryKey: queryKey(identity),
    queryFn: () => getCustomCatalogueSnapshot(identity),
  });
}

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

export interface CatalogueState {
  /** Prestations validées du propriétaire — aucune suggestion ou valeur de démonstration. */
  prestations: CataloguePrestation[];
  isLoading: boolean;
  isRefetching: boolean;
  isError: boolean;
  /** Révision du snapshot propriétaire, transmise aux choix Bob pour refuser un résultat périmé. */
  revision: number | null;
  refetch: () => void;
}

/**
 * Catalogue du propriétaire, validé par le use case pur. `trade` reste transmis au contrat
 * de vue mais ne déclenche aucun tarif ni aucune prestation implicite.
 */
export function useCatalogue(): CatalogueState {
  const profile = useProfile();
  const custom = useCustomPrestations();

  const prestations = useMemo<CataloguePrestation[]>(() => {
    if (profile.data === undefined || custom.data === undefined) return [];
    return [
      ...deriveCatalogue({ trade: profile.data.trade, custom: custom.data.prestations })
        .prestations,
    ];
  }, [profile.data, custom.data]);

  return {
    prestations,
    isLoading: profile.isLoading || custom.isLoading,
    isRefetching: profile.isRefetching || custom.isRefetching,
    isError: profile.isError || custom.isError,
    revision: custom.data?.revision ?? null,
    refetch: () => {
      void profile.refetch();
      void custom.refetch();
    },
  };
}

/** Ajoute ou met à jour une prestation perso (même id = édition) — invalide la query partagée. */
export function useUpsertPrestation() {
  const qc = useQueryClient();
  const identity = useCatalogueStorageIdentity();
  const qk = queryKey(identity);
  return useMutation({
    mutationFn: async (input: CustomPrestation) => {
      await store.update(identity, (list) =>
        list.some((prestation) => prestation.id === input.id)
          ? list.map((prestation) => (prestation.id === input.id ? input : prestation))
          : [...list, input],
      );
      return input;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk }),
  });
}

export function useDeletePrestation() {
  const qc = useQueryClient();
  const identity = useCatalogueStorageIdentity();
  const qk = queryKey(identity);
  return useMutation({
    mutationFn: async (id: string) => {
      await store.update(identity, (list) => list.filter((prestation) => prestation.id !== id));
      return id;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk }),
  });
}
