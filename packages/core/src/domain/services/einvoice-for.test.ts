import { describe, it, expect } from 'vitest';
import { einvoiceFor } from './einvoice-for';
import { Company, type CompanyProps } from '../company/company';
import { Customer, type CustomerProps } from '../customer/customer';

const baseCompany: CompanyProps = {
  id: 'c1',
  name: 'Mercier Plomberie',
  legalForm: 'EI',
  siren: '732829320',
  siret: '73282932000074',
  trade: 'plombier',
  vatRegime: 'reel_simpl',
  address: { line1: 'x', zip: '92000', city: 'Nanterre' },
  rcsOrRm: 'RM 92',
};
const baseCustomer: CustomerProps = {
  id: 'k1',
  companyId: 'c1',
  type: 'b2c',
  name: 'X',
  address: { line1: 'x', zip: '75001', city: 'Paris' },
  score: 80,
  avgDelayDays: 0,
  outstanding: 0,
};

const co = (): Company => {
  const r = Company.of(baseCompany);
  if (!r.ok) throw new Error('company de test invalide');
  return r.value;
};
const cu = (over: Partial<CustomerProps> = {}): Customer => {
  const r = Customer.of({ ...baseCustomer, ...over });
  if (!r.ok) throw new Error('customer de test invalide');
  return r.value;
};

describe('einvoiceFor', () => {
  it('b2g => chorus_pro', () => {
    expect(einvoiceFor(cu({ type: 'b2g', siren: '732829320' }), co()).channel).toBe('chorus_pro');
  });
  it('b2b => pa (Plateforme Agréée)', () => {
    expect(einvoiceFor(cu({ type: 'b2b', siren: '732829320' }), co()).channel).toBe('pa');
  });
  it('b2b sans siren => non ready', () => {
    expect(einvoiceFor(cu({ type: 'b2b' }), co()).ready).toBe(false);
  });
  it('b2c => ereporting transactions', () => {
    const p = einvoiceFor(cu({ type: 'b2c' }), co());
    expect(p.channel).toBe('ereporting');
    expect(p.ereportingKind).toBe('transactions');
  });
});
