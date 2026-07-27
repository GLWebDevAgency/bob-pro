import { describe, it, expect } from 'vitest';
import { buildQuoteRelance, buildRelance, type BuildRelanceInput } from './build-relance';

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

  // —— P12 (C-EXP2 vA) : la MED B2B/B2G CHIFFRE les pénalités quand les montants sont fournis ——
  it('mise en demeure B2B chiffrée : énonce intérêts + 40 € (D441-5) et le total réclamé', () => {
    const m = buildRelance({
      ...base,
      amountCents: 185000,
      tone: 'miseendemeure',
      customerType: 'b2b',
      penalties: { interestCents: 2771, fixedIndemnityCents: 4000 },
    });
    expect(m.body).toContain('a ce jour');
    expect(m.body).toContain('27,71'); // intérêts courus
    expect(m.body).toContain('40,00'); // indemnité forfaitaire chiffrée
    expect(m.body).toContain('D441-5');
    expect(m.body).toContain('soit un total de');
    expect(m.body).toContain('917,71'); // 1 850 + 27,71 + 40 = 1 917,71 € (séparateur NBSP fine)
  });

  it('mise en demeure B2G chiffrée : intérêts moratoires BCE+8 + 40 €, total réclamé', () => {
    const m = buildRelance({
      ...base,
      amountCents: 185000,
      tone: 'miseendemeure',
      customerType: 'b2g',
      penalties: { interestCents: 2315, fixedIndemnityCents: 4000 },
    });
    expect(m.body).toContain("d'interets moratoires");
    expect(m.body).toContain('23,15');
    expect(m.body).toContain('soit un total de');
    expect(m.body).toContain('913,15'); // 1 850 + 23,15 + 40 = 1 913,15 €
  });

  it('mise en demeure B2C : pénalités fournies IGNORÉES — la MED fait courir les intérêts, jamais 40 €', () => {
    const withPenalties = buildRelance({
      ...base,
      tone: 'miseendemeure',
      customerType: 'b2c',
      penalties: { interestCents: 2771, fixedIndemnityCents: 4000 },
    });
    const without = buildRelance({ ...base, tone: 'miseendemeure', customerType: 'b2c' });
    expect(withPenalties).toEqual(without);
    expect(withPenalties.body).not.toContain('soit un total');
    expect(withPenalties.body).not.toContain('40 €');
  });

  it('compat ascendante : sans montants fournis, les textes B2B/B2G restent exactement inchangés', () => {
    for (const customerType of ['b2b', 'b2g'] as const) {
      const m = buildRelance({ ...base, tone: 'miseendemeure', customerType });
      expect(m.body).not.toContain('a ce jour');
      expect(m.body).not.toContain('soit un total');
      expect(m.body.endsWith('.')).toBe(true);
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

describe('buildQuoteRelance (PR-05 — relance devis pré-rédigée, jamais envoyée seule)', () => {
  it('ton cordial UNIQUEMENT : cite le numéro, le montant et les jours — AUCUNE référence légale', () => {
    const m = buildQuoteRelance({
      customerName: 'RATP CAP',
      docNumber: 'D-2026-0007',
      amountCents: 240_000,
      daysSinceIssued: 15,
      personality: 'Pro',
    });
    expect(m.subject).toContain('D-2026-0007');
    expect(m.body).toContain('RATP CAP');
    expect(m.body).toContain('15 jours');
    expect(m.body).not.toMatch(/L441|mise en demeure|penalite|pénalité/i);
    // Le CLIENT est toujours vouvoyé (un prospect n'est pas un copain, quelle que soit l'humeur).
    expect(m.body).toContain('vous');
  });

  it('lien de signature inséré UNIQUEMENT quand fourni — jamais fabriqué', () => {
    const sans = buildQuoteRelance({
      customerName: 'X',
      docNumber: 'D-1',
      amountCents: 1000,
      daysSinceIssued: 16,
      personality: 'Pote',
    });
    expect(sans.body).not.toContain('http');
    const avec = buildQuoteRelance({
      customerName: 'X',
      docNumber: 'D-1',
      amountCents: 1000,
      daysSinceIssued: 16,
      personality: 'Pote',
      signatureUrl: 'https://sign.test/s/tok',
    });
    expect(avec.body).toContain('https://sign.test/s/tok');
  });
});
