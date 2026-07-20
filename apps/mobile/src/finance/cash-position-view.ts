/**
 * Vue d'affichage de la POSITION DE TRÉSORERIE — la moitié qui manquait à l'écran.
 *
 * POURQUOI ce module existe : le solde bancaire est un FAIT ponctuel et daté. Marquer une facture
 * payée ne le fait pas bouger — c'est correct, personne n'a reconstaté la banque — mais affiché
 * SEUL il se lit comme un bug (« j'encaisse 60 €, mon solde ne change pas »). L'app doit donc
 * montrer DEUX nombres : le constaté daté (le fait) et la position estimée (le fait + ce qui a
 * bougé depuis), sans jamais faire passer la seconde pour un relevé bancaire.
 *
 * Source unique partagée par l'Accueil et l'écran Argent : deux écrans qui calculeraient
 * séparément « depuis quand » et « combien » finiraient par se contredire.
 */
import { formatEUR, parisDateOnly, type QualifiedBankBalanceWithPosition } from '@bob/core';
import { t, type Personality } from '@bob/i18n';
import { formatDateFr } from '../data/company-draft';

export interface CashPositionDisplay {
  /** Le nombre PRINCIPAL : constaté + mouvements postérieurs. Toujours présenté comme estimé. */
  readonly estimatedCents: number;
  /** Le FAIT, conservé en mention — il reste la seule chose que quelqu'un a réellement vue. */
  readonly observedCents: number;
  /** « Constaté 1 000,00 € le 19/07/2026 » — le fait ET sa date, jamais l'un sans l'autre. */
  readonly observedLabel: string;
  /** Le constaté déjà formaté (« 1 000,00 € ») — évite que chaque écran reformate à sa façon. */
  readonly observedAmount: string;
  /** Jour Europe/Paris de l'observation, format FR (« 19/07/2026 »). */
  readonly observedDate: string;
  /** « +60,00 € encaissés · −184,90 € sortis » — l'explication de l'écart, en clair. */
  readonly movementsLabel: string;
}

/**
 * `null` = il n'y a rien de plus à montrer que le solde constaté, et l'écran garde EXACTEMENT son
 * rendu actuel. Trois cas, tous légitimes :
 * · aucune observation qualifiée (`balance` absent) → l'invitation à saisir le solde est inchangée ;
 * · `position === null` → la projection des mouvements est indisponible ; on n'affiche jamais un
 *   estimé partiel, qui serait un mensonge silencieux ;
 * · aucun mouvement retenu → l'estimé est ÉGAL au constaté ; afficher deux fois le même nombre
 *   serait du bruit, pas de l'information.
 *
 * NB : le déclencheur est le NOMBRE de mouvements, pas leur net. Des entrées et des sorties qui
 * s'annulent laissent un net nul mais restent une information que le propriétaire veut voir.
 */
export function deriveCashPositionDisplay(input: {
  readonly balance: QualifiedBankBalanceWithPosition | undefined;
  readonly personality: Personality;
}): CashPositionDisplay | null {
  const position = input.balance?.position ?? null;
  if (position === null) return null;
  const { movements } = position;
  if (movements.inflowCount === 0 && movements.outflowCount === 0) return null;

  // Jour métier Europe/Paris, comme partout ailleurs (parisDateOnly) : à 23 h UTC la France est
  // déjà au lendemain, et dater l'observation en UTC afficherait la veille au propriétaire.
  const observedDay = formatDateFr(parisDateOnly(position.observedAt)) ?? '';

  const observedAmount = formatEUR(position.observedBalanceCents);

  return {
    estimatedCents: position.estimatedBalanceCents,
    observedCents: position.observedBalanceCents,
    observedAmount,
    observedDate: observedDay,
    observedLabel: t('argent.positionObservedMention', {
      personality: input.personality,
      params: { observed: observedAmount, date: observedDay },
    }),
    movementsLabel: t('argent.positionMovements', {
      personality: input.personality,
      params: {
        inflow: formatEUR(movements.inflowCents),
        outflow: formatEUR(movements.outflowCents),
      },
    }),
  };
}
