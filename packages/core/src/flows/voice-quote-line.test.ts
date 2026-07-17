import { describe, expect, it } from 'vitest';
import {
  completePendingQuoteLinePrice,
  isVoiceAddLineUtterance,
  parseVoiceQuoteLine,
} from './voice-quote-line';
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
  it('« deux heures de main-d’œuvre à 55 euros » → labor ×2, PU énoncé, TVA déjà confirmée', () => {
    const r = parseVoiceQuoteLine('ajoute deux heures de main-d’œuvre à 55 euros', { confirmedVatRate: 10 });
    expect(r.kind).toBe('line');
    if (r.kind !== 'line') return;
    expect(r.line).toMatchObject({ category: 'labor', qty: 2, unitPriceHT: 5_500, vatRate: 10, source: 'dictee' });
  });

  it('un BIEN discret sans main-d’œuvre est une FOURNITURE, libellé propre et capitalisé', () => {
    const r = parseVoiceQuoteLine('ajoute un chauffe-eau 300 litres à 890 euros', { confirmedVatRate: 20 });
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
    const r = parseVoiceQuoteLine('3 unités de robinet thermostatique à 45 euros tva 20', { confirmedVatRate: 10 });
    expect(r.kind).toBe('line');
    if (r.kind !== 'line') return;
    expect(r.line).toMatchObject({ qty: 3, vatRate: 20, category: 'supply', unitPriceHT: 4_500 });
  });

  it('nombres EN TOUTES LETTRES (dictée réelle) : « cinquante-cinq euros », « quatre-vingt-quinze », « cent vingt »', () => {
    const r = parseVoiceQuoteLine('ajoute deux heures de main-d’œuvre à cinquante-cinq euros', { confirmedVatRate: 10 });
    expect(r.kind).toBe('line');
    if (r.kind === 'line') expect(r.line).toMatchObject({ qty: 2, unitPriceHT: 5_500, category: 'labor' });
    const r2 = parseVoiceQuoteLine('ajoute un déplacement à quatre-vingt-quinze euros', { confirmedVatRate: 20 });
    expect(r2.kind === 'line' && r2.line.unitPriceHT).toBe(9_500);
    expect(r2.kind === 'line' && r2.line.category).toBe('travel');
    const r3 = parseVoiceQuoteLine('mets trois unités de robinet à cent vingt euros', { confirmedVatRate: 20 });
    expect(r3.kind === 'line' && r3.line.unitPriceHT).toBe(12_000);
    expect(r3.kind === 'line' && r3.line.qty).toBe(3);
  });

  it('« 2 heures pour 110 euros au total » → PU 55 € (division EXACTE), jamais 2 × 110', () => {
    const r = parseVoiceQuoteLine('2 heures de dépannage pour 110 euros au total', { confirmedVatRate: 20 });
    expect(r.kind).toBe('line');
    if (r.kind === 'line') expect(r.line).toMatchObject({ qty: 2, unitPriceHT: 5_500 });
  });

  it('total NON divisible exactement → on redemande (jamais d’arrondi silencieux)', () => {
    const r = parseVoiceQuoteLine('3 heures de pose pour 100 euros au total', {});
    expect(r.kind).toBe('missing_price');
  });

  it('le libellé ne garde ni les nombres en lettres ni « euros »', () => {
    const r = parseVoiceQuoteLine('ajoute un dépannage à cinquante-cinq euros', { confirmedVatRate: 20 });
    expect(r.kind).toBe('line');
    if (r.kind === 'line') {
      expect(r.line.label.toLowerCase()).not.toMatch(/cinquante|euro/);
      expect(r.line.unitPriceHT).toBe(5_500);
    }
  });

  it('énoncé vide ou inexploitable → none (fail-safe)', () => {
    expect(parseVoiceQuoteLine('   ', {}).kind).toBe('none');
    expect(parseVoiceQuoteLine('euh', {}).kind).toBe('missing_price');
  });

  it('une prestation INDICATIVE du catalogue ne chiffre jamais une ligne', () => {
    const r = parseVoiceQuoteLine('prestation indicative', { prestations: CATALOGUE });
    expect(r.kind).not.toBe('line');
  });

  it('prix compris mais TVA absente => missing_vat, jamais 20 % implicite', () => {
    const r = parseVoiceQuoteLine('ajoute deux heures de plomberie à 55 euros');
    expect(r.kind).toBe('missing_vat');
    if (r.kind !== 'missing_vat') return;
    expect(r.line).toMatchObject({ qty: 2, unitPriceHT: 5_500, category: 'labor' });
    expect(r.line).not.toHaveProperty('vatRate');
  });
});

/**
 * BUG FONDATEUR 2026-07-16 (device réel, wizard devis) : « ajoute deux heures de
 * main-d'œuvre » répondait « je ne m'occupe que d'administratif » — la chaîne complète
 * ÉCHOUAIT AVANT LE FIX en dehors de l'étape lignes (aucune affordance ne couvrait un ajout
 * de ligne sur tvaMentions/signature/acompte/facture, l'énoncé tombait donc en silence vers
 * le classifieur serveur, qui n'a — et ne peut PHYSIQUEMENT pas avoir — d'intent pour muter
 * un brouillon de devis 100 % local). Ces tests couvrent la reconnaissance ET l'extraction
 * de slots attendue côté « papa vocal » : jamais redemander un champ déjà connu.
 */
describe('isVoiceAddLineUtterance — déclencheur unique du pouvoir local d’ajout de ligne', () => {
  it('reconnaît la phrase exacte du fondateur et ses variantes de verbe', () => {
    expect(isVoiceAddLineUtterance('ajoute deux heures de main-d’œuvre')).toBe(true);
    expect(isVoiceAddLineUtterance('Ajoute deux heures de main-d’œuvre')).toBe(true);
    expect(isVoiceAddLineUtterance('ajoutez deux heures de main-d’œuvre')).toBe(true);
    expect(isVoiceAddLineUtterance('rajoute deux heures de main-d’œuvre')).toBe(true);
    expect(isVoiceAddLineUtterance('mets deux heures de main-d’œuvre')).toBe(true);
  });

  it('ne capture PAS un énoncé sans rapport (jamais un faux positif qui vole le tour)', () => {
    expect(isVoiceAddLineUtterance('étape suivante')).toBe(false);
    expect(isVoiceAddLineUtterance('corrige la ligne 2 à 55 euros')).toBe(false);
    expect(isVoiceAddLineUtterance('55 euros')).toBe(false);
  });
});

describe('parseVoiceQuoteLine — « ajoute deux heures de main-d’œuvre » (bug fondateur 2026-07-16)', () => {
  it('SANS prix énoncé → missing_price avec qty/catégorie DÉJÀ extraits (jamais perdus)', () => {
    const r = parseVoiceQuoteLine('ajoute deux heures de main-d’œuvre', {});
    expect(r.kind).toBe('missing_price');
    if (r.kind !== 'missing_price') return;
    expect(r.qty).toBe(2);
    expect(r.category).toBe('labor');
    expect(r.label.toLowerCase()).toContain('main');
  });

  it('variante STT « main d oeuvre » (sans ponctuation) → même extraction', () => {
    const r = parseVoiceQuoteLine('ajoute deux heures de main d oeuvre', {});
    expect(r.kind).toBe('missing_price');
    if (r.kind !== 'missing_price') return;
    expect(r.qty).toBe(2);
    expect(r.category).toBe('labor');
  });

  it('variante STT « manoeuvre » (confusion phonétique main-d’œuvre) → catégorie labor via l’unité « heures »', () => {
    const r = parseVoiceQuoteLine('ajoute deux heures de manoeuvre', {});
    expect(r.kind).toBe('missing_price');
    if (r.kind !== 'missing_price') return;
    expect(r.qty).toBe(2);
    expect(r.category).toBe('labor');
  });

  it('AVEC prix énoncé (« ajoute 3 heures de plomberie à 45 euros ») → ligne COMPLÈTE, aucune question', () => {
    const r = parseVoiceQuoteLine('ajoute 3 heures de plomberie à 45 euros', { confirmedVatRate: 20 });
    expect(r.kind).toBe('line');
    if (r.kind !== 'line') return;
    expect(r.line).toMatchObject({ qty: 3, category: 'labor', unitPriceHT: 4_500 });
  });
});

describe('completePendingQuoteLinePrice — le suivi « 55 euros » complète SANS tout redire', () => {
  it('un prix unitaire nu complète directement (« 55 euros » = 55 €/heure)', () => {
    expect(completePendingQuoteLinePrice('55 euros', 2)).toBe(5_500);
  });

  it('« à 55 euros de l’heure » (marqueur unitaire explicite) complète directement', () => {
    expect(completePendingQuoteLinePrice('à 55 euros de l’heure', 2)).toBe(5_500);
  });

  it('un TOTAL divisible exactement se répartit sur la quantité connue', () => {
    expect(completePendingQuoteLinePrice('110 euros au total', 2)).toBe(5_500);
  });

  it('un TOTAL non divisible exactement redemande (jamais un arrondi silencieux)', () => {
    expect(completePendingQuoteLinePrice('100 euros au total', 3)).toBeNull();
  });

  it('un suivi sans aucun prix exploitable ne complète rien (laisse tenter d’autres affordances)', () => {
    expect(completePendingQuoteLinePrice('non annule', 2)).toBeNull();
  });

  it('nombres en toutes lettres (dictée réelle)', () => {
    expect(completePendingQuoteLinePrice('cinquante-cinq euros', 2)).toBe(5_500);
  });
});
