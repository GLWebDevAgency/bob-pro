import type { CompanyBillingSettingsPatch } from '@bob/core';
import { useCompanyBillingSettings, useUpdateCompanyBillingSettings } from './hooks';

/**
 * Façade mobile strictement distante. PostgreSQL est l'unique autorité ; une erreur ou une
 * absence de ligne ne produit jamais de préférences par défaut dans l'UI.
 */
export function useBillingPrefs() {
  const query = useCompanyBillingSettings();
  const mutation = useUpdateCompanyBillingSettings();
  return {
    prefs: query.data ?? null,
    ready: query.isSuccess,
    isLoading: query.isLoading,
    isError: query.isError || mutation.isError,
    isPending: mutation.isPending,
    refetch: () => {
      mutation.reset();
      return query.refetch();
    },
    update: (patch: CompanyBillingSettingsPatch): void => {
      const current = query.data;
      if (current === undefined || mutation.isPending) return;
      mutation.mutate({ expectedRevision: current.revision, patch });
    },
  };
}
