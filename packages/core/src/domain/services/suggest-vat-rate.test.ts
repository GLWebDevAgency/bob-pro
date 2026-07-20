import { describe, it, expect } from 'vitest';
import { suggestVatRate, type SuggestVatInput } from './suggest-vat-rate';
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
    const r = suggestVatRate({ company: company(), customer: customer(), category: 'labor', requestedRate: 10, context: { housingOlderThan2y: true } });
    expect(r.ok && r.value).toBe(10);
  });
  it('renovation energetique => 5.5', () => {
    const r = suggestVatRate({ company: company(), customer: customer(), category: 'labor', requestedRate: 5.5, context: { housingOlderThan2y: true, energyRenovation: true } });
    expect(r.ok && r.value).toBe(5.5);
  });
  it("test d'or franchise : regime franchise => 0", () => {
    const r = suggestVatRate({ company: company({ vatRegime: 'franchise' }), customer: customer(), category: 'supply', requestedRate: 0 });
    expect(r.ok && r.value).toBe(0);
  });
  it("test d'or franchise : taux 20 demande sous franchise => rejet 293B", () => {
    const r = suggestVatRate({ company: company({ vatRegime: 'franchise' }), customer: customer(), category: 'supply', requestedRate: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'VAT_RATE_NOT_APPLICABLE', reason: 'franchise_293B' });
  });
  it("test d'or autoliquidation : sous-traitance BTP B2B => 0", () => {
    const r = suggestVatRate({ company: company(), customer: customer({ type: 'b2b', siren: '732829320', isSubcontractingBtp: true }), category: 'labor', requestedRate: 0 });
    expect(r.ok && r.value).toBe(0);
  });
  it("test d'or autoliquidation : taux !=0 demande => rejet", () => {
    const r = suggestVatRate({ company: company(), customer: customer({ type: 'b2b', siren: '732829320', isSubcontractingBtp: true }), category: 'labor', requestedRate: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'VAT_RATE_NOT_APPLICABLE', reason: 'autoliquidation' });
  });
  it('aucun taux demandé => validation fail-closed, jamais 20 % implicite', () => {
    // Simulation d'une frontière JSON/non typée : le contrat TS interdit déjà cet oubli.
    const input = {
      company: company(),
      customer: customer(),
      category: 'labor',
    } as unknown as SuggestVatInput;
    const r = suggestVatRate(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'VALIDATION', field: 'vatRate' });
  });
  it('10 % sans éligibilité logement et 0 % hors franchise/autoliquidation sont rejetés', () => {
    const ten = suggestVatRate({
      company: company(),
      customer: customer(),
      category: 'labor',
      requestedRate: 10,
    });
    const zero = suggestVatRate({
      company: company(),
      customer: customer(),
      category: 'labor',
      requestedRate: 0,
    });
    expect(ten.ok).toBe(false);
    expect(zero.ok).toBe(false);
  });
});

describe('suggestVatRate — débours B9 (art. 267, II-2° CGI)', () => {
  it('régime RÉEL : débours à 0 % ACCEPTÉ (hors base TVA)', () => {
    const r = suggestVatRate({
      company: company(),
      customer: customer(),
      category: 'disbursement',
      requestedRate: 0,
    });
    expect(r.ok && r.value).toBe(0);
  });
  it('régime RÉEL : débours à taux > 0 REFUSÉ (la pièce serait fiscalement fausse)', () => {
    for (const rate of [5.5, 10, 20] as const) {
      const r = suggestVatRate({
        company: company(),
        customer: customer(),
        category: 'disbursement',
        requestedRate: rate,
      });
      expect(r.ok).toBe(false);
      if (!r.ok)
        expect(r.error).toMatchObject({ code: 'VAT_RATE_NOT_APPLICABLE', reason: 'disbursement_267' });
    }
  });
  it('franchise : débours à 0 % accepté (la règle franchise prime, même verdict)', () => {
    const r = suggestVatRate({
      company: company({ vatRegime: 'franchise' }),
      customer: customer(),
      category: 'disbursement',
      requestedRate: 0,
    });
    expect(r.ok && r.value).toBe(0);
  });
  it('cohérence interne : les autres catégories gardent leur régime (0 refusé au réel)', () => {
    const r = suggestVatRate({
      company: company(),
      customer: customer(),
      category: 'labor',
      requestedRate: 0,
    });
    expect(r.ok).toBe(false);
  });
});
