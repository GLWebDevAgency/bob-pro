import { describe, it, expect } from 'vitest';
import { RecordAccountingEntry, type RecordAccountingEntryInput } from './record-accounting-entry';
import { type AccountingEntry } from '../../domain/accounting/accounting-entry';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';

class MemoryAccountingEntries implements AccountingEntryRepository {
  saved: AccountingEntry[] = [];

  async save(entry: AccountingEntry): Promise<void> {
    this.saved.push(entry);
  }

  async findById(companyId: string, id: string): Promise<AccountingEntry | null> {
    return this.saved.find((entry) => entry.companyId === companyId && entry.id === id) ?? null;
  }

  async listByCompany(companyId: string): Promise<AccountingEntry[]> {
    return this.saved.filter((entry) => entry.companyId === companyId);
  }
}

const input: RecordAccountingEntryInput = {
  companyId: 'co-1',
  journal: 'sales',
  sourceType: 'invoice',
  sourceId: 'inv-1',
  entryDate: '2026-07-01',
  reference: 'F2026-001',
  label: 'Facture F2026-001',
  lines: [
    { account: '411', label: 'Client Durand', debitCents: 120000, creditCents: 0 },
    { account: '706', label: 'Prestation', debitCents: 0, creditCents: 100000 },
    { account: '445710', label: 'TVA collectee', debitCents: 0, creditCents: 20000 },
  ],
};

describe('RecordAccountingEntry', () => {
  it('valide et persiste une ecriture equilibree', async () => {
    const entries = new MemoryAccountingEntries();
    const useCase = new RecordAccountingEntry({ entries, ids: { newId: () => 'entry-1' } });

    const r = await useCase.execute(input);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ id: 'entry-1', totalDebitCents: 120000, totalCreditCents: 120000 });
    }
    expect(entries.saved).toHaveLength(1);
    expect(await entries.findById('co-1', 'entry-1')).toBe(entries.saved[0]);
  });

  it("retourne une erreur domaine et ne persiste rien si l'ecriture est invalide", async () => {
    const entries = new MemoryAccountingEntries();
    const useCase = new RecordAccountingEntry({ entries, ids: { newId: () => 'entry-1' } });

    const r = await useCase.execute({
      ...input,
      lines: [input.lines[0]!, { ...input.lines[1]!, creditCents: 99999 }, input.lines[2]!],
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'domain' });
    expect(entries.saved).toHaveLength(0);
  });
});
