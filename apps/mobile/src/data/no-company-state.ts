/**
 * Session valide + company ABSENTE en base — la frontière « onboarding vs tabs » (bug device live).
 *
 * Deux signaux, un seul verdict :
 * · JWT sans app_metadata.company_id (compte neuf jamais provisionné) — connu AVANT tout réseau ;
 * · le serveur répond 403 NO_COMPANY (interceptor tenant : company_id du JWT sans ligne en base —
 *   base réinitialisée, provisioning interrompu après écriture des métadonnées) ou
 *   PROVISIONING_REQUIRED (guard : défense en profondeur si un JWT sans tenant atteint les tabs).
 *
 * Dans les deux cas l'app doit tomber sur le flux d'onboarding (ProvisioningScreen), JAMAIS sur
 * les tabs en erreur : ces 403 ne sont pas des pannes, aucun retry ne les résoudra.
 */
import { useEffect, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

/** Raisons `forbidden` serveur qui signifient « pas d'espace de travail », pas « panne ». */
const NO_COMPANY_REASONS: ReadonlySet<string> = new Set(['NO_COMPANY', 'PROVISIONING_REQUIRED']);

/** Vrai si l'erreur est le 403 « pas de company » (AppError forbidden au code stable). */
export function isNoCompanyError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { kind?: unknown; reason?: unknown };
  return (
    candidate.kind === 'forbidden' &&
    typeof candidate.reason === 'string' &&
    NO_COMPANY_REASONS.has(candidate.reason)
  );
}

/** Forme minimale d'une query en cache — découplée de TanStack pour rester testable pure. */
export interface QueryErrorSnapshot {
  readonly state: { readonly error: unknown };
}

/** Vrai si AU MOINS une query du cache porte le 403 « pas de company ». */
export function queriesContainNoCompanyError(
  queries: readonly QueryErrorSnapshot[],
): boolean {
  return queries.some((query) => isNoCompanyError(query.state.error));
}

/**
 * La décision de la porte d'auth : session valide → onboarding si le JWT n'a pas de tenant OU si
 * le serveur a déclaré le tenant sans company. Les tabs ne se rendent JAMAIS dans ces deux états.
 */
export function shouldRouteToProvisioning(input: {
  readonly companyId: string | null;
  readonly serverReportsNoCompany: boolean;
}): boolean {
  return input.companyId === null || input.serverReportsNoCompany;
}

function cacheReportsNoCompany(queryClient: QueryClient): boolean {
  return queriesContainNoCompanyError(queryClient.getQueryCache().getAll());
}

/**
 * Signal LIVE dérivé du cache react-query (jamais un flag collant) : vrai tant qu'une query en
 * cache porte le 403 « pas de company ». Il retombe de lui-même quand le provisioning réussi
 * purge ces queries (ProvisioningScreen) — pas de désynchronisation possible avec le cache.
 */
export function useServerNoCompanySignal(): boolean {
  const queryClient = useQueryClient();
  const [flagged, setFlagged] = useState(() => cacheReportsNoCompany(queryClient));
  useEffect(() => {
    // Rattrape tout événement survenu entre le premier render et l'abonnement.
    setFlagged(cacheReportsNoCompany(queryClient));
    return queryClient.getQueryCache().subscribe(() => {
      setFlagged(cacheReportsNoCompany(queryClient));
    });
  }, [queryClient]);
  return flagged;
}

/**
 * Purge les queries marquées « pas de company » — à appeler APRÈS un provisioning réussi
 * (JWT rafraîchi) : le signal retombe et les écrans repartent sur des fetchs propres.
 */
export function clearNoCompanyQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({ predicate: (query) => isNoCompanyError(query.state.error) });
}
