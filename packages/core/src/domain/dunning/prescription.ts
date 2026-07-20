import { type DateOnly } from '../../shared-kernel/time';
import { type CustomerType } from '../customer/customer';

/**
 * Chrono de prescription par facture (P04, C-EXP2 vA) — service domaine pur.
 *
 * Régimes (références CORRIGÉES, roadmap expertise-comptable §P04) :
 * · b2c — prescription BIENNALE, art. L218-2 C. conso. Point de départ jurisprudentiel =
 *   achèvement de la prestation (Cass. 1re civ. 19/5/2021, 20-12.520) ; le schéma n'ayant pas
 *   de date d'achèvement, ANCRE PRUDENTE = min(date d'émission, échéance) — on préfère
 *   sous-estimer le temps restant que rassurer à tort.
 * · b2b — prescription QUINQUENNALE, art. L110-4 C. com. Ancre = exigibilité (échéance),
 *   repli prudent sur l'émission si l'échéance manque.
 * · b2g — DÉCHÉANCE QUADRIENNALE, loi 68-1250 (art. 1) : 4 ans à compter du 1er janvier
 *   suivant l'année du fait générateur → deadline = 31/12 de (année du fait générateur + 4).
 *   Régime INVERSÉ : une simple réclamation écrite à l'administration INTERROMPT (art. 2) —
 *   contrairement au droit privé où une relance, même LRAR, n'interrompt JAMAIS
 *   (Cass. com. 18/5/2022, 20-23.204).
 * · Reconnaissance du débiteur (paiement partiel = art. 2240 C. civ) : la plus récente
 *   RÉ-ANCRE le délai (b2b/b2c). En b2g, l'interruption (loi 68-1250, art. 2) fait courir un
 *   nouveau délai à compter du 1er janvier suivant : même ré-ancrage, même formule 31/12 de N+4.
 *
 * Aucune date d'ancrage disponible (ni émission ni échéance) → null : on n'invente JAMAIS
 * une échéance de prescription.
 */

export type PrescriptionUrgency = 'lointaine' | 'a_surveiller' | 'urgente' | 'prescrite';

export interface DerivePrescriptionInput {
  issuedAt: DateOnly | null;
  dueAt: DateOnly | null;
  customerType: CustomerType;
  /** Dates de reconnaissance de dette (paiement partiel — art. 2240 C. civ) : la plus récente ré-ancre. */
  acknowledgments: readonly DateOnly[];
  asOf: DateOnly;
}

export interface PrescriptionView {
  /** Dernier jour utile pour agir en justice (après : créance prescrite/déchue). */
  deadline: DateOnly;
  /** Jours restants à `asOf` — négatif si la deadline est dépassée. */
  daysLeft: number;
  urgency: PrescriptionUrgency;
  legalRef: string;
  /** Ancre retenue pour le délai (reconnaissance la plus récente si ré-ancré, sinon ancre du régime). */
  anchor: DateOnly;
  /** Pédagogie du régime — b2g : une réclamation écrite interrompt ; droit privé : jamais. */
  explain: string;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / MS_PER_DAY);
}

/**
 * anchor + n années, en UTC. Un délai en années expire « de quantième à quantième, à défaut le
 * dernier jour du mois » (art. 641 al. 2 CPC) : le 29/02 + n années tombe, l'année cible n'étant
 * pas bissextile, sur le 28/02 — PAS le 01/03. On borne donc le quantième au dernier jour du mois
 * cible (sinon le débordement natif de Date donnerait un jour de plus, au détriment de l'alerte).
 */
function addYears(date: DateOnly, years: number): DateOnly {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)); // 1..12
  const day = Number(date.slice(8, 10));
  const targetYear = y + years;
  // Dernier jour du mois cible : jour 0 du mois suivant (Date.UTC gère le débordement de mois).
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, m, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);
  return new Date(Date.UTC(targetYear, m - 1, clampedDay)).toISOString().slice(0, 10);
}

function minDate(a: DateOnly | null, b: DateOnly | null): DateOnly | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/** Paliers : prescrite (deadline dépassée) · urgente < 90 j · a_surveiller < 365 j · sinon lointaine. */
function urgencyOf(daysLeft: number): PrescriptionUrgency {
  if (daysLeft < 0) return 'prescrite';
  if (daysLeft < 90) return 'urgente';
  if (daysLeft < 365) return 'a_surveiller';
  return 'lointaine';
}

interface Regime {
  baseAnchor: DateOnly | null;
  deadlineFrom: (anchor: DateOnly) => DateOnly;
  legalRef: string;
  explain: string;
}

function regimeOf(input: DerivePrescriptionInput): Regime {
  switch (input.customerType) {
    case 'b2c':
      return {
        // Ancre PRUDENTE : la biennale court de l'achèvement (Cass. 1re civ. 19/5/2021) —
        // sans date d'achèvement en schéma, on retient la plus ancienne date connue.
        baseAnchor: minDate(input.issuedAt, input.dueAt),
        deadlineFrom: (anchor) => addYears(anchor, 2),
        legalRef: 'L218-2 C. conso (prescription biennale)',
        explain:
          "Prescription de 2 ans (consommateur). Seuls une action en justice, une mesure d'execution forcee ou une reconnaissance du debiteur (ex. paiement partiel) interrompent le delai — une relance, meme en recommande, ne l'interrompt PAS (Cass. com. 18/5/2022).",
      };
    case 'b2b':
      return {
        // Exigibilité (échéance) ; à défaut, repli prudent sur l'émission (plus ancienne).
        baseAnchor: input.dueAt ?? input.issuedAt,
        deadlineFrom: (anchor) => addYears(anchor, 5),
        legalRef: 'L110-4 C. com (prescription quinquennale)',
        explain:
          "Prescription de 5 ans entre professionnels. Seuls une action en justice, une mesure d'execution forcee ou une reconnaissance du debiteur (ex. paiement partiel) interrompent le delai — une relance, meme en recommande, ne l'interrompt PAS (Cass. com. 18/5/2022).",
      };
    case 'b2g':
      return {
        // Fait générateur : plus ancienne date connue de la créance (prudent sur l'année N).
        baseAnchor: minDate(input.issuedAt, input.dueAt),
        // Art. 1 loi 68-1250 : déchéance au 31/12 de la 4e année suivant celle du fait générateur.
        // Après interruption (art. 2), nouveau délai à compter du 1/1 suivant : même formule.
        deadlineFrom: (anchor) => `${Number(anchor.slice(0, 4)) + 4}-12-31`,
        legalRef: 'loi 68-1250 (decheance quadriennale)',
        explain:
          "Decheance quadriennale (creance sur une personne publique) : perdue au 31/12 de la 4e annee suivant le fait generateur. Une simple RECLAMATION ECRITE adressee a l'administration interrompt le delai (loi 68-1250, art. 2) — un nouveau delai court a compter du 1er janvier suivant.",
      };
  }
}

/**
 * Dérive l'échéance de prescription d'une facture : ancre du régime (ou reconnaissance la plus
 * récente si postérieure), deadline, jours restants et palier d'urgence. Null si aucune date
 * d'ancrage n'est disponible.
 */
export function derivePrescription(input: DerivePrescriptionInput): PrescriptionView | null {
  const regime = regimeOf(input);
  if (regime.baseAnchor === null) return null;

  // Reconnaissance (art. 2240) : la plus récente, jamais dans le futur, ré-ancre si postérieure.
  const acks = input.acknowledgments.filter((d) => d <= input.asOf);
  const latestAck = acks.length > 0 ? acks.reduce((a, b) => (a > b ? a : b)) : null;
  const anchor = latestAck !== null && latestAck > regime.baseAnchor ? latestAck : regime.baseAnchor;

  const deadline = regime.deadlineFrom(anchor);
  const daysLeft = daysBetween(input.asOf, deadline);
  return {
    deadline,
    daysLeft,
    urgency: urgencyOf(daysLeft),
    legalRef: regime.legalRef,
    anchor,
    explain: regime.explain,
  };
}
