import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LocalBobClient, HttpBobClient, type BobClient } from '@bob/api-client';
import { getAccessToken, supabaseEnabled } from './supabase';
import { useAuth } from './auth';
import { companyIdFromAppMetadata, configuredDemoCompanyId } from './tenant-identity';

const BobClientContext = createContext<BobClient | null>(null);

/**
 * Sélection de la façade data :
 * - `EXPO_PUBLIC_API_URL` défini → HttpBobClient, recalé sur le tenant du JWT ;
 * - sinon → LocalBobClient (hors-ligne, fixtures déterministes).
 * L'UI ne dépend que de l'interface BobClient : brancher le backend = poser une variable d'env.
 */
function defaultClient(companyId: string): BobClient {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL;
  if (baseUrl) {
    return new HttpBobClient({
      baseUrl,
      companyId,
      getToken: getAccessToken, // session Supabase, ou EXPO_PUBLIC_API_TOKEN, ou null (démo)
    });
  }
  return new LocalBobClient();
}

export function BobClientProvider({
  children,
  client,
}: {
  children: ReactNode;
  client?: BobClient;
}) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const authenticatedCompanyId = companyIdFromAppMetadata(session?.user.app_metadata);
  // Le tenant statique n'est qu'un choix EXPLICITE de dev/démo. En auth réelle, il ne peut
  // jamais supplanter ni masquer le tenant signé dans le JWT.
  const demoCompanyId = !supabaseEnabled
    ? configuredDemoCompanyId(process.env.EXPO_PUBLIC_COMPANY_ID)
    : null;
  // Les routes publiques de lookup/provisioning n'utilisent pas ce tenant. Ce sentinel borné
  // évite toute société fixture implicite avant que le JWT fraîchement provisionné arrive.
  const companyId = authenticatedCompanyId ?? demoCompanyId ?? 'public';
  const value = useMemo<BobClient>(() => client ?? defaultClient(companyId), [client, companyId]);
  const identity = client
    ? `injected:${client.companyId}`
    : `${process.env.EXPO_PUBLIC_API_URL ?? 'local'}:${companyId}`;
  const previousIdentity = useRef(identity);

  useEffect(() => {
    if (previousIdentity.current === identity) return;
    previousIdentity.current = identity;
    // Une query d'un tenant ne survit jamais au provisioning ou à un changement de compte.
    queryClient.clear();
  }, [identity, queryClient]);

  return <BobClientContext.Provider value={value}>{children}</BobClientContext.Provider>;
}

export function useBobClient(): BobClient {
  const ctx = useContext(BobClientContext);
  if (!ctx) throw new Error('useBobClient doit être utilisé dans un BobClientProvider');
  return ctx;
}
