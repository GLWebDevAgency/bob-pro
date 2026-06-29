import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { LocalBobClient, HttpBobClient, type BobClient } from '@bob/api-client';

const BobClientContext = createContext<BobClient | null>(null);

/**
 * Sélection de la façade data :
 * - `EXPO_PUBLIC_API_URL` défini → HttpBobClient (backend NestJS réel) ;
 * - sinon → LocalBobClient (hors-ligne, fixtures déterministes).
 * L'UI ne dépend que de l'interface BobClient : brancher le backend = poser une variable d'env.
 */
function defaultClient(): BobClient {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL;
  if (baseUrl) {
    const token = process.env.EXPO_PUBLIC_API_TOKEN;
    return new HttpBobClient({
      baseUrl,
      companyId: process.env.EXPO_PUBLIC_COMPANY_ID ?? 'company-mercier',
      // En prod, remplacer par la session Supabase : getToken: () => supabase.auth.getSession()...
      ...(token ? { getToken: async () => token } : {}),
    });
  }
  return new LocalBobClient();
}

export function BobClientProvider({ children, client }: { children: ReactNode; client?: BobClient }) {
  const value = useMemo<BobClient>(() => client ?? defaultClient(), [client]);
  return <BobClientContext.Provider value={value}>{children}</BobClientContext.Provider>;
}

export function useBobClient(): BobClient {
  const ctx = useContext(BobClientContext);
  if (!ctx) throw new Error('useBobClient doit être utilisé dans un BobClientProvider');
  return ctx;
}
