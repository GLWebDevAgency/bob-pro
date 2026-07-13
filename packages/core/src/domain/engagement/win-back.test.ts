import { describe, expect, it } from 'vitest';
import { decideWinBack, type ExpiringQuote, type OverdueInvoice } from './win-back';

const NOW = '2026-07-14T09:00:00.000Z';
const ACTIVE_YESTERDAY = '2026-07-13T09:00:00.000Z';
const INACTIVE_10D = '2026-07-04T09:00:00.000Z';

const quote = (over: Partial<ExpiringQuote> = {}): ExpiringQuote => ({
  id: 'q1',
  label: 'Devis 2026-0007 — Camping Les Pins',
  totalCents: 138_600,
  expiresAt: '2026-07-20T00:00:00.000Z',
  ...over,
});
const invoice = (over: Partial<OverdueInvoice> = {}): OverdueInvoice => ({
  id: 'i1',
  label: 'Facture 2026-014 — Lefebvre',
  remainingCents: 41_500,
  dueAt: '2026-07-01T00:00:00.000Z',
  ...over,
});

describe('decideWinBack — un rappel UNIQUEMENT pour une valeur À LUI qui dort', () => {
  it('utilisateur actif → JAMAIS de win-back, même avec de la valeur dormante', () => {
    expect(
      decideWinBack({
        now: NOW,
        lastActivityAt: ACTIVE_YESTERDAY,
        lastWinBackAt: null,
        expiringQuotes: [quote()],
        overdueInvoices: [invoice()],
      }),
    ).toEqual({ kind: 'none' });
  });

  it('inactif SANS valeur dormante → silence (jamais un « tu nous manques »)', () => {
    expect(
      decideWinBack({
        now: NOW,
        lastActivityAt: INACTIVE_10D,
        lastWinBackAt: null,
        expiringQuotes: [],
        overdueInvoices: [],
      }),
    ).toEqual({ kind: 'none' });
  });

  it('inactif + devis qui expire bientôt → UN crochet chiffré et daté', () => {
    const decision = decideWinBack({
      now: NOW,
      lastActivityAt: INACTIVE_10D,
      lastWinBackAt: null,
      expiringQuotes: [quote()],
      overdueInvoices: [],
    });
    expect(decision).toEqual({
      kind: 'send',
      hook: {
        type: 'expiring_quote',
        id: 'q1',
        label: 'Devis 2026-0007 — Camping Les Pins',
        amountCents: 138_600,
        deadline: '2026-07-20T00:00:00.000Z',
      },
    });
  });

  it('le plus GROS montant gagne — un seul crochet, la vraie raison de revenir', () => {
    const decision = decideWinBack({
      now: NOW,
      lastActivityAt: INACTIVE_10D,
      lastWinBackAt: null,
      expiringQuotes: [quote({ totalCents: 30_000 })],
      overdueInvoices: [invoice({ remainingCents: 90_000 })],
    });
    expect(decision).toMatchObject({ kind: 'send', hook: { type: 'overdue_invoice', amountCents: 90_000 } });
  });

  it('cooldown : un win-back récent verrouille le suivant (le silence est un droit)', () => {
    expect(
      decideWinBack({
        now: NOW,
        lastActivityAt: INACTIVE_10D,
        lastWinBackAt: '2026-07-05T09:00:00.000Z', // il y a 9 jours < 14
        expiringQuotes: [quote()],
        overdueInvoices: [],
      }),
    ).toEqual({ kind: 'none' });
  });

  it('devis DÉJÀ expiré ou hors horizon → pas un crochet (l’urgence vraie, pas fabriquée)', () => {
    const expired = quote({ expiresAt: '2026-07-10T00:00:00.000Z' });
    const tooFar = quote({ id: 'q2', expiresAt: '2026-09-01T00:00:00.000Z' });
    expect(
      decideWinBack({
        now: NOW,
        lastActivityAt: INACTIVE_10D,
        lastWinBackAt: null,
        expiringQuotes: [expired, tooFar],
        overdueInvoices: [],
      }),
    ).toEqual({ kind: 'none' });
  });

  it('facture non échue ou soldée → pas un crochet', () => {
    const notDue = invoice({ dueAt: '2026-08-01T00:00:00.000Z' });
    const paid = invoice({ id: 'i2', remainingCents: 0 });
    expect(
      decideWinBack({
        now: NOW,
        lastActivityAt: INACTIVE_10D,
        lastWinBackAt: null,
        expiringQuotes: [],
        overdueInvoices: [notDue, paid],
      }),
    ).toEqual({ kind: 'none' });
  });

  it('à montant égal, l’échéance la plus proche gagne', () => {
    const decision = decideWinBack({
      now: NOW,
      lastActivityAt: INACTIVE_10D,
      lastWinBackAt: null,
      expiringQuotes: [
        quote({ id: 'q-loin', totalCents: 50_000, expiresAt: '2026-07-25T00:00:00.000Z' }),
        quote({ id: 'q-proche', totalCents: 50_000, expiresAt: '2026-07-16T00:00:00.000Z' }),
      ],
      overdueInvoices: [],
    });
    expect(decision).toMatchObject({ kind: 'send', hook: { id: 'q-proche' } });
  });
});
