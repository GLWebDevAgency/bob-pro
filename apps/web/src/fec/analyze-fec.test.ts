import { FEC_HEADERS } from '@bob/core';
import { describe, expect, it } from 'vitest';

import { analyzeFec, deriveFecClosingReview } from './analyze-fec';
import { parseFec } from './parse-fec';

type Header = (typeof FEC_HEADERS)[number];

function row(overrides: Partial<Record<Header, string>>): string {
  const defaults: Record<Header, string> = {
    JournalCode: 'OD',
    JournalLib: 'Operations diverses',
    EcritureNum: '000001',
    EcritureDate: '20241231',
    CompteNum: '512',
    CompteLib: 'Banque',
    CompAuxNum: '',
    CompAuxLib: '',
    PieceRef: 'TEST',
    PieceDate: '20241231',
    EcritureLib: 'Test',
    Debit: '0,00',
    Credit: '0,00',
    EcritureLet: '',
    DateLet: '',
    ValidDate: '20241231',
    Montantdevise: '',
    Idevise: '',
  };
  const values = { ...defaults, ...overrides };
  return FEC_HEADERS.map((header) => values[header]).join('\t');
}

function parse(lines: readonly string[]) {
  const text = `${FEC_HEADERS.join('\t')}\n${lines.join('\n')}\n`;
  return parseFec(new TextEncoder().encode(text));
}

describe('analyzeFec', () => {
  it('derive les trois etats du core, les libelles, le CA 70x et les invariants croises', () => {
    const fec = parse([
      row({ JournalCode: 'OD', CompteNum: '512', CompteLib: 'Banque', Debit: '5000,00' }),
      row({ JournalCode: 'OD', CompteNum: '101', CompteLib: 'Capital social', Credit: '5000,00' }),
      row({
        JournalCode: 'AC',
        CompteNum: '606',
        CompteLib: 'Achats non stockes',
        Debit: '300,00',
      }),
      row({ JournalCode: 'AC', CompteNum: '44566', CompteLib: 'TVA deductible', Debit: '60,00' }),
      row({ JournalCode: 'AC', CompteNum: '401', CompteLib: 'Fournisseurs', Credit: '360,00' }),
      row({ JournalCode: 'VE', CompteNum: '411', CompteLib: 'Clients', Debit: '1200,00' }),
      row({
        JournalCode: 'VE',
        CompteNum: '706',
        CompteLib: 'Prestations de services',
        Credit: '1000,00',
      }),
      row({ JournalCode: 'VE', CompteNum: '44571', CompteLib: 'TVA collectee', Credit: '200,00' }),
      row({ JournalCode: 'BQ', CompteNum: '512', CompteLib: 'Banque', Debit: '1200,00' }),
      row({ JournalCode: 'BQ', CompteNum: '411', CompteLib: 'Clients', Credit: '1200,00' }),
      // Produit non-CA : il augmente le resultat, jamais le chiffre d'affaires 70x.
      row({
        JournalCode: 'OD',
        EcritureNum: '000002',
        CompteNum: '512',
        CompteLib: 'Banque',
        Debit: '50,00',
      }),
      row({
        JournalCode: 'OD',
        EcritureNum: '000002',
        CompteNum: '758',
        CompteLib: 'Produits divers',
        Credit: '50,00',
      }),
    ]);

    const analysis = analyzeFec(fec);

    expect(analysis.trialBalance.balanced).toBe(true);
    expect(analysis.trialBalance.rows.find((item) => item.account === '706')).toMatchObject({
      label: 'Prestations de services',
      creditCents: 100_000,
    });
    expect(analysis.turnoverCents).toBe(100_000);
    expect(analysis.incomeStatement.resultatNetCents).toBe(75_000);
    expect(analysis.balanceSheet.passif.resultatNetCents).toBe(75_000);
    expect(analysis.balanceSheet.balanced).toBe(true);
    expect(analysis.unbalancedEntries).toEqual([]);
    expect(analysis.checks).toEqual({
      entriesBalanced: true,
      trialBalanceBalanced: true,
      balanceSheetBalanced: true,
      resultConsistent: true,
      allPassed: true,
    });
  });

  it('analyse sans rejet un FEC desequilibre et expose ecarts et controles rouges', () => {
    const fec = parse([
      row({ JournalCode: 'VE', CompteNum: '706', CompteLib: 'Prestations', Credit: '100,00' }),
    ]);

    const analysis = analyzeFec(fec);

    expect(analysis.trialBalance.balanced).toBe(false);
    expect(analysis.balanceSheet.balanced).toBe(false);
    expect(analysis.unbalancedEntries).toEqual([
      expect.objectContaining({
        journalCode: 'VE',
        entryNumber: '000001',
        totalDebitCents: 0,
        totalCreditCents: 10_000,
        differenceCents: -10_000,
      }),
    ]);
    // Les trois moteurs restent coherents entre eux meme si la partie double ne tient pas.
    expect(analysis.checks).toMatchObject({
      entriesBalanced: false,
      trialBalanceBalanced: false,
      balanceSheetBalanced: false,
      resultConsistent: true,
      allPassed: false,
    });
  });

  it('donne un libelle de repli honnete lorsque CompteLib est vide', () => {
    const analysis = analyzeFec(parse([row({ CompteNum: '512', CompteLib: '', Debit: '1,00' })]));

    expect(analysis.trialBalance.rows[0]?.label).toBe('Compte 512');
  });

  it('branche la revue de cloture core et durcit les avances 4191 en fin exercice', () => {
    const fec = parse([
      row({ CompteNum: '512', CompteLib: 'Banque', Debit: '300,00' }),
      row({ CompteNum: '4191', CompteLib: 'Avances clients', Credit: '300,00' }),
    ]);

    const monthly = deriveFecClosingReview(fec);
    const yearEnd = deriveFecClosingReview(fec, { yearEnd: true });
    const monthlyAdvance = monthly.controls.find((control) => control.id === 'avances_4191');
    const yearEndAdvance = yearEnd.controls.find((control) => control.id === 'avances_4191');

    expect(monthlyAdvance?.status).toBe('info');
    expect(yearEndAdvance?.status).toBe('attention');
    expect(yearEnd.hasReserves).toBe(true);
    expect(yearEnd.anomalieCount).toBe(0);
  });
});
