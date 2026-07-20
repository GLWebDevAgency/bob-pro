import { describe, expect, it } from 'vitest';
import {
  cabinetDossierAnalysisSha256,
  cabinetDossierUpsertInputSchema,
  normalizeCabinetDossierSiren,
  storedFecAnalysisSchema,
  type StoredFecAnalysis,
} from './cabinet-dossier-contract';

export function validStoredFecAnalysis(): StoredFecAnalysis {
  return {
    trialBalance: {
      rows: [
        { account: '101', label: 'Capital', debitCents: 0, creditCents: 10_000, balanceCents: -10_000 },
        { account: '512', label: 'Banque', debitCents: 10_000, creditCents: 0, balanceCents: 10_000 },
      ],
      totalDebitCents: 10_000,
      totalCreditCents: 10_000,
      balanced: true,
      resultCents: 0,
      revenueCents: 0,
      chargesCents: 0,
    },
    incomeStatement: {
      exploitationProduitsCents: 0,
      exploitationChargesCents: 0,
      resultatExploitationCents: 0,
      financierProduitsCents: 0,
      financierChargesCents: 0,
      resultatFinancierCents: 0,
      resultatCourantCents: 0,
      exceptionnelProduitsCents: 0,
      exceptionnelChargesCents: 0,
      resultatExceptionnelCents: 0,
      participationCents: 0,
      resultatNetAvantImpotCents: 0,
      impotBeneficesCents: 0,
      resultatNetCents: 0,
    },
    balanceSheet: {
      actif: {
        immobilisationsNettesCents: 0,
        stocksCents: 0,
        creancesCents: 0,
        disponibilitesCents: 10_000,
        totalCents: 10_000,
      },
      passif: {
        capitauxPropresCents: 10_000,
        resultatNetCents: 0,
        provisionsCents: 0,
        empruntsCents: 0,
        dettesCents: 0,
        decouvertCents: 0,
        totalCents: 10_000,
      },
      balanced: true,
      ecartCents: 0,
    },
    turnoverCents: 0,
    unbalancedEntries: [],
    checks: {
      entriesBalanced: true,
      trialBalanceBalanced: true,
      balanceSheetBalanced: true,
      resultConsistent: true,
      allPassed: true,
    },
  };
}

export function validDossierInput(expectedRevision: number | null = null) {
  return {
    siren: '552100554',
    clientName: '  Atelier   Martin  ',
    sourceFileName: '552100554FEC20251231.txt',
    entryCount: 1,
    rowCount: 2,
    period: { from: '2025-01-01', to: '2025-12-31' },
    analysis: validStoredFecAnalysis(),
    review: { verdict: 'ready', okCount: 4, attentionCount: 0, anomalyCount: 0, infoCount: 1 },
    fiscal: {
      legalForm: 'SASU',
      vatRegime: 'reel_normal',
      incomeTaxRegime: 'IS',
      fiscalYearEnd: '12-31',
      urssafPeriodicity: 'monthly',
      dateCreation: '2020-03-12',
    },
    expectedRevision,
  } as const;
}

describe('cabinet dossier FEC contract', () => {
  it('normalise un SIREN valide et refuse une clé de contrôle fausse', () => {
    expect(normalizeCabinetDossierSiren('552 100 554')).toBe('552100554');
    expect(normalizeCabinetDossierSiren('552100555')).toBeNull();
  });

  it('accepte une analyse cohérente, normalise le nom et produit une empreinte stable', () => {
    const parsed = cabinetDossierUpsertInputSchema.parse(validDossierInput());
    expect(parsed.clientName).toBe('Atelier Martin');
    expect(cabinetDossierAnalysisSha256(parsed.analysis)).toMatch(/^[a-f0-9]{64}$/);
    expect(cabinetDossierAnalysisSha256(parsed.analysis)).toBe(
      cabinetDossierAnalysisSha256(structuredClone(parsed.analysis)),
    );
  });

  it.each([
    ['total balance', (analysis: StoredFecAnalysis) => { analysis.trialBalance.totalDebitCents += 1; }],
    ['solde compte', (analysis: StoredFecAnalysis) => { analysis.trialBalance.rows[0]!.balanceCents = 0; }],
    ['résultat net', (analysis: StoredFecAnalysis) => { analysis.incomeStatement.resultatNetCents = 1; }],
    ['total bilan', (analysis: StoredFecAnalysis) => { analysis.balanceSheet.actif.totalCents = 9_999; }],
    ['CA 70x', (analysis: StoredFecAnalysis) => {
      analysis.trialBalance.rows.push({ account: '706', label: 'Prestations', debitCents: 0, creditCents: 500, balanceCents: -500 });
      analysis.trialBalance.rows.push({ account: '411', label: 'Clients', debitCents: 500, creditCents: 0, balanceCents: 500 });
      analysis.trialBalance.totalDebitCents += 500;
      analysis.trialBalance.totalCreditCents += 500;
    }],
    ['verdict global', (analysis: StoredFecAnalysis) => { analysis.checks.allPassed = false; }],
  ])('refuse une analyse dont %s est fabriqué', (_label, mutate) => {
    const analysis = validStoredFecAnalysis();
    mutate(analysis);
    expect(storedFecAnalysisSchema.safeParse(analysis).success).toBe(false);
  });

  it('refuse doublons de comptes, anomalies dupliquées et différences nulles', () => {
    const duplicateAccount = validStoredFecAnalysis();
    duplicateAccount.trialBalance.rows.push({ ...duplicateAccount.trialBalance.rows[0]! });
    duplicateAccount.trialBalance.totalCreditCents += 10_000;
    duplicateAccount.trialBalance.balanced = false;
    duplicateAccount.checks.trialBalanceBalanced = false;
    duplicateAccount.checks.allPassed = false;
    expect(storedFecAnalysisSchema.safeParse(duplicateAccount).success).toBe(false);

    const invalidAnomaly = validStoredFecAnalysis();
    invalidAnomaly.unbalancedEntries.push({
      key: 'VE:1',
      journalCode: 'VE',
      entryNumber: '1',
      entryDate: '2025-01-02',
      totalDebitCents: 100,
      totalCreditCents: 100,
      differenceCents: 0,
    });
    invalidAnomaly.checks.entriesBalanced = false;
    invalidAnomaly.checks.allPassed = false;
    expect(storedFecAnalysisSchema.safeParse(invalidAnomaly).success).toBe(false);
  });

  it('refuse les champs inconnus, une révision nulle ambiguë et les chemins de fichier', () => {
    expect(cabinetDossierUpsertInputSchema.safeParse({ ...validDossierInput(), invented: true }).success).toBe(false);
    expect(cabinetDossierUpsertInputSchema.safeParse({ ...validDossierInput(), expectedRevision: 0 }).success).toBe(false);
    expect(cabinetDossierUpsertInputSchema.safeParse({ ...validDossierInput(), sourceFileName: '../fec.txt' }).success).toBe(false);
  });
});
