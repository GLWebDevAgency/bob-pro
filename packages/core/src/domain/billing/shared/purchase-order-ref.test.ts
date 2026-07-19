import { describe, it, expect } from 'vitest';
import {
  makePurchaseOrderRef,
  purchaseOrderRefEquals,
  clonePurchaseOrderRef,
  MAX_PURCHASE_ORDER_NUMBER_LENGTH,
} from './purchase-order-ref';

describe('makePurchaseOrderRef (B8 — numéro d’engagement grands comptes)', () => {
  it('accepte un numéro simple, defaults null pour receivedAt/documentId', () => {
    const r = makePurchaseOrderRef({ number: '4500123456' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ number: '4500123456', receivedAt: null, documentId: null });
  });

  it('assainit : trim + espaces internes normalisés (tabulation/retour ligne d’un scan)', () => {
    const r = makePurchaseOrderRef({ number: '  BC\t2026\n0456  ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.number).toBe('BC 2026 0456');
  });

  it('rejette un numéro vide ou fait uniquement de blancs', () => {
    for (const number of ['', '   ', '\t\n']) {
      const r = makePurchaseOrderRef({ number });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ code: 'VALIDATION', field: 'number' });
    }
  });

  it('borne la longueur à 60 après assainissement (60 OK, 61 rejeté)', () => {
    const ok60 = makePurchaseOrderRef({ number: 'X'.repeat(MAX_PURCHASE_ORDER_NUMBER_LENGTH) });
    expect(ok60.ok).toBe(true);
    const ko61 = makePurchaseOrderRef({ number: 'X'.repeat(MAX_PURCHASE_ORDER_NUMBER_LENGTH + 1) });
    expect(ko61.ok).toBe(false);
    // Les blancs superflus ne comptent pas : ' X…X ' de 60 utiles passe.
    const trimmed = makePurchaseOrderRef({ number: `  ${'X'.repeat(60)}  ` });
    expect(trimmed.ok).toBe(true);
  });

  it('rejette les caractères de contrôle restants (non blancs)', () => {
    const r = makePurchaseOrderRef({ number: 'BC\u0000456' });
    expect(r.ok).toBe(false);
  });

  it('rejette un number non-string (codec défensif)', () => {
    const r = makePurchaseOrderRef({ number: 42 as unknown as string });
    expect(r.ok).toBe(false);
  });

  it('valide receivedAt : ISO accepté, charabia rejeté, null conservé', () => {
    expect(makePurchaseOrderRef({ number: 'BC1', receivedAt: '2026-07-10T09:00:00.000Z' }).ok).toBe(true);
    expect(makePurchaseOrderRef({ number: 'BC1', receivedAt: null }).ok).toBe(true);
    const bad = makePurchaseOrderRef({ number: 'BC1', receivedAt: 'pas-une-date' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatchObject({ code: 'VALIDATION', field: 'receivedAt' });
  });

  it('valide documentId : trim, non vide, sans contrôle', () => {
    const okDoc = makePurchaseOrderRef({ number: 'BC1', documentId: '  doc-42  ' });
    expect(okDoc.ok).toBe(true);
    if (okDoc.ok) expect(okDoc.value.documentId).toBe('doc-42');
    expect(makePurchaseOrderRef({ number: 'BC1', documentId: '   ' }).ok).toBe(false);
    expect(makePurchaseOrderRef({ number: 'BC1', documentId: 'doc\u0007id' }).ok).toBe(false);
    expect(makePurchaseOrderRef({ number: 'BC1', documentId: 'd'.repeat(101) }).ok).toBe(false);
  });

  it('retourne un objet GELÉ (référence immuable)', () => {
    const r = makePurchaseOrderRef({ number: 'BC1' });
    if (!r.ok) throw new Error('ref');
    expect(Object.isFrozen(r.value)).toBe(true);
  });
});

describe('purchaseOrderRefEquals / clonePurchaseOrderRef', () => {
  const a = { number: 'BC1', receivedAt: '2026-07-10T09:00:00.000Z', documentId: 'doc-1' };

  it('égalité structurelle stricte champ à champ', () => {
    expect(purchaseOrderRefEquals(a, { ...a })).toBe(true);
    expect(purchaseOrderRefEquals(a, { ...a, number: 'BC2' })).toBe(false);
    expect(purchaseOrderRefEquals(a, { ...a, receivedAt: null })).toBe(false);
    expect(purchaseOrderRefEquals(a, { ...a, documentId: null })).toBe(false);
    expect(purchaseOrderRefEquals(null, null)).toBe(true);
    expect(purchaseOrderRefEquals(a, null)).toBe(false);
    expect(purchaseOrderRefEquals(null, a)).toBe(false);
  });

  it('clone : copie gelée structurellement égale, référence distincte', () => {
    const c = clonePurchaseOrderRef(a);
    expect(c).toEqual(a);
    expect(c).not.toBe(a);
    expect(Object.isFrozen(c)).toBe(true);
  });
});
