import { describe, expect, it } from 'vitest';
import { suggestRegistrationNumber } from './registration-number';

// SIREN Luhn-valides utilisés partout dans la suite (mêmes que company.test.ts / seeds).
const SIRET_SAS = '73282932000074'; // SIREN 732 829 320
const SIRET_EI = '81234567600009'; // SIREN 812 345 676

describe('suggestRegistrationNumber — société commerciale (RCS)', () => {
  it('dérive « <SIREN> RCS <Ville> » du SIRET et de la ville du siège', () => {
    const s = suggestRegistrationNumber({
      legalForm: 'SAS',
      siret: SIRET_SAS,
      city: 'PARIS',
    });
    expect(s).not.toBeNull();
    expect(s?.registry).toBe('rcs');
    expect(s?.value).toBe('732 829 320 RCS Paris');
    // La ville du GREFFE n'est pas toujours celle du siège : l'hypothèse est marquée, la
    // confirmation utilisateur est donc obligatoire côté écran (« vérifie ton extrait Kbis »).
    expect(s?.greffeCityAssumed).toBe(true);
  });

  it('couvre toutes les formes à capital (EURL, SASU, SARL, SAS)', () => {
    for (const legalForm of ['EURL', 'SASU', 'SARL', 'SAS'] as const) {
      const s = suggestRegistrationNumber({ legalForm, siret: SIRET_SAS, city: 'Lyon' });
      expect(s?.registry).toBe('rcs');
      expect(s?.value).toBe('732 829 320 RCS Lyon');
    }
  });

  it('normalise une ville INSEE en capitales vers une casse de greffe lisible', () => {
    expect(
      suggestRegistrationNumber({ legalForm: 'SAS', siret: SIRET_SAS, city: 'SAINT-ÉTIENNE' })
        ?.value,
    ).toBe('732 829 320 RCS Saint-Étienne');
    expect(
      suggestRegistrationNumber({ legalForm: 'SARL', siret: SIRET_SAS, city: 'le havre' })?.value,
    ).toBe('732 829 320 RCS Le Havre');
  });

  it('ne propose AUCUNE valeur quand la ville du siège est inconnue (jamais de greffe inventé)', () => {
    const s = suggestRegistrationNumber({ legalForm: 'SAS', siret: SIRET_SAS, city: '   ' });
    expect(s?.registry).toBe('rcs');
    expect(s?.value).toBeNull();
    expect(s?.placeholder.length).toBeGreaterThan(0);
  });
});

describe('suggestRegistrationNumber — artisan au répertoire des métiers (RM)', () => {
  it('propose le FORMAT sans jamais inventer de numéro (EI, micro)', () => {
    for (const legalForm of ['EI', 'micro'] as const) {
      const s = suggestRegistrationNumber({ legalForm, siret: SIRET_EI, city: 'Sèvres' });
      expect(s?.registry).toBe('rm');
      // Le n° RM ne se DÉDUIT pas du SIREN (chambre de métiers + département d'immatriculation) :
      // fail-closed, aucune valeur pré-remplie.
      expect(s?.value).toBeNull();
      expect(s?.placeholder).toContain('RM');
      expect(s?.greffeCityAssumed).toBe(false);
    }
  });
});

describe('suggestRegistrationNumber — fail-closed', () => {
  it('rend null sur un SIRET structurellement invalide (jamais un SIREN tronqué au hasard)', () => {
    expect(suggestRegistrationNumber({ legalForm: 'SAS', siret: '123', city: 'Paris' })).toBeNull();
    // Clé de contrôle Luhn fausse (dernier chiffre altéré) — le cas réel d'une saisie fautive.
    expect(
      suggestRegistrationNumber({ legalForm: 'SAS', siret: '73282932000075', city: 'Paris' }),
    ).toBeNull();
    expect(
      suggestRegistrationNumber({ legalForm: 'SAS', siret: 'abcdefghijklmn', city: 'Paris' }),
    ).toBeNull();
  });

  it('tolère un SIRET espacé (saisie/annuaire) sans changer la dérivation', () => {
    expect(
      suggestRegistrationNumber({ legalForm: 'SAS', siret: '732 829 320 00074', city: 'Paris' })
        ?.value,
    ).toBe('732 829 320 RCS Paris');
  });
});
