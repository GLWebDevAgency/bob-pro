import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RELANCE_POLICY,
  deriveRelancePlan,
  deriveUpcomingDues,
  type DeriveRelancePlanInput,
} from './derive-relance-plan';
import { type TodayCustomerData, type TodayInvoiceData } from '../today/derive-today-priorities';
import { type Totals } from '../../domain/billing/shared/totals';

// ── Fixtures unitaires ciblées (fonction pure : données en clair suffisent) ──

const TODAY = '2026-07-10';

function totalsOf(ttc: number, netToPay: number = ttc): Totals {
  return { ht: ttc, vatByRate: {}, vat: 0, ttc, netToPay };
}

function invoiceFixture(overrides: Partial<TodayInvoiceData> & Pick<TodayInvoiceData, 'id'>): TodayInvoiceData {
  return {
    customerId: 'cust-1',
    kind: 'final',
    status: 'issued',
    number: 'F-2026-0088',
    parentQuoteId: null,
    totals: totalsOf(124000),
    dueAt: '2026-07-01', // 9 j de retard au 2026-07-10
    paid: 0,
    ...overrides,
  };
}

/** dueAt tel que la facture ait exactement `days` jours de retard au TODAY. */
function dueDaysAgo(days: number): string {
  const d = new Date(`${TODAY}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const CUSTOMERS: TodayCustomerData[] = [
  { id: 'cust-1', name: 'SARL Martin' },
  { id: 'cust-2', name: 'Mme Durand' },
];

function plan(partial: Partial<DeriveRelancePlanInput>) {
  return deriveRelancePlan({ invoices: [], customers: CUSTOMERS, today: TODAY, ...partial });
}

describe('deriveRelancePlan', () => {
  it('escalade les tons par ancienneté (défauts J+3 / J+10 / J+20 / J+30) et date la prochaine escalade', () => {
    const entries = plan({
      invoices: [
        invoiceFixture({ id: 'inv-1j', dueAt: dueDaysAgo(1) }),
        invoiceFixture({ id: 'inv-5j', dueAt: dueDaysAgo(5) }),
        invoiceFixture({ id: 'inv-12j', dueAt: dueDaysAgo(12) }),
        invoiceFixture({ id: 'inv-25j', dueAt: dueDaysAgo(25) }),
        invoiceFixture({ id: 'inv-40j', dueAt: dueDaysAgo(40) }),
      ],
    });
    // Tri du moteur des candidates : retard le plus long d'abord.
    expect(entries.map((e) => [e.invoiceId, e.tone, e.dueNow])).toEqual([
      ['inv-40j', 'miseendemeure', true],
      ['inv-25j', 'ferme', true],
      ['inv-12j', 'neutre', true],
      ['inv-5j', 'cordial', true],
      ['inv-1j', 'cordial', false], // premier palier (J+3) pas encore atteint : planifiée, pas due
    ]);
    // Prochaine escalade = aujourd'hui + (palier suivant − retard actuel).
    expect(entries.map((e) => e.nextEscalationAt)).toEqual([
      null, // mise en demeure : dernier palier
      '2026-07-15', // ferme 25 j → mise en demeure à J+30 : dans 5 j
      '2026-07-18', // neutre 12 j → ferme à J+20 : dans 8 j
      '2026-07-15', // cordial 5 j → neutre à J+10 : dans 5 j
      '2026-07-12', // pas encore due 1 j → cordial à J+3 : dans 2 j
    ]);
  });

  it('mise en demeure : texte légal L441-10 + indemnité 40 € (copy du domaine, jamais dupliquée)', () => {
    const entries = plan({ invoices: [invoiceFixture({ id: 'inv-40j', dueAt: dueDaysAgo(40) })] });
    expect(entries).toHaveLength(1);
    const med = entries[0]!;
    expect(med.tone).toBe('miseendemeure');
    expect(med.message.subject).toContain('Mise en demeure');
    expect(med.message.subject).toContain('F-2026-0088');
    expect(med.message.body).toContain('L441-10');
    expect(med.message.body).toContain('indemnite forfaitaire de recouvrement de 40 €');
  });

  it('exclut payées, annulées, brouillons, avoirs et non échues — reste dû plafonné à netToPay', () => {
    const entries = plan({
      invoices: [
        invoiceFixture({ id: 'inv-paid', status: 'paid', paid: 124000 }),
        invoiceFixture({ id: 'inv-cancelled', status: 'cancelled' }),
        invoiceFixture({ id: 'inv-draft', status: 'draft', dueAt: null }),
        invoiceFixture({ id: 'inv-credit', kind: 'credit_note', totals: totalsOf(-50000, -50000) }),
        invoiceFixture({ id: 'inv-not-due', dueAt: '2026-07-20' }),
        invoiceFixture({
          id: 'inv-partial',
          status: 'partially_paid',
          customerId: 'cust-2',
          totals: totalsOf(162800, 48840), // acompte 30 % : netToPay < ttc
          paid: 20000,
        }),
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      invoiceId: 'inv-partial',
      customerName: 'Mme Durand',
      amountCents: 28840, // netToPay 48 840 − 20 000 encaissés — jamais le ttc
      daysLate: 9,
      tone: 'cordial',
      dueNow: true,
    });
    expect(entries[0]!.message.body).toContain('288,40');
  });

  it('respecte une politique personnalisée et décline la personnalité (Pote tutoie, Pro vouvoie)', () => {
    const policy = { cordialAfterDays: 1, neutreAfterDays: 2, fermeAfterDays: 3, miseEnDemeureAfterDays: 4 };
    const invoices = [invoiceFixture({ id: 'inv-3j', dueAt: dueDaysAgo(3) })];
    expect(plan({ invoices, policy })[0]).toMatchObject({ tone: 'ferme', nextEscalationAt: '2026-07-11' });
    expect(DEFAULT_RELANCE_POLICY).toEqual({
      cordialAfterDays: 3,
      neutreAfterDays: 10,
      fermeAfterDays: 20,
      miseEnDemeureAfterDays: 30,
    });

    const cordial = [invoiceFixture({ id: 'inv-5j', dueAt: dueDaysAgo(5) })];
    expect(plan({ invoices: cordial })[0]!.message.body).toContain('ta facture'); // défaut Pote
    expect(plan({ invoices: cordial, personality: 'Pro' })[0]!.message.body).toContain('nous vous rappelons');
  });
});

describe('deriveUpcomingDues', () => {
  it('fenêtre 7 j par défaut : échéances à venir triées, échues et payées exclues', () => {
    const upcoming = deriveUpcomingDues({
      today: TODAY,
      customers: CUSTOMERS,
      invoices: [
        invoiceFixture({ id: 'inv-overdue', dueAt: dueDaysAgo(2) }), // échue → plan de relances
        invoiceFixture({ id: 'inv-late-flag', status: 'late', dueAt: '2026-07-12' }), // statut backend → plan
        invoiceFixture({ id: 'inv-today', dueAt: TODAY }), // échue aujourd'hui : pas encore en retard
        invoiceFixture({ id: 'inv-in-3j', customerId: 'cust-2', dueAt: '2026-07-13', totals: totalsOf(50000) }),
        invoiceFixture({ id: 'inv-in-9j', dueAt: '2026-07-19' }), // hors fenêtre
        invoiceFixture({ id: 'inv-paid', status: 'paid', dueAt: '2026-07-13', paid: 124000 }),
        invoiceFixture({ id: 'inv-credit', kind: 'credit_note', dueAt: '2026-07-13', totals: totalsOf(-1000, -1000) }),
      ],
    });
    expect(upcoming.map((u) => [u.invoiceId, u.inDays])).toEqual([
      ['inv-today', 0],
      ['inv-in-3j', 3],
    ]);
    expect(upcoming[1]).toMatchObject({ customerName: 'Mme Durand', amountCents: 50000, dueAt: '2026-07-13' });
  });
});
