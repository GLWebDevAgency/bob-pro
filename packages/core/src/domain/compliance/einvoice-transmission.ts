import { AggregateRoot } from '../../shared-kernel/aggregate';
import { type DomainResult, ok } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { assertTransition, type TransmissionStatus, TRANSMISSION_TRANSITIONS } from '../billing/shared/state-machines';

export type EinvoiceChannel = 'pdp' | 'chorus_pro' | 'ereporting';

/** Agrégat Compliance — cycle de transmission e-invoice (issued -> transmitted -> received -> accepted/refused -> paid). */
export class EinvoiceTransmission extends AggregateRoot<string> {
  private constructor(
    id: string,
    readonly invoiceId: string,
    readonly channel: EinvoiceChannel,
    private _status: TransmissionStatus,
  ) {
    super(id);
  }

  static open(id: string, invoiceId: string, channel: EinvoiceChannel): DomainResult<EinvoiceTransmission> {
    return ok(new EinvoiceTransmission(id, invoiceId, channel, 'issued'));
  }

  get status(): TransmissionStatus {
    return this._status;
  }

  private to(next: TransmissionStatus, at: Instant, type: string): DomainResult<void> {
    const t = assertTransition(TRANSMISSION_TRANSITIONS, this._status, next);
    if (!t.ok) return t;
    this._status = next;
    this.record({ type, occurredAt: at, version: 1 });
    return ok(undefined);
  }

  transmit(at: Instant): DomainResult<void> {
    return this.to('transmitted', at, 'InvoiceTransmitted');
  }
  acknowledgeReceived(at: Instant): DomainResult<void> {
    return this.to('received', at, 'InvoiceReceived');
  }
  accept(at: Instant): DomainResult<void> {
    return this.to('accepted', at, 'InvoiceAccepted');
  }
  refuse(at: Instant): DomainResult<void> {
    return this.to('refused', at, 'InvoiceRefused');
  }
  markPaidOnPlatform(at: Instant): DomainResult<void> {
    return this.to('paid', at, 'EinvoicePaid');
  }
}
