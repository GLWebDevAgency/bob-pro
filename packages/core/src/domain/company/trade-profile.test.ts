import { describe, it, expect } from 'vitest';
import { tradeProfile, resolveTradeConfig, tradeToWorksiteTerminology } from './trade-profile';
import type { Trade } from './company';

describe('TradeProfile — produit adapté au métier', () => {
  it('BTP : modules chantier sans taux fiscal déduit du métier', () => {
    const p = tradeProfile('plombier');
    expect(p).not.toHaveProperty('defaultVatRate');
    expect(p.modules).toContain('situations_travaux');
    expect(p.modules).toContain('retenue_garantie');
    expect(p.vocabulary.project).toBe('Chantier');
  });

  it('consultant : CRA et vocabulaire « Mission », sans TVA implicite', () => {
    const p = tradeProfile('consultant');
    expect(p).not.toHaveProperty('defaultVatRate');
    expect(p.modules).toContain('cra');
    expect(p.vocabulary.project).toBe('Mission');
  });

  it('resolveTradeConfig : le métier décide la pertinence, le palier décide le droit', () => {
    const free = resolveTradeConfig('plombier', 'free');
    const socle = free.modules.find((m) => m.key === 'devis_factures');
    const situations = free.modules.find((m) => m.key === 'situations_travaux');
    expect(socle?.active).toBe(true); // socle dispo au gratuit
    expect(situations?.active).toBe(false); // module à valeur -> Pro
    expect(situations?.unlockTier).toBe('pro');

    const pro = resolveTradeConfig('plombier', 'pro');
    expect(pro.modules.find((m) => m.key === 'situations_travaux')?.active).toBe(true);
  });

  it('add-on Pack BTP : modules chantier actifs sur Solo (sans passer Pro)', () => {
    const soloPlus = resolveTradeConfig('plombier', 'solo', ['vertical_btp']);
    expect(soloPlus.modules.find((m) => m.key === 'situations_travaux')?.active).toBe(true);
    const soloSans = resolveTradeConfig('plombier', 'solo');
    expect(soloSans.modules.find((m) => m.key === 'situations_travaux')?.active).toBe(false);
  });
});

describe('tradeToWorksiteTerminology — vocabulaire adaptatif chantier/projet', () => {
  it('BTP (plombier, électricien, maçon, peintre, paysagiste) : « chantier », masculin', () => {
    for (const trade of ['plombier', 'electricien', 'macon', 'peintre', 'paysagiste'] as const) {
      const term = tradeToWorksiteTerminology(trade);
      expect(term.singular).toBe('chantier');
      expect(term.plural).toBe('chantiers');
      expect(term.gender).toBe('m');
      expect(term.article).toEqual({ indefinite: 'un', definite: 'le' });
    }
  });

  it('consultant : « mission », féminin', () => {
    const term = tradeToWorksiteTerminology('consultant');
    expect(term.singular).toBe('mission');
    expect(term.plural).toBe('missions');
    expect(term.gender).toBe('f');
    expect(term.article).toEqual({ indefinite: 'une', definite: 'la' });
  });

  it('freelance_it : « mission », féminin (régie/forfait — vocabulaire IT, pas BTP)', () => {
    const term = tradeToWorksiteTerminology('freelance_it');
    expect(term.singular).toBe('mission');
    expect(term.gender).toBe('f');
  });

  it('photographe : « prestation », féminin', () => {
    const term = tradeToWorksiteTerminology('photographe');
    expect(term.singular).toBe('prestation');
    expect(term.gender).toBe('f');
  });

  it('coach : « séance », féminin', () => {
    const term = tradeToWorksiteTerminology('coach');
    expect(term.singular).toBe('séance');
    expect(term.gender).toBe('f');
  });

  it('autre (et tout métier par défaut) : « projet », masculin', () => {
    const term = tradeToWorksiteTerminology('autre');
    expect(term.singular).toBe('projet');
    expect(term.plural).toBe('projets');
    expect(term.gender).toBe('m');
    expect(term.article).toEqual({ indefinite: 'un', definite: 'le' });
  });

  it('couvre les 10 métiers sans lever — jamais de terminologie undefined', () => {
    const trades: readonly Trade[] = [
      'plombier', 'electricien', 'macon', 'peintre', 'paysagiste',
      'consultant', 'freelance_it', 'photographe', 'coach', 'autre',
    ];
    for (const trade of trades) {
      const term = tradeToWorksiteTerminology(trade);
      expect(term.singular.length).toBeGreaterThan(0);
      expect(term.plural.length).toBeGreaterThan(0);
    }
  });
});
