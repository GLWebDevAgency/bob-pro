import { describe, expect, it } from 'vitest';
import { derivePrescription, type DerivePrescriptionInput } from './prescription';

const AS_OF = '2026-07-04';

function derive(overrides: Partial<DerivePrescriptionInput>) {
  return derivePrescription({
    issuedAt: '2026-06-01',
    dueAt: '2026-07-01',
    customerType: 'b2b',
    acknowledgments: [],
    asOf: AS_OF,
    ...overrides,
  });
}

describe('derivePrescription — b2b (L110-4 C. com, 5 ans)', () => {
  it('ancre = exigibilité (échéance) → deadline à +5 ans, lointaine', () => {
    const p = derive({});
    expect(p).not.toBeNull();
    expect(p!.anchor).toBe('2026-07-01');
    expect(p!.deadline).toBe('2031-07-01');
    expect(p!.daysLeft).toBe(1823);
    expect(p!.urgency).toBe('lointaine');
    expect(p!.legalRef).toContain('L110-4');
  });

  it('échéance absente → repli PRUDENT sur l’émission', () => {
    const p = derive({ dueAt: null });
    expect(p!.anchor).toBe('2026-06-01');
    expect(p!.deadline).toBe('2031-06-01');
  });

  it('deadline dépassée → prescrite, daysLeft négatif', () => {
    const p = derive({ issuedAt: '2021-01-10', dueAt: '2021-03-10' });
    expect(p!.deadline).toBe('2026-03-10');
    expect(p!.daysLeft).toBe(-116);
    expect(p!.urgency).toBe('prescrite');
  });

  it('paiement partiel (art. 2240) → la reconnaissance la plus récente RÉ-ANCRE le délai', () => {
    const p = derive({
      issuedAt: '2021-01-10',
      dueAt: '2021-03-10',
      acknowledgments: ['2022-05-02', '2024-01-15'],
    });
    expect(p!.anchor).toBe('2024-01-15');
    expect(p!.deadline).toBe('2029-01-15');
    expect(p!.urgency).toBe('lointaine');
  });

  it('reconnaissances non pertinentes ignorées : datées dans le futur ou antérieures à l’ancre', () => {
    const future = derive({ acknowledgments: ['2026-09-01'] });
    expect(future!.anchor).toBe('2026-07-01'); // > asOf : ignorée
    const before = derive({ acknowledgments: ['2020-01-01'] });
    expect(before!.anchor).toBe('2026-07-01'); // antérieure à l'ancre : n'allonge rien
  });

  it("l'explication rappelle qu'une relance n'interrompt JAMAIS en droit privé (Cass. com. 18/5/2022)", () => {
    const p = derive({});
    expect(p!.explain).toContain("ne l'interrompt PAS");
    expect(p!.explain).toContain('paiement partiel');
  });

  it('paliers d’urgence : prescrite < aujourd’hui ≤ urgente < 90 j ≤ a_surveiller < 365 j ≤ lointaine', () => {
    expect(derive({ dueAt: '2021-07-04' })!.urgency).toBe('urgente'); // deadline = asOf : dernier jour utile
    expect(derive({ dueAt: '2021-08-01' })!.urgency).toBe('urgente'); // 28 j restants
    expect(derive({ dueAt: '2021-12-01' })!.urgency).toBe('a_surveiller'); // 150 j
    expect(derive({ dueAt: '2022-07-04' })!.urgency).toBe('lointaine'); // 365 j pile
  });
});

describe('derivePrescription — b2c (L218-2 C. conso, 2 ans, ancre prudente)', () => {
  it('ancre PRUDENTE = min(émission, échéance) — jurisprudence achèvement (Cass. 1re civ. 19/5/2021)', () => {
    const p = derive({ customerType: 'b2c' });
    expect(p!.anchor).toBe('2026-06-01'); // l'émission, antérieure à l'échéance
    expect(p!.deadline).toBe('2028-06-01');
    expect(p!.legalRef).toContain('L218-2');
  });

  it('si l’échéance précède l’émission, c’est elle la plus prudente', () => {
    const p = derive({ customerType: 'b2c', issuedAt: '2026-06-01', dueAt: '2026-05-01' });
    expect(p!.anchor).toBe('2026-05-01');
    expect(p!.deadline).toBe('2028-05-01');
  });

  it('2 ans seulement : une facture b2c de 2023 est déjà prescrite', () => {
    const p = derive({ customerType: 'b2c', issuedAt: '2023-05-01', dueAt: '2023-06-01' });
    expect(p!.deadline).toBe('2025-05-01');
    expect(p!.urgency).toBe('prescrite');
  });
});

describe('derivePrescription — b2g (loi 68-1250, déchéance quadriennale)', () => {
  it('deadline = 31/12 de (année du fait générateur + 4), référence légale distincte', () => {
    const p = derive({ customerType: 'b2g', issuedAt: '2026-03-15', dueAt: '2026-04-15' });
    expect(p!.anchor).toBe('2026-03-15');
    expect(p!.deadline).toBe('2030-12-31');
    expect(p!.legalRef).toContain('68-1250');
    expect(p!.legalRef).not.toContain('L110-4');
  });

  it("explain : une RÉCLAMATION ÉCRITE interrompt (régime inversé par rapport au droit privé)", () => {
    const p = derive({ customerType: 'b2g' });
    expect(p!.explain).toContain('RECLAMATION ECRITE');
    expect(p!.explain).toContain('interrompt');
  });

  it('paiement partiel de l’administration → interruption : ré-ancre, même formule 31/12 de N+4', () => {
    const p = derive({
      customerType: 'b2g',
      issuedAt: '2022-03-15',
      dueAt: '2022-04-15',
      acknowledgments: ['2024-06-01'],
    });
    expect(p!.anchor).toBe('2024-06-01');
    expect(p!.deadline).toBe('2028-12-31'); // sans reconnaissance : 2026-12-31
  });
});

describe('derivePrescription — garde-fous', () => {
  it('aucune date d’ancrage (ni émission ni échéance) → null, jamais d’invention', () => {
    expect(derive({ issuedAt: null, dueAt: null })).toBeNull();
    expect(derive({ customerType: 'b2c', issuedAt: null, dueAt: null })).toBeNull();
    expect(derive({ customerType: 'b2g', issuedAt: null, dueAt: null })).toBeNull();
  });
});
