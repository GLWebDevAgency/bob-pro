/**
 * PR-12c — logique PURE de la fiche contrat et du wizard (écrans §3.1-§3.3), testée sans
 * react-native. Tout fait affiché est ADOSSÉ à une colonne ou une dérivation NOMMÉE du
 * document domaine — l'écran constate, il ne réinterprète jamais :
 *  · la période contractuelle vit en fin EXCLUSIVE côté domaine → l'affichage montre la
 *    VEILLE (bornes incluses lisibles — « jamais une borne exclusive qui ment d'un jour ») ;
 *  · [annexe erratum n° 4] la saisie « déjà facturé jusqu'au » du wizard est INCLUSIVE
 *    (lecture humaine naturelle) → conversion +1 jour vers la colonne EXCLUSIVE
 *    `importCoveredUntil` — l'anti off-by-one qui évitera la fausse alerte « facture
 *    annuelle à émettre » sur toute la flotte migrée au jour 1 ;
 *  · l'historique mêle FAITS STOCKÉS (activatedAt, terminatedAt+motif) et reconductions
 *    DÉRIVÉES arithmétiquement, toujours suffixées « (calculé) » (revue P10).
 */
import { addDays, parisDateOnly, type ContractPeriod, type MaintenanceContractProps } from '@bob/core';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** [Erratum n° 4] saisie humaine INCLUSIVE → borne EXCLUSIVE de la colonne (+1 jour).
 *  Chaîne vide/invalide → null (le champ est optionnel, jamais une date inventée). */
export function importCoveredUntilFromInclusive(inclusive: string): string | null {
  const trimmed = inclusive.trim();
  if (trimmed === '') return null;
  if (!DATE_ONLY.test(trimmed)) return null;
  return addDays(trimmed, 1);
}

/** Inverse exacte pour le pré-remplissage d'édition : colonne EXCLUSIVE → affichage INCLUSIF. */
export function inclusiveFromImportCoveredUntil(exclusive: string | null): string {
  if (exclusive === null || !DATE_ONLY.test(exclusive)) return '';
  return addDays(exclusive, -1);
}

/** Bornes HUMAINES d'une période domaine (fin exclusive → veille incluse). */
export function inclusivePeriodOf(period: ContractPeriod): { start: string; end: string } {
  return { start: period.start, end: addDays(period.end, -1) };
}

const MONTHS_SHORT = [
  'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.',
] as const;

/** « 2026-10-12 » → « 12 oct. 2026 » (dates complètes en toutes lettres — a11y §9). */
export function frContractDate(dateOnly: string): string {
  if (!DATE_ONLY.test(dateOnly)) return dateOnly;
  const month = MONTHS_SHORT[Number(dateOnly.slice(5, 7)) - 1] ?? '';
  return `${Number(dateOnly.slice(8, 10))} ${month} ${dateOnly.slice(0, 4)}`;
}

/**
 * Jour MÉTIER (Europe/Paris) d'un instant stocké — `parisDateOnly` de @bob/core, la SEULE
 * source de vérité du calendrier de l'entreprise. Jamais `.slice(0, 10)` : ce serait le jour
 * UTC, et entre 00 h et 02 h à Paris l'UTC est encore la VEILLE — le fait s'afficherait daté
 * d'un jour trop tôt (même faille que celle corrigée sur TerminateContract, 97a96840).
 * Absence de fait ⇒ null : aucune date inventée.
 */
export function contractEventDay(at: string | null): string | null {
  return at === null || at === '' ? null : parisDateOnly(at);
}

export interface ContractHistoryEntry {
  /** Fait STOCKÉ (activatedAt/terminatedAt) ou DÉRIVÉ (reconduction arithmétique). */
  kind: 'activated' | 'renewed' | 'terminated';
  /** DateOnly de l'événement (tri décroissant à l'affichage). */
  at: string;
  /** Vrai pour toute entrée CALCULÉE — l'UI suffixe « (calculé) », jamais en couleur seule. */
  computed: boolean;
  /** Motif de résiliation (fait stocké) — null ailleurs. */
  note: string | null;
}

/**
 * Historique honnête [revue P10] : DEUX faits stockés + les reconductions dérivées — rien
 * n'est journalisé par un cron, tout se recalcule. `renewals` vient du serveur
 * (deriveContractLifecycleFacts, la MÊME dérivation §2.5 que la voix).
 */
export function contractHistoryEntries(input: {
  contract: Pick<MaintenanceContractProps, 'activatedAt' | 'terminatedAt' | 'terminationNote'>;
  renewals: readonly string[];
}): ContractHistoryEntry[] {
  const entries: ContractHistoryEntry[] = [];
  const activatedOn = contractEventDay(input.contract.activatedAt);
  if (activatedOn !== null) {
    entries.push({ kind: 'activated', at: activatedOn, computed: false, note: null });
  }
  for (const renewal of input.renewals) {
    entries.push({ kind: 'renewed', at: renewal, computed: true, note: null });
  }
  const terminatedOn = contractEventDay(input.contract.terminatedAt);
  if (terminatedOn !== null) {
    entries.push({
      kind: 'terminated',
      at: terminatedOn,
      computed: false,
      note: input.contract.terminationNote,
    });
  }
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** CTA primaire de la fiche, dérivé de l'état + faits (§3.1) — les transitions interdites
 *  sont des CTA ABSENTS, jamais grisés. */
export type ContractPrimaryCta = 'activate' | 'prepare_annual_invoice' | null;

export function contractPrimaryCta(view: {
  status: MaintenanceContractProps['status'];
  billingDue: unknown | null;
}): ContractPrimaryCta {
  if (view.status === 'draft') return 'activate';
  if (view.status === 'active' && view.billingDue !== null) return 'prepare_annual_invoice';
  return null;
}
