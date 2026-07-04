import { describe, expect, it } from 'vitest';
import { deriveTrialBalance } from './derive-trial-balance';

/** Le seed démo en miniature : une vente encaissée + un achat payé. */
const ENTRIES = [
  {
    // Vente 488,40 TTC : 411 D / 4191 C 407,00 / 44571 C 81,40
    lines: [
      { account: '411', debitCents: 48840, creditCents: 0 },
      { account: '4191', debitCents: 0, creditCents: 40700 },
      { account: '44571', debitCents: 0, creditCents: 8140 },
    ],
  },
  {
    // Encaissement : 512 D / 411 C
    lines: [
      { account: '512', debitCents: 48840, creditCents: 0 },
      { account: '411', debitCents: 0, creditCents: 48840 },
    ],
  },
  {
    // Achat 184,90 TTC : 606 D 154,08 / 44566 D 30,82 / 401 C
    lines: [
      { account: '606', debitCents: 15408, creditCents: 0 },
      { account: '44566', debitCents: 3082, creditCents: 0 },
      { account: '401', debitCents: 0, creditCents: 18490 },
    ],
  },
  {
    // Prestation facturée 100,00 HT : 411 D 120,00 / 706 C 100,00 / 44571 C 20,00
    lines: [
      { account: '411', debitCents: 12000, creditCents: 0 },
      { account: '706', debitCents: 0, creditCents: 10000 },
      { account: '44571', debitCents: 0, creditCents: 2000 },
    ],
  },
];

describe('deriveTrialBalance (CLOTURE-1 — la balance que l’expert associé ouvre en premier)', () => {
  it('cumule par compte, trie par numéro, solde signé (+ débiteur / − créditeur)', () => {
    const b = deriveTrialBalance(ENTRIES);
    expect(b.rows.map((r) => r.account)).toEqual(['401', '411', '4191', '44566', '44571', '512', '606', '706']);
    const c411 = b.rows.find((r) => r.account === '411');
    expect(c411).toEqual({ account: '411', debitCents: 60840, creditCents: 48840, balanceCents: 12000 });
    const c401 = b.rows.find((r) => r.account === '401');
    expect(c401?.balanceCents).toBe(-18490); // créditeur : dette fournisseur vivante
  });

  it('équilibre global au centime (partie double sur l’ensemble des comptes)', () => {
    const b = deriveTrialBalance(ENTRIES);
    expect(b.totalDebitCents).toBe(b.totalCreditCents);
    expect(b.balanced).toBe(true);
  });

  it('résultat provisoire = produits (7) − charges (6) — bénéfice positif, jambes exposées', () => {
    const b = deriveTrialBalance(ENTRIES);
    expect(b.revenueCents).toBe(10000); // 706
    expect(b.chargesCents).toBe(15408); // 606
    expect(b.resultCents).toBe(-5408); // perte provisoire honnête (les 4191 ne sont PAS du produit)
  });

  it('vide : zéros, équilibré, résultat nul — jamais un chiffre inventé', () => {
    expect(deriveTrialBalance([])).toEqual({
      rows: [],
      totalDebitCents: 0,
      totalCreditCents: 0,
      balanced: true,
      resultCents: 0,
      revenueCents: 0,
      chargesCents: 0,
    });
  });
});
