import { useMemo } from 'react';
import { MERCIER_PROPS } from '@bob/core';
import { supabaseEnabled } from './supabase';
import { useAuth } from './auth';

/**
 * Identité affichée (prénom, initiales, société) — SOURCE UNIQUE.
 * RÈGLE (directive 2026-07-03) : « Mercier » est une société DÉMO, un exemple.
 * Aucun écran ne code l'identité en dur :
 *  · mode démo (Supabase non configuré) → identité du seed @bob/core (MERCIER_PROPS) ;
 *  · mode connecté → session Supabase (user_metadata, sinon l'email) ; le nom de
 *    société reste null tant que le serveur n'expose pas l'entreprise du tenant
 *    (TODO serveur : GET /company/me — les écrans masquent la ligne plutôt que mentir).
 */
export interface Identity {
  firstName: string | null;
  initials: string;
  companyName: string | null;
  /** Détail légal (forme, SIRET…) — démo uniquement pour l'instant. */
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

export function useIdentity(): Identity {
  const { session } = useAuth();

  return useMemo(() => {
    if (!supabaseEnabled) {
      // Chemin DÉMO explicite : le seed est la seule source du nom d'exemple.
      const first = 'Julien'; // prénom du proto, cohérent avec le seed démo Mercier
      return {
        firstName: first,
        initials: initialsOf(first, MERCIER_PROPS.name),
        companyName: MERCIER_PROPS.name,
        legalLine: `${MERCIER_PROPS.legalForm} · SIRET ${MERCIER_PROPS.siret} · ${MERCIER_PROPS.rcsOrRm}`,
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
    return {
      firstName,
      initials: initialsOf(fullName ?? firstName),
      companyName: null, // TODO serveur GET /company/me — jamais un nom inventé
      legalLine: null,
      isDemo: false,
    };
  }, [session]);
}
