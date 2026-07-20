import { describe, expect, it, vi } from 'vitest';
import { CabinetApiError, type CabinetDossierListItem } from './api';
import {
  dossierSummaryFromDetail,
  loadCabinetDossierPortfolio,
  replaceDossierSummary,
} from './dossier-portfolio';

function dossier(siren: string, cabinetId = 'cabinet-a'): CabinetDossierListItem {
  return {
    id: `dossier-${siren}`,
    cabinetId,
    revision: 1,
    createdAt: '2026-07-17T08:00:00.000Z',
    updatedAt: '2026-07-17T08:00:00.000Z',
    siren,
    clientName: `Client ${siren}`,
    sourceFileName: `${siren}FEC20261231.txt`,
    entryCount: 1,
    rowCount: 2,
    period: { from: '2026-01-01', to: '2026-12-31' },
    financial: {
      turnoverCents: 100,
      resultCents: 20,
      totalDebitCents: 100,
      totalCreditCents: 100,
      trialBalanceBalanced: true,
      balanceSheetBalanced: true,
      statementsConsistent: true,
      balanceSheetDifferenceCents: 0,
    },
    review: null,
    fiscal: {
      legalForm: 'SASU',
      vatRegime: 'reel_normal',
      incomeTaxRegime: 'IS',
      fiscalYearEnd: '12-31',
      urssafPeriodicity: null,
      dateCreation: null,
    },
    lastImportedAt: '2026-07-17T08:00:00.000Z',
  };
}

describe('portefeuille dossiers distant', () => {
  it('charge toutes les pages dans le cabinet demandé', async () => {
    const listDossiers = vi.fn()
      .mockResolvedValueOnce({ items: [dossier('732829320')], nextCursor: 'page-2', hasMore: true })
      .mockResolvedValueOnce({ items: [dossier('552100554')], nextCursor: null, hasMore: false });

    await expect(loadCabinetDossierPortfolio({ listDossiers }, 'cabinet-a'))
      .resolves.toHaveLength(2);
    expect(listDossiers).toHaveBeenNthCalledWith(1, 'cabinet-a', undefined);
    expect(listDossiers).toHaveBeenNthCalledWith(2, 'cabinet-a', 'page-2');
  });

  it.each([
    ['un dossier d’un autre tenant', [{ items: [dossier('732829320', 'cabinet-b')], nextCursor: null, hasMore: false }]],
    ['un SIREN dupliqué', [
      { items: [dossier('732829320')], nextCursor: 'page-2', hasMore: true },
      { items: [dossier('732829320')], nextCursor: null, hasMore: false },
    ]],
    ['un curseur cyclique', [
      { items: [], nextCursor: 'page-2', hasMore: true },
      { items: [], nextCursor: 'page-2', hasMore: true },
    ]],
  ])('échoue fermé devant %s', async (_label, pages) => {
    const listDossiers = vi.fn();
    for (const page of pages) listDossiers.mockResolvedValueOnce(page);
    await expect(loadCabinetDossierPortfolio({ listDossiers }, 'cabinet-a'))
      .rejects.toBeInstanceOf(CabinetApiError);
  });

  it('remplace une révision sans conserver l’analyse dans la liste', () => {
    const previous = dossier('732829320');
    const detail = {
      ...previous,
      revision: 2,
      analysisSha256: 'a'.repeat(64),
      analysis: {
        trialBalance: { rows: [], totalDebitCents: 0, totalCreditCents: 0, balanced: true, resultCents: 0, revenueCents: 0, chargesCents: 0 },
        incomeStatement: { exploitationProduitsCents: 0, exploitationChargesCents: 0, resultatExploitationCents: 0, financierProduitsCents: 0, financierChargesCents: 0, resultatFinancierCents: 0, resultatCourantCents: 0, exceptionnelProduitsCents: 0, exceptionnelChargesCents: 0, resultatExceptionnelCents: 0, participationCents: 0, resultatNetAvantImpotCents: 0, impotBeneficesCents: 0, resultatNetCents: 0 },
        balanceSheet: { actif: { immobilisationsNettesCents: 0, stocksCents: 0, creancesCents: 0, disponibilitesCents: 0, totalCents: 0 }, passif: { capitauxPropresCents: 0, resultatNetCents: 0, provisionsCents: 0, empruntsCents: 0, dettesCents: 0, decouvertCents: 0, totalCents: 0 }, balanced: true, ecartCents: 0 },
        turnoverCents: 0,
        unbalancedEntries: [],
        checks: { entriesBalanced: true, trialBalanceBalanced: true, balanceSheetBalanced: true, resultConsistent: true, allPassed: true },
      },
    };

    const summary = dossierSummaryFromDetail(detail);
    expect(summary).not.toHaveProperty('analysis');
    expect(summary).not.toHaveProperty('analysisSha256');
    expect(replaceDossierSummary([previous], detail)).toEqual([summary]);
  });
});
