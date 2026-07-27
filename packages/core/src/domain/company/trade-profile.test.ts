import { describe, it, expect } from 'vitest';
import { TRADE_PROFILES, tradeProfile, resolveTradeConfig, tradeToWorksiteTerminology } from './trade-profile';
import { isBtpTrade, type Trade } from './company';

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

describe('PR-10 — métiers de la maintenance (gating révisé + vocabulaire « site »)', () => {
  it('snapshot frigoriste : sites + contrats récurrents, vocabulaire Site, métier BTP (autoliquidation possible)', () => {
    expect(tradeProfile('frigoriste')).toEqual({
      trade: 'frigoriste',
      label: 'Frigoriste',
      modules: ['devis_factures', 'chantiers', 'acomptes', 'abonnements'],
      vocabulary: { customer: 'Client', project: 'Site' },
    });
    expect(isBtpTrade('frigoriste')).toBe(true);
  });

  it('snapshot mainteneur : mêmes briques SANS être un métier du bâtiment (jamais d’autoliquidation présumée)', () => {
    expect(tradeProfile('mainteneur')).toEqual({
      trade: 'mainteneur',
      label: 'Mainteneur',
      modules: ['devis_factures', 'chantiers', 'acomptes', 'abonnements'],
      vocabulary: { customer: 'Client', project: 'Site' },
    });
    expect(isBtpTrade('mainteneur')).toBe(false);
  });

  it('gating révisé : le module chantiers n’est PLUS un marqueur BTP (mainteneur = sites sans bâtiment)', () => {
    const withChantiers = (Object.keys(TRADE_PROFILES) as Trade[]).filter((trade) =>
      TRADE_PROFILES[trade].modules.includes('chantiers'),
    );
    expect(withChantiers).toContain('mainteneur');
    expect(isBtpTrade('mainteneur')).toBe(false);
    // Les 5 métiers bâtiment historiques restent BTP — non-régression du set du domaine.
    for (const trade of ['plombier', 'electricien', 'macon', 'peintre', 'paysagiste'] as const) {
      expect(isBtpTrade(trade)).toBe(true);
    }
  });

  it('le même écran parle « chantier » à un maçon et « site » à un frigoriste', () => {
    expect(tradeToWorksiteTerminology('macon').singular).toBe('chantier');
    for (const trade of ['frigoriste', 'mainteneur'] as const) {
      const term = tradeToWorksiteTerminology(trade);
      expect(term.singular).toBe('site');
      expect(term.plural).toBe('sites');
      expect(term.gender).toBe('m');
      expect(term.article).toEqual({ indefinite: 'un', definite: 'le' });
    }
  });

  it('gating par palier inchangé : chantiers dès Solo, abonnements en Pro — pour les métiers de maintenance aussi', () => {
    const solo = resolveTradeConfig('frigoriste', 'solo');
    expect(solo.modules.find((m) => m.key === 'chantiers')?.active).toBe(true);
    expect(solo.modules.find((m) => m.key === 'abonnements')?.active).toBe(false);
    const pro = resolveTradeConfig('mainteneur', 'pro');
    expect(pro.modules.find((m) => m.key === 'chantiers')?.active).toBe(true);
    expect(pro.modules.find((m) => m.key === 'abonnements')?.active).toBe(true);
  });

  it('snapshot COMPLET du catalogue métier×modules — toute dérive de gating est un choix explicite', () => {
    const snapshot = Object.fromEntries(
      (Object.keys(TRADE_PROFILES) as Trade[]).map((trade) => [
        trade,
        {
          modules: [...TRADE_PROFILES[trade].modules],
          project: TRADE_PROFILES[trade].vocabulary.project,
          btp: isBtpTrade(trade),
        },
      ]),
    );
    expect(snapshot).toEqual({
      plombier: { modules: ['devis_factures', 'chantiers', 'acomptes', 'situations_travaux', 'retenue_garantie'], project: 'Chantier', btp: true },
      electricien: { modules: ['devis_factures', 'chantiers', 'acomptes', 'retenue_garantie'], project: 'Chantier', btp: true },
      macon: { modules: ['devis_factures', 'chantiers', 'situations_travaux', 'retenue_garantie'], project: 'Chantier', btp: true },
      peintre: { modules: ['devis_factures', 'chantiers', 'acomptes'], project: 'Chantier', btp: true },
      paysagiste: { modules: ['devis_factures', 'chantiers', 'abonnements'], project: 'Chantier', btp: true },
      frigoriste: { modules: ['devis_factures', 'chantiers', 'acomptes', 'abonnements'], project: 'Site', btp: true },
      mainteneur: { modules: ['devis_factures', 'chantiers', 'acomptes', 'abonnements'], project: 'Site', btp: false },
      consultant: { modules: ['devis_factures', 'cra', 'frais_refactures'], project: 'Mission', btp: false },
      freelance_it: { modules: ['devis_factures', 'cra', 'forfaits', 'acomptes', 'frais_refactures', 'abonnements'], project: 'Mission', btp: false },
      photographe: { modules: ['devis_factures', 'acomptes', 'cession_droits'], project: 'Prestation', btp: false },
      coach: { modules: ['devis_factures', 'forfaits', 'abonnements'], project: 'Séance', btp: false },
      autre: { modules: ['devis_factures'], project: 'Projet', btp: false },
    });
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
