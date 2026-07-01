import { describe, it, expect } from 'vitest';
import { AccountingEntry, type AccountingEntryProps } from './accounting-entry';
import { ChartOfAccounts } from './chart-of-accounts';

const base: AccountingEntryProps = {
  id: 'ae-1',
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
    { account: '44571', label: 'TVA collectee', debitCents: 0, creditCents: 20000 },
  ],
};

describe('AccountingEntry', () => {
  it('cree une ecriture equilibree et normalisee', () => {
    const r = AccountingEntry.create({
      ...base,
      id: '  ae-1  ',
      reference: '  F2026-001  ',
      lines: [{ ...base.lines[0]!, account: ' 411 ', label: ' Client Durand ' }, base.lines[1]!, base.lines[2]!],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe('ae-1');
      expect(r.value.reference).toBe('F2026-001');
      expect(r.value.totalDebitCents).toBe(120000);
      expect(r.value.totalCreditCents).toBe(120000);
      expect(r.value.lines[0]).toMatchObject({ account: '411', label: 'Client Durand' });
    }
  });

  it('refuse une ecriture non equilibree', () => {
    const r = AccountingEntry.create({ ...base, lines: [base.lines[0]!, { ...base.lines[1]!, creditCents: 99999 }, base.lines[2]!] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'VALIDATION', field: 'lines' });
  });

  it('refuse les lignes sans cote unique debit/credit', () => {
    expect(
      AccountingEntry.create({
        ...base,
        lines: [{ account: '411', label: 'Client', debitCents: 0, creditCents: 0 }, base.lines[1]!],
      }).ok,
    ).toBe(false);
    expect(
      AccountingEntry.create({
        ...base,
        lines: [{ account: '411', label: 'Client', debitCents: 100, creditCents: 100 }, base.lines[1]!],
      }).ok,
    ).toBe(false);
  });

  it('refuse les montants invalides et les comptes mal formes', () => {
    expect(AccountingEntry.create({ ...base, lines: [{ ...base.lines[0]!, debitCents: 12.5 }, base.lines[1]!] }).ok).toBe(false);
    expect(AccountingEntry.create({ ...base, lines: [{ ...base.lines[0]!, debitCents: -1 }, base.lines[1]!] }).ok).toBe(false);
    expect(AccountingEntry.create({ ...base, lines: [{ ...base.lines[0]!, account: 'client' }, base.lines[1]!] }).ok).toBe(false);
    expect(AccountingEntry.create({ ...base, lines: [{ ...base.lines[0]!, account: '41' }, base.lines[1]!] }).ok).toBe(false);
  });

  it('refuse un compte absent ou inactif quand un plan comptable est fourni', () => {
    const chart = ChartOfAccounts.create({
      companyId: 'co-1',
      accounts: [
        { code: '411', label: 'Clients', kind: 'asset' },
        { code: '706', label: 'Prestations', kind: 'revenue' },
        { code: '44571', label: 'TVA collectee', kind: 'liability', active: false },
      ],
    });
    expect(chart.ok).toBe(true);
    if (chart.ok) {
      expect(AccountingEntry.create(base, { chart: chart.value }).ok).toBe(false);
      expect(
        AccountingEntry.create(
          {
            ...base,
            lines: [
              base.lines[0]!,
              base.lines[1]!,
              { account: '999', label: 'Compte inconnu', debitCents: 0, creditCents: 20000 },
            ],
          },
          { chart: chart.value },
        ).ok,
      ).toBe(false);
    }
  });

  it('accepte tous les comptes actifs du plan comptable fourni', () => {
    const chart = ChartOfAccounts.create({
      companyId: 'co-1',
      accounts: [
        { code: '411', label: 'Clients', kind: 'asset' },
        { code: '706', label: 'Prestations', kind: 'revenue' },
        { code: '44571', label: 'TVA collectee', kind: 'liability' },
      ],
    });
    expect(chart.ok).toBe(true);
    if (chart.ok) expect(AccountingEntry.create(base, { chart: chart.value }).ok).toBe(true);
  });

  it('refuse un compte de regroupement meme present dans le plan comptable', () => {
    const chart = ChartOfAccounts.create({
      companyId: 'co-1',
      accounts: [
        { code: '41', label: 'Clients rattaches', kind: 'asset', postingAllowed: false },
        { code: '706', label: 'Prestations', kind: 'revenue' },
      ],
    });
    expect(chart.ok).toBe(true);
    if (chart.ok) expect(AccountingEntry.create({ ...base, lines: [{ ...base.lines[0]!, account: '41' }, base.lines[1]!] }, { chart: chart.value }).ok).toBe(false);
  });

  it('refuse les metadonnees invalides', () => {
    expect(AccountingEntry.create({ ...base, id: ' ' }).ok).toBe(false);
    expect(AccountingEntry.create({ ...base, journal: 'payroll' as unknown as 'sales' }).ok).toBe(false);
    expect(AccountingEntry.create({ ...base, sourceType: 'unknown' as unknown as 'invoice' }).ok).toBe(false);
    expect(AccountingEntry.create({ ...base, entryDate: '2026-02-30' }).ok).toBe(false);
    expect(AccountingEntry.create({ ...base, lines: [base.lines[0]!] }).ok).toBe(false);
  });

  it('retourne des copies defensives', () => {
    const r = AccountingEntry.create(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const lines = r.value.lines;
      lines[0]!.account = '999';
      expect(r.value.lines[0]!.account).toBe('411');

      const props = r.value.toProps();
      props.lines[0]!.account = '999';
      expect(r.value.toProps().lines[0]!.account).toBe('411');
    }
  });

  it('rehydrate sans revalider une ligne deja persistee', () => {
    const e = AccountingEntry.rehydrate({ ...base, entryDate: '2026-02-30' });
    expect(e.entryDate).toBe('2026-02-30');
  });
});
