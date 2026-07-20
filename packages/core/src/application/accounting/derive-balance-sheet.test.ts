import { describe, expect, it } from 'vitest';
import { deriveBalanceSheet, type BalanceSheetEntryData } from './derive-balance-sheet';
import { deriveIncomeStatement } from './derive-income-statement';
import { deriveTrialBalance } from './derive-trial-balance';

function e(lines: { account: string; debitCents: number; creditCents: number }[]): BalanceSheetEntryData {
  return { lines };
}

/**
 * Petite entreprise complète et ÉQUILIBRÉE (Σ débits = Σ crédits) : apport de capital,
 * achat de matériel amorti, prestation encaissée, achat fournisseur non payé.
 */
const COMPANY: BalanceSheetEntryData[] = [
  e([{ account: '512', debitCents: 500000, creditCents: 0 }, { account: '101', debitCents: 0, creditCents: 500000 }]), // apport
  e([{ account: '215', debitCents: 200000, creditCents: 0 }, { account: '512', debitCents: 0, creditCents: 200000 }]), // matériel
  e([{ account: '6811', debitCents: 40000, creditCents: 0 }, { account: '2815', debitCents: 0, creditCents: 40000 }]), // amortissement
  e([
    { account: '411', debitCents: 120000, creditCents: 0 },
    { account: '706', debitCents: 0, creditCents: 100000 },
    { account: '44571', debitCents: 0, creditCents: 20000 },
  ]), // prestation facturée
  e([{ account: '512', debitCents: 120000, creditCents: 0 }, { account: '411', debitCents: 0, creditCents: 120000 }]), // encaissement
  e([
    { account: '606', debitCents: 30000, creditCents: 0 },
    { account: '44566', debitCents: 6000, creditCents: 0 },
    { account: '401', debitCents: 0, creditCents: 36000 },
  ]), // achat non payé
];

describe('deriveBalanceSheet (BILAN-1 — le bilan que l’expert associé signe)', () => {
  it('classe l’actif : immobilisations NETTES (28 contra), stocks, créances, disponibilités', () => {
    const b = deriveBalanceSheet(COMPANY);
    expect(b.actif.immobilisationsNettesCents).toBe(160000); // 215 (200 000) − amort. 2815 (40 000)
    expect(b.actif.creancesCents).toBe(6000); // 44566 débiteur (TVA déductible)
    expect(b.actif.disponibilitesCents).toBe(420000); // 512 : 500 − 200 + 120
    expect(b.actif.totalCents).toBe(586000);
  });

  it('classe le passif : capitaux propres + RÉSULTAT affecté, dettes par signe', () => {
    const b = deriveBalanceSheet(COMPANY);
    expect(b.passif.capitauxPropresCents).toBe(500000); // 101
    expect(b.passif.resultatNetCents).toBe(30000); // 100 000 − 40 000 − 30 000
    expect(b.passif.dettesCents).toBe(56000); // 401 (36 000 créditeur) + 44571 (20 000 créditeur)
    expect(b.passif.totalCents).toBe(586000);
  });

  it('INVARIANT : actif = passif (le résultat non clôturé affecté aux capitaux propres équilibre)', () => {
    const b = deriveBalanceSheet(COMPANY);
    expect(b.balanced).toBe(true);
    expect(b.ecartCents).toBe(0);
    expect(b.actif.totalCents).toBe(b.passif.totalCents);
  });

  it('COHÉRENCE inter-états : résultat du bilan = résultat du compte de résultat = résultat provisoire', () => {
    const b = deriveBalanceSheet(COMPANY);
    expect(b.passif.resultatNetCents).toBe(deriveIncomeStatement(COMPANY).resultatNetCents);
    expect(b.passif.resultatNetCents).toBe(deriveTrialBalance(COMPANY).resultCents);
  });

  it('PAR SIGNE : un compte de tiers change de côté selon son solde (512 découvert, 401 avance)', () => {
    const b = deriveBalanceSheet([
      e([{ account: '512', debitCents: 0, creditCents: 15000 }, { account: '401', debitCents: 15000, creditCents: 0 }]),
    ]);
    expect(b.actif.disponibilitesCents).toBe(0);
    expect(b.passif.decouvertCents).toBe(15000); // 512 créditeur = découvert au passif
    expect(b.passif.dettesCents).toBe(0);
    expect(b.actif.creancesCents).toBe(15000); // 401 débiteur (fournisseur trop payé) = créance à l'actif
  });

  it('provisions (15) et emprunts (16) au passif ; vide → zéros équilibrés', () => {
    const b = deriveBalanceSheet([
      e([{ account: '164', debitCents: 0, creditCents: 300000 }, { account: '512', debitCents: 300000, creditCents: 0 }]),
    ]);
    expect(b.passif.empruntsCents).toBe(300000);
    expect(b.actif.disponibilitesCents).toBe(300000);
    expect(b.balanced).toBe(true);

    const empty = deriveBalanceSheet([]);
    expect(empty.actif.totalCents).toBe(0);
    expect(empty.passif.totalCents).toBe(0);
    expect(empty.balanced).toBe(true);
  });
});
