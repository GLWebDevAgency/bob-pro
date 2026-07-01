import { describe, expect, it } from 'vitest';
import { createFrenchOperationalChartOfAccounts, RecordAccountingEntry } from '@bob/core';
import { InMemoryPersistence } from './persistence';

describe('InMemoryPersistence accounting repositories', () => {
  it('records an accounting entry through the application ports with chart validation and tenant isolation', async () => {
    const persistence = new InMemoryPersistence();
    const chart = createFrenchOperationalChartOfAccounts('company-a');
    expect(chart.ok).toBe(true);
    if (!chart.ok) return;

    await persistence.chartOfAccounts.save(chart.value);

    const useCase = new RecordAccountingEntry({
      entries: persistence.accountingEntries,
      charts: persistence.chartOfAccounts,
      ids: { newId: () => 'entry-1' },
    });

    const result = await useCase.execute({
      companyId: 'company-a',
      journal: 'sales',
      sourceType: 'invoice',
      sourceId: 'invoice-1',
      entryDate: '2026-07-01',
      reference: 'F-2026-001',
      label: 'Facture F-2026-001',
      lines: [
        { account: '411', label: 'Client', debitCents: 12000, creditCents: 0 },
        { account: '706', label: 'Prestation', debitCents: 0, creditCents: 10000 },
        { account: '44571', label: 'TVA collectee', debitCents: 0, creditCents: 2000 },
      ],
    });

    expect(result.ok).toBe(true);
    const entry = await persistence.accountingEntries.findById('company-a', 'entry-1');
    expect(entry?.totalDebitCents).toBe(12000);
    expect(entry?.totalCreditCents).toBe(12000);
    await expect(persistence.accountingEntries.findById('other-company', 'entry-1')).resolves.toBeNull();
  });
});
