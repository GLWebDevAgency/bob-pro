import { describe, it, expect } from 'vitest';
import { tradeProfile, resolveTradeConfig } from './trade-profile';

describe('TradeProfile — produit adapté au métier', () => {
  it('BTP : TVA travaux 10 % + modules chantier', () => {
    const p = tradeProfile('plombier');
    expect(p.defaultVatRate).toBe(10);
    expect(p.modules).toContain('situations_travaux');
    expect(p.modules).toContain('retenue_garantie');
    expect(p.vocabulary.project).toBe('Chantier');
  });

  it('consultant : TVA 20 %, CRA, vocabulaire « Mission »', () => {
    const p = tradeProfile('consultant');
    expect(p.defaultVatRate).toBe(20);
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
