import { describe, expect, it } from 'vitest';
import { equipmentRowSubtitle, matchesEquipmentQuery, warrantyChipOf } from './equipment-row.logic';

describe('warrantyChipOf — chip garantie dérivée de la colonne réelle (écrans §2.1)', () => {
  const today = '2026-07-28';
  it('> 90 j restants → success ; ≤ 90 j → warning ; échue → neutral avec sa clé dédiée', () => {
    expect(warrantyChipOf('2027-03-12', today)).toEqual({
      tone: 'success',
      labelKey: 'equipements.warrantyUntil',
      date: '2027-03-12',
    });
    expect(warrantyChipOf('2026-09-01', today)).toEqual({
      tone: 'warning',
      labelKey: 'equipements.warrantyUntil',
      date: '2026-09-01',
    });
    expect(warrantyChipOf('2026-05-01', today)).toEqual({
      tone: 'neutral',
      labelKey: 'equipements.warrantyExpired',
      date: '2026-05-01',
    });
  });
  it('borne exacte : J+90 reste warning, J+91 passe success ; aujourd’hui = encore valide', () => {
    expect(warrantyChipOf('2026-10-26', today)?.tone).toBe('warning'); // J+90
    expect(warrantyChipOf('2026-10-27', today)?.tone).toBe('success'); // J+91
    expect(warrantyChipOf(today, today)?.tone).toBe('warning');
  });
  it('absente → null (jamais une chip inventée)', () => {
    expect(warrantyChipOf(null, today)).toBeNull();
  });
});

describe('matchesEquipmentQuery — recherche locale accent-insensible', () => {
  const fontaine = {
    label: 'Fontaine accueil R+2',
    kind: 'Fontaine réseau',
    brand: 'Culligan',
    serialNumber: 'SN 88-4121',
    location: 'R+2, accueil',
  };
  it('matche label/type/marque/série/emplacement, accents et casse repliés', () => {
    expect(matchesEquipmentQuery(fontaine, 'fontaine')).toBe(true);
    expect(matchesEquipmentQuery(fontaine, 'RÉSEAU culligan')).toBe(true);
    expect(matchesEquipmentQuery(fontaine, '88-4121')).toBe(true);
    expect(matchesEquipmentQuery(fontaine, 'clim')).toBe(false);
  });
  it('requête vide = tout passe', () => {
    expect(matchesEquipmentQuery(fontaine, '  ')).toBe(true);
  });
});

describe('equipmentRowSubtitle', () => {
  it('assemble les seules parts réelles, null si aucune', () => {
    expect(
      equipmentRowSubtitle({ label: 'x', kind: 'Fontaine réseau', brand: 'Culligan', serialNumber: null, location: null }),
    ).toBe('Fontaine réseau · Culligan');
    expect(
      equipmentRowSubtitle({ label: 'x', kind: null, brand: null, serialNumber: null, location: null }),
    ).toBeNull();
  });
});
