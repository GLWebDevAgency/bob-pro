import { type DateOnly, addDays } from '../../shared-kernel/time';
import { buildRelance, type RelanceMessage, type RelanceTone } from '../../domain/services/build-relance';
import { type CustomerType } from '../../domain/customer/customer';
import { computeLatePenalties, type LatePenalties } from '../../domain/dunning/late-penalties';
import { derivePrescription, type PrescriptionView } from '../../domain/dunning/prescription';
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
 * par le SEUL moteur du domaine (buildRelance — mise en demeure au RÉGIME du type de client,
 * P01 C-EXP1 : b2b = L441-10 + 40 €, b2c = code civil/taux légal sans 40 €, b2g = CCP BCE+8 + 40 €),
 * prochaine échéance d'escalade. Aucune I/O, aucun repli fixtures : zéro facture échue = plan vide.
 *
 * RÉUTILISATION (interdiction de dupliquer le moteur) : les candidates viennent de
 * deriveTodayPriorities (statuts encaissables, avoirs/brouillons exclus, reste dû plafonné à
 * netToPay − paid, tri retard puis montant) ; la copy vient de buildRelance (4 tons, 3 humeurs).
 *
 * C-EXP2 vA (champs ADDITIFS) : chaque facture échue porte ses pénalités de retard chiffrées
 * (computeLatePenalties — P12) et son chrono de prescription (derivePrescription — P04) ; la
 * mise en demeure B2B/B2G devient CHIFFRÉE. Données optionnelles manquantes (échéance, émission,
 * paiements datés) → null / montants à 0, jamais d'invention.
 */

// ── Politique de délais (config typée, défauts raisonnables) ──────────────────

export interface RelancePolicy {
  /** J+n après l'échéance : premier rappel cordial. */
  cordialAfterDays: number;
  /** J+n : relance neutre (demande de date de règlement). */
  neutreAfterDays: number;
  /** J+n : relance ferme (dernier rappel avant procédure). */
  fermeAfterDays: number;
  /** J+n : mise en demeure — régime légal selon le type de client ; jamais envoyée sans validation. */
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

/**
 * Client du plan de relances : la projection « Aujourd'hui » (id, name) + le TYPE — il pilote le
 * régime juridique de la mise en demeure (P01). CustomerListItem (api-client) le porte déjà :
 * les appelants existants restent compatibles structurellement.
 */
export interface RelanceCustomerData extends TodayCustomerData {
  type: CustomerType;
}

/** Encaissement daté (socle E3 — PaymentView de l'api-client) : matière des reconnaissances P04. */
export interface RelancePaymentData {
  /** Date d'encaissement — DateOnly ou ISO complet, seul le jour compte. */
  receivedAt: string;
  amountCents: number;
}

/**
 * Facture du plan de relances : la projection « Aujourd'hui » ÉTENDUE de façon OPTIONNELLE par
 * les dates du socle E3 (C-EXP2 vA) — pas de donnée → pas de chiffre, jamais d'invention :
 * · issuedAt (InvoiceView.issuedAt) ancre la prescription P04 ;
 * · payments (listPayments datés) : un paiement partiel = reconnaissance art. 2240 → ré-ancre.
 * Les appelants existants (TodayInvoiceData nu) restent compatibles structurellement.
 */
export interface RelanceInvoiceData extends TodayInvoiceData {
  issuedAt?: DateOnly | null;
  payments?: readonly RelancePaymentData[];
}

export interface DeriveRelancePlanInput {
  invoices: readonly RelanceInvoiceData[];
  customers: readonly RelanceCustomerData[];
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
  /** Message prêt à partir (buildRelance — mise en demeure au régime légal du type de client). */
  message: RelanceMessage;
  /**
   * Message automatique immuable pour ce palier. `daysLate` y est ancré au seuil de la
   * politique (J+3/J+10/J+20), afin qu'un cron relancé le lendemain conserve exactement le
   * même payload sous la même clé de déduplication. `message` garde, lui, le retard réel pour
   * une relance manuelle explicitement validée.
   */
  automaticMessage: RelanceMessage;
  /** Date du prochain palier d'escalade — null une fois la mise en demeure atteinte. */
  nextEscalationAt: DateOnly | null;
  /**
   * Pénalités de retard chiffrées au jour du plan (P12, C-EXP2 vA) — null si l'échéance manque.
   * b2c sans mise en demeure envoyée : montants à 0 (rien ne court de plein droit).
   */
  penalties: LatePenalties | null;
  /** Chrono de prescription (P04) — null si aucune date d'ancrage (ni émission ni échéance). */
  prescription: PrescriptionView | null;
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
  const typeById = new Map(input.customers.map((c) => [c.id, c.type]));
  const invoiceById = new Map(input.invoices.map((i) => [i.id, i]));

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
    // Sans client autoritatif, aucune qualification juridique ni relance ne peut être produite.
    // Supposer B2C serait prudent sur les pénalités, mais fabriquerait tout de même une donnée.
    const customerType = typeById.get(candidate.customerId);
    if (customerType === undefined) continue;
    const invoice = invoiceById.get(candidate.invoiceId);

    // P12 — pénalités chiffrées sur le RESTE DÛ (netToPay − paid) : échéance manquante → null
    // (jamais d'invention). b2c : aucune date de MED connue du plan → montants à 0 de plein droit.
    const penalties =
      invoice !== undefined && invoice.dueAt !== null
        ? computeLatePenalties({
            ttcCents: candidate.amountCents,
            dueAt: invoice.dueAt,
            asOf: input.today,
            customerType,
          })
        : null;

    // P04 — chrono de prescription : les paiements datés (socle E3) valent reconnaissance
    // art. 2240 et ré-ancrent ; sans aucune date d'ancrage, derivePrescription rend null.
    const prescription =
      invoice !== undefined
        ? derivePrescription({
            issuedAt: invoice.issuedAt ?? null,
            dueAt: invoice.dueAt,
            customerType,
            acknowledgments: (invoice.payments ?? [])
              .filter((p) => p.amountCents > 0)
              .map((p) => p.receivedAt.slice(0, 10)),
            asOf: input.today,
          })
        : null;

    const messageInput = {
      customerName: candidate.customerName,
      docNumber: candidate.docNumber ?? candidate.invoiceId,
      amountCents: candidate.amountCents,
      tone,
      personality,
      customerType,
      // MED chiffrée (P12) : buildRelance n'énonce les montants que pour b2b/b2g.
      ...(tone === 'miseendemeure' && penalties !== null
        ? {
            penalties: {
              interestCents: penalties.interestCents,
              fixedIndemnityCents: penalties.fixedIndemnityCents,
            },
          }
        : {}),
    };

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
        ...messageInput,
        daysLate: candidate.daysLate,
      }),
      automaticMessage: buildRelance({
        ...messageInput,
        daysLate: reached?.afterDays ?? candidate.daysLate,
      }),
      // Le prochain palier se compte depuis l'échéance : dans (palier − retard actuel) jours.
      nextEscalationAt: next ? addDays(input.today, next.afterDays - candidate.daysLate) : null,
      penalties,
      prescription,
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
    const customerName = names.get(invoice.customerId);
    if (customerName === undefined) continue;
    const inDays = daysBetween(input.today, invoice.dueAt);
    if (inDays > windowDays) continue;
    upcoming.push({
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      customerName,
      docNumber: invoice.number,
      amountCents: remaining,
      dueAt: invoice.dueAt,
      inDays,
    });
  }
  return upcoming.sort((a, b) => a.inDays - b.inDays || b.amountCents - a.amountCents);
}
