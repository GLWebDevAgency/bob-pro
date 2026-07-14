import { AggregateRoot } from '../../../shared-kernel/aggregate';
import { type DomainResult, ok, err } from '../../../shared-kernel/result';
import { type Instant, type DateOnly } from '../../../shared-kernel/time';
import { Percentage } from '../../../shared-kernel/percentage';
import { DocNumber } from '../shared/doc-number';
import { type QuoteLine } from '../shared/line';
import { type LineInput } from '../shared/line-item';
import { type Totals } from '../shared/totals';
import { type Signature } from '../shared/signature';
import { isVatRate } from '../shared/vat-rate';
import { Quantity } from '../shared/quantity';
import { computeTotals } from '../../services/compute-totals';
import { assertTransition, type QuoteStatus, QUOTE_TRANSITIONS } from '../shared/state-machines';

export interface ComposeQuoteInput {
  id: string;
  companyId: string;
  customerId: string;
  at: Instant;
  validUntil?: DateOnly;
}

/**
 * Agrégat Quote — cycle commercial du devis (draft -> sent -> viewed -> signed/refused/expired).
 * Invariants structurels uniquement : édition en draft, taux valide, numéro immuable, transitions légales.
 * Les règles cross-agrégat (franchise/autoliquidation) sont appliquées par le use case via suggestVatRate.
 */
export class Quote extends AggregateRoot<string> {
  private _status: QuoteStatus = 'draft';
  private _lines: QuoteLine[] = [];
  private _number: DocNumber | null = null;
  private _depositPct: Percentage | null = null;
  private _signature: Signature | null = null;

  private constructor(
    id: string,
    readonly companyId: string,
    readonly customerId: string,
    private readonly _validUntil: DateOnly | null,
  ) {
    super(id);
  }

  static compose(input: ComposeQuoteInput): DomainResult<Quote> {
    const q = new Quote(input.id, input.companyId, input.customerId, input.validUntil ?? null);
    q.record({ type: 'QuoteComposed', occurredAt: input.at, version: 1 });
    return ok(q);
  }

  get status(): QuoteStatus {
    return this._status;
  }
  get lines(): readonly QuoteLine[] {
    return this._lines;
  }
  get number(): string | null {
    return this._number?.value ?? null;
  }
  get depositPct(): number | null {
    return this._depositPct?.value ?? null;
  }
  get validUntil(): DateOnly | null {
    return this._validUntil;
  }
  get signature(): Signature | null {
    return this._signature;
  }

  private assertDraft(): DomainResult<void> {
    if (this._status !== 'draft') return err({ code: 'INVALID_TRANSITION', from: this._status, to: 'draft' });
    return ok(undefined);
  }

  addLine(line: QuoteLine): DomainResult<void> {
    const d = this.assertDraft();
    if (!d.ok) return d;
    const q = Quantity.of(line.qty);
    if (!q.ok) return q;
    if (!isVatRate(line.vatRate))
      return err({ code: 'VALIDATION', field: 'vatRate', message: 'Taux TVA non autorise.' });
    this._lines.push(line);
    return ok(undefined);
  }

  removeLine(lineId: string): DomainResult<void> {
    const d = this.assertDraft();
    if (!d.ok) return d;
    if (!this._lines.some((l) => l.id === lineId))
      return err({ code: 'VALIDATION', field: 'lineId', message: 'Ligne introuvable.' });
    this._lines = this._lines.filter((l) => l.id !== lineId);
    return ok(undefined);
  }

  /**
   * R6 : édition d'une ligne EXISTANTE (label/qty/unitPriceHT/vatRate), draft uniquement — un
   * devis signé est un contrat (assertDraft, même garde qu'addLine/removeLine). Patch partiel :
   * seuls les champs fournis sont revalidés/remplacés, les autres restent inchangés.
   */
  updateLine(lineId: string, patch: Partial<Pick<LineInput, 'label' | 'qty' | 'unitPriceHT' | 'vatRate'>>): DomainResult<void> {
    const d = this.assertDraft();
    if (!d.ok) return d;
    const index = this._lines.findIndex((l) => l.id === lineId);
    const current = index === -1 ? undefined : this._lines[index];
    if (index === -1 || current === undefined)
      return err({ code: 'VALIDATION', field: 'lineId', message: 'Ligne introuvable.' });
    if (patch.qty !== undefined) {
      const q = Quantity.of(patch.qty);
      if (!q.ok) return q;
    }
    if (patch.vatRate !== undefined && !isVatRate(patch.vatRate))
      return err({ code: 'VALIDATION', field: 'vatRate', message: 'Taux TVA non autorise.' });
    if (patch.unitPriceHT !== undefined && (!Number.isSafeInteger(patch.unitPriceHT) || patch.unitPriceHT < 0))
      return err({ code: 'VALIDATION', field: 'unitPriceHT', message: 'Prix unitaire invalide.' });
    if (patch.label !== undefined && patch.label.trim().length === 0)
      return err({ code: 'VALIDATION', field: 'label', message: 'Libelle requis.' });
    this._lines[index] = { ...current, ...patch };
    return ok(undefined);
  }

  setDeposit(pct: number | null): DomainResult<void> {
    const d = this.assertDraft();
    if (!d.ok) return d;
    if (pct === null) {
      this._depositPct = null;
      return ok(undefined);
    }
    const p = Percentage.of(pct);
    if (!p.ok) return p;
    this._depositPct = p.value;
    return ok(undefined);
  }

  totals(): Totals {
    return computeTotals([...this._lines], this._depositPct ? { depositPct: this._depositPct.value } : undefined);
  }

  /** Pure : valide et fige le numéro alloué par le use case (no-gap garanti côté infra). */
  assignNumber(n: DocNumber, at: Instant): DomainResult<void> {
    if (this._number) return err({ code: 'VALIDATION', field: 'number', message: 'Numero deja attribue.' });
    this._number = n;
    this.record({ type: 'DocumentNumbered', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  send(at: Instant): DomainResult<void> {
    const t = assertTransition(QUOTE_TRANSITIONS, this._status, 'sent');
    if (!t.ok) return t;
    if (!this._number) return err({ code: 'VALIDATION', field: 'number', message: 'Numero requis avant envoi.' });
    if (this._lines.length === 0)
      return err({ code: 'VALIDATION', field: 'lines', message: 'Au moins une ligne requise.' });
    this._status = 'sent';
    this.record({ type: 'QuoteSent', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  markViewed(at: Instant): DomainResult<void> {
    const t = assertTransition(QUOTE_TRANSITIONS, this._status, 'viewed');
    if (!t.ok) return t;
    this._status = 'viewed';
    this.record({ type: 'QuoteViewed', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  sign(signature: Signature, at: Instant): DomainResult<void> {
    const t = assertTransition(QUOTE_TRANSITIONS, this._status, 'signed');
    if (!t.ok) return t;
    this._status = 'signed';
    this._signature = signature;
    this.record({ type: 'QuoteSigned', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  refuse(at: Instant): DomainResult<void> {
    const t = assertTransition(QUOTE_TRANSITIONS, this._status, 'refused');
    if (!t.ok) return t;
    this._status = 'refused';
    this.record({ type: 'QuoteRefused', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  markExpired(at: Instant): DomainResult<void> {
    const t = assertTransition(QUOTE_TRANSITIONS, this._status, 'expired');
    if (!t.ok) return t;
    this._status = 'expired';
    this.record({ type: 'QuoteExpired', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  // ——— Persistance (réhydratation depuis la base, sans rejouer les invariants/events) ———
  toSnapshot(): QuoteSnapshot {
    return {
      id: this.id,
      companyId: this.companyId,
      customerId: this.customerId,
      status: this._status,
      lines: this._lines.map((l) => ({ ...l })),
      number: this._number?.value ?? null,
      depositPct: this._depositPct?.value ?? null,
      validUntil: this._validUntil,
      signature: this._signature,
    };
  }

  static rehydrate(s: QuoteSnapshot): Quote {
    const q = new Quote(s.id, s.companyId, s.customerId, s.validUntil);
    q._status = s.status;
    q._lines = s.lines.map((l) => ({ ...l }));
    if (s.number) {
      const n = DocNumber.of(s.number);
      if (n.ok) q._number = n.value;
    }
    if (s.depositPct !== null) {
      const p = Percentage.of(s.depositPct);
      if (p.ok) q._depositPct = p.value;
    }
    q._signature = s.signature;
    return q;
  }
}

export interface QuoteSnapshot {
  id: string;
  companyId: string;
  customerId: string;
  status: QuoteStatus;
  lines: QuoteLine[];
  number: string | null;
  depositPct: number | null;
  validUntil: DateOnly | null;
  signature: Signature | null;
}
