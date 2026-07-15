import { useMemo } from 'react';
import { deriveOwnerPayGuidance, type OwnerPayGuidance, type OwnerPayGuidanceCashflow } from '@bob/core';
import { useFiscalProfile, usePayments } from '../data/hooks';

/** Date locale du jour (DateOnly) — même règle que hooks.ts/argent.tsx : calendrier LOCAL, pas UTC. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface UseOwnerPayGuidanceResult {
  /** undefined tant que le profil fiscal ou le cashflow fourni ne sont pas encore chargés. */
  guidance: OwnerPayGuidance | undefined;
  isLoading: boolean;
}

/**
 * Compose useFiscalProfile (Phase 1B) + les paiements datés déjà servis ailleurs (socle E3, mêmes
 * données que le grand-livre d'Argent) avec le CASHFLOW FOURNI PAR L'ÉCRAN APPELANT pour produire
 * l'objet PUR `deriveOwnerPayGuidance` (@bob/core, Phase 1C). Le cashflow n'est JAMAIS recalculé
 * ici : chaque écran garde son propre scénario/horizon (Home = réaliste/30j, Argent = prudent/30j)
 * — la guidance doit toujours porter sur LE MÊME chiffre que celui affiché à côté, jamais un
 * scénario parallèle qui désaccorderait deux montants censés être identiques.
 *
 * periodeCA (cas micro uniquement) : CA encaissé du MOIS CIVIL EN COURS — simplification 1C
 * documentée. La période de déclaration URSSAF exacte peut être trimestrielle (cf.
 * deriveUrssafProvision / la carte « déclaration pré-calculée » d'Argent, qui reste la source de
 * vérité pour LA DÉCLARATION) ; ici on veut seulement une provision « du mois » raisonnable pour
 * le retrait suggéré, pas une déclaration officielle. Aucun nouvel endpoint en 1C (mission) :
 * `usePayments()` est la même query déjà chargée par l'écran Argent (cache react-query partagé,
 * coût nul en plus). Paiements absents/en erreur → periodeCA absent → `deriveOwnerPayGuidance`
 * retombe honnêtement sur `kind: 'prudent'`.
 */
export function useOwnerPayGuidance(cashflow: OwnerPayGuidanceCashflow | undefined): UseOwnerPayGuidanceResult {
  const profile = useFiscalProfile();
  const payments = usePayments();

  const guidance = useMemo(() => {
    if (!profile.data || !cashflow) return undefined;
    const today = localToday();
    const month = today.slice(0, 7); // 'YYYY-MM'
    const year = Number(today.slice(0, 4));
    const periodeCA =
      payments.data === undefined
        ? undefined
        : {
            encaissedCents: Math.max(
              0,
              payments.data
                .filter((p) => p.receivedAt.slice(0, 7) === month)
                .reduce((sum, p) => sum + p.amountCents, 0),
            ),
            year,
          };
    return deriveOwnerPayGuidance(profile.data, cashflow, periodeCA);
  }, [profile.data, payments.data, cashflow]);

  return { guidance, isLoading: profile.isLoading || payments.isLoading };
}
