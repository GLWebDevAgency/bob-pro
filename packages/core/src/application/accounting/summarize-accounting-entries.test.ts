import { describe, expect, it } from 'vitest';
import { summarizeAccountingEntries } from './summarize-accounting-entries';

const ENTRIES = [
  {
    id: 'e1',
    journal: 'sales',
    entryDate: '2026-07-01',
    lines: [
      { debitCents: 48840, creditCents: 0 },
      { debitCents: 0, creditCents: 40700 },
      { debitCents: 0, creditCents: 8140 },
    ],
  },
  {
    id: 'e2',
    journal: 'bank',
    entryDate: '2026-07-02',
    lines: [
      { debitCents: 48840, creditCents: 0 },
      { debitCents: 0, creditCents: 48840 },
    ],
  },
  {
    id: 'e3',
    journal: 'sales',
    entryDate: '2026-06-15',
    lines: [{ debitCents: 100, creditCents: 90 }], // volontairement déséquilibrée
  },
] as const;

describe('summarizeAccountingEntries (C17 — le grand-livre se résume dans le domaine)', () => {
  it('compte par journal, totalise débit/crédit et détecte le déséquilibre', () => {
    const s = summarizeAccountingEntries(ENTRIES, { month: '2026-07' });
    expect(s.entryCount).toBe(3);
    expect(s.byJournal).toEqual([
      { journal: 'sales', count: 2 },
      { journal: 'bank', count: 1 },
    ]);
    expect(s.totalDebitCents).toBe(97780);
    expect(s.totalCreditCents).toBe(97770);
    expect(s.balanced).toBe(false);
    expect(s.currentMonthCount).toBe(2);
  });

  it('filtre par journal : totaux et équilibre recalculés sur le sous-ensemble', () => {
    const s = summarizeAccountingEntries(ENTRIES, { journal: 'bank' });
    expect(s.entryCount).toBe(1);
    expect(s.balanced).toBe(true);
    expect(s.totalDebitCents).toBe(48840);
  });

  it('vide : zéros partout et équilibré (rien à signaler)', () => {
    const s = summarizeAccountingEntries([]);
    expect(s).toEqual({
      entryCount: 0,
      byJournal: [],
      totalDebitCents: 0,
      totalCreditCents: 0,
      balanced: true,
      currentMonthCount: 0,
    });
  });
});
