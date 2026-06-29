import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { LocalBobClient, type BobClient } from '@bob/api-client';

const BobClientContext = createContext<BobClient | null>(null);

/** Fournit la façade data. Par défaut : LocalBobClient (hors-ligne, fixtures). Plus tard : HttpBobClient. */
export function BobClientProvider({ children, client }: { children: ReactNode; client?: BobClient }) {
  const value = useMemo<BobClient>(() => client ?? new LocalBobClient(), [client]);
  return <BobClientContext.Provider value={value}>{children}</BobClientContext.Provider>;
}

export function useBobClient(): BobClient {
  const ctx = useContext(BobClientContext);
  if (!ctx) throw new Error('useBobClient doit être utilisé dans un BobClientProvider');
  return ctx;
}
