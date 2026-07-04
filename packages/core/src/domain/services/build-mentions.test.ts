import { describe, it, expect } from 'vitest';
import { buildMentions, operationNatureOf, type BuildMentionsInput } from './build-mentions';
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
const b2b = () => customer({ type: 'b2b', siren: '552081317' });
const b2g = () => customer({ type: 'b2g', siren: '130025265' });

const mentions = (over: Partial<BuildMentionsInput> = {}): string[] =>
  buildMentions({ company: company(), customer: customer(), kind: 'invoice', asOf: '2026-06-01', ...over });

describe('buildMentions', () => {
  it('inclut le RM et l’en-tête société', () => {
    const m = mentions();
    expect(m.some((s) => s.includes('RM 92'))).toBe(true);
    expect(m.some((s) => s.includes('Mercier Plomberie'))).toBe(true);
  });
  it('franchise => mention 293 B', () => {
    const m = mentions({ company: company({ vatRegime: 'franchise' }) });
    expect(m.some((s) => s.includes('293 B'))).toBe(true);
  });
  it('BTP => assurance decennale presente', () => {
    expect(mentions().some((s) => s.includes('Assurance'))).toBe(true);
  });
  it('devis => Bon pour accord', () => {
    const m = mentions({ kind: 'quote', validUntilDays: 30 });
    expect(m.some((s) => s.toLowerCase().includes('bon pour accord'))).toBe(true);
  });

  // —— P14 (C-EXP1) : mentions L441-9/L441-10 réservées aux ventes entre PROFESSIONNELS ——
  it('B2B : escompte néant (L441-9) + pénalités BCE + 10 points (L441-10, jamais de taux chiffré) + 40 € (D441-5)', () => {
    const m = mentions({ customer: b2b() });
    expect(m.some((s) => s === 'Escompte pour paiement anticipé : néant.')).toBe(true);
    const penalites = m.find((s) => s.includes('Pénalités de retard'));
    expect(penalites).toBe(
      'Pénalités de retard : taux BCE + 10 points (art. L441-10 du code de commerce). Indemnité forfaitaire de recouvrement : 40 € (art. D441-5 du code de commerce).',
    );
    // Plancher L441-10 II : la stipulation « taux légal en vigueur » (irrégulière) a disparu,
    // et aucun taux chiffré n'est écrit en dur (il change chaque semestre).
    expect(m.some((s) => s.includes('taux legal en vigueur') || s.includes('taux légal en vigueur'))).toBe(false);
    expect(penalites).not.toMatch(/\d+\s*,?\d*\s*%/);
  });

  it('B2G : intérêts moratoires BCE + 8 points + 40 € (L2192-12/13 CCP) — pas de L441-10', () => {
    const m = mentions({ customer: b2g() });
    expect(m.some((s) => s === 'Escompte pour paiement anticipé : néant.')).toBe(true);
    expect(
      m.some(
        (s) =>
          s ===
          'Intérêts moratoires : taux BCE + 8 points. Indemnité forfaitaire de recouvrement : 40 € (art. L2192-12 et L2192-13 du code de la commande publique).',
      ),
    ).toBe(true);
    expect(m.some((s) => s.includes('L441-10'))).toBe(false);
  });

  it('B2C (particulier) : ni escompte, ni pénalités, ni 40 €, ni L441-10 — le régime consommateur est différent', () => {
    const m = mentions();
    expect(m.some((s) => s.includes('Escompte'))).toBe(false);
    expect(m.some((s) => s.includes('Pénalités'))).toBe(false);
    expect(m.some((s) => s.includes('40 €'))).toBe(false);
    expect(m.some((s) => s.includes('L441-10'))).toBe(false);
    expect(m.some((s) => s.includes('Intérêts moratoires'))).toBe(false);
  });

  // —— P11 (C-EXP1) : mention certifiée taux réduits travaux (remplace l'attestation Cerfa) ——
  it('ligne à 10 % => mention certifiée art. 279-0 bis (habitation achevée depuis plus de deux ans)', () => {
    const m = mentions({ lineVatRates: [10, 20] });
    const certifiee = m.find((s) => s.includes('279-0 bis'));
    expect(certifiee).toContain('Taux réduit de TVA 10 %');
    expect(certifiee).toContain('achevés depuis plus de deux ans');
    expect(certifiee).toContain('le client atteste');
    expect(m.some((s) => s.includes('278-0 bis A'))).toBe(false);
  });

  it('ligne à 5,5 % => mention certifiée art. 278-0 bis A (rénovation énergétique)', () => {
    const m = mentions({ lineVatRates: [5.5] });
    const certifiee = m.find((s) => s.includes('278-0 bis A'));
    expect(certifiee).toContain('Taux réduit de TVA 5,5 %');
    expect(certifiee).toContain('rénovation énergétique');
    expect(m.some((s) => s.includes('279-0 bis du CGI'))).toBe(false);
  });

  it('les deux taux réduits présents => les deux mentions ; aucun taux réduit => aucune mention', () => {
    const both = mentions({ lineVatRates: [10, 5.5] });
    expect(both.some((s) => s.includes('279-0 bis du CGI'))).toBe(true);
    expect(both.some((s) => s.includes('278-0 bis A du CGI'))).toBe(true);
    const none = mentions({ lineVatRates: [20, 0] });
    expect(none.some((s) => s.includes('Taux réduit'))).toBe(false);
    expect(mentions().some((s) => s.includes('Taux réduit'))).toBe(false);
  });

  it('les booléens d’éligibilité, quand ils sont fournis, GATENT la mention (suggestVatRate context)', () => {
    const veto = mentions({
      lineVatRates: [10, 5.5],
      reducedVatEligibility: { housingOlderThan2y: false, energyRenovation: false },
    });
    expect(veto.some((s) => s.includes('Taux réduit'))).toBe(false);
    const partiel = mentions({
      lineVatRates: [10, 5.5],
      reducedVatEligibility: { housingOlderThan2y: true, energyRenovation: false },
    });
    expect(partiel.some((s) => s.includes('279-0 bis du CGI'))).toBe(true);
    expect(partiel.some((s) => s.includes('278-0 bis A du CGI'))).toBe(false);
  });

  it('la mention certifiée s’imprime aussi sur le devis (la signature « Bon pour accord » vaut certification)', () => {
    const m = mentions({ kind: 'quote', lineVatRates: [10] });
    expect(m.some((s) => s.includes('279-0 bis du CGI'))).toBe(true);
    expect(m.some((s) => s.toLowerCase().includes('bon pour accord'))).toBe(true);
  });

  // —— Réforme 2026/2027 ——
  it('B2B => SIREN du client mentionné', () => {
    const m = mentions({ customer: b2b() });
    expect(m.some((s) => s.includes('SIREN 552081317'))).toBe(true);
  });
  it('B2C => pas de SIREN client', () => {
    expect(mentions().some((s) => s.includes('SIREN'))).toBe(false);
  });
  it('nature des opérations sur facture', () => {
    const m = mentions({ operationNature: 'services' });
    expect(m.some((s) => s.includes('Prestation de services'))).toBe(true);
  });
  it('franchise : 293 B avant 2026-09-01, CIBS à partir', () => {
    const before = mentions({ company: company({ vatRegime: 'franchise' }), asOf: '2026-08-31' });
    expect(before.some((s) => s.includes('293 B'))).toBe(true);
    const after = mentions({ company: company({ vatRegime: 'franchise' }), asOf: '2026-09-01' });
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
