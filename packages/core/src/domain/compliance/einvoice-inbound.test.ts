import { describe, it, expect } from 'vitest';
import { InboundEinvoice, AFNOR_INBOUND_REFUSAL_LABELS } from './einvoice-inbound';

const AT = '2026-07-05T10:00:00.000Z';

function received(): InboundEinvoice {
  const r = InboundEinvoice.receive('inb-1', '732829320|F-2026-0042');
  if (!r.ok) throw new Error('fixture: réception KO');
  return r.value;
}

describe('InboundEinvoice — cycle ENTRANT (C-EXP6b)', () => {
  it('naît en received (clé de facture obligatoire)', () => {
    const inb = received();
    expect(inb.status).toBe('received');
    expect(inb.invoiceKey).toBe('732829320|F-2026-0042');
    expect(inb.refusal).toBeNull();

    const noKey = InboundEinvoice.receive('inb-2', '   ');
    expect(noKey.ok).toBe(false);
  });

  it('received → approved (événement enregistré)', () => {
    const inb = received();
    const r = inb.approve(AT);
    expect(r.ok).toBe(true);
    expect(inb.status).toBe('approved');
    expect(inb.pullEvents().map((e) => e.type)).toEqual(['InboundEinvoiceApproved']);
  });

  it('received → refused avec MOTIF + statut AFNOR 210 (refusée)', () => {
    const inb = received();
    const r = inb.refuse(AT, { afnorStatus: 210, reason: 'Facture mal adressée : SIREN acheteur ≠ ma société.' });
    expect(r.ok).toBe(true);
    expect(inb.status).toBe('refused');
    expect(inb.refusal).toEqual({
      afnorStatus: 210,
      reason: 'Facture mal adressée : SIREN acheteur ≠ ma société.',
      at: AT,
    });
    expect(AFNOR_INBOUND_REFUSAL_LABELS[210]).toBe('refusée');
    expect(AFNOR_INBOUND_REFUSAL_LABELS[213]).toBe('rejetée');
  });

  it('refuse() SANS motif = erreur de VALIDATION — jamais un refus silencieux', () => {
    const inb = received();
    const r = inb.refuse(AT, { afnorStatus: 213, reason: '   ' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({
      code: 'VALIDATION',
      field: 'reason',
      message: 'Motif de refus obligatoire (AFNOR 210/213).',
    });
    // La machine n'a PAS bougé : la facture reste réputée valable tant qu'elle n'est pas refusée.
    expect(inb.status).toBe('received');
    expect(inb.refusal).toBeNull();
  });

  it('états terminaux : approved et refused ne transitionnent plus (INVALID_TRANSITION)', () => {
    const approved = received();
    expect(approved.approve(AT).ok).toBe(true);
    const reRefuse = approved.refuse(AT, { afnorStatus: 210, reason: 'trop tard' });
    expect(reRefuse.ok).toBe(false);
    if (!reRefuse.ok) expect(reRefuse.error.code).toBe('INVALID_TRANSITION');

    const refused = received();
    expect(refused.refuse(AT, { afnorStatus: 213, reason: 'XML corrompu' }).ok).toBe(true);
    const reApprove = refused.approve(AT);
    expect(reApprove.ok).toBe(false);
    if (!reApprove.ok) expect(reApprove.error.code).toBe('INVALID_TRANSITION');
  });
});
