import { useMemo } from 'react';
import { type CompanyProps } from '@bob/core';
import { useAuth } from './auth';
import { useCompanyMe } from './hooks';

/**
 * Identité affichée (prénom, initiales, société) — SOURCE UNIQUE.
 * La session Supabase (user_metadata, sinon l'email) et la fiche société RÉELLE du tenant via
 * GET /company/me sont les seules sources. Tant que la fiche n'est pas chargée,
 * companyName reste null : les écrans masquent la ligne plutôt que mentir.
 */
export interface Identity {
  firstName: string | null;
  initials: string;
  companyName: string | null;
  /** Détail légal (forme · SIRET) issu de la fiche BDD. */
  legalLine: string | null;
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

  // Fiche société du tenant — hook PARTAGÉ useCompanyMe (hooks.ts, queryKey ['company-me']) :
  // son absence ou son échec laissent simplement companyName null (jamais un nom inventé).
  const companyMe = useCompanyMe();

  return useMemo(() => {
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
    };
  }, [session, companyMe.data]);
}
