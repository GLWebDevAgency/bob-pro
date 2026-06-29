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

  static fromSignedQuote(quote: Quote, mode: 'deposit' | 'final', id: string): DomainResult<Invoice> {
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
    return computeTotals([...this._lines], this._depositPct ? { depositPct: this._depositPct.value } : undefined);
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
    if (amountCents <= 0) return err({ code: 'VALIDATION', field: 'amount', message: 'Montant > 0 requis.' });
    this._paid += amountCents;
    const due = (this._frozenTotals ?? this.totals()).netToPay;
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
}
