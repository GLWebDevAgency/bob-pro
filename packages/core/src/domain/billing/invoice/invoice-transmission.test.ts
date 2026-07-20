import { describe, it, expect } from 'vitest';
import { Invoice } from './invoice';
import { DocNumber } from '../shared/doc-number';
import { PaymentTerms } from '../../../shared-kernel/payment-terms';

/**
 * Suivi MANUEL de transmission (canal de facturation) — invariants de l'agrégat :
 * pièce ÉMISE uniquement, jamais d'acceptation sans dépôt ni antérieure au dépôt,
 * corrigeable (suivi déclaratif), round-trip snapshot fidèle, compat ascendante.
 */

const AT = '2026-07-20T10:00:00.000Z';
const terms = (() => {
  const t = PaymentTerms.of({ days: 30, endOfMonth: false, label: 'Paiement a 30 jours' });
  if (!t.ok) throw new Error('terms');
  return t.value;
})();

function issuedInvoice(): Invoice {
  const r = Invoice.composeStandalone({ id: 'i1', companyId: 'c1', customerId: 'k1' });
  if (!r.ok) throw new Error('invoice');
  const inv = r.value;
  inv.addLine({ id: 'l1', label: 'Depannage', category: 'labor', qty: 1, unitPriceHT: 10_000, vatRate: 20 });
  inv.assignNumber(DocNumber.format('F', 2026, 1), AT);
  const issued = inv.issue({ mentions: [], terms, issuedAt: '2026-07-20', at: AT });
  if (!issued.ok) throw new Error('issue');
  return inv;
}

describe('Invoice.recordTransmission', () => {
  it('refuse sur un BROUILLON (rien à transmettre avant émission)', () => {
    const r = Invoice.composeStandalone({ id: 'i1', companyId: 'c1', customerId: 'k1' });
    if (!r.ok) throw new Error('invoice');
    const rec = r.value.recordTransmission({ depositedAt: '2026-07-20', acceptedAt: null }, AT);
    expect(rec.ok).toBe(false);
  });

  it('dépôt seul puis acceptation ≥ dépôt : accepté, getter défensif', () => {
    const inv = issuedInvoice();
    expect(inv.recordTransmission({ depositedAt: '2026-07-21', acceptedAt: null }, AT).ok).toBe(true);
    expect(inv.transmission).toEqual({ depositedAt: '2026-07-21', acceptedAt: null });
    expect(
      inv.recordTransmission({ depositedAt: '2026-07-21', acceptedAt: '2026-07-25' }, AT).ok,
    ).toBe(true);
    const t = inv.transmission!;
    t.acceptedAt = '2099-01-01';
    expect(inv.transmission).toEqual({ depositedAt: '2026-07-21', acceptedAt: '2026-07-25' });
  });

  it('JAMAIS d’acceptation sans dépôt', () => {
    const inv = issuedInvoice();
    expect(inv.recordTransmission({ depositedAt: null, acceptedAt: '2026-07-25' }, AT).ok).toBe(false);
  });

  it('JAMAIS d’acceptation antérieure au dépôt', () => {
    const inv = issuedInvoice();
    expect(
      inv.recordTransmission({ depositedAt: '2026-07-25', acceptedAt: '2026-07-21' }, AT).ok,
    ).toBe(false);
  });

  it('dates difformes refusées (AAAA-MM-JJ requis)', () => {
    const inv = issuedInvoice();
    expect(inv.recordTransmission({ depositedAt: '21/07/2026', acceptedAt: null }, AT).ok).toBe(false);
  });

  it('effacement explicite (null/null) : retour à « jamais suivi »', () => {
    const inv = issuedInvoice();
    inv.recordTransmission({ depositedAt: '2026-07-21', acceptedAt: null }, AT);
    expect(inv.recordTransmission({ depositedAt: null, acceptedAt: null }, AT).ok).toBe(true);
    expect(inv.transmission).toBeNull();
  });

  it('round-trip snapshot fidèle + compat ascendante (snapshot antérieur sans le champ)', () => {
    const inv = issuedInvoice();
    inv.recordTransmission({ depositedAt: '2026-07-21', acceptedAt: '2026-07-25' }, AT);
    const rehydrated = Invoice.rehydrate(inv.toSnapshot());
    expect(rehydrated.transmission).toEqual({ depositedAt: '2026-07-21', acceptedAt: '2026-07-25' });
    // Snapshot legacy SANS transmission : null honnête, jamais inventé.
    const legacy = { ...inv.toSnapshot() };
    delete legacy.transmission;
    expect(Invoice.rehydrate(legacy).transmission).toBeNull();
  });
});
