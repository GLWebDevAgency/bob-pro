import { AggregateRoot } from '../../../shared-kernel/aggregate';
import { type DomainResult, ok, err } from '../../../shared-kernel/result';
import { type Instant, type DateOnly } from '../../../shared-kernel/time';
import { Percentage } from '../../../shared-kernel/percentage';
import { type PaymentTerms } from '../../../shared-kernel/payment-terms';
import { DocNumber } from '../shared/doc-number';
import { type QuoteLine } from '../shared/line';
import { type Totals } from '../shared/totals';
import { isVatRate } from '../shared/vat-rate';
import { Quantity } from '../shared/quantity';
import { computeTotals } from '../../services/compute-totals';
import { assertTransition, type InvoiceStatus, INVOICE_TRANSITIONS } from '../shared/state-machines';
import { type Quote } from '../quote/quote';

export type InvoiceKind = 'final' | 'deposit' | 'credit_note' | 'situation';

export interface IssueInvoiceArgs {
  mentions: string[];
  terms: PaymentTerms;
  issuedAt: DateOnly;
  at: Instant;
}

/**
 * Agrégat Invoice — cycle commercial de la facture.
 * Numéro immuable assigné à la 1re sortie de draft ; totaux + mentions FIGÉS à l'émission.
 */
export class Invoice extends AggregateRoot<string> {
  private _status: InvoiceStatus = 'draft';
  private _lines: QuoteLine[] = [];
  private _depositDeductionCents = 0;
  private _depositInvoiceId: string | null = null;
  private _number: DocNumber | null = null;
  private _frozenTotals: Totals | null = null;
  private _mentions: string[] = [];
  private _issuedAt: DateOnly | null = null;
  private _dueAt: DateOnly | null = null;
  private _paid = 0; // centimes cumulés
  private _cancelReason: string | null = null;

  private constructor(
    id: string,
    readonly companyId: string,
    readonly customerId: string,
    readonly kind: InvoiceKind,
    private readonly _depositPct: Percentage | null,
    readonly parentQuoteId: string | null,
  ) {
    super(id);
  }

  static fromSignedQuote(
    quote: Quote,
    mode: 'deposit' | 'final',
    id: string,
    opts?: {
      /** DÉJÀ FACTURÉ sur ce devis (acompte, situations émises) : la finale le déduit —
       *  jamais de double facturation. invoiceId = la pièce source si UNIQUE, null si la
       *  déduction est composite (acompte + situations, A5). */
      depositDeduction?: { amountCents: number; invoiceId: string | null };
    },
  ): DomainResult<Invoice> {
    if (quote.status !== 'signed')
      return err({ code: 'VALIDATION', field: 'quote', message: 'Le devis doit etre signe.' });
    let dep: Percentage | null = null;
    if (mode === 'deposit' && quote.depositPct !== null) {
      const p = Percentage.of(quote.depositPct);
      if (!p.ok) return p;
      dep = p.value;
    }
    const kind: InvoiceKind = mode === 'deposit' ? 'deposit' : 'final';
    const inv = new Invoice(id, quote.companyId, quote.customerId, kind, dep, quote.id);
    for (const l of quote.lines) inv._lines.push({ ...l });
    if (mode === 'final' && opts?.depositDeduction) {
      const { amountCents, invoiceId } = opts.depositDeduction;
      if (!Number.isSafeInteger(amountCents) || amountCents < 0)
        return err({ code: 'VALIDATION', field: 'depositDeduction', message: 'Déduction d’acompte invalide (centimes entiers ≥ 0 requis).' });
      const ttc = inv.totals().ttc;
      if (amountCents > ttc)
        return err({ code: 'VALIDATION', field: 'depositDeduction', message: 'Déduction d’acompte supérieure au TTC du chantier.' });
      inv._depositDeductionCents = amountCents;
      inv._depositInvoiceId = invoiceId;
    }
    return ok(inv);
  }

  static composeStandalone(input: { id: string; companyId: string; customerId: string }): DomainResult<Invoice> {
    return ok(new Invoice(input.id, input.companyId, input.customerId, 'final', null, null));
  }

  get status(): InvoiceStatus {
    return this._status;
  }
  get lines(): readonly QuoteLine[] {
    return this._lines;
  }
  get number(): string | null {
    return this._number?.value ?? null;
  }
  get mentions(): readonly string[] {
    return this._mentions;
  }
  get issuedAt(): DateOnly | null {
    return this._issuedAt;
  }
  get dueAt(): DateOnly | null {
    return this._dueAt;
  }
  get paid(): number {
    return this._paid;
  }
  /** Acompte déjà facturé, déduit du net à payer de la finale (0 = aucun). */
  get depositDeductionCents(): number {
    return this._depositDeductionCents;
  }
  /** Facture d'acompte déduite (traçabilité + nav croisée). */
  get depositInvoiceId(): string | null {
    return this._depositInvoiceId;
  }

  addLine(line: QuoteLine): DomainResult<void> {
    if (this._status !== 'draft')
      return err({ code: 'INVALID_TRANSITION', from: this._status, to: 'draft' });
    const q = Quantity.of(line.qty);
    if (!q.ok) return q;
    if (!isVatRate(line.vatRate))
      return err({ code: 'VALIDATION', field: 'vatRate', message: 'Taux TVA non autorise.' });
    this._lines.push(line);
    return ok(undefined);
  }

  totals(): Totals {
    if (this._frozenTotals) return this._frozenTotals;
    const base = computeTotals([...this._lines], this._depositPct ? { depositPct: this._depositPct.value } : undefined);
    if (this._depositDeductionCents > 0) {
      // Facture finale après acompte : le net à payer est LE SOLDE (ttc − acompte facturé).
      return { ...base, netToPay: Math.max(0, base.ttc - this._depositDeductionCents) };
    }
    return base;
  }

  assignNumber(n: DocNumber, at: Instant): DomainResult<void> {
    if (this._number) return err({ code: 'VALIDATION', field: 'number', message: 'Numero deja attribue.' });
    this._number = n;
    this.record({ type: 'DocumentNumbered', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  issue(args: IssueInvoiceArgs): DomainResult<void> {
    const t = assertTransition(INVOICE_TRANSITIONS, this._status, 'issued');
    if (!t.ok) return t;
    if (!this._number) return err({ code: 'VALIDATION', field: 'number', message: 'Numero requis avant emission.' });
    if (this._lines.length === 0)
      return err({ code: 'VALIDATION', field: 'lines', message: 'Au moins une ligne requise.' });
    this._frozenTotals = this.totals();
    this._mentions = [...args.mentions];
    this._issuedAt = args.issuedAt;
    this._dueAt = args.terms.dueDateFrom(args.issuedAt);
    this._status = 'issued';
    this.record({ type: 'InvoiceIssued', occurredAt: args.at, version: 1 });
    return ok(undefined);
  }

  registerPayment(amountCents: number, at: Instant): DomainResult<void> {
    if (this._status !== 'issued' && this._status !== 'partially_paid' && this._status !== 'late')
      return err({ code: 'INVALID_TRANSITION', from: this._status, to: 'partially_paid' });
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0)
      return err({ code: 'VALIDATION', field: 'amount', message: 'Montant > 0 requis en centimes entiers.' });
    const due = (this._frozenTotals ?? this.totals()).netToPay;
    const remaining = due - this._paid;
    // Pas de trop-perçu silencieux : un paiement supérieur au reste dû est rejeté (avoir/remboursement = flux dédié).
    if (amountCents > remaining)
      return err({ code: 'VALIDATION', field: 'amount', message: `Paiement supérieur au reste dû (${remaining} c).` });
    this._paid += amountCents;
    if (this._paid >= due) {
      this._status = 'paid';
      this.record({ type: 'PaymentReceived', occurredAt: at, version: 1 });
    } else {
      this._status = 'partially_paid';
      this.record({ type: 'InvoicePartiallyPaid', occurredAt: at, version: 1 });
    }
    return ok(undefined);
  }

  markLate(at: Instant): DomainResult<void> {
    const t = assertTransition(INVOICE_TRANSITIONS, this._status, 'late');
    if (!t.ok) return t;
    this._status = 'late';
    this.record({ type: 'InvoiceLate', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  cancel(reason: string, at: Instant): DomainResult<void> {
    const t = assertTransition(INVOICE_TRANSITIONS, this._status, 'cancelled');
    if (!t.ok) return t;
    this._status = 'cancelled';
    this._cancelReason = reason;
    this.record({ type: 'InvoiceCancelled', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  // ——— Persistance ———
  toSnapshot(): InvoiceSnapshot {
    return {
      id: this.id,
      companyId: this.companyId,
      customerId: this.customerId,
      kind: this.kind,
      status: this._status,
      lines: this._lines.map((l) => ({ ...l })),
      number: this._number?.value ?? null,
      frozenTotals: this._frozenTotals,
      mentions: [...this._mentions],
      issuedAt: this._issuedAt,
      dueAt: this._dueAt,
      paid: this._paid,
      depositPct: this._depositPct?.value ?? null,
      parentQuoteId: this.parentQuoteId,
      depositDeductionCents: this._depositDeductionCents,
      depositInvoiceId: this._depositInvoiceId,
    };
  }

  static rehydrate(s: InvoiceSnapshot): Invoice {
    let dep: Percentage | null = null;
    if (s.depositPct !== null) {
      const p = Percentage.of(s.depositPct);
      if (p.ok) dep = p.value;
    }
    const inv = new Invoice(s.id, s.companyId, s.customerId, s.kind, dep, s.parentQuoteId);
    inv._status = s.status;
    inv._lines = s.lines.map((l) => ({ ...l }));
    if (s.number) {
      const n = DocNumber.of(s.number);
      if (n.ok) inv._number = n.value;
    }
    inv._frozenTotals = s.frozenTotals;
    inv._mentions = [...s.mentions];
    inv._issuedAt = s.issuedAt;
    inv._dueAt = s.dueAt;
    inv._paid = s.paid;
    inv._depositDeductionCents = s.depositDeductionCents ?? 0;
    inv._depositInvoiceId = s.depositInvoiceId ?? null;
    return inv;
  }
}

export interface InvoiceSnapshot {
  id: string;
  companyId: string;
  customerId: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  lines: QuoteLine[];
  number: string | null;
  frozenTotals: Totals | null;
  mentions: string[];
  issuedAt: DateOnly | null;
  dueAt: DateOnly | null;
  paid: number;
  depositPct: number | null;
  parentQuoteId: string | null;
  /** Acompte déjà facturé déduit de la finale — optionnels : snapshots antérieurs compatibles. */
  depositDeductionCents?: number;
  depositInvoiceId?: string | null;
}
