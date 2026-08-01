import { useMemo } from 'react';
import {
  businessDayOf,
  deriveOwnerPayGuidance,
  parisDateOnly,
  type OwnerPayGuidance,
  type OwnerPayGuidanceCashflow,
  type OwnerPayGuidancePeriodCA,
} from '@bob/core';
import { useFiscalProfile, usePayments } from '../data/hooks';

/**
 * CA encaissé du MOIS MÉTIER Europe/Paris en cours — fonction PURE (testable à horloge gelée),
 * même calcul que le serveur (backend.service getOwnerPayGuidance) pour que la voix et l'écran
 * annoncent LE MÊME chiffre. Deux côtés sur le même calendrier (doctrine time.ts @bob/core) :
 * · la borne « mois en cours » vient de parisDateOnly(now) — jamais le fuseau ambiant de
 *   l'appareil (peut dériver en déplacement), jamais le jour UTC ;
 * · le jour de chaque encaissement vient de businessDayOf(receivedAt) — receivedAt est un
 *   Instant : sa troncature UTC perdait les paiements de 00:00–~02:00 Paris le 1er du mois
 *   (et comptait à tort ceux de fin de mois côté UTC dans le mois suivant).
 * `payments` absent (chargement) → undefined : la guidance retombe honnêtement sur 'prudent'.
 */
export function periodeCAOf(
  payments: readonly { receivedAt: string; amountCents: number }[] | undefined,
  now: Date = new Date(),
): OwnerPayGuidancePeriodCA | undefined {
  if (payments === undefined) return undefined;
  const today = parisDateOnly(now);
  const month = today.slice(0, 7); // 'YYYY-MM'
  return {
    encaissedCents: Math.max(
      0,
      payments
        .filter((p) => businessDayOf(p.receivedAt).slice(0, 7) === month)
        .reduce((sum, p) => sum + p.amountCents, 0),
    ),
    year: Number(today.slice(0, 4)),
  };
}

export interface UseOwnerPayGuidanceResult {
  /** undefined tant que le profil fiscal ou le cashflow fourni ne sont pas encore chargés. */
  guidance: OwnerPayGuidance | undefined;
  isLoading: boolean;
  /** Une erreur amont ne doit jamais être confondue avec un profil fiscal ou un CA absents. */
  isError: boolean;
}

/**
 * Compose useFiscalProfile (Phase 1B) + les paiements datés déjà servis ailleurs (socle E3, mêmes
 * données que le grand-livre d'Argent) avec le CASHFLOW FOURNI PAR L'ÉCRAN APPELANT pour produire
 * l'objet PUR `deriveOwnerPayGuidance` (@bob/core, Phase 1C). Le cashflow n'est JAMAIS recalculé
 * ici : chaque écran garde son propre scénario/horizon (Home = réaliste/30j, Argent = prudent/30j)
 * — la guidance doit toujours porter sur LE MÊME chiffre que celui affiché à côté, jamais un
 * scénario parallèle qui désaccorderait deux montants censés être identiques.
 *
 * periodeCA (cas micro uniquement) : CA encaissé du MOIS MÉTIER Paris en cours (periodeCAOf
 * ci-dessus — même mois et même filtre que le serveur) — simplification 1C documentée. La
 * période de déclaration URSSAF exacte peut être trimestrielle (cf. deriveUrssafProvision / la
 * carte « déclaration pré-calculée » d'Argent, qui reste la source de vérité pour LA
 * DÉCLARATION) ; ici on veut seulement une provision « du mois » raisonnable pour le retrait
 * suggéré, pas une déclaration officielle. Aucun nouvel endpoint en 1C (mission) :
 * `usePayments()` est la même query déjà chargée par l'écran Argent (cache react-query partagé,
 * coût nul en plus). Une absence de paiements réussie produit bien un CA nul ; une ERREUR réseau,
 * elle, est propagée via `isError` et ne doit jamais devenir un scénario « prudent » silencieux.
 */
export function useOwnerPayGuidance(cashflow: OwnerPayGuidanceCashflow | undefined): UseOwnerPayGuidanceResult {
  const profile = useFiscalProfile();
  const payments = usePayments();

  const guidance = useMemo(() => {
    if (!profile.data || !cashflow) return undefined;
    return deriveOwnerPayGuidance(profile.data, cashflow, periodeCAOf(payments.data));
  }, [profile.data, payments.data, cashflow]);

  return {
    guidance,
    isLoading: profile.isLoading || payments.isLoading,
    isError: profile.isError || payments.isError,
  };
}
