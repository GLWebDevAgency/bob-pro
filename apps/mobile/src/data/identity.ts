import { useMemo } from 'react';
import { MERCIER_PROPS, type CompanyProps } from '@bob/core';
import { supabaseEnabled } from './supabase';
import { useAuth } from './auth';
import { useCompanyMe } from './hooks';

/**
 * Identité affichée (prénom, initiales, société) — SOURCE UNIQUE.
 * RÈGLE (directive 2026-07-03) : « Mercier » est une société DÉMO, un exemple.
 * Aucun écran ne code l'identité en dur :
 *  · mode démo (Supabase non configuré) → identité du seed @bob/core (MERCIER_PROPS) ;
 *  · mode connecté → session Supabase (user_metadata, sinon l'email) + fiche société
 *    RÉELLE du tenant via GET /company/me (PONT-SERVEUR ④) — tant que la fiche n'est
 *    pas chargée (ou si le client ne l'expose pas), companyName reste null : les
 *    écrans masquent la ligne plutôt que mentir.
 */
export interface Identity {
  firstName: string | null;
  initials: string;
  companyName: string | null;
  /** Détail légal (forme · SIRET) — seed en démo, fiche BDD en connecté. */
  legalLine: string | null;
  isDemo: boolean;
}

function initialsOf(...words: (string | null | undefined)[]): string {
  const letters = words
    .filter((w): w is string => !!w)
    .flatMap((w) => w.split(/\s+/))
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '');
  return letters.join('') || '—';
}

function legalLineOf(c: Pick<CompanyProps, 'legalForm' | 'siret'> & { rcsOrRm?: string }): string {
  const parts = [c.legalForm, `SIRET ${c.siret}`];
  if (c.rcsOrRm) parts.push(c.rcsOrRm);
  return parts.join(' · ');
}

export function useIdentity(): Identity {
  const { session } = useAuth();

  // Fiche société du tenant (connecté seulement) — hook PARTAGÉ useCompanyMe (hooks.ts,
  // queryKey ['company-me'] : même cache que l'écran Argent, C-EXP-UI2). getCompanyMe est
  // OPTIONNEL sur l'interface (le LocalBobClient ne l'a pas encore — TODO session B tracé) :
  // son absence ou son échec laissent simplement companyName null (jamais un nom inventé).
  const companyMe = useCompanyMe();

  return useMemo(() => {
    if (!supabaseEnabled) {
      // Chemin DÉMO explicite : le seed est la seule source du nom d'exemple.
      const first = 'Julien'; // prénom du proto, cohérent avec le seed démo Mercier
      return {
        firstName: first,
        initials: initialsOf(first, MERCIER_PROPS.name),
        companyName: MERCIER_PROPS.name,
        legalLine: legalLineOf(MERCIER_PROPS),
        isDemo: true,
      };
    }
    const meta = (session?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const fullName = typeof meta.full_name === 'string' ? meta.full_name : null;
    const firstName =
      (typeof meta.first_name === 'string' && meta.first_name) ||
      fullName?.split(/\s+/)[0] ||
      session?.user?.email?.split('@')[0] ||
      null;
    const company = companyMe.data ?? null;
    return {
      firstName,
      initials: initialsOf(fullName ?? firstName),
      companyName: company?.name ?? null,
      legalLine: company ? legalLineOf(company) : null,
      isDemo: false,
    };
  }, [session, companyMe.data]);
}
