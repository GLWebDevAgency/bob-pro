import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RELANCE_POLICY,
  deriveRelancePlan,
  deriveUpcomingDues,
  type DeriveRelancePlanInput,
  type RelanceCustomerData,
} from './derive-relance-plan';
import { type TodayInvoiceData } from '../today/derive-today-priorities';
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

const CUSTOMERS: RelanceCustomerData[] = [
  { id: 'cust-1', name: 'SARL Martin', type: 'b2b' },
  { id: 'cust-2', name: 'Mme Durand', type: 'b2c' },
  { id: 'cust-3', name: 'Mairie de Nanterre', type: 'b2g' },
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

  it('mise en demeure B2B : texte légal L441-10 + indemnité 40 € (copy du domaine, jamais dupliquée)', () => {
    const entries = plan({ invoices: [invoiceFixture({ id: 'inv-40j', dueAt: dueDaysAgo(40) })] });
    expect(entries).toHaveLength(1);
    const med = entries[0]!;
    expect(med.tone).toBe('miseendemeure');
    expect(med.message.subject).toContain('Mise en demeure');
    expect(med.message.subject).toContain('F-2026-0088');
    expect(med.message.body).toContain('L441-10');
    expect(med.message.body).toContain('indemnite forfaitaire de recouvrement de 40 €');
  });

  // —— P01 (C-EXP1) : le plan branche buildRelance sur customer.type — la bonne lettre, zéro config ——
  it('mise en demeure B2C (particulier) : art. 1344 code civil + taux légal — jamais 40 € ni L441-10', () => {
    const entries = plan({
      invoices: [invoiceFixture({ id: 'inv-40j', customerId: 'cust-2', dueAt: dueDaysAgo(40) })],
    });
    const med = entries[0]!;
    expect(med.tone).toBe('miseendemeure');
    expect(med.message.body).toContain('art. 1344 du code civil');
    expect(med.message.body).toContain('taux legal');
    expect(med.message.body).not.toContain('L441-10');
    expect(med.message.body).not.toContain('40 €');
  });

  it('mise en demeure B2G (acheteur public) : L2192-12/13 CCP, BCE + 8 points + 40 € de plein droit', () => {
    const entries = plan({
      invoices: [invoiceFixture({ id: 'inv-40j', customerId: 'cust-3', dueAt: dueDaysAgo(40) })],
    });
    const med = entries[0]!;
    expect(med.message.body).toContain('code de la commande publique');
    expect(med.message.body).toContain('BCE majore de 8 points');
    expect(med.message.body).toContain('40 €');
    expect(med.message.body).not.toContain('L441-10');
  });

  it('client absent de la projection : prudence b2c — on ne réclame jamais 40 € sans savoir le débiteur professionnel', () => {
    const entries = plan({
      invoices: [invoiceFixture({ id: 'inv-40j', customerId: 'cust-inconnu', dueAt: dueDaysAgo(40) })],
    });
    const med = entries[0]!;
    expect(med.tone).toBe('miseendemeure');
    expect(med.message.body).toContain('art. 1344 du code civil');
    expect(med.message.body).not.toContain('40 €');
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

// —— C-EXP2 vA : pénalités chiffrées (P12) + chrono de prescription (P04) dans le plan ——
describe('deriveRelancePlan — pénalités chiffrées et prescription (C-EXP2 vA)', () => {
  const TODAY_S1 = '2026-06-20'; // S1 2026 : semestre AU référentiel (stale false)

  it('B2B échue 40 j : pénalités BCE+10 sur le reste dû, MED CHIFFRÉE (intérêts + 40 € + total)', () => {
    const entries = deriveRelancePlan({
      invoices: [{ ...invoiceFixture({ id: 'inv-40j', dueAt: '2026-05-11' }), issuedAt: '2026-04-11' }],
      customers: CUSTOMERS,
      today: TODAY_S1,
    });
    const med = entries[0]!;
    expect(med.tone).toBe('miseendemeure');
    expect(med.penalties).toEqual({
      interestCents: 1651, // 1 240 € × 12,15 % × 40/365
      fixedIndemnityCents: 4000,
      dailyCents: 41,
      days: 40,
      rateAnnualPct: 12.15,
      rateBasis: 'bce_plus_10',
      stale: false,
      flooredToLegalMinimum: false,
    });
    // La lettre énonce les montants (fini « l'argent dû de plein droit, abandonné »).
    expect(med.message.body).toContain('16,51');
    expect(med.message.body).toContain('D441-5');
    expect(med.message.body).toContain('soit un total de');
    expect(med.message.body).toContain('296,51'); // 1 240 + 16,51 + 40 = 1 296,51 €
    // Prescription quinquennale ancrée sur l'exigibilité.
    expect(med.prescription).toMatchObject({
      anchor: '2026-05-11',
      deadline: '2031-05-11',
      urgency: 'lointaine',
    });
    expect(med.prescription!.legalRef).toContain('L110-4');
  });

  it('paiement partiel daté (socle E3) = reconnaissance art. 2240 → la prescription se RÉ-ANCRE', () => {
    const entries = deriveRelancePlan({
      invoices: [
        {
          ...invoiceFixture({ id: 'inv-40j', dueAt: '2026-05-11', status: 'partially_paid', paid: 20000 }),
          issuedAt: '2026-04-11',
          payments: [{ receivedAt: '2026-06-01T09:30:00.000Z', amountCents: 20000 }],
        },
      ],
      customers: CUSTOMERS,
      today: TODAY_S1,
    });
    expect(entries[0]!.prescription).toMatchObject({ anchor: '2026-06-01', deadline: '2031-06-01' });
    // Et les pénalités portent sur le reste dû (netToPay − paid), pas le TTC d'origine.
    expect(entries[0]!.amountCents).toBe(104000);
  });

  it('B2G échue 40 j : BCE+8, MED chiffrée en intérêts moratoires, déchéance quadriennale', () => {
    const entries = deriveRelancePlan({
      invoices: [
        { ...invoiceFixture({ id: 'inv-40j', customerId: 'cust-3', dueAt: '2026-05-11' }), issuedAt: '2026-04-11' },
      ],
      customers: CUSTOMERS,
      today: TODAY_S1,
    });
    const med = entries[0]!;
    expect(med.penalties).toMatchObject({ rateAnnualPct: 10.15, rateBasis: 'bce_plus_8', interestCents: 1379 });
    expect(med.message.body).toContain("d'interets moratoires");
    expect(med.message.body).toContain('293,79'); // 1 240 + 13,79 + 40 = 1 293,79 €
    expect(med.prescription).toMatchObject({ deadline: '2030-12-31' }); // 31/12 de (2026 + 4)
    expect(med.prescription!.legalRef).toContain('68-1250');
  });

  it('B2C : aucune MED envoyée connue → pénalités à 0 (jamais 40 €), lettre SANS chiffres, biennale prudente', () => {
    const entries = deriveRelancePlan({
      invoices: [
        { ...invoiceFixture({ id: 'inv-40j', customerId: 'cust-2', dueAt: '2026-05-11' }), issuedAt: '2026-04-11' },
      ],
      customers: CUSTOMERS,
      today: TODAY_S1,
    });
    const med = entries[0]!;
    expect(med.penalties).toMatchObject({
      interestCents: 0,
      fixedIndemnityCents: 0,
      days: 0,
      rateBasis: 'taux_legal',
    });
    expect(med.message.body).not.toContain('soit un total');
    expect(med.message.body).not.toContain('40 €');
    expect(med.message.body).not.toContain('indemnite');
    expect(med.prescription).toMatchObject({ anchor: '2026-04-11', deadline: '2028-04-11' }); // min(émission, échéance)
    expect(med.prescription!.legalRef).toContain('L218-2');
  });

  it('données manquantes → null, jamais d’invention : sans échéance ni émission, ni pénalités ni prescription', () => {
    const entries = deriveRelancePlan({
      invoices: [invoiceFixture({ id: 'inv-late-sans-date', status: 'late', dueAt: null })],
      customers: CUSTOMERS,
      today: TODAY_S1,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.penalties).toBeNull();
    expect(entries[0]!.prescription).toBeNull();
  });

  it('semestre hors référentiel (TODAY en S2 2026) → pénalités au dernier taux CONNU, stale signalé', () => {
    const entries = plan({ invoices: [invoiceFixture({ id: 'inv-40j', dueAt: dueDaysAgo(40) })] });
    expect(entries[0]!.penalties).toMatchObject({ stale: true, rateAnnualPct: 12.15 });
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
