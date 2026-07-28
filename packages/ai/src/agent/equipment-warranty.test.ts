import { describe, expect, it } from 'vitest';
import { extractSpokenWarranty } from './equipment-warranty';

/**
 * [Revue train n°2] — la garantie PARLÉE ne se perd jamais en silence : mois-année dit
 * (norme fondateur §1.6) résolu en fin de mois, jour dit accepté, et toute mention illisible
 * SIGNALÉE (mentioned sans date) pour être dite honnêtement à la confirmation.
 */
describe('extractSpokenWarranty', () => {
  it('exemple NORMATIF fondateur : « sous garantie jusqu’en mars 2027 » → fin de mois', () => {
    expect(extractSpokenWarranty('elle est sous garantie jusqu’en mars 2027')).toEqual({
      date: '2027-03-31',
      mentioned: true,
      raw: 'sous garantie jusqu’en mars 2027',
    });
  });

  it('mois-année parlé : chaque mois résout à sa VRAIE fin de mois (février bissextile compris)', () => {
    expect(extractSpokenWarranty('garantie jusqu’en avril 2027').date).toBe('2027-04-30');
    expect(extractSpokenWarranty('garantie jusqu’en février 2027').date).toBe('2027-02-28');
    expect(extractSpokenWarranty('garantie jusqu’en fevrier 2028').date).toBe('2028-02-29');
    expect(extractSpokenWarranty('garantie jusqu’à fin décembre 2026').date).toBe('2026-12-31');
    expect(extractSpokenWarranty('sous garantie jusqu’en août 2027').date).toBe('2027-08-31');
  });

  it('jour dit : « jusqu’au 12 mars 2027 » et « 1er mars 2027 » sont lus au jour près', () => {
    expect(extractSpokenWarranty('garantie jusqu’au 12 mars 2027').date).toBe('2027-03-12');
    expect(extractSpokenWarranty('la garantie court jusqu’au 1er mars 2027').date).toBe('2027-03-01');
  });

  it('formats numériques historiques inchangés : JJ/MM/AAAA et AAAA-MM-JJ', () => {
    expect(extractSpokenWarranty('garantie jusqu’au 12/03/2027').date).toBe('2027-03-12');
    expect(extractSpokenWarranty('garantie 2027-03-12').date).toBe('2027-03-12');
  });

  it('mention ILLISIBLE : signalée (mentioned) avec le segment dit — jamais une date inventée', () => {
    expect(extractSpokenWarranty('garantie constructeur deux ans')).toEqual({
      date: null,
      mentioned: true,
      raw: 'garantie constructeur deux ans',
    });
    expect(extractSpokenWarranty('encore sous garantie')).toEqual({
      date: null,
      mentioned: true,
      raw: 'sous garantie',
    });
    // Date IMPOSSIBLE dite (31 février) : jamais promue — signalée illisible.
    expect(extractSpokenWarranty('garantie jusqu’au 31/02/2027').date).toBeNull();
    expect(extractSpokenWarranty('garantie jusqu’au 31/02/2027').mentioned).toBe(true);
  });

  it('aucune mention : ni date ni signalement', () => {
    expect(extractSpokenWarranty('Ajoute la clim du local serveur chez Carrefour')).toEqual({
      date: null,
      mentioned: false,
      raw: null,
    });
  });
});
