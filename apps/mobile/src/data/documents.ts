import { useQuery } from '@tanstack/react-query';
import { useBobClient } from './client';

/** Liste réelle des documents archivés (factures PDF/Factur-X, devis signés, reçus scannés…). */
export function useDocuments() {
  const client = useBobClient();
  return useQuery({
    queryKey: ['documents'],
    queryFn: async () => {
      const r = await client.listDocuments();
      if (!r.ok) throw new Error('Chargement des documents impossible.');
      return r.value;
    },
  });
}
