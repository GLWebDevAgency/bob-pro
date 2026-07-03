import { describe, it, expect } from 'vitest';
import { deriveTradeProfile } from './derive-trade-profile';
import { TRADE_PROFILES } from '../../domain/company/trade-profile';
import { Company, type Trade } from '../../domain/company/company';

const ALL_TRADES = Object.keys(TRADE_PROFILES) as Trade[];

/** Set BTP de référence via le DOMAINE (Company.isBtp) — pas de liste dupliquée dans le test. */
function domainIsBtp(trade: Trade): boolean {
  const c = Company.of({
    id: 'c1',
    name: 'Test',
    legalForm: 'EI',
    siren: '732829320',
    siret: '73282932000074',
    trade,
    vatRegime: 'reel_simpl',
    address: { line1: '14 rue des Artisans', zip: '92310', city: 'Sèvres' },
  });
  if (!c.ok) throw new Error('company fixture invalide');
  return c.value.isBtp();
}

describe('deriveTradeProfile — onboarding adaptatif (C22)', () => {
  it('plombier : preview chantier proto EXACT, décennale + retenue + TVA travaux, vocabulaire Chantier', () => {
    const r = deriveTradeProfile('plombier');
    expect(r.preview).toEqual(['Chantiers', 'Acomptes', 'Photos avant/après', 'TVA travaux', 'Retenue de garantie']);
    expect(r.highlights).toEqual(['decennale', 'retenue_garantie', 'tva_travaux']);
    expect(r.spaceLabel).toBe('plombier');
    expect(r.defaultVatRate).toBe(10);
    expect(r.vocabulary.project).toBe('Chantier');
  });

  it('électricien : le Consuel s’ajoute aux repères bâtiment, spaceLabel minuscule accentué', () => {
    const r = deriveTradeProfile('electricien');
    expect(r.highlights).toEqual(['decennale', 'consuel', 'retenue_garantie', 'tva_travaux']);
    expect(r.spaceLabel).toBe('électricien');
    expect(r.preview).toContain('Retenue de garantie');
  });

  it('métiers de services : previews proto EXACTS et repères propres (cession de droits, CRA)', () => {
    expect(deriveTradeProfile('consultant').preview).toEqual(['Missions', 'TJM', 'CRA', 'Frais refacturés', 'Acompte']);
    expect(deriveTradeProfile('consultant').highlights).toEqual(['cra']);
    expect(deriveTradeProfile('photographe').preview).toEqual(['Prestations', 'Acompte', 'Cession de droits', 'Galeries']);
    expect(deriveTradeProfile('photographe').highlights).toEqual(['cession_droits']);
    expect(deriveTradeProfile('coach').preview).toEqual(['Séances', 'Forfaits', 'Abonnements', 'Acompte']);
    expect(deriveTradeProfile('coach').highlights).toEqual([]);
    expect(deriveTradeProfile('coach').defaultVatRate).toBe(20);
  });

  it('autre : espace « pro » (proto onbMetierLabel), preview générique, aucun repère spécifique', () => {
    const r = deriveTradeProfile('autre');
    expect(r.spaceLabel).toBe('pro');
    expect(r.preview).toEqual(['Devis', 'Factures', 'Acomptes', 'Récurrent']);
    expect(r.highlights).toEqual([]);
  });

  it('les 9 métiers : preview non vide, spaceLabel en minuscules, décennale ⇔ BTP du domaine', () => {
    for (const trade of ALL_TRADES) {
      const r = deriveTradeProfile(trade);
      expect(r.preview.length).toBeGreaterThan(0);
      expect(r.spaceLabel).toBe(r.spaceLabel.toLowerCase());
      // Invariant anti-divergence : le repère décennale suit EXACTEMENT le set BTP du domaine company.
      expect(r.highlights.includes('decennale')).toBe(domainIsBtp(trade));
    }
  });
});
