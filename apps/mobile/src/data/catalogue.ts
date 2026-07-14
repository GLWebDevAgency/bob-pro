import { useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deriveCatalogue, type CataloguePrestation, type CustomPrestation } from '@bob/core';
import { useProfile } from './hooks';
import { readCustomPrestations } from './catalogue-storage';

/**
 * Prestations PERSONNELLES de l'artisan (claim C27) — persistance LOCALE typée.
 *
 * AUCUN endpoint serveur (vérifié packages/api-client/src/client.ts : l'interface BobClient
 * n'expose rien pour un catalogue de prestations) → AsyncStorage, même famille que les
 * préférences (src/data/settings.ts). Écritures best-effort, lectures VALIDÉES champ à champ
 * (une entrée corrompue est écartée, jamais propagée aux écrans).
 *
 * TODO(serveur) : quand l'API exposera GET/PUT /catalogue/prestations (company-scoped),
 * basculer ce module sur BobClient (pattern C40) et migrer les prestations locales au premier
 * démarrage connecté — les ids `perso-*` restent valides comme clés de fusion.
 */

const KEY = 'bob.catalogue.perso';

/** Query key partagée : écran catalogue, suggestions devis (C21) et voix (C20) — une vérité. */
const QK = ['catalogue', 'perso'] as const;

export function newPrestationId(): string {
  return `perso-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function getCustomPrestations(): Promise<CustomPrestation[]> {
  return readCustomPrestations(() => AsyncStorage.getItem(KEY));
}

async function saveCustomPrestations(list: readonly CustomPrestation[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(list));
}

/** Prestations perso brutes (pour la voix C20 : SEULS les prix de l'artisan chiffrent). */
export function useCustomPrestations() {
  return useQuery({ queryKey: QK, queryFn: getCustomPrestations });
}

export interface CatalogueState {
  /** Catalogue fusionné (perso + suggestions métier) — @bob/core deriveCatalogue. */
  prestations: CataloguePrestation[];
  isLoading: boolean;
  isRefetching: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * Catalogue COMPLET de l'artisan : suggestions métier (profil réel useProfile → trade) +
 * prestations perso locales, fusionnées par le use case pur — l'écran ne calcule rien.
 */
export function useCatalogue(): CatalogueState {
  const profile = useProfile();
  const custom = useCustomPrestations();

  const prestations = useMemo<CataloguePrestation[]>(() => {
    if (profile.data === undefined || custom.data === undefined) return [];
    return [...deriveCatalogue({ trade: profile.data.trade, custom: custom.data }).prestations];
  }, [profile.data, custom.data]);

  return {
    prestations,
    isLoading: profile.isLoading || custom.isLoading,
    isRefetching: profile.isRefetching || custom.isRefetching,
    isError: profile.isError || custom.isError,
    refetch: () => {
      void profile.refetch();
      void custom.refetch();
    },
  };
}

/** Ajoute ou met à jour une prestation perso (même id = édition) — invalide la query partagée. */
export function useUpsertPrestation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CustomPrestation) => {
      const list = await getCustomPrestations();
      const next = list.some((p) => p.id === input.id)
        ? list.map((p) => (p.id === input.id ? input : p))
        : [...list, input];
      await saveCustomPrestations(next);
      return input;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: QK }),
  });
}

export function useDeletePrestation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const list = await getCustomPrestations();
      await saveCustomPrestations(list.filter((p) => p.id !== id));
      return id;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: QK }),
  });
}
