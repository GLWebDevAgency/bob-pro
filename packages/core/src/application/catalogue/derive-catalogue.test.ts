import { describe, it, expect } from 'vitest';
import { TRADE_PROFILES } from '../../domain/company/trade-profile';
import {
  CATALOGUE_CATEGORIES,
  deriveCatalogue,
  isCatalogueCategory,
  searchCatalogue,
  type CustomPrestation,
} from './derive-catalogue';
import { type Trade } from '../../domain/company/company';

const TRADES = Object.keys(TRADE_PROFILES) as Trade[];

const persoChauffeEau: CustomPrestation = {
  id: 'perso-1',
  label: 'Chauffe-eau 200 L',
  category: 'supply',
  unit: null,
  unitPriceHT: 79000, // le prix DE L'ARTISAN, différent de l'indicatif métier (89 000)
  vatRate: 10,
};

const persoRamonage: CustomPrestation = {
  id: 'perso-2',
  label: 'Ramonage conduit',
  category: 'labor',
  unit: 'forfait',
  unitPriceHT: 9000,
  vatRate: 10,
};

describe('application/catalogue/deriveCatalogue (C27 — métier → prestations suggérées + perso)', () => {
  it('chaque métier produit des suggestions cohérentes : indicatives, catégories fermées, TVA du métier, prix > 0, ids uniques', () => {
    for (const trade of TRADES) {
      const view = deriveCatalogue({ trade });
      expect(view.prestations.length).toBeGreaterThan(0);
      for (const p of view.prestations) {
        expect(p.source).toBe('metier');
        expect(p.indicative).toBe(true); // un indicatif n'est JAMAIS présenté comme le prix de l'artisan
        expect(isCatalogueCategory(p.category)).toBe(true);
        expect(p.vatRate).toBe(TRADE_PROFILES[trade].defaultVatRate); // 10 travaux · 20 services (C22)
        expect(Number.isInteger(p.unitPriceHT)).toBe(true);
        expect(p.unitPriceHT).toBeGreaterThan(0);
      }
      const ids = view.prestations.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(CATALOGUE_CATEGORIES).toEqual(['labor', 'supply', 'travel']);
  });

  it('vocabulaire métier : plombier → chauffe-eau/débouchage/recherche de fuite ; électricien → tableau + Consuel', () => {
    const plombier = deriveCatalogue({ trade: 'plombier' }).prestations.map((p) => p.label);
    expect(plombier).toContain('Chauffe-eau 200 L');
    expect(plombier).toContain('Débouchage canalisation');
    expect(plombier).toContain('Recherche de fuite');
    const electricien = deriveCatalogue({ trade: 'electricien' }).prestations.map((p) => p.label);
    expect(electricien).toContain('Remplacement tableau électrique');
    expect(electricien).toContain('Mise en conformité Consuel');
    // TVA suggérée par les règles existantes : BTP 10 %, services 20 %.
    expect(deriveCatalogue({ trade: 'plombier' }).prestations[0]?.vatRate).toBe(10);
    expect(deriveCatalogue({ trade: 'consultant' }).prestations[0]?.vatRate).toBe(20);
    // Freelance IT : catalogue propre (régie/TJM, forfait, TMA), distinct du consultant, TVA 20 %.
    const it = deriveCatalogue({ trade: 'freelance_it' }).prestations.map((p) => p.label);
    expect(it).toContain('Journée en régie (TJM)');
    expect(it).toContain('Maintenance mensuelle (TMA)');
    expect(deriveCatalogue({ trade: 'freelance_it' }).prestations[0]?.vatRate).toBe(20);
  });

  it("fusion « Bob garde tes prix » : la perso au même libellé ÉCLIPSE l'indicatif métier, la nouvelle s'ajoute", () => {
    const view = deriveCatalogue({ trade: 'plombier', custom: [persoChauffeEau, persoRamonage] });
    const chauffeEaux = view.prestations.filter((p) => p.label === 'Chauffe-eau 200 L');
    expect(chauffeEaux).toHaveLength(1); // l'indicatif a disparu — le prix de l'artisan fait foi
    expect(chauffeEaux[0]).toMatchObject({
      source: 'perso',
      indicative: false,
      unitPriceHT: 79000,
      id: 'perso-1',
    });
    expect(view.prestations.filter((p) => p.label === 'Ramonage conduit')).toHaveLength(1);
    // Ordre : catégorie labor → supply → travel, perso avant métier dans chaque catégorie.
    const labor = view.prestations.filter((p) => p.category === 'labor');
    expect(labor[0]?.id).toBe('perso-2');
    const rank = { labor: 0, supply: 1, travel: 2 } as const;
    const ranks = view.prestations.map((p) => rank[p.category]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b)); // jamais de catégorie entremêlée
  });

  it('searchCatalogue : insensible casse/accents, requête vide = tout, aucun résultat = liste vide', () => {
    const view = deriveCatalogue({ trade: 'plombier', custom: [persoRamonage] });
    expect(searchCatalogue(view.prestations, '')).toHaveLength(view.prestations.length);
    const chauffe = searchCatalogue(view.prestations, 'CHAUFFE');
    expect(chauffe.some((p) => p.label === 'Chauffe-eau 200 L')).toBe(true);
    // « débouchage » sans accents ni majuscules retrouve « Débouchage canalisation ».
    expect(searchCatalogue(view.prestations, 'debouchage')).toHaveLength(1);
    expect(searchCatalogue(view.prestations, 'zzz-introuvable')).toHaveLength(0);
  });
});
