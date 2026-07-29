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
import {
  addDays,
  contractLabelRefusal,
  parisDateOnly,
  type ContractLabelRefusal,
  type ContractPeriod,
  type MaintenanceContractProps,
} from '@bob/core';

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

// ────────────────────────────────────────────────────────────────────────────────────────────
// RENOMMER — le remède que la garde du libellé PROMET
// ────────────────────────────────────────────────────────────────────────────────────────────
//
// La doctrine du train Contrats repose sur une promesse écrite noir sur blanc dans le code
// (`annual-invoice-designation.ts`, `contract-label-guard.ts`) : « un nom de contrat imparfait
// DANS L'APPLICATION se corrige d'un tap sur la fiche ». C'est CE geste. Deux conséquences que
// la logique ci-dessous porte, et qui expliquent pourquoi elle ne ressemble à aucune autre
// validation de champ du produit :
//
//  · le nom TAPÉ ne repasse PAS par `inspectContractLabel`. Cette garde existe pour les noms
//    que Bob DÉDUIT d'une dictée ; l'appliquer au remède le transformerait en cul-de-sac —
//    le nom qu'elle vient de refuser serait précisément celui que le pro ne pourrait plus
//    écrire. Ici, c'est l'artisan qui a tapé le nom et qui le relit : il est sa propre garde.
//  · il reste borné par le DOMAINE (`contractLabelRefusal`, @bob/core) : vide, trop long,
//    caractères de contrôle. La même règle que `record`, lue AVANT l'appel — l'écran DIT ce qui
//    coince pendant la frappe au lieu de l'apprendre au pro par un refus serveur.

/** Ce qui empêche le renommage de partir — jamais un booléen muet : l'écran DIT lequel. */
export type ContractRenameBlock = 'unchanged' | ContractLabelRefusal;

export interface ContractRenameSubmission {
  /** Nom TRIMÉ prêt à partir, ou `null` quand le geste ne peut pas partir. */
  label: string | null;
  /** La raison EXACTE du blocage — `null` quand le geste peut partir. */
  blocked: ContractRenameBlock | null;
}

/**
 * État du champ « Renommer ». `'unchanged'` est évalué EN PREMIER : un champ pré-rempli et
 * intact n'est pas une erreur, c'est un bouton qui attend — afficher « nom requis » sur une
 * feuille qu'on vient d'ouvrir serait reprocher au pro de ne pas encore avoir tapé. Un nom
 * seulement re-espacé compte comme intact : le renvoyer ferait tourner la révision pour rien.
 */
export function contractRenameSubmission(input: {
  current: string;
  typed: string;
}): ContractRenameSubmission {
  const typed = input.typed.trim();
  if (typed === input.current.trim()) return { label: null, blocked: 'unchanged' };
  const refusal = contractLabelRefusal(typed);
  if (refusal !== null) return { label: null, blocked: refusal };
  return { label: typed, blocked: null };
}

/**
 * Le renommage n'existe QUE là où le domaine l'autorise : `MaintenanceContract.update` refuse
 * un contrat résilié (« lecture seule »). Une transition interdite est un CTA ABSENT, jamais
 * grisé (§3.1) — proposer « Renommer » sur une fiche résiliée serait promettre un refus.
 */
export function contractRenameAllowed(status: MaintenanceContractProps['status']): boolean {
  return status !== 'terminated';
}

/**
 * CONFLIT DE RÉVISION — la fiche a changé ailleurs entre son chargement et le tap. L'écran le
 * DIT et s'arrête là : il ne réessaie JAMAIS avec la révision fraîche, ce qui écraserait en
 * silence ce que l'autre appareil vient d'écrire. La révision est une question, pas un obstacle
 * à contourner.
 */
export function isContractRevisionConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { kind?: unknown; entity?: unknown };
  return candidate.kind === 'conflict' && candidate.entity === 'maintenance_contract';
}
