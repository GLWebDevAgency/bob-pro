import { describe, expect, it } from 'vitest';
import { INVOICE_BADGE, invoiceBadgeFor, invoiceListBadgeFor } from './invoice-badge.logic';

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

describe('invoiceListBadgeFor (PR-02 — émise jamais transmise = AMBRE)', () => {
  const base = { kind: 'final', status: 'issued' } as const;

  it('émise sans envoi constaté ni dépôt déclaré : « À transmettre » tone warning', () => {
    expect(
      invoiceListBadgeFor({ ...base, emailDeliveredAt: null, transmission: null }, 'pro'),
    ).toEqual({ label: 'À transmettre', tone: 'warning' });
  });

  it('éteinte dès qu’un envoi e-mail est constaté (job outbox réussi)', () => {
    expect(
      invoiceListBadgeFor(
        { ...base, emailDeliveredAt: '2026-07-25T08:00:00.000Z', transmission: null },
        'pro',
      ),
    ).toEqual(INVOICE_BADGE.issued);
  });

  it('éteinte dès qu’un dépôt est déclaré (chorus/portail ou « envoyée le »)', () => {
    expect(
      invoiceListBadgeFor(
        { ...base, emailDeliveredAt: null, transmission: { depositedAt: '2026-07-24', acceptedAt: null } },
        'pro',
      ),
    ).toEqual(INVOICE_BADGE.issued);
  });

  it('fail-closed : projection MUETTE (serveur antérieur) = badge historique, jamais une alerte inventée', () => {
    expect(invoiceListBadgeFor(base, 'pro')).toEqual(INVOICE_BADGE.issued);
    expect(invoiceListBadgeFor({ ...base, emailDeliveredAt: null }, 'pro')).toEqual(
      INVOICE_BADGE.issued,
    );
  });

  it('jamais sur un avoir ni un autre statut (payée, retard : la relance prend le relais)', () => {
    expect(
      invoiceListBadgeFor(
        { kind: 'credit_note', status: 'issued', emailDeliveredAt: null, transmission: null },
        'pro',
      ),
    ).toEqual({ label: 'Émis', tone: 'warning' });
    expect(
      invoiceListBadgeFor(
        { kind: 'final', status: 'late', emailDeliveredAt: null, transmission: null },
        'pro',
      ),
    ).toEqual(INVOICE_BADGE.late);
  });
});
