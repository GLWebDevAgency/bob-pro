import { describe, it, expect } from 'vitest';
import { buildRelance, type BuildRelanceInput } from './build-relance';

const base: Omit<BuildRelanceInput, 'tone' | 'customerType'> = {
  customerName: 'M. Bernard',
  docNumber: 'F-2026-0118',
  amountCents: 162800,
  daysLate: 35,
  personality: 'Pro',
};

describe('buildRelance', () => {
  // —— P01 (C-EXP1) : la mise en demeure suit le RÉGIME JURIDIQUE du type de client ——
  it('mise en demeure B2B : L441-10 + indemnité forfaitaire 40 € (débiteur professionnel)', () => {
    const m = buildRelance({ ...base, tone: 'miseendemeure', customerType: 'b2b' });
    expect(m.subject).toContain('Mise en demeure');
    expect(m.body).toContain('L441-10');
    expect(m.body).toContain('40 €');
  });

  it('mise en demeure B2C : art. 1344 + intérêts au taux légal (1344-1, 1231-6) — JAMAIS 40 € ni L441-10', () => {
    const m = buildRelance({ ...base, customerName: 'Mme Durand', tone: 'miseendemeure', customerType: 'b2c' });
    expect(m.subject).toContain('Mise en demeure');
    expect(m.body).toContain('1344');
    expect(m.body).toContain('1344-1');
    expect(m.body).toContain('1231-6');
    expect(m.body).toContain('taux legal');
    expect(m.body).not.toContain('L441-10');
    expect(m.body).not.toContain('40 €');
    expect(m.body).not.toContain('code de commerce');
  });

  it('mise en demeure B2G : L2192-12/13 CCP, intérêts BCE + 8 points + 40 € de plein droit', () => {
    const m = buildRelance({ ...base, customerName: 'Mairie de Nanterre', tone: 'miseendemeure', customerType: 'b2g' });
    expect(m.body).toContain('L2192-12');
    expect(m.body).toContain('L2192-13');
    expect(m.body).toContain('code de la commande publique');
    expect(m.body).toContain('BCE majore de 8 points');
    expect(m.body).toContain('40 €');
    expect(m.body).not.toContain('L441-10');
  });

  it('les paliers cordial/neutre/ferme sont communs aux trois types (aucune référence légale)', () => {
    for (const tone of ['cordial', 'neutre', 'ferme'] as const) {
      const b2b = buildRelance({ ...base, tone, customerType: 'b2b' });
      const b2c = buildRelance({ ...base, tone, customerType: 'b2c' });
      const b2g = buildRelance({ ...base, tone, customerType: 'b2g' });
      expect(b2c).toEqual(b2b);
      expect(b2g).toEqual(b2b);
      expect(b2b.body).not.toMatch(/L441-10|1344|L2192|40 €/);
    }
  });

  it('ton cordial en personnalite Pote tutoie', () => {
    const m = buildRelance({
      customerName: 'Martin',
      docNumber: 'F-1',
      amountCents: 5000,
      daysLate: 7,
      tone: 'cordial',
      personality: 'Pote',
      customerType: 'b2c',
    });
    expect(m.body.toLowerCase()).toMatch(/\btu\b|\bton\b|\bta\b|\bte\b/);
  });
});
