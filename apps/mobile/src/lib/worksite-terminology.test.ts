import { describe, expect, it } from 'vitest';
import { tradeToWorksiteTerminology } from '@bob/core';
import { DEFAULT_WORKSITE_TERM, worksiteParamsFor } from './worksite-terminology';

describe('worksiteParamsFor — accord grammatical du regroupement chantier/projet', () => {
  it('nom masculin (chantier, BTP) : un/du/Nouveau/ce/Le/premier/créé', () => {
    const params = worksiteParamsFor(tradeToWorksiteTerminology('plombier'));
    expect(params).toMatchObject({
      term: 'chantier',
      termCap: 'Chantier',
      plural: 'chantiers',
      pluralCap: 'Chantiers',
      article: 'un',
      de: 'du',
      newAdj: 'Nouveau',
      demonstrative: 'ce',
      articleDefCap: 'Le',
      premierAdj: 'premier',
      createdAdj: 'créé',
      aucunAdj: 'Aucun',
    });
  });

  it('nom féminin (mission, freelance IT) : une/de la/Nouvelle/cette/La/première/créée', () => {
    const params = worksiteParamsFor(tradeToWorksiteTerminology('freelance_it'));
    expect(params).toMatchObject({
      term: 'mission',
      termCap: 'Mission',
      plural: 'missions',
      pluralCap: 'Missions',
      article: 'une',
      de: 'de la',
      newAdj: 'Nouvelle',
      demonstrative: 'cette',
      articleDefCap: 'La',
      premierAdj: 'première',
      createdAdj: 'créée',
      aucunAdj: 'Aucune',
    });
  });

  it('métier sans nom déclaré (autre) : repli « projet », masculin', () => {
    const params = worksiteParamsFor(tradeToWorksiteTerminology('autre'));
    expect(params).toMatchObject({ term: 'projet', article: 'un', de: 'du' });
  });

  it('PR-10 — maintenance (frigoriste/mainteneur) : « site », masculin — le même écran parle site, jamais chantier', () => {
    for (const trade of ['frigoriste', 'mainteneur'] as const) {
      const params = worksiteParamsFor(tradeToWorksiteTerminology(trade));
      expect(params).toMatchObject({
        term: 'site',
        termCap: 'Site',
        plural: 'sites',
        pluralCap: 'Sites',
        article: 'un',
        de: 'du',
        newAdj: 'Nouveau',
        demonstrative: 'ce',
        articleDefCap: 'Le',
        premierAdj: 'premier',
        createdAdj: 'créé',
        aucunAdj: 'Aucun',
      });
    }
  });

  it('repli neutre (profil non chargé) : identique au vocabulaire BTP par défaut', () => {
    expect(worksiteParamsFor(DEFAULT_WORKSITE_TERM)).toMatchObject({ term: 'chantier', article: 'un' });
  });
});
