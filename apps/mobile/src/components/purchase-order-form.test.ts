import { describe, it, expect } from 'vitest';
import {
  buildPurchaseOrderRefInput,
  displayPurchaseOrderReceivedDate,
  parsePurchaseOrderReceivedDate,
  purchaseOrderErrorMessage,
} from './purchase-order-form.logic';

describe('parsePurchaseOrderReceivedDate (B8)', () => {
  it('date vide → null (la réception est facultative)', () => {
    expect(parsePurchaseOrderReceivedDate('')).toEqual({ ok: true, value: null });
    expect(parsePurchaseOrderReceivedDate('   ')).toEqual({ ok: true, value: null });
  });

  it('JJ/MM/AAAA et AAAA-MM-JJ → Instant ISO canonique minuit UTC (forme toISOString)', () => {
    expect(parsePurchaseOrderReceivedDate('15/07/2026')).toEqual({
      ok: true,
      value: '2026-07-15T00:00:00.000Z',
    });
    expect(parsePurchaseOrderReceivedDate('2026-07-15')).toEqual({
      ok: true,
      value: '2026-07-15T00:00:00.000Z',
    });
    // Stabilité aller-retour : la forme émise EST déjà la forme canonique serveur.
    expect(new Date('2026-07-15T00:00:00.000Z').toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  it('rejette les dates impossibles ou difformes sans jamais corriger', () => {
    expect(parsePurchaseOrderReceivedDate('31/02/2026')).toEqual({ ok: false });
    expect(parsePurchaseOrderReceivedDate('15-07-2026')).toEqual({ ok: false });
    expect(parsePurchaseOrderReceivedDate('demain')).toEqual({ ok: false });
  });

  it('affichage : Instant ISO → JJ/MM/AAAA (jour UTC), aller-retour stable', () => {
    expect(displayPurchaseOrderReceivedDate('2026-07-15T00:00:00.000Z')).toBe('15/07/2026');
    const parsed = parsePurchaseOrderReceivedDate('01/02/2026');
    expect(parsed.ok && parsed.value !== null && displayPurchaseOrderReceivedDate(parsed.value)).toBe(
      '01/02/2026',
    );
  });
});

describe('buildPurchaseOrderRefInput (B8) — autorité makePurchaseOrderRef', () => {
  it('assainit le numéro (retours à la ligne d’un scan → espaces simples) et gèle la forme canonique', () => {
    const result = buildPurchaseOrderRefInput({
      number: '  BC\n2026\t0458  ',
      receivedDate: '15/07/2026',
      documentId: null,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        number: 'BC 2026 0458',
        receivedAt: '2026-07-15T00:00:00.000Z',
        documentId: null,
      },
    });
  });

  it('numéro vide ou trop long (61+) → champ number en erreur', () => {
    expect(
      buildPurchaseOrderRefInput({ number: '   ', receivedDate: '', documentId: null }),
    ).toEqual({ ok: false, field: 'number' });
    expect(
      buildPurchaseOrderRefInput({ number: 'X'.repeat(61), receivedDate: '', documentId: null }),
    ).toEqual({ ok: false, field: 'number' });
  });

  it('date difforme → champ receivedAt en erreur ; document lié transmis tel quel', () => {
    expect(
      buildPurchaseOrderRefInput({ number: 'BC-1', receivedDate: '99/99/9999', documentId: null }),
    ).toEqual({ ok: false, field: 'receivedAt' });
    const withDoc = buildPurchaseOrderRefInput({
      number: 'BC-1',
      receivedDate: '',
      documentId: 'doc-42',
    });
    expect(withDoc).toEqual({
      ok: true,
      value: { number: 'BC-1', receivedAt: null, documentId: 'doc-42' },
    });
  });
});

describe('purchaseOrderErrorMessage (B8) — la voix serveur d’abord, repli honnête sinon', () => {
  const fallback = 'Enregistrement KO. Réessaie.';

  it('409 conflict → message métier du use case (« Devis déjà facturé… », révision périmée)', () => {
    expect(
      purchaseOrderErrorMessage(
        {
          kind: 'conflict',
          entity: 'quote',
          reason: 'Devis déjà facturé — attache le bon de commande directement à la facture.',
        },
        fallback,
      ),
    ).toBe('Devis déjà facturé — attache le bon de commande directement à la facture.');
  });

  it('422 validation/domaine → premier message d’issue ou message domaine', () => {
    expect(
      purchaseOrderErrorMessage(
        { kind: 'validation', issues: [{ field: 'number', message: 'Numéro invalide.' }] },
        fallback,
      ),
    ).toBe('Numéro invalide.');
    expect(
      purchaseOrderErrorMessage(
        {
          kind: 'domain',
          error: { code: 'VALIDATION', field: 'number', message: 'Numéro de bon de commande requis.' },
        },
        fallback,
      ),
    ).toBe('Numéro de bon de commande requis.');
  });

  it('erreur inconnue, not_found ou difforme → repli fourni (jamais de message technique)', () => {
    expect(purchaseOrderErrorMessage({ kind: 'not_found', entity: 'quote', id: 'q1' }, fallback)).toBe(
      fallback,
    );
    expect(purchaseOrderErrorMessage(new Error('boom'), fallback)).toBe(fallback);
    expect(purchaseOrderErrorMessage(undefined, fallback)).toBe(fallback);
    expect(purchaseOrderErrorMessage({ kind: 'validation', issues: [] }, fallback)).toBe(fallback);
  });
});
