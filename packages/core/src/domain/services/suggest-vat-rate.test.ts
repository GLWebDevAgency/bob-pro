import { describe, it, expect } from 'vitest';
import { suggestVatRate } from './suggest-vat-rate';
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
  name: 'Martin',
  address: { line1: 'x', zip: '75001', city: 'Paris' },
  score: 80,
  avgDelayDays: 5,
  outstanding: 0,
};

const company = (over: Partial<CompanyProps> = {}): Company => {
  const r = Company.of({ ...baseCompany, ...over });
  if (!r.ok) throw new Error('company de test invalide');
  return r.value;
};
const customer = (over: Partial<CustomerProps> = {}): Customer => {
  const r = Customer.of({ ...baseCustomer, ...over });
  if (!r.ok) throw new Error('customer de test invalide');
  return r.value;
};

describe('suggestVatRate', () => {
  it('travaux logement >2 ans => 10 (chauffe-eau)', () => {
    const r = suggestVatRate({ company: company(), customer: customer(), category: 'labor', context: { housingOlderThan2y: true } });
    expect(r.ok && r.value).toBe(10);
  });
  it('renovation energetique => 5.5', () => {
    const r = suggestVatRate({ company: company(), customer: customer(), category: 'labor', context: { energyRenovation: true } });
    expect(r.ok && r.value).toBe(5.5);
  });
  it("test d'or franchise : regime franchise => 0", () => {
    const r = suggestVatRate({ company: company({ vatRegime: 'franchise' }), customer: customer(), category: 'supply' });
    expect(r.ok && r.value).toBe(0);
  });
  it("test d'or franchise : taux 20 demande sous franchise => rejet 293B", () => {
    const r = suggestVatRate({ company: company({ vatRegime: 'franchise' }), customer: customer(), category: 'supply', requestedRate: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'VAT_RATE_NOT_APPLICABLE', reason: 'franchise_293B' });
  });
  it("test d'or autoliquidation : sous-traitance BTP B2B => 0", () => {
    const r = suggestVatRate({ company: company(), customer: customer({ type: 'b2b', siren: '732829320', isSubcontractingBtp: true }), category: 'labor' });
    expect(r.ok && r.value).toBe(0);
  });
  it("test d'or autoliquidation : taux !=0 demande => rejet", () => {
    const r = suggestVatRate({ company: company(), customer: customer({ type: 'b2b', siren: '732829320', isSubcontractingBtp: true }), category: 'labor', requestedRate: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'VAT_RATE_NOT_APPLICABLE', reason: 'autoliquidation' });
  });
});
