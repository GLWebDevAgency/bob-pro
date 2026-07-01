import { describe, expect, it } from 'vitest';
import { AccountingEntry } from '../../domain/accounting/accounting-entry';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { ListAccountingEntries } from './list-accounting-entries';

class MemoryEntries implements AccountingEntryRepository {
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

function entry(id: string, companyId: string): AccountingEntry {
  const r = AccountingEntry.create({
    id,
    companyId,
    journal: 'sales',
    sourceType: 'invoice',
    sourceId: `invoice-${id}`,
    entryDate: '2026-07-01',
    reference: `F-${id}`,
    label: `Facture ${id}`,
    lines: [
      { account: '411', label: 'Client', debitCents: 12000, creditCents: 0 },
      { account: '706', label: 'Prestation', debitCents: 0, creditCents: 10000 },
      { account: '44571', label: 'TVA', debitCents: 0, creditCents: 2000 },
    ],
  });
  if (!r.ok) throw new Error('entry');
  return r.value;
}

describe('ListAccountingEntries', () => {
  it('liste uniquement les ecritures du tenant demande', async () => {
    const entries = new MemoryEntries();
    await entries.save(entry('1', 'co-1'));
    await entries.save(entry('2', 'co-2'));

    const r = await new ListAccountingEntries({ entries }).execute({ companyId: 'co-1' });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.companyId).toBe('co-1');
      expect(r.value[0]?.lines.map((line) => line.account)).toEqual(['411', '706', '44571']);
    }
  });
});
