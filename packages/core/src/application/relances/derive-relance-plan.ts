import { type DateOnly, addDays } from '../../shared-kernel/time';
import { buildRelance, type RelanceMessage, type RelanceTone } from '../../domain/services/build-relance';
import {
  deriveTodayPriorities,
  type TodayCustomerData,
  type TodayInvoiceData,
} from '../today/derive-today-priorities';

/**
 * Use case pur « plan de relances » (claim C25 — ferme les TODO ①② de l'audit parité C15).
 * Entrée = factures/clients RÉELS (mêmes projections que deriveTodayPriorities, `paid` = cumul
 * des encaissements) + politique de délais typée ; sortie = une relance PRÊTE par facture échue :
 * ton escaladé selon l'ancienneté (cordial → neutre → ferme → mise en demeure), message généré
 * par le SEUL moteur du domaine (buildRelance — L441-10 + indemnité 40 € au dernier palier),
 * prochaine échéance d'escalade. Aucune I/O, aucun repli fixtures : zéro facture échue = plan vide.
 *
 * RÉUTILISATION (interdiction de dupliquer le moteur) : les candidates viennent de
 * deriveTodayPriorities (statuts encaissables, avoirs/brouillons exclus, reste dû plafonné à
 * netToPay − paid, tri retard puis montant) ; la copy vient de buildRelance (4 tons, 3 humeurs).
 */

// ── Politique de délais (config typée, défauts raisonnables) ──────────────────

export interface RelancePolicy {
  /** J+n après l'échéance : premier rappel cordial. */
  cordialAfterDays: number;
  /** J+n : relance neutre (demande de date de règlement). */
  neutreAfterDays: number;
  /** J+n : relance ferme (dernier rappel avant procédure). */
  fermeAfterDays: number;
  /** J+n : mise en demeure — L441-10 + indemnité 40 € ; jamais envoyée sans validation. */
  miseEnDemeureAfterDays: number;
}

export const DEFAULT_RELANCE_POLICY: RelancePolicy = {
  cordialAfterDays: 3,
  neutreAfterDays: 10,
  fermeAfterDays: 20,
  miseEnDemeureAfterDays: 30,
};

/** Personnalité de la copy (libellés @bob/i18n PERSONALITY_LABELS — buildRelance les attend ainsi). */
export type RelancePersonality = 'Pote' | 'Pro' | 'Direct';

export interface DeriveRelancePlanInput {
  invoices: readonly TodayInvoiceData[];
  customers: readonly TodayCustomerData[];
  today: DateOnly;
  /** Politique de délais — défaut DEFAULT_RELANCE_POLICY (J+3 / J+10 / J+20 / J+30). */
  policy?: RelancePolicy;
  /** Humeur de la copy générée — défaut 'Pote' (aligné sur les hôtes agent existants). */
  personality?: RelancePersonality;
}

// ── Sortie ────────────────────────────────────────────────────────────────────

export interface RelancePlanEntry {
  invoiceId: string;
  customerId: string;
  customerName: string;
  docNumber: string | null;
  /** Reste à encaisser en centimes — plafonné à netToPay (jamais ttc) : netToPay − paid. */
  amountCents: number;
  daysLate: number;
  /** Palier atteint selon la politique ; `cordial` tant que le premier palier n'est pas atteint. */
  tone: RelanceTone;
  /** true = le palier `tone` est dû (relance à envoyer maintenant) ; false = planifiée. */
  dueNow: boolean;
  /** Message prêt à partir (buildRelance — texte légal L441-10 + 40 € au ton mise en demeure). */
  message: RelanceMessage;
  /** Date du prochain palier d'escalade — null une fois la mise en demeure atteinte. */
  nextEscalationAt: DateOnly | null;
}

// ── Règles métier ─────────────────────────────────────────────────────────────

interface EscalationStep {
  tone: RelanceTone;
  afterDays: number;
}

/** Paliers ordonnés par ancienneté croissante (robuste à une politique saisie dans le désordre). */
function escalationSteps(policy: RelancePolicy): EscalationStep[] {
  return (
    [
      { tone: 'cordial', afterDays: policy.cordialAfterDays },
      { tone: 'neutre', afterDays: policy.neutreAfterDays },
      { tone: 'ferme', afterDays: policy.fermeAfterDays },
      { tone: 'miseendemeure', afterDays: policy.miseEnDemeureAfterDays },
    ] as EscalationStep[]
  ).sort((a, b) => a.afterDays - b.afterDays);
}

/**
 * Dérive le plan de relances : une entrée par facture échue, triée comme le briefing
 * (retard le plus long d'abord, puis montant). Les statuts non encaissables (payée, annulée,
 * brouillon), les avoirs et les factures non échues sont exclus par le moteur des candidates.
 */
export function deriveRelancePlan(input: DeriveRelancePlanInput): RelancePlanEntry[] {
  const policy = input.policy ?? DEFAULT_RELANCE_POLICY;
  const personality = input.personality ?? 'Pote';
  const steps = escalationSteps(policy);

  const candidates = deriveTodayPriorities({
    invoices: input.invoices,
    quotes: [],
    customers: input.customers,
    today: input.today,
  });

  const plan: RelancePlanEntry[] = [];
  for (const candidate of candidates) {
    if (candidate.kind !== 'relance') continue;
    const reached = [...steps].reverse().find((s) => s.afterDays <= candidate.daysLate);
    const next = steps.find((s) => s.afterDays > candidate.daysLate);
    const tone = reached?.tone ?? steps[0]?.tone ?? 'cordial';
    plan.push({
      invoiceId: candidate.invoiceId,
      customerId: candidate.customerId,
      customerName: candidate.customerName,
      docNumber: candidate.docNumber,
      amountCents: candidate.amountCents,
      daysLate: candidate.daysLate,
      tone,
      dueNow: reached !== undefined,
      message: buildRelance({
        customerName: candidate.customerName || 'le client',
        docNumber: candidate.docNumber ?? candidate.invoiceId,
        amountCents: candidate.amountCents,
        daysLate: candidate.daysLate,
        tone,
        personality,
      }),
      // Le prochain palier se compte depuis l'échéance : dans (palier − retard actuel) jours.
      nextEscalationAt: next ? addDays(input.today, next.afterDays - candidate.daysLate) : null,
    });
  }
  return plan;
}

// ── Échéances proches (notifications C25 — « ça arrive, rien à faire encore ») ──

/** Statuts encore encaissables — aligné sur deriveTodayPriorities (C10). */
const COLLECTIBLE = new Set(['issued', 'partially_paid', 'late']);

const MS_PER_DAY = 86_400_000;

function daysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / MS_PER_DAY);
}

export interface UpcomingDueEntry {
  invoiceId: string;
  customerId: string;
  customerName: string;
  docNumber: string | null;
  /** Reste à encaisser en centimes (netToPay − paid). */
  amountCents: number;
  dueAt: DateOnly;
  /** Jours restants avant l'échéance (0 = échue aujourd'hui, pas encore en retard). */
  inDays: number;
}

export interface DeriveUpcomingDuesInput {
  invoices: readonly TodayInvoiceData[];
  customers: readonly TodayCustomerData[];
  today: DateOnly;
  /** Fenêtre d'alerte en jours — défaut 7. */
  windowDays?: number;
}

/**
 * Factures encaissables dont l'échéance tombe dans la fenêtre [aujourd'hui, +windowDays] —
 * complément du plan de relances (jamais de recouvrement : une facture échue est dans le plan,
 * pas ici). Tri : échéance la plus proche d'abord, puis montant.
 */
export function deriveUpcomingDues(input: DeriveUpcomingDuesInput): UpcomingDueEntry[] {
  const windowDays = input.windowDays ?? 7;
  const names = new Map(input.customers.map((c) => [c.id, c.name]));
  const upcoming: UpcomingDueEntry[] = [];
  for (const invoice of input.invoices) {
    if (invoice.kind === 'credit_note') continue;
    if (!COLLECTIBLE.has(invoice.status)) continue;
    if (invoice.dueAt === null) continue;
    // Échue (statut late posé par le backend, ou date dépassée) → plan de relances, pas ici.
    if (invoice.status === 'late' || invoice.dueAt < input.today) continue;
    const remaining = invoice.totals.netToPay - invoice.paid;
    if (remaining <= 0) continue;
    const inDays = daysBetween(input.today, invoice.dueAt);
    if (inDays > windowDays) continue;
    upcoming.push({
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      customerName: names.get(invoice.customerId) ?? '',
      docNumber: invoice.number,
      amountCents: remaining,
      dueAt: invoice.dueAt,
      inDays,
    });
  }
  return upcoming.sort((a, b) => a.inDays - b.inDays || b.amountCents - a.amountCents);
}
