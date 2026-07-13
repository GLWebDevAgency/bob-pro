import { describe, expect, it } from 'vitest';
import { parseVoiceQuoteLine } from './voice-quote-line';
import { type VoicePrestation } from './voice-invoice-draft';

const CATALOGUE: readonly VoicePrestation[] = [
  { label: 'Chauffe-eau 200 L (fourniture + pose)', category: 'supply', unitPriceHT: 74_900, vatRate: 10 },
  { label: 'Main-d’œuvre plomberie', category: 'labor', unitPriceHT: 5_500, vatRate: 10 },
  { label: 'Détartrage chauffe-eau', category: 'labor', unitPriceHT: 12_000, vatRate: 10 },
  { label: 'Radiateur acier', category: 'supply', unitPriceHT: 28_000, vatRate: 10 },
  { label: 'Pose radiateur acier', category: 'labor', unitPriceHT: 18_000, vatRate: 10 },
  { label: 'Prestation indicative', category: 'labor', unitPriceHT: 999, vatRate: 20, indicative: true },
];

describe('parseVoiceQuoteLine — dictée fondateur (S2-GUIDÉ)', () => {
  it('« deux heures de main-d’œuvre à 55 euros » → labor ×2, PU énoncé, TVA métier', () => {
    const r = parseVoiceQuoteLine('ajoute deux heures de main-d’œuvre à 55 euros', { defaultVatRate: 10 });
    expect(r.kind).toBe('line');
    if (r.kind !== 'line') return;
    expect(r.line).toMatchObject({ category: 'labor', qty: 2, unitPriceHT: 5_500, vatRate: 10, source: 'dictee' });
  });

  it('un BIEN discret sans main-d’œuvre est une FOURNITURE, libellé propre et capitalisé', () => {
    const r = parseVoiceQuoteLine('ajoute un chauffe-eau 300 litres à 890 euros', {});
    expect(r.kind).toBe('line');
    if (r.kind !== 'line') return;
    expect(r.line.category).toBe('supply');
    expect(r.line.unitPriceHT).toBe(89_000);
    expect(r.line.label.charAt(0)).toBe(r.line.label.charAt(0).toUpperCase());
    expect(r.line.label.toLowerCase()).toContain('chauffe');
  });

  it('CATALOGUE D’ABORD : l’énoncé qui matche une prestation reprend libellé/PU/TVA de l’artisan', () => {
    const r = parseVoiceQuoteLine('mets le détartrage du chauffe-eau', { prestations: CATALOGUE });
    expect(r.kind).toBe('line');
    if (r.kind !== 'line') return;
    expect(r.line).toMatchObject({
      label: 'Détartrage chauffe-eau',
      unitPriceHT: 12_000,
      vatRate: 10,
      source: 'catalogue',
    });
  });

  it('le prix ÉNONCÉ prime sur celui du catalogue (jamais l’inverse silencieux)', () => {
    const r = parseVoiceQuoteLine('détartrage chauffe-eau à 150 euros', { prestations: CATALOGUE });
    expect(r.kind === 'line' && r.line.unitPriceHT).toBe(15_000);
    expect(r.kind === 'line' && r.line.source).toBe('catalogue');
  });

  it('deux prestations catalogue plausibles → ambiguïté honnête, jamais un choix silencieux', () => {
    // « pose radiateur acier » contient TOUS les mots des deux prestations → les deux matchent.
    const r = parseVoiceQuoteLine('ajoute la pose radiateur acier', { prestations: CATALOGUE });
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') return;
    expect(r.options).toHaveLength(2);
  });

  it('hors catalogue SANS prix énoncé → missing_price (un prix ne s’invente JAMAIS)', () => {
    const r = parseVoiceQuoteLine('ajoute le remplacement du groupe de sécurité', {});
    expect(r.kind).toBe('missing_price');
    if (r.kind !== 'missing_price') return;
    expect(r.label.toLowerCase()).toContain('remplacement');
  });

  it('TVA énoncée prime, « quantité 3 » comprise, unités discrètes → fourniture', () => {
    const r = parseVoiceQuoteLine('3 unités de robinet thermostatique à 45 euros tva 20', { defaultVatRate: 10 });
    expect(r.kind).toBe('line');
    if (r.kind !== 'line') return;
    expect(r.line).toMatchObject({ qty: 3, vatRate: 20, category: 'supply', unitPriceHT: 4_500 });
  });

  it('énoncé vide ou inexploitable → none (fail-safe)', () => {
    expect(parseVoiceQuoteLine('   ', {}).kind).toBe('none');
    expect(parseVoiceQuoteLine('euh', {}).kind).toBe('missing_price');
  });

  it('une prestation INDICATIVE du catalogue ne chiffre jamais une ligne', () => {
    const r = parseVoiceQuoteLine('prestation indicative', { prestations: CATALOGUE });
    expect(r.kind).not.toBe('line');
  });
});
