import { describe, it, expect } from 'vitest';
import {
  ChartOfAccounts,
  type ChartOfAccountsCreateProps,
  accountingAccountClass,
  createFrenchOperationalChartOfAccounts,
  isAccountingAccountCode,
  isPostingAccountCode,
} from './chart-of-accounts';

const base: ChartOfAccountsCreateProps = {
  companyId: 'co-1',
  accounts: [
    { code: '411', label: 'Clients', kind: 'asset' },
    { code: '706', label: 'Prestations de services', kind: 'revenue' },
    { code: '44571', label: 'TVA collectee', kind: 'liability' },
  ],
};

describe('ChartOfAccounts', () => {
  it('cree un plan comptable normalise avec comptes actifs par defaut', () => {
    const r = ChartOfAccounts.create({
      companyId: ' co-1 ',
      accounts: [{ code: ' 411 ', label: ' Clients ', kind: 'asset' }, base.accounts[1]!, base.accounts[2]!],
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.companyId).toBe('co-1');
      expect(r.value.find('411')).toMatchObject({
        code: '411',
        label: 'Clients',
        kind: 'asset',
        normalSide: 'debit',
        active: true,
        postingAllowed: true,
      });
      expect(r.value.acceptsPosting('411')).toBe(true);
    }
  });

  it('refuse plan vide, codes invalides, doublons et categories inconnues', () => {
    expect(ChartOfAccounts.create({ ...base, accounts: [] }).ok).toBe(false);
    expect(ChartOfAccounts.create({ ...base, accounts: [{ ...base.accounts[0]!, code: 'client' }] }).ok).toBe(false);
    expect(ChartOfAccounts.create({ ...base, accounts: [base.accounts[0]!, { ...base.accounts[0]!, label: 'Client bis' }] }).ok).toBe(false);
    expect(ChartOfAccounts.create({ ...base, accounts: [{ ...base.accounts[0]!, kind: 'weird' as unknown as 'asset' }] }).ok).toBe(false);
  });

  it('valide la hierarchie parent/enfant et les comptes de regroupement', () => {
    const r = ChartOfAccounts.create({
      companyId: 'co-1',
      accounts: [
        { code: '4', label: 'Tiers', kind: 'asset', normalSide: 'mixed', postingAllowed: false },
        { code: '41', label: 'Clients rattaches', kind: 'asset', parentCode: '4', postingAllowed: false },
        { code: '411', label: 'Clients', kind: 'asset', parentCode: '41' },
      ],
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.acceptsPosting('4')).toBe(false);
      expect(r.value.acceptsPosting('41')).toBe(false);
      expect(r.value.acceptsPosting('411')).toBe(true);
      expect(r.value.childrenOf('4')).toHaveLength(1);
    }

    expect(
      ChartOfAccounts.create({
        companyId: 'co-1',
        accounts: [{ code: '411', label: 'Clients', kind: 'asset', parentCode: '41' }],
      }).ok,
    ).toBe(false);
    expect(
      ChartOfAccounts.create({
        companyId: 'co-1',
        accounts: [
          { code: '4', label: 'Tiers', kind: 'asset', active: false, postingAllowed: false },
          { code: '411', label: 'Clients', kind: 'asset', parentCode: '4' },
        ],
      }).ok,
    ).toBe(false);
  });

  it('distingue les comptes absents et inactifs', () => {
    const r = ChartOfAccounts.create({ ...base, accounts: [{ ...base.accounts[0]!, active: false }, base.accounts[1]!, base.accounts[2]!] });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.find('999')).toBeNull();
      expect(r.value.acceptsPosting('999')).toBe(false);
      expect(r.value.acceptsPosting('411')).toBe(false);
    }
  });

  it('retourne des copies defensives', () => {
    const r = ChartOfAccounts.create(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const accounts = r.value.accounts;
      accounts[0]!.label = 'Mutated';
      expect(r.value.find('411')?.label).toBe('Clients');

      const props = r.value.toProps();
      props.accounts[0]!.label = 'Mutated';
      expect(r.value.toProps().accounts[0]!.label).toBe('Clients');
    }
  });

  it('cree le gabarit operationnel francais avec comptes ventes/TVA/banque/achats postables', () => {
    const r = createFrenchOperationalChartOfAccounts('co-1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.find('411')?.label).toBe('Clients');
      expect(r.value.find('44571')?.label).toBe('TVA collectee');
      expect(r.value.find('512')?.label).toBe('Banques');
      expect(r.value.find('706')?.normalSide).toBe('credit');
      expect(r.value.find('606')?.normalSide).toBe('debit');
      expect(r.value.acceptsPosting('70')).toBe(false);
      expect(r.value.acceptsPosting('706')).toBe(true);
      expect(r.value.postingAccounts.length).toBeGreaterThan(40);
    }
  });

  it('expose la validation de forme, de classe et de comptes postables', () => {
    expect(isAccountingAccountCode('411')).toBe(true);
    expect(isAccountingAccountCode('44571')).toBe(true);
    expect(isAccountingAccountCode('12')).toBe(true);
    expect(isAccountingAccountCode('41A')).toBe(false);
    expect(isPostingAccountCode('12')).toBe(false);
    expect(isPostingAccountCode('411')).toBe(true);
    expect(accountingAccountClass('706')).toBe('7');
    expect(accountingAccountClass('906')).toBeNull();
  });
});
