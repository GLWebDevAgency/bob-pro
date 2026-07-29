import { describe, expect, it } from 'vitest';
import { type Trade } from '../../domain/company/company';
import {
  CATALOGUE_CATEGORIES,
  deriveCatalogue,
  isCatalogueCategory,
  normalizeCatalogueSearchKey,
  parseCustomPrestation,
  searchCatalogue,
  type CustomPrestation,
} from './derive-catalogue';

const TRADE_COVERAGE = {
  plombier: true,
  electricien: true,
  macon: true,
  peintre: true,
  paysagiste: true,
  frigoriste: true,
  mainteneur: true,
  consultant: true,
  freelance_it: true,
  photographe: true,
  coach: true,
  autre: true,
} as const satisfies Record<Trade, true>;

const TRADES = Object.keys(TRADE_COVERAGE) as Trade[];

const ownerChauffeEau: CustomPrestation = {
  id: 'owner-1',
  label: 'Chauffe-eau 200 L',
  category: 'supply',
  unit: null,
  unitPriceHT: 79_000,
  vatRate: 10,
};

const ownerRamonage: CustomPrestation = {
  id: 'owner-2',
  label: 'Ramonage conduit',
  category: 'labor',
  unit: 'forfait',
  unitPriceHT: 9_000,
  vatRate: 10,
};

function custom(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'owner-1',
    label: 'Main-d\u2019\u0153uvre plomberie',
    category: 'labor',
    unit: '1 h',
    unitPriceHT: 5_500,
    vatRate: 10,
    ...overrides,
  };
}

describe('parseCustomPrestation', () => {
  it('produit une valeur canonique en trimant le libellé et l\u2019unité', () => {
    expect(
      parseCustomPrestation(custom({ label: '  Pose chauffe-eau  ', unit: '  forfait  ' })),
    ).toEqual({
      id: 'owner-1',
      label: 'Pose chauffe-eau',
      category: 'labor',
      unit: 'forfait',
      unitPriceHT: 5_500,
      vatRate: 10,
    });
    expect(parseCustomPrestation(custom({ unit: null }))).toMatchObject({ unit: null });
  });

  it('accepte exactement les bornes de prix et rejette tout prix hors domaine', () => {
    expect(parseCustomPrestation(custom({ unitPriceHT: 1 }))).not.toBeNull();
    expect(parseCustomPrestation(custom({ unitPriceHT: 1_500_000_000 }))).not.toBeNull();

    for (const unitPriceHT of [
      0,
      -1,
      1.5,
      1_500_000_001,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
    ]) {
      expect(parseCustomPrestation(custom({ unitPriceHT }))).toBeNull();
    }
  });

  it('applique les bornes et l\u2019hygiène texte du devis', () => {
    expect(parseCustomPrestation(custom({ label: 'a'.repeat(500) }))).not.toBeNull();
    expect(parseCustomPrestation(custom({ unit: 'u'.repeat(80) }))).not.toBeNull();

    for (const label of ['', '   ', 'a'.repeat(501), 'Pose\ninterdite', 'Pose\u0085interdite']) {
      expect(parseCustomPrestation(custom({ label }))).toBeNull();
    }
    for (const unit of ['', '   ', 'u'.repeat(81), 'h\tforfait']) {
      expect(parseCustomPrestation(custom({ unit }))).toBeNull();
    }
  });

  it('exige un id canonique, une catégorie/TVA fermées et aucune clé étrangère', () => {
    expect(parseCustomPrestation(custom({ id: 'A-1' }))).not.toBeNull();
    expect(parseCustomPrestation(custom({ id: 'a'.repeat(128) }))).not.toBeNull();

    for (const id of ['', ' owner-1', 'owner_1', 'a'.repeat(129)]) {
      expect(parseCustomPrestation(custom({ id }))).toBeNull();
    }
    expect(parseCustomPrestation(custom({ category: 'disbursement' }))).toBeNull();
    expect(parseCustomPrestation(custom({ vatRate: 7 }))).toBeNull();
    expect(parseCustomPrestation({ ...custom(), extra: true })).toBeNull();
    expect(parseCustomPrestation(null)).toBeNull();
    expect(parseCustomPrestation([])).toBeNull();
  });
});

describe('application/catalogue/deriveCatalogue — données propriétaire uniquement', () => {
  it('reste vide pour chaque métier sans prestation propriétaire', () => {
    for (const trade of TRADES) {
      expect(deriveCatalogue({ trade })).toEqual({ trade, prestations: [] });
    }
  });

  it('retourne seulement les prestations propriétaire validées, sans indicatif', () => {
    const view = deriveCatalogue({
      trade: 'plombier',
      custom: [ownerChauffeEau, ownerRamonage],
    });

    expect(view.prestations).toEqual([
      { ...ownerRamonage, source: 'perso', indicative: false },
      { ...ownerChauffeEau, source: 'perso', indicative: false },
    ]);
    expect(view.prestations).toHaveLength(2);
    expect(view.prestations.every((prestation) => prestation.source === 'perso')).toBe(true);
    expect(view.prestations.every((prestation) => prestation.indicative === false)).toBe(true);
  });

  it('ne change ni les prestations ni les prix propriétaire selon le métier', () => {
    const plombier = deriveCatalogue({ trade: 'plombier', custom: [ownerChauffeEau] });
    const consultant = deriveCatalogue({ trade: 'consultant', custom: [ownerChauffeEau] });

    expect(plombier.prestations).toEqual(consultant.prestations);
    expect(plombier.prestations).toEqual([
      { ...ownerChauffeEau, source: 'perso', indicative: false },
    ]);
  });

  it('écarte chaque entrée invalide sans fabriquer de valeur de remplacement', () => {
    const invalidEntries = [
      custom({ id: 'invalid-price', unitPriceHT: 0 }),
      custom({ id: 'invalid-category', category: 'disbursement' }),
      { ...custom({ id: 'invalid-shape' }), tenantId: 'foreign-tenant' },
    ] as unknown as CustomPrestation[];

    const view = deriveCatalogue({
      trade: 'plombier',
      custom: [ownerRamonage, ...invalidEntries],
    });

    expect(view.prestations).toEqual([
      { ...ownerRamonage, source: 'perso', indicative: false },
    ]);
  });

  it('trie par catégorie puis par libellé français sans altérer les entrées', () => {
    const entries: CustomPrestation[] = [
      { ...ownerChauffeEau, id: 'travel-alpha', label: 'Alpha', category: 'travel' },
      { ...ownerChauffeEau, id: 'labor-zulu', label: 'Zulu', category: 'labor' },
      { ...ownerChauffeEau, id: 'supply-alpha', label: 'Alpha', category: 'supply' },
      { ...ownerChauffeEau, id: 'labor-alpha', label: 'Alpha', category: 'labor' },
    ];

    const view = deriveCatalogue({ trade: 'autre', custom: entries });

    expect(view.prestations.map((prestation) => prestation.id)).toEqual([
      'labor-alpha',
      'labor-zulu',
      'supply-alpha',
      'travel-alpha',
    ]);
    expect(entries.map((prestation) => prestation.id)).toEqual([
      'travel-alpha',
      'labor-zulu',
      'supply-alpha',
      'labor-alpha',
    ]);
  });

  it('expose uniquement les catégories facturables fermées', () => {
    // PR-14 « Le métier » : `subscription` (forfaits/contrats récurrents) rejoint le catalogue.
    expect(CATALOGUE_CATEGORIES).toEqual(['labor', 'supply', 'travel', 'subscription']);
    for (const category of CATALOGUE_CATEGORIES) {
      expect(isCatalogueCategory(category)).toBe(true);
    }
    // Un débours (remboursement à l'euro près, art. 267 CGI) n'est jamais une prestation
    // cataloguable — la catégorie reste hors du catalogue propriétaire.
    expect(isCatalogueCategory('disbursement')).toBe(false);
    expect(isCatalogueCategory(null)).toBe(false);
  });

  it('trie les forfaits/abonnements après les catégories historiques (ordre stable)', () => {
    const entries: CustomPrestation[] = [
      { ...ownerChauffeEau, id: 'sub-alpha', label: 'Entretien annuel fontaine', category: 'subscription' },
      { ...ownerChauffeEau, id: 'labor-alpha', label: 'Alpha', category: 'labor' },
    ];
    const view = deriveCatalogue({ trade: 'autre', custom: entries });
    expect(view.prestations.map((prestation) => prestation.id)).toEqual(['labor-alpha', 'sub-alpha']);
  });
});

describe('application/catalogue/searchCatalogue', () => {
  const prestations = deriveCatalogue({
    trade: 'plombier',
    custom: [
      ownerChauffeEau,
      ownerRamonage,
      {
        id: 'owner-3',
        label: 'Main-d\u2019\u0153uvre électricité',
        category: 'labor',
        unit: '1 h',
        unitPriceHT: 6_200,
        vatRate: 20,
      },
    ],
  }).prestations;

  it('retrouve les seuls éléments propriétaire sans tenir compte des accents, casse ou ligatures', () => {
    expect(searchCatalogue(prestations, 'CHAUFFE EAU').map((item) => item.id)).toEqual([
      'owner-1',
    ]);
    expect(searchCatalogue(prestations, 'oeuvre electricite').map((item) => item.id)).toEqual([
      'owner-3',
    ]);
  });

  it.each([
    ['  Main-d’Œuvre, Électricité ! ', 'main d oeuvre electricite'],
    ['CÆUR / pose', 'caeur pose'],
    ['Chauffe---eau  200 L', 'chauffe eau 200 l'],
    ['Škoda Łódź — Straße', 'skoda lodz strasse'],
    ['Þing Đuro, Øresund', 'thing duro oresund'],
    ['Ångström service', 'angstrom service'],
    ['E\u0301lectricite\u0301', 'electricite'],
  ])('normalise "%s" comme la future clé indexée PostgreSQL', (input, expected) => {
    expect(normalizeCatalogueSearchKey(input)).toBe(expected);
  });

  it('retourne une copie complète pour une requête vide et une liste vide sans correspondance', () => {
    const all = searchCatalogue(prestations, '   ');

    expect(all).toEqual(prestations);
    expect(all).not.toBe(prestations);
    expect(searchCatalogue(prestations, 'zzz-introuvable')).toEqual([]);
  });
});
