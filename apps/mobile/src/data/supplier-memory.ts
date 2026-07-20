import { useQuery } from '@tanstack/react-query';
import type { SuggestExpenseDefaultsInput } from '@bob/api-client';
import { useAuth } from './auth';
import { useBobClient } from './client';
import { companyIdFromAppMetadata } from './tenant-identity';
import { loadSupplierExpenseDefaults, supplierExpenseDefaultsKey } from './supplier-memory-query';

/**
 * Lecture de la mémoire fournisseur PostgreSQL/RLS via `POST /expenses/defaults`.
 * Aucun historique de dépenses mobile et aucun adapter en mémoire ne participent à ce chemin.
 */
export function useSupplierExpenseDefaults(input: SuggestExpenseDefaultsInput | null) {
  const client = useBobClient();
  const { session } = useAuth();
  const companyId = companyIdFromAppMetadata(session?.user.app_metadata);
  const query = useQuery({
    queryKey: supplierExpenseDefaultsKey(companyId, input),
    enabled: input !== null && companyId !== null,
    queryFn: () => {
      if (input === null || companyId === null) {
        throw new Error('SUPPLIER_MEMORY_TENANT_REQUIRED');
      }
      return loadSupplierExpenseDefaults(client, input);
    },
  });

  return { ...query, companyId };
}
