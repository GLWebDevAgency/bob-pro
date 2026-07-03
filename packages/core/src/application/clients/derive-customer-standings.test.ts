import { describe, it, expect } from 'vitest';
import {
  deriveCustomerStandings,
  pendingTotalCents,
  revenueLast12MonthsCents,
  type CustomerStanding,
  type DeriveCustomerStandingsInput,
  type StandingCustomerData,
  type StandingInvoiceData,
  type StandingQuoteData,
} from './derive-customer-standings';

// ── Fixtures unitaires ciblées (fonction pure : données en clair suffisent) ──

function customer(overrides: Partial<StandingCustomerData> & Pick<StandingCustomerData, 'id'>): StandingCustomerData {
  return { outstanding: 0, scoreBand: 'orange', ...overrides };
}

function invoice(
  overrides: Partial<StandingInvoiceData> & Pick<StandingInvoiceData, 'customerId'>,
): StandingInvoiceData {
  return { kind: 'final', status: 'issued', totals: { netToPay: 100000 }, dueAt: '2026-08-01', paid: 0, ...overrides };
}

function quote(overrides: Partial<StandingQuoteData> & Pick<StandingQuoteData, 'customerId'>): StandingQuoteData {
  return { status: 'sent', totals: { ttc: 148000 }, ...overrides };
}

const TODAY = '2026-07-03';

function derive(partial: Partial<DeriveCustomerStandingsInput> & Pick<DeriveCustomerStandingsInput, 'customers'>) {
  return deriveCustomerStandings({ invoices: [], quotes: [], today: TODAY, ...partial });
}

function only(standings: CustomerStanding[]): CustomerStanding {
  expect(standings).toHaveLength(1);
  return standings[0] as CustomerStanding;
}

describe('deriveCustomerStandings', () => {
  it('en retard : facture échue avec reste dû — encours = TOUT le reste dû, retard = le plus long', () => {
    const s = only(
      derive({
        customers: [customer({ id: 'cust-martin' })],
        invoices: [
          // F-2026-088 du proto : 1 240 € échue depuis 9 jours.
          invoice({ customerId: 'cust-martin', status: 'late', totals: { netToPay: 124000 }, dueAt: '2026-06-24' }),
          // Seconde facture émise, pas encore échue : elle gonfle l'encours, pas le retard.
          invoice({ customerId: 'cust-martin', totals: { netToPay: 124000 }, dueAt: '2026-07-20' }),
        ],
      }),
    );
    expect(s).toEqual({ customerId: 'cust-martin', kind: 'en_retard', amountCents: 248000, daysLate: 9 });
  });

  it('en attente : reste dû sans échéance dépassée (plafond netToPay − paid, jamais ttc)', () => {
    const s = only(
      derive({
        customers: [customer({ id: 'cust-sevres' })],
        invoices: [
          invoice({
            customerId: 'cust-sevres',
            status: 'partially_paid',
            totals: { netToPay: 185000 },
            paid: 35000,
            dueAt: '2026-07-20',
          }),
        ],
      }),
    );
    expect(s).toEqual({ customerId: 'cust-sevres', kind: 'en_attente', amountCents: 150000, daysLate: 0 });
  });

  it('devis : sans reste dû, un devis envoyé/consulté ressort en « devis » (ttc) ; signé → à jour ; payé → à jour', () => {
    const standings = derive({
      customers: [customer({ id: 'cust-bernard' }), customer({ id: 'cust-durand' }), customer({ id: 'cust-lefevre' })],
      invoices: [
        // Facture soldée : historique engagé, plus rien d'ouvert.
        invoice({ customerId: 'cust-lefevre', status: 'paid', totals: { netToPay: 19000 }, paid: 19000 }),
      ],
      quotes: [
        quote({ customerId: 'cust-bernard' }), // devis chauffe-eau 1 480 € en attente de réponse
        quote({ customerId: 'cust-durand', status: 'signed', totals: { ttc: 177000 } }),
      ],
    });
    expect(standings).toEqual([
      { customerId: 'cust-bernard', kind: 'devis', amountCents: 148000, daysLate: 0 },
      { customerId: 'cust-durand', kind: 'a_jour', amountCents: 0, daysLate: 0 },
      { customerId: 'cust-lefevre', kind: 'a_jour', amountCents: 0, daysLate: 0 },
    ]);
  });

  it('repli sans pièce : outstanding + scoreBand du client (rouge → retard · encours → attente · vert → à jour · sinon → nouveau)', () => {
    const standings = derive({
      customers: [
        customer({ id: 'cust-martin', outstanding: 248000, scoreBand: 'red' }),
        customer({ id: 'cust-sevres', outstanding: 185000, scoreBand: 'orange' }),
        customer({ id: 'cust-durand', scoreBand: 'green' }),
        customer({ id: 'cust-camping', scoreBand: 'red' }),
      ],
    });
    expect(standings.map((s) => s.kind)).toEqual(['en_retard', 'en_attente', 'a_jour', 'nouveau']);
    expect(standings.map((s) => s.amountCents)).toEqual([248000, 185000, 0, 0]);
    // Sources indisponibles (chargement/erreur) → même repli, jamais un chiffre inventé.
    const offline = deriveCustomerStandings({
      customers: [customer({ id: 'cust-martin', outstanding: 248000, scoreBand: 'red' })],
      today: TODAY,
    });
    expect(only(offline).kind).toBe('en_retard');
  });

  it('pendingTotalCents : Σ retard + attente, hors devis (réf proto 4 330 €)', () => {
    const standings = derive({
      customers: [
        customer({ id: 'cust-martin', outstanding: 248000, scoreBand: 'red' }),
        customer({ id: 'cust-sevres', outstanding: 185000 }),
        customer({ id: 'cust-bernard' }),
      ],
      quotes: [quote({ customerId: 'cust-bernard' })],
    });
    expect(pendingTotalCents(standings)).toBe(433000);
  });

  it('ignore brouillons, annulées et avoirs pour l’encours ; brouillon seul ne fait pas un historique', () => {
    const s = only(
      derive({
        customers: [customer({ id: 'cust-1' })],
        invoices: [
          invoice({ customerId: 'cust-1', status: 'draft' }),
          invoice({ customerId: 'cust-1', status: 'cancelled' }),
          invoice({ customerId: 'cust-1', kind: 'credit_note', totals: { netToPay: 5000 } }),
        ],
      }),
    );
    // Avoir « encaissable » exclu de l'encours ; l'avoir émis compte comme historique engagé → à jour.
    expect(s).toEqual({ customerId: 'cust-1', kind: 'a_jour', amountCents: 0, daysLate: 0 });
  });
});

describe('revenueLast12MonthsCents (KPI « CA 12 mois » de la fiche C13)', () => {
  it('Σ netToPay des factures engagées de la fenêtre — acompte + finale sans double compte', () => {
    // Devis proto 1 628 € ttc : acompte 30 % net 488,40 € + finale net 1 139,60 € = 1 628 €.
    const cents = revenueLast12MonthsCents(
      [
        invoice({ customerId: 'c', kind: 'deposit', status: 'paid', totals: { netToPay: 48840 }, dueAt: '2026-05-10' }),
        invoice({ customerId: 'c', kind: 'final', status: 'issued', totals: { netToPay: 113960 }, dueAt: '2026-07-20' }),
      ],
      TODAY,
    );
    expect(cents).toBe(162800);
  });

  it('exclut brouillons/annulées et la facture échue il y a plus de 12 mois ; déduit les avoirs ; garde la facture sans échéance', () => {
    const cents = revenueLast12MonthsCents(
      [
        invoice({ customerId: 'c', status: 'draft', totals: { netToPay: 99900 } }),
        invoice({ customerId: 'c', status: 'cancelled', totals: { netToPay: 99900 } }),
        invoice({ customerId: 'c', status: 'paid', totals: { netToPay: 50000 }, dueAt: '2025-07-02' }), // hors fenêtre
        invoice({ customerId: 'c', status: 'paid', totals: { netToPay: 50000 }, dueAt: '2025-07-03' }), // borne incluse
        invoice({ customerId: 'c', kind: 'credit_note', status: 'issued', totals: { netToPay: 12000 }, dueAt: '2026-06-01' }),
        invoice({ customerId: 'c', status: 'issued', totals: { netToPay: 30000 }, dueAt: null }),
      ],
      TODAY,
    );
    expect(cents).toBe(50000 - 12000 + 30000);
  });
});
