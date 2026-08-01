import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { HttpBobClient, type BobClient } from '@bob/api-client';
import { getAccessToken } from './supabase';
import { useAuth } from './auth';
import { companyIdFromAppMetadata } from './tenant-identity';
import { reportApiFailure } from '../observability/api-failure-reporter';
import {
  mobileDataEnvironmentFromProcess,
  resolveMobileDataMode,
  type MobileDataMode,
} from './mobile-data-mode';

const BobClientContext = createContext<BobClient | null>(null);

/**
 * Sélection de la façade data :
 * Le runtime Bob standard est exclusivement distant. Un client local ne peut entrer que par la
 * prop d'injection explicite des tests/harness, jamais par une variable d'environnement de l'app.
 */
function defaultClient(companyId: string, mode: MobileDataMode): BobClient {
  if (mode.kind !== 'remote') {
    throw new Error('BOB_MOBILE_REMOTE_DATA_REQUIRED');
  }
  return new HttpBobClient({
    baseUrl: mode.apiUrl,
    companyId,
    getToken: getAccessToken,
    // SPEC_SYSTEME_ERREUR §5 : chaque échec API alimente le journal local (écran « Diagnostic
    // technique ») et, pour les seuls `dependency`, le canal de crash — sans PII.
    onError: reportApiFailure,
  });
}

export function BobClientProvider({
  children,
  client,
}: {
  children: ReactNode;
  client?: BobClient;
}) {
  const { session } = useAuth();
  const dataMode = useMemo(
    () => (client ? null : resolveMobileDataMode(mobileDataEnvironmentFromProcess())),
    [client],
  );
  const authenticatedCompanyId = companyIdFromAppMetadata(session?.user.app_metadata);
  // Les routes publiques de lookup/provisioning n'utilisent pas ce tenant. Ce sentinel borné
  // évite toute société fixture implicite avant que le JWT fraîchement provisionné arrive.
  const companyId = authenticatedCompanyId ?? 'public';
  const value = useMemo<BobClient>(() => {
    if (client) return client;
    if (dataMode === null) throw new Error('BOB_MOBILE_DATA_MODE_UNAVAILABLE');
    return defaultClient(companyId, dataMode);
  }, [client, companyId, dataMode]);

  return <BobClientContext.Provider value={value}>{children}</BobClientContext.Provider>;
}

export function useBobClient(): BobClient {
  const ctx = useContext(BobClientContext);
  if (!ctx) throw new Error('useBobClient doit être utilisé dans un BobClientProvider');
  return ctx;
}
