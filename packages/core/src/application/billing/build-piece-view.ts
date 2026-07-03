import { type Totals } from '../../domain/billing/shared/totals';
import { type QuoteLine } from '../../domain/billing/shared/line';
import { type LineCategory } from '../../domain/billing/shared/line-item';
import { type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { type InvoiceStatus, type QuoteStatus } from '../../domain/billing/shared/state-machines';
import { einvoiceChannelFor, type EinvoiceChannel } from '../../domain/services/einvoice-for';

/**
 * Use case pur « détail pièce » (claim C16) : projections RÉELLES (InvoiceView/QuoteView/
 * CustomerListItem tels que servis par l'api-client) → vue paramétrée par kind, prête pour
 * l'écran ET pour Bob (parité d'actions : mêmes dérivations, mêmes règles).
 * Doctrine billing : tout « reste à encaisser » est plafonné à netToPay (jamais ttc).
 */

// ── Entrées (projections minimales, structurellement compatibles api-client) ──

export interface PieceInvoiceData {
  id: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  number: string | null;
  parentQuoteId: string | null;
  totals: Totals;
  paid: number;
  mentions: readonly string[];
  dueAt: string | null;
  lines: readonly QuoteLine[];
  customerId: string;
  /** Acompte déjà facturé déduit (A2-C16) — 0/null si aucun. */
  depositDeductionCents?: number;
  depositInvoiceId?: string | null;
}

export interface PieceQuoteData {
  id: string;
  status: QuoteStatus;
  number: string | null;
  depositPct: number | null;
  totals: Totals;
  lines: readonly QuoteLine[];
  signed: boolean;
  customerId: string;
}

export interface PieceCustomerData {
  id: string;
  name: string;
  type: 'b2c' | 'b2b' | 'b2g';
  siren: string | null;
}

/** Référence croisée légère (devis parent, avoir émis, situation liée). */
export interface PieceLinkedRef {
  id: string;
  number: string | null;
  /** TTC en centimes — sert au % d'avancement d'une situation, au montant de l'avoir. */
  ttcCents?: number;
}

export type BuildPieceViewInput =
  | {
      source: 'invoice';
      invoice: PieceInvoiceData;
      customer: PieceCustomerData | null;
      parentQuote?: PieceLinkedRef;
      creditNote?: PieceLinkedRef;
      situation?: PieceLinkedRef;
      /** Facture d'acompte du même devis (nav croisée + libellé de la déduction). */
      depositInvoice?: PieceLinkedRef;
      /** Une facture FINALE existe déjà sur le même devis (le pont « créer la finale » se tait). */
      hasFinalInvoice?: boolean;
    }
  | { source: 'quote'; quote: PieceQuoteData; customer: PieceCustomerData | null; finalInvoice?: PieceLinkedRef };

// ── Sortie ──

export type PieceKind = 'devis' | 'facture' | 'acompte' | 'avoir' | 'situation';
export type PieceTone = 'warning' | 'b2b' | 'success' | 'danger';

export interface PieceLineView {
  id: string;
  label: string;
  category: LineCategory;
  qty: number;
  unit: string | null;
  unitPriceHTCents: number;
  vatRatePct: number;
  totalHTCents: number;
}

export type PieceTransmissionStepState = 'done' | 'current' | 'todo';
export interface PieceTransmissionStep {
  key: 'emise' | 'transmise' | 'recue' | 'acceptee' | 'payee';
  state: PieceTransmissionStepState;
}

export type PiecePrimaryAction = 'envoyer' | 'relancer' | 'facturer' | 'encaisser' | 'emettre' | null;

export interface PieceView {
  kind: PieceKind;
  number: string | null;
  status: { key: InvoiceStatus | QuoteStatus; tone: PieceTone };
  customerName: string;
  customerType: PieceCustomerData['type'] | null;
  /** SIREN formaté pour b2b/b2g — NULL pour un particulier (rien d'affiché, RGPD-friendly). */
  partyLine: string | null;
  lines: readonly PieceLineView[];
  totals: Totals;
  /** Devis avec acompte : « Acompte {pct} % à la commande : {amount} » (= netToPay du devis). */
  deposit: { pct: number; amountCents: number } | null;
  /** Facture encaissable : suivi réel — remaining plafonné netToPay − paid. */
  suivi: { paidCents: number; remainingCents: number; isPaid: boolean } | null;
  /** Avoir : montant SIGNÉ négatif (affichage « −488,40 € »). */
  signedAmountCents: number;
  /**
   * LE montant de la pièce (héros) = netToPay : pour un acompte/situation il est INFÉRIEUR
   * au TTC du chantier — l'écran doit afficher « Net à payer » et non « Total TTC »
   * (A1-C16 : une facture d'acompte de 488,40 € ne titre pas 1 628,00 €).
   */
  amountDue: { cents: number; isPartialOfTtc: boolean };
  /**
   * Pont réel vers la suite du chantier : acompte PAYÉ sans facture finale existante →
   * « Créer la facture finale » avec le reste à facturer EXACT (ttc chantier − acompte).
   */
  nextStep: { kind: 'facture_finale'; quoteId: string; remainingToInvoiceCents: number } | null;
  /** Frise e-facture (b2b/b2g émise+) — null pour B2C (encart e-reporting) et brouillons. */
  transmission: { channel: EinvoiceChannel; steps: readonly PieceTransmissionStep[] } | null;
  /** B2C : la donnée part en e-reporting (pas de PDP). */
  isEreporting: boolean;
  /** % d'avancement d'une situation (ttc situation / ttc devis parent) — null si inconnu. */
  situationProgressPct: number | null;
  mentions: readonly string[];
  /** Mentions figées à l'émission (facture non brouillon). */
  frozen: boolean;
  /** Facture finale : acompte déjà facturé, affiché en déduction avant le net à payer. */
  depositDeduction: { amountCents: number; invoiceRef: PieceLinkedRef | null } | null;
  /** Pièces liées à afficher en nav croisée. */
  linkedQuote: PieceLinkedRef | null;
  linkedInvoice: PieceLinkedRef | null;
  creditNote: PieceLinkedRef | null;
  situation: PieceLinkedRef | null;
  primaryAction: PiecePrimaryAction;
}

// ── Règles ──

const INVOICE_KIND: Record<InvoiceKind, PieceKind> = {
  final: 'facture',
  deposit: 'acompte',
  credit_note: 'avoir',
  situation: 'situation',
};

const INVOICE_TONE: Record<InvoiceStatus, PieceTone> = {
  draft: 'warning',
  issued: 'b2b',
  partially_paid: 'warning',
  paid: 'success',
  late: 'danger',
  cancelled: 'danger',
};

const QUOTE_TONE: Record<QuoteStatus, PieceTone> = {
  draft: 'warning',
  sent: 'b2b',
  viewed: 'b2b',
  signed: 'success',
  refused: 'danger',
  expired: 'danger',
};

/** SIREN lisible : 821503642 → « SIREN 821 503 642 ». */
export function formatSiren(siren: string): string {
  const v = siren.replace(/\s/g, '');
  return `SIREN ${v.slice(0, 3)} ${v.slice(3, 6)} ${v.slice(6, 9)}`;
}

/** partyLine adaptatif (C13/C16) : personne morale → SIREN ; particulier → RIEN. */
export function buildPartyLine(customer: PieceCustomerData | null): string | null {
  if (!customer || customer.type === 'b2c') return null;
  return customer.siren ? formatSiren(customer.siren) : null;
}

function toLineViews(lines: readonly QuoteLine[]): PieceLineView[] {
  return lines.map((l) => ({
    id: l.id,
    label: l.label,
    category: l.category,
    qty: l.qty,
    unit: l.unit ?? null,
    unitPriceHTCents: l.unitPriceHT,
    vatRatePct: l.vatRate,
    totalHTCents: Math.round(l.qty * l.unitPriceHT),
  }));
}

const TRANSMISSION_KEYS = ['emise', 'transmise', 'recue', 'acceptee', 'payee'] as const;

/** Rang atteint dans le cycle PDP/Chorus selon le statut RÉEL de la facture (pas d'invention :
 *  sans agrégat de transmission branché, « émise » est acquise, « transmise » est en cours). */
function transmissionRank(status: InvoiceStatus): number {
  if (status === 'paid') return TRANSMISSION_KEYS.length; // tout est acquis
  if (status === 'issued' || status === 'partially_paid' || status === 'late') return 1;
  return 0;
}

export function buildTransmissionSteps(status: InvoiceStatus): PieceTransmissionStep[] {
  const rank = transmissionRank(status);
  return TRANSMISSION_KEYS.map((key, i) => ({
    key,
    state: i < rank ? 'done' : i === rank && rank < TRANSMISSION_KEYS.length ? 'current' : rank >= TRANSMISSION_KEYS.length ? 'done' : 'todo',
  }));
}

function invoicePrimaryAction(invoice: PieceInvoiceData): PiecePrimaryAction {
  if (invoice.kind === 'credit_note') return null;
  switch (invoice.status) {
    case 'draft':
      return 'emettre';
    case 'issued':
    case 'partially_paid':
      return 'encaisser';
    case 'late':
      return 'relancer';
    default:
      return null;
  }
}

function quotePrimaryAction(quote: PieceQuoteData): PiecePrimaryAction {
  switch (quote.status) {
    case 'draft':
      return 'envoyer';
    case 'sent':
    case 'viewed':
      return 'relancer';
    case 'signed':
      return 'facturer';
    default:
      return null;
  }
}

export function buildPieceView(input: BuildPieceViewInput): PieceView {
  const customer = input.customer;
  const partyLine = buildPartyLine(customer);
  const customerName = customer?.name ?? '';
  const customerType = customer?.type ?? null;

  if (input.source === 'quote') {
    const q = input.quote;
    return {
      kind: 'devis',
      number: q.number,
      status: { key: q.status, tone: QUOTE_TONE[q.status] },
      customerName,
      customerType,
      partyLine,
      lines: toLineViews(q.lines),
      totals: q.totals,
      // Le domaine calcule netToPay = acompte quand depositPct est posé (test d'or 488,40).
      deposit: q.depositPct !== null && q.depositPct > 0 ? { pct: q.depositPct, amountCents: q.totals.netToPay } : null,
      suivi: null,
      signedAmountCents: q.totals.ttc,
      amountDue: { cents: q.totals.ttc, isPartialOfTtc: false },
      nextStep: null,
      depositDeduction: null,
      transmission: null,
      isEreporting: false,
      situationProgressPct: null,
      mentions: [],
      frozen: false,
      linkedQuote: null,
      linkedInvoice: input.finalInvoice ?? null,
      creditNote: null,
      situation: null,
      primaryAction: quotePrimaryAction(q),
    };
  }

  const inv = input.invoice;
  const kind = INVOICE_KIND[inv.kind];
  const isCredit = inv.kind === 'credit_note';
  const collectable = !isCredit && inv.status !== 'draft' && inv.status !== 'cancelled';
  const remaining = Math.max(0, inv.totals.netToPay - inv.paid);
  const channel = customer ? einvoiceChannelFor(customer.type) : null;
  const emitted = inv.status !== 'draft';

  const isPartialOfTtc = !isCredit && inv.totals.netToPay < inv.totals.ttc;
  const parentTtc = input.parentQuote?.ttcCents;
  const nextStep =
    inv.kind === 'deposit' &&
    inv.status === 'paid' &&
    input.hasFinalInvoice !== true &&
    inv.parentQuoteId !== null &&
    parentTtc !== undefined &&
    parentTtc > inv.totals.netToPay
      ? {
          kind: 'facture_finale' as const,
          quoteId: inv.parentQuoteId,
          remainingToInvoiceCents: parentTtc - inv.totals.netToPay,
        }
      : null;

  const progress =
    inv.kind === 'situation' && input.parentQuote?.ttcCents !== undefined && input.parentQuote.ttcCents > 0
      ? Math.min(100, Math.round((inv.totals.ttc / input.parentQuote.ttcCents) * 100))
      : null;

  return {
    kind,
    number: inv.number,
    status: { key: inv.status, tone: INVOICE_TONE[inv.status] },
    customerName,
    customerType,
    partyLine,
    lines: toLineViews(inv.lines),
    totals: inv.totals,
    deposit: null,
    suivi: collectable
      ? { paidCents: inv.paid, remainingCents: remaining, isPaid: inv.status === 'paid' || remaining === 0 }
      : null,
    signedAmountCents: isCredit ? -Math.abs(inv.totals.ttc) : inv.totals.ttc,
    amountDue: { cents: inv.totals.netToPay, isPartialOfTtc },
    nextStep,
    depositDeduction:
      (inv.depositDeductionCents ?? 0) > 0
        ? { amountCents: inv.depositDeductionCents ?? 0, invoiceRef: input.depositInvoice ?? null }
        : null,
    transmission:
      emitted && !isCredit && channel !== null && channel !== 'ereporting'
        ? { channel, steps: buildTransmissionSteps(inv.status) }
        : null,
    isEreporting: emitted && !isCredit && channel === 'ereporting',
    situationProgressPct: progress,
    mentions: inv.mentions,
    frozen: emitted,
    linkedQuote: input.parentQuote ?? null,
    linkedInvoice: null,
    creditNote: input.creditNote ?? null,
    situation: input.situation ?? null,
    primaryAction: invoicePrimaryAction(inv),
  };
}
