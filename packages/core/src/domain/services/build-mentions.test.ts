import { describe, it, expect } from 'vitest';
import { buildMentions, operationNatureOf } from './build-mentions';
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
  address: { line1: '1 rue X', zip: '92000', city: 'Nanterre' },
  rcsOrRm: 'RM 92',
  decennale: { insurer: 'AXA', policyNo: 'P123', coverage: 'France', expiresAt: '2027-12-31' },
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

describe('buildMentions', () => {
  it('inclut indemnite 40 (L441-10) et RM', () => {
    const m = buildMentions({ company: company(), customer: customer(), kind: 'invoice', asOf: '2026-06-01' });
    expect(m.some((s) => s.includes('40'))).toBe(true);
    expect(m.some((s) => s.includes('L441-10'))).toBe(true);
    expect(m.some((s) => s.includes('RM 92'))).toBe(true);
  });
  it('franchise => mention 293 B', () => {
    const m = buildMentions({ company: company({ vatRegime: 'franchise' }), customer: customer(), kind: 'invoice', asOf: '2026-06-01' });
    expect(m.some((s) => s.includes('293 B'))).toBe(true);
  });
  it('BTP => assurance decennale presente', () => {
    const m = buildMentions({ company: company(), customer: customer(), kind: 'invoice', asOf: '2026-06-01' });
    expect(m.some((s) => s.includes('Assurance'))).toBe(true);
  });
  it('devis => Bon pour accord', () => {
    const m = buildMentions({ company: company(), customer: customer(), kind: 'quote', asOf: '2026-06-01', validUntilDays: 30 });
    expect(m.some((s) => s.toLowerCase().includes('bon pour accord'))).toBe(true);
  });

  // —— Réforme 2026/2027 ——
  it('B2B => SIREN du client mentionné', () => {
    const m = buildMentions({ company: company(), customer: customer({ type: 'b2b', siren: '552081317' }), kind: 'invoice', asOf: '2026-06-01' });
    expect(m.some((s) => s.includes('SIREN 552081317'))).toBe(true);
  });
  it('B2C => pas de SIREN client', () => {
    const m = buildMentions({ company: company(), customer: customer(), kind: 'invoice', asOf: '2026-06-01' });
    expect(m.some((s) => s.includes('SIREN'))).toBe(false);
  });
  it('nature des opérations sur facture', () => {
    const m = buildMentions({ company: company(), customer: customer(), kind: 'invoice', asOf: '2026-06-01', operationNature: 'services' });
    expect(m.some((s) => s.includes('Prestation de services'))).toBe(true);
  });
  it('franchise : 293 B avant 2026-09-01, CIBS à partir', () => {
    const before = buildMentions({ company: company({ vatRegime: 'franchise' }), customer: customer(), kind: 'invoice', asOf: '2026-08-31' });
    expect(before.some((s) => s.includes('293 B'))).toBe(true);
    const after = buildMentions({ company: company({ vatRegime: 'franchise' }), customer: customer(), kind: 'invoice', asOf: '2026-09-01' });
    expect(after.some((s) => s.includes('CIBS'))).toBe(true);
    expect(after.some((s) => s.includes('293 B'))).toBe(false);
  });
});

describe('operationNatureOf', () => {
  it('supply => biens, labor => services, mixte', () => {
    expect(operationNatureOf([{ category: 'supply' }])).toBe('biens');
    expect(operationNatureOf([{ category: 'labor' }])).toBe('services');
    expect(operationNatureOf([{ category: 'supply' }, { category: 'labor' }])).toBe('mixte');
  });
  it('les débours ne pilotent pas la nature : supply + disbursement => biens', () => {
    expect(operationNatureOf([{ category: 'supply' }, { category: 'disbursement' }])).toBe('biens');
    expect(operationNatureOf([{ category: 'labor' }, { category: 'disbursement' }])).toBe('services');
  });
});
