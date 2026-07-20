import { AggregateRoot } from '../../shared-kernel/aggregate';
import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { assertTransition } from '../billing/shared/state-machines';

/**
 * einvoice-inbound — cycle de vie d'une e-facture ENTRANTE (C-EXP6b), machine PURE.
 *
 * Miroir du cycle SORTANT (einvoice-transmission) côté réception : le poste de contrôle
 * d'un cabinet ne « saisit » jamais une facture d'achat, il la RÉCEPTIONNE puis DÉCIDE :
 *   received → approved  (l'Expense est enregistrée, les écritures 6xx/44566/401 partent via E1)
 *   received → refused   (motif OBLIGATOIRE + statut AFNOR : 210 « refusée » / 213 « rejetée »)
 *
 * Règle métier clé (facturation électronique 2026/2027) : une facture contestée mais NON
 * refusée formellement est réputée valable — d'où le motif obligatoire : `refuse()` sans
 * motif est une erreur de VALIDATION, jamais un refus silencieux.
 */

export type InboundEinvoiceStatus = 'received' | 'approved' | 'refused';

export const INBOUND_EINVOICE_TRANSITIONS: Record<InboundEinvoiceStatus, readonly InboundEinvoiceStatus[]> = {
  received: ['approved', 'refused'],
  approved: [],
  refused: [],
};

/** Statuts AFNOR du cycle de vie entrant : 210 = refusée (motif métier), 213 = rejetée (technique). */
export type AfnorInboundRefusalStatus = 210 | 213;

export const AFNOR_INBOUND_REFUSAL_LABELS: Record<AfnorInboundRefusalStatus, string> = {
  210: 'refusée',
  213: 'rejetée',
};

export interface InboundEinvoiceRefusal {
  afnorStatus: AfnorInboundRefusalStatus;
  reason: string;
  at: Instant;
}

/** Agrégat Compliance — décision de réception d'une e-facture fournisseur (C-EXP6b). */
export class InboundEinvoice extends AggregateRoot<string> {
  private _status: InboundEinvoiceStatus;
  private _refusal: InboundEinvoiceRefusal | null = null;

  private constructor(
    id: string,
    /** Clé métier de la pièce reçue (SIREN fournisseur + n° de facture) — trace d'audit. */
    readonly invoiceKey: string,
    status: InboundEinvoiceStatus,
  ) {
    super(id);
    this._status = status;
  }

  static receive(id: string, invoiceKey: string): DomainResult<InboundEinvoice> {
    if (!id.trim()) return err({ code: 'VALIDATION', field: 'id', message: 'Id de réception requis.' });
    if (!invoiceKey.trim())
      return err({ code: 'VALIDATION', field: 'invoiceKey', message: 'Clé de facture entrante requise.' });
    return ok(new InboundEinvoice(id, invoiceKey, 'received'));
  }

  get status(): InboundEinvoiceStatus {
    return this._status;
  }

  get refusal(): InboundEinvoiceRefusal | null {
    return this._refusal === null ? null : { ...this._refusal };
  }

  /** Approbation : la facture entre en comptabilité (RecordExpense + écritures E1 côté application). */
  approve(at: Instant): DomainResult<void> {
    const t = assertTransition(INBOUND_EINVOICE_TRANSITIONS, this._status, 'approved');
    if (!t.ok) return t;
    this._status = 'approved';
    this.record({ type: 'InboundEinvoiceApproved', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  /**
   * Refus : motif OBLIGATOIRE (une facture contestée non refusée est réputée valable) +
   * statut AFNOR typé (210 refusée / 213 rejetée). Sans motif → erreur de VALIDATION.
   */
  refuse(at: Instant, input: { afnorStatus: AfnorInboundRefusalStatus; reason: string }): DomainResult<void> {
    const reason = input.reason.trim();
    if (!reason)
      return err({ code: 'VALIDATION', field: 'reason', message: 'Motif de refus obligatoire (AFNOR 210/213).' });
    if (input.afnorStatus !== 210 && input.afnorStatus !== 213)
      return err({ code: 'VALIDATION', field: 'afnorStatus', message: 'Statut AFNOR de refus inconnu (210 ou 213).' });
    const t = assertTransition(INBOUND_EINVOICE_TRANSITIONS, this._status, 'refused');
    if (!t.ok) return t;
    this._status = 'refused';
    this._refusal = { afnorStatus: input.afnorStatus, reason, at };
    this.record({ type: 'InboundEinvoiceRefused', occurredAt: at, version: 1 });
    return ok(undefined);
  }
}
