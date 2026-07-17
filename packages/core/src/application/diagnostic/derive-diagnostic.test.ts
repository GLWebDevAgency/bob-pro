import { describe, it, expect } from 'vitest';
import { runDiagnostic, type DiagnosticInput } from '../../domain/compliance/diagnostic';
import {
  deriveDiagnostic,
  type DeriveDiagnosticInput,
  type DiagCustomerData,
  type DiagInvoiceData,
} from './derive-diagnostic';

/** Faits réels via le MOTEUR du domaine (zéro duplication : mêmes échéances, mêmes acquis). */
function facts(overrides: Partial<DiagnosticInput> = {}) {
  return runDiagnostic({
    country: 'FR',
    trade: 'plombier',
    vatRegime: 'reel_normal',
    customerTypes: ['b2c'],
    hasDecennale: true,
    asOf: '2026-07-03',
    ...overrides,
  });
}

function invoice(overrides: Partial<DiagInvoiceData> & Pick<DiagInvoiceData, 'id' | 'customerId'>): DiagInvoiceData {
  return {
    kind: 'final',
    status: 'paid',
    ttcCents: 120_000,
    lineCategories: ['labor', 'supply'],
    ...overrides,
  };
}

function input(overrides: Partial<DeriveDiagnosticInput> = {}): DeriveDiagnosticInput {
  return {
    facts: facts(),
    customers: [],
    invoices: [],
    payments: [],
    profile: { trade: 'plombier' },
    answers: {},
    today: '2026-07-03',
    companySize: 'tpe_pme',
    ...overrides,
  };
}

const B2C: DiagCustomerData[] = [
  { id: 'c1', type: 'b2c', siren: null },
  { id: 'c2', type: 'b2c', siren: null },
];

describe('deriveDiagnostic — audit expert-comptable (C23 v2)', () => {
  it('artisan b2c pur : e-reporting seul, pas de canal B2B/B2G, réception critique datée 2026-09-01', () => {
    const r = deriveDiagnostic(input({ customers: B2C, invoices: [invoice({ id: 'i1', customerId: 'c1' })] }));
    const kinds = r.items.map((i) => i.kind);

    expect(kinds).toContain('ereporting_sales');
    expect(kinds).not.toContain('emission_einvoicing');
    expect(kinds).not.toContain('chorus_pro');
    expect(kinds).not.toContain('siren_missing'); // aucun client pro → item non pertinent

    const reception = r.items.find((i) => i.kind === 'reception_platform');
    expect(reception).toMatchObject({ done: false, severity: 'critical', axis: 'reception' });
    // Échéance LUE dans les faits du domaine (jamais re-déclarée dans le use case).
    expect(reception?.deadline).toBe(facts().items.find((i) => i.id === 'einvoice-reception')?.dueDate);
    expect(reception?.deadline).toBe('2026-09-01');

    // Questionnaire adaptatif : l'exposition B2C déclenche la question caisse.
    expect(r.questions).toEqual(['platform', 'offAppSales', 'accountant']);
    expect(r.mix.b2c.channel).toBe('ereporting');
  });

  it('mixte BTP : Chorus acquis (b2g), e-invoicing B2B daté 2027, décennale relayée du dossier', () => {
    const customers: DiagCustomerData[] = [
      { id: 'c1', type: 'b2c', siren: null },
      { id: 'c2', type: 'b2b', siren: '732829320' },
      { id: 'c3', type: 'b2g', siren: '110014016' },
    ];
    const r = deriveDiagnostic(
      input({
        facts: facts({ trade: 'macon', customerTypes: ['b2c', 'b2b', 'b2g'], hasDecennale: false }),
        customers,
        invoices: [invoice({ id: 'i1', customerId: 'c2', ttcCents: 500_000 })],
        profile: { trade: 'macon' },
      }),
    );

    expect(r.items.find((i) => i.kind === 'chorus_pro')).toMatchObject({ done: true, axis: 'emission' });
    const emission = r.items.find((i) => i.kind === 'emission_einvoicing');
    expect(emission).toMatchObject({ done: false, severity: 'important', deadline: '2027-09-01' });
    // Décennale non à jour → critique (sévérité du domaine), axe qualité (mention devis/factures).
    expect(r.items.find((i) => i.kind === 'decennale')).toMatchObject({ done: false, severity: 'critical' });
    expect(r.mix.b2b.volumeCents).toBe(500_000);
    expect(r.mix.b2b.channel).toBe('pa');
    expect(r.mix.b2g.channel).toBe('chorus_pro');
  });

  it('ne fabrique aucune échéance d’émission quand la taille réelle de société est inconnue', () => {
    const unknownSizeInput = input({
      facts: facts({ customerTypes: ['b2b'] }),
      customers: [{ id: 'c1', type: 'b2b', siren: '732829320' }],
    });
    delete unknownSizeInput.companySize;
    const r = deriveDiagnostic(unknownSizeInput);
    expect(r.items.find((item) => item.kind === 'emission_einvoicing')?.deadline).toBeNull();
  });

  it('b2b avec SIREN manquants : count + route fiche client (1 manquant) ou carnet (plusieurs)', () => {
    const one = deriveDiagnostic(
      input({
        facts: facts({ customerTypes: ['b2b'] }),
        customers: [
          { id: 'c1', type: 'b2b', siren: '732829320' },
          { id: 'c2', type: 'b2b', siren: null },
        ],
      }),
    );
    const oneItem = one.items.find((i) => i.kind === 'siren_missing');
    expect(oneItem).toMatchObject({ done: false, count: 1, route: '/client/c2', detailKey: 'diag.itemSirenTodoOne' });
    // Pas d'exposition B2C → pas de question caisse (2 questions seulement).
    expect(one.questions).toEqual(['platform', 'accountant']);

    const many = deriveDiagnostic(
      input({
        facts: facts({ customerTypes: ['b2b'] }),
        customers: [
          { id: 'c1', type: 'b2b', siren: null },
          { id: 'c2', type: 'b2b', siren: null },
          { id: 'c3', type: 'b2g', siren: null },
        ],
      }),
    );
    const manyItem = many.items.find((i) => i.kind === 'siren_missing');
    expect(manyItem).toMatchObject({ done: false, count: 3, route: '/(tabs)/clients', detailKey: 'diag.itemSirenTodo' });
  });

  it('franchise 293 B : constat présent mais AUCUNE dispense — réception et e-reporting restent dus', () => {
    const r = deriveDiagnostic(
      input({ facts: facts({ vatRegime: 'franchise' }), customers: B2C }),
    );
    expect(r.items.find((i) => i.kind === 'franchise_scope')).toMatchObject({ done: true, source: 'dossier' });
    // Le piège codé : la franchise reste assujettie, les obligations sont identiques.
    expect(r.items.find((i) => i.kind === 'reception_platform')?.done).toBe(false);
    expect(r.items.find((i) => i.kind === 'ereporting_sales')?.done).toBe(false);
  });

  it('dossier parfait = 100 : plateforme choisie, tout centralisé, comptable prévenu, fiches complètes', () => {
    const r = deriveDiagnostic(
      input({
        facts: facts({ customerTypes: ['b2c', 'b2b'] }),
        customers: [
          { id: 'c1', type: 'b2c', siren: null },
          { id: 'c2', type: 'b2b', siren: '732829320' },
        ],
        invoices: [invoice({ id: 'i1', customerId: 'c2' })],
        payments: [{ invoiceId: 'i1', amountCents: 120_000 }],
        answers: { platform: 'yes', offAppSales: 'no', accountant: 'yes' },
      }),
    );
    expect(r.items.every((i) => i.done)).toBe(true);
    expect(r.axes.map((a) => a.score)).toEqual([100, 100, 100]);
    expect(r.score).toBe(100);
  });

  it('réception surpondérée avant le 01/09/2026 : le même dossier pèse plus lourd avant l’échéance', () => {
    const base = input({ customers: B2C, answers: { offAppSales: 'no', accountant: 'yes' } });
    // Seule la réception est à faire (platform inconnue) → axes émission/données quasi parfaits.
    const before = deriveDiagnostic(base);
    const after = deriveDiagnostic({ ...base, today: '2026-09-02' });
    expect(before.score).toBeLessThan(after.score);

    // Les items « à faire » passent devant les acquis, critique en tête.
    expect(before.items[0]?.kind).toBe('reception_platform');
    const firstDoneIndex = before.items.findIndex((i) => i.done);
    expect(before.items.slice(firstDoneIndex).every((i) => i.done)).toBe(true);
  });
});
