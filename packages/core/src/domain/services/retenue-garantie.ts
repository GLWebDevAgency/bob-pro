import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type DateOnly, isValidDateOnly } from '../../shared-kernel/time';
import { formatEUR } from '../../format/money';

/**
 * B5 — Retenue de garantie des MARCHÉS PRIVÉS de travaux (loi n° 71-584 du 16 juillet 1971,
 * texte vérifié sur Légifrance) :
 *  • art. 1er : les paiements des acomptes (situations) peuvent être amputés d'une retenue
 *    AU PLUS ÉGALE À 5 % de leur montant, garantissant contractuellement l'exécution des
 *    travaux pour satisfaire, le cas échéant, aux réserves formulées à la réception ;
 *  • art. 2 : la retenue est libérée À L'EXPIRATION DU DÉLAI D'UNE ANNÉE à compter de la date
 *    de RÉCEPTION des travaux, faite avec ou sans réserves — sauf opposition motivée du maître
 *    de l'ouvrage par lettre recommandée (réserves non levées).
 *
 * Doctrine produit : la retenue est OPTIONNELLE par devis-chantier (jamais imposée), calculée
 * aux situations et à la finale, DÉDUITE du net à payer, imprimée en mention dédiée, et sa
 * restitution est une CRÉANCE SUIVIE (vue de suivi ci-dessous) — pas une pièce fiscale
 * nouvelle : la TVA a déjà été facturée sur le montant plein, seul l'encaissement est différé.
 */
export const RETENUE_GARANTIE_MAX_PCT = 5;

/** Délai de libération de la retenue : un an à compter de la réception (loi 71-584, art. 2). */
export const RETENUE_GARANTIE_RESTITUTION_DELAY_YEARS = 1;

/** 2 décimales max — un taux de retenue se stipule lisiblement (5, 3, 2,5…). */
function hasAtMostTwoDecimals(value: number): boolean {
  const scaled = value * 100;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/** Taux de retenue valide : 0 < pct ≤ 5 (le plafond de l'art. 1er est d'ordre public). */
export function validateRetenueGarantiePct(pct: number): DomainResult<number> {
  if (!Number.isFinite(pct) || pct <= 0 || pct > RETENUE_GARANTIE_MAX_PCT || !hasAtMostTwoDecimals(pct))
    return err({
      code: 'VALIDATION',
      field: 'retenueGarantiePct',
      message: `Taux de retenue de garantie invalide (0 < taux ≤ ${RETENUE_GARANTIE_MAX_PCT} %, loi n° 71-584 du 16 juillet 1971).`,
    });
  return ok(pct);
}

/**
 * Montant retenu sur un paiement donné (base TTC de la situation ou du solde de la finale),
 * arrondi commercial — 0 si aucune retenue stipulée.
 */
export function retenueGarantieCents(baseCents: number, pct: number | null | undefined): number {
  if (pct === null || pct === undefined || baseCents <= 0) return 0;
  return Math.min(Math.round((baseCents * pct) / 100), baseCents);
}

/** Mention DÉDIÉE imprimée sur la pièce (situation/finale) quand la retenue s'applique. */
export function retenueGarantieMention(pct: number, retainedCents: number): string {
  return (
    `Retenue de garantie de ${String(pct).replace('.', ',')} % (loi n° 71-584 du 16 juillet 1971) : ` +
    `${formatEUR(retainedCents)} déduits du net à payer de la présente pièce. Cette somme est ` +
    `libérée à l'expiration du délai d'une année à compter de la réception des travaux, sauf ` +
    `opposition motivée du maître de l'ouvrage pour réserves non levées.`
  );
}

/** « 2026-02-29 » + 1 an → « 2027-02-28 » : anniversaire calendaire, borné au dernier jour du mois. */
export function addOneYear(date: DateOnly): DateOnly {
  const year = Number(date.slice(0, 4)) + RETENUE_GARANTIE_RESTITUTION_DELAY_YEARS;
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const clamped = Math.min(day, lastDayOfMonth);
  return `${year}-${String(month).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

/** Une pièce émise portant une retenue constituée (numéro + montant, relus des totaux figés). */
export interface RetenueGarantiePiece {
  /** Numéro de la pièce émise (null impossible en pratique : la retenue naît à l'émission). */
  pieceNumber: string | null;
  retainedCents: number;
}

export interface RetenueGarantieSuiviInput {
  /** Pièces émises du devis-chantier portant une retenue (situations + finale). */
  pieces: readonly RetenueGarantiePiece[];
  /**
   * Date de RÉCEPTION des travaux (avec ou sans réserves) — null/absent = pas encore reçue :
   * le délai d'un an n'a pas commencé à courir (restitution sans échéance, jamais inventée).
   */
  receptionAt?: DateOnly | null;
  /** Jour métier du calcul (Europe/Paris), injecté — jamais Date.now(). */
  asOf: DateOnly;
}

export interface RetenueGarantieSuivi {
  /** Total retenu (constitué) sur les pièces émises, en centimes. */
  retainedCents: number;
  /** Échéance de restitution = réception + 1 an (loi 71-584, art. 2) ; null tant que non reçue. */
  restitutionDueAt: DateOnly | null;
  /** true = l'échéance est atteinte (créance exigible sauf opposition motivée pour réserves). */
  restitutionDue: boolean;
  pieces: readonly RetenueGarantiePiece[];
}

/**
 * Vue de SUIVI de la retenue de garantie d'un devis-chantier — règle PURE : la restitution est
 * une créance suivie (relance humaine/vocale), JAMAIS une nouvelle pièce fiscale.
 */
export function deriveRetenueGarantieSuivi(
  input: RetenueGarantieSuiviInput,
): DomainResult<RetenueGarantieSuivi> {
  if (!isValidDateOnly(input.asOf))
    return err({ code: 'VALIDATION', field: 'asOf', message: 'Date de calcul invalide (AAAA-MM-JJ requis).' });
  const receptionAt = input.receptionAt ?? null;
  if (receptionAt !== null && !isValidDateOnly(receptionAt))
    return err({ code: 'VALIDATION', field: 'receptionAt', message: 'Date de réception invalide (AAAA-MM-JJ requis).' });
  for (const piece of input.pieces) {
    if (!Number.isSafeInteger(piece.retainedCents) || piece.retainedCents < 0)
      return err({ code: 'VALIDATION', field: 'pieces', message: 'Montant retenu invalide (centimes entiers ≥ 0 requis).' });
  }
  const retainedCents = input.pieces.reduce((sum, piece) => sum + piece.retainedCents, 0);
  const restitutionDueAt = receptionAt === null ? null : addOneYear(receptionAt);
  return ok({
    retainedCents,
    restitutionDueAt,
    restitutionDue: restitutionDueAt !== null && input.asOf >= restitutionDueAt,
    pieces: input.pieces.map((piece) => ({ ...piece })),
  });
}
