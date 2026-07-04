import { describe, expect, it } from 'vitest';
import { deriveIncomeStatement, type IncomeStatementEntryData } from './derive-income-statement';
import { deriveTrialBalance } from './derive-trial-balance';

/** Une écriture réduite à une ligne compte/montant (les tests posent des soldes directs). */
function line(account: string, debitCents: number, creditCents: number): IncomeStatementEntryData {
  return { lines: [{ account, debitCents, creditCents }] };
}

describe('deriveIncomeStatement (CDR-1 — compte de résultat normé français)', () => {
  it('cascade des 4 résultats intermédiaires sur un cas complet', () => {
    const s = deriveIncomeStatement([
      line('706', 0, 100000), // prestation 1000 € → produit d'exploitation
      line('607', 40000, 0), // achat marchandises 400 € → charge d'exploitation
      line('6811', 10000, 0), // dotation amortissement → EXPLOITATION (681, pas 68)
      line('761', 0, 5000), // revenus de participation 50 € → produit financier
      line('661', 3000, 0), // charge d'intérêts 30 € → charge financière
      line('775', 0, 20000), // produit de cession d'actif 200 € → EXCEPTIONNEL
      line('675', 8000, 0), // VNC de l'actif cédé 80 € → EXCEPTIONNEL
    ]);
    expect(s.exploitationProduitsCents).toBe(100000);
    expect(s.exploitationChargesCents).toBe(50000); // 400 + 100 dotation
    expect(s.resultatExploitationCents).toBe(50000);
    expect(s.resultatFinancierCents).toBe(2000); // 50 − 30
    expect(s.resultatCourantCents).toBe(52000);
    expect(s.resultatExceptionnelCents).toBe(12000); // 200 − 80 (plus-value de cession)
    expect(s.resultatNetCents).toBe(64000);
  });

  it('INVARIANT : résultat net = classe 7 − classe 6 (= résultat provisoire de la balance)', () => {
    const entries: IncomeStatementEntryData[] = [
      line('706', 0, 154167),
      line('44571', 0, 30833), // TVA (classe 4) : ignorée, ni produit ni charge
      line('411', 185000, 0), // client (classe 4) : ignoré
      line('606', 15408, 0),
      line('661', 4200, 0),
      line('761', 0, 900),
      line('6811', 3000, 0),
    ];
    const is = deriveIncomeStatement(entries);
    const tb = deriveTrialBalance(entries);
    // La ventilation fine ne change JAMAIS le total : elle le décompose.
    expect(is.resultatNetCents).toBe(tb.resultCents);
  });

  it('PIÈGE dotations 68 : 681 exploitation, 686 financier, 687 exceptionnel (jamais « 68 » nu)', () => {
    const s = deriveIncomeStatement([
      line('6811', 10000, 0), // 681 → exploitation
      line('6866', 4000, 0), // 686 → financier
      line('6871', 2000, 0), // 687 → exceptionnel
    ]);
    expect(s.exploitationChargesCents).toBe(10000);
    expect(s.financierChargesCents).toBe(4000);
    expect(s.exceptionnelChargesCents).toBe(2000);
  });

  it('PIÈGES de classement : 63 impôts/taxes ≠ 695 IS · 65 créances irrécouvrables = exploitation · 691 ≠ 695', () => {
    const s = deriveIncomeStatement([
      line('635', 5000, 0), // impôts et taxes (CFE) → EXPLOITATION
      line('654', 3000, 0), // créance irrécouvrable → EXPLOITATION (65), pas exceptionnel
      line('691', 1000, 0), // participation salariés → sous le courant, AVANT IS
      line('695', 12000, 0), // impôt sur les bénéfices → poste terminal
    ]);
    expect(s.exploitationChargesCents).toBe(8000); // 635 + 654
    expect(s.participationCents).toBe(1000);
    expect(s.impotBeneficesCents).toBe(12000);
    // net avant impôt déduit la participation mais PAS l'IS ; net déduit l'IS.
    expect(s.resultatNetAvantImpotCents).toBe(-9000); // 0 − 8000 − 1000
    expect(s.resultatNetCents).toBe(-21000); // − 12000 IS
  });

  it('RRR à contre-sens : 709 accordés (débit) minorent les ventes, 609 obtenus (crédit) minorent les achats', () => {
    const s = deriveIncomeStatement([
      line('706', 0, 100000), // ventes 1000
      line('709', 5000, 0), // RRR accordés −50 (débit dans un compte de produit)
      line('607', 40000, 0), // achats 400
      line('609', 0, 8000), // RRR obtenus −80 (crédit dans un compte de charge)
    ]);
    expect(s.exploitationProduitsCents).toBe(95000); // 1000 − 50
    expect(s.exploitationChargesCents).toBe(32000); // 400 − 80
  });

  it('artisan à l’IR (classe 69 absente) : net avant impôt = net (aucune correction), vide → zéros', () => {
    const s = deriveIncomeStatement([line('706', 0, 80000), line('606', 30000, 0)]);
    expect(s.participationCents).toBe(0);
    expect(s.impotBeneficesCents).toBe(0);
    expect(s.resultatNetAvantImpotCents).toBe(s.resultatNetCents);
    expect(s.resultatNetCents).toBe(50000);
    expect(deriveIncomeStatement([]).resultatNetCents).toBe(0);
  });
});
