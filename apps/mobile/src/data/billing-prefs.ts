import type { CompanyBillingSettingsPatch } from '@bob/core';
import { useCompanyBillingSettings, useUpdateCompanyBillingSettings } from './hooks';

/**
 * Façade mobile strictement distante. PostgreSQL est l'unique autorité ; une erreur ou une
 * absence de ligne ne produit jamais de préférences par défaut dans l'UI.
 *
 * Doctrine blocking vs stale (vague hors-lots, audit 03/08) : l'écran doit DISTINGUER un
 * échec de LECTURE (queryIsError — bloquant seulement sans donnée en cache) d'un échec de
 * MUTATION (un tap de switch raté ne remplace JAMAIS l'écran entier par un ErrorRetry plein
 * écran quand les données sont encore là — il remonte en ErrorSheet via `onError`).
 * `isError` conserve l'union historique pour les consommateurs existants (devis/new).
 */
export function useBillingPrefs() {
  const query = useCompanyBillingSettings();
  const mutation = useUpdateCompanyBillingSettings();
  return {
    prefs: query.data ?? null,
    ready: query.isSuccess,
    isLoading: query.isLoading,
    isError: query.isError || mutation.isError,
    /** Échec de la SOURCE seulement — le seul qui puisse justifier un état bloquant. */
    queryIsError: query.isError,
    isPending: mutation.isPending,
    /** Refetch manuel en cours — alimente le spinner du bouton « Réessayer ». */
    isRefetching: query.isRefetching,
    refetch: () => {
      mutation.reset();
      return query.refetch();
    },
    update: (
      patch: CompanyBillingSettingsPatch,
      options?: { readonly onError?: (error: unknown) => void },
    ): void => {
      const current = query.data;
      if (current === undefined || mutation.isPending) return;
      mutation.mutate(
        { expectedRevision: current.revision, patch },
        options?.onError !== undefined ? { onError: options.onError } : undefined,
      );
    },
  };
}
