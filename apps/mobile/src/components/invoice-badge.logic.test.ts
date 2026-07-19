import { describe, expect, it } from 'vitest';
import { INVOICE_BADGE, invoiceBadgeFor } from './invoice-badge.logic';

/**
 * E5 — badge de statut dérivé par kind : un AVOIR émis est « Émis » AMBRE (masculin, tone
 * warning), jamais le bleu « Émise » d'une facture vivante ; annulé → « Annulé ».
 */

describe('invoiceBadgeFor (E5 — avoir masculin/ambre)', () => {
  it.each(['pote', 'pro', 'direct'] as const)(
    'avoir émis (%s) : « Émis » tone warning',
    (personality) => {
      expect(invoiceBadgeFor({ kind: 'credit_note', status: 'issued' }, personality)).toEqual({
        label: 'Émis',
        tone: 'warning',
      });
    },
  );

  it('avoir annulé : « Annulé » (masculin), tone danger', () => {
    expect(invoiceBadgeFor({ kind: 'credit_note', status: 'cancelled' }, 'pro')).toEqual({
      label: 'Annulé',
      tone: 'danger',
    });
  });

  it('avoir brouillon : repli INVOICE_BADGE (« Brouillon », genre invariant)', () => {
    expect(invoiceBadgeFor({ kind: 'credit_note', status: 'draft' }, 'pro')).toEqual(
      INVOICE_BADGE.draft,
    );
  });

  it.each(['final', 'deposit', 'situation'] as const)(
    'pièce %s : badge INCHANGÉ (une facture émise reste « Émise » bleue)',
    (kind) => {
      expect(invoiceBadgeFor({ kind, status: 'issued' }, 'pro')).toEqual(INVOICE_BADGE.issued);
      expect(invoiceBadgeFor({ kind, status: 'paid' }, 'pro')).toEqual(INVOICE_BADGE.paid);
    },
  );
});
