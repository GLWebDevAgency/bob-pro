import { describe, expect, it } from 'vitest';
import { EQUIPMENT_TRANSITIONS, Equipment, type EquipmentProps } from './equipment';

function props(overrides: Partial<EquipmentProps> = {}): EquipmentProps {
  return {
    id: 'equip-1',
    companyId: 'company-1',
    chantierId: 'chantier-bastille',
    label: 'Fontaine accueil R+2',
    kind: 'Fontaine réseau',
    brand: 'Culligan',
    serialNumber: 'SN 88-4121',
    location: 'R+2, accueil',
    installedAt: '2024-03-12',
    warrantyUntil: '2027-03-12',
    status: 'active',
    retiredAt: null,
    notes: null,
    revision: 1,
    ...overrides,
  };
}

describe('Equipment — invariants de composition (Bloc A §1.3)', () => {
  it('canonise les champs libres (trim) et accepte tout kind non vide — jamais de taxonomie', () => {
    const r = Equipment.record(props({ label: '  Fontaine accueil R+2  ', kind: '  PAC gainable  ' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.label).toBe('Fontaine accueil R+2');
    expect(r.value.kind).toBe('PAC gainable');
    // Un libellé vidé par le trim devient null honnête (champ optionnel).
    const emptied = Equipment.record(props({ brand: '   ' }));
    expect(emptied.ok && emptied.value.toProps().brand === null).toBe(true);
  });

  it('refuse un label vide, trop long ou avec caractères de contrôle', () => {
    expect(Equipment.record(props({ label: '   ' })).ok).toBe(false);
    expect(Equipment.record(props({ label: 'a'.repeat(201) })).ok).toBe(false);
    expect(Equipment.record(props({ label: 'Fontaine' })).ok).toBe(false);
    expect(Equipment.record(props({ label: 'a'.repeat(200) })).ok).toBe(true);
  });

  it('refuse une garantie antérieure à la pose — et accepte les dates égales ou absentes', () => {
    expect(Equipment.record(props({ installedAt: '2026-03-12', warrantyUntil: '2026-03-11' })).ok).toBe(false);
    expect(Equipment.record(props({ installedAt: '2026-03-12', warrantyUntil: '2026-03-12' })).ok).toBe(true);
    expect(Equipment.record(props({ installedAt: null, warrantyUntil: '2027-03-12' })).ok).toBe(true);
    expect(Equipment.record(props({ installedAt: '2026-03-12', warrantyUntil: null })).ok).toBe(true);
    expect(Equipment.record(props({ installedAt: '2026-02-30', warrantyUntil: null })).ok).toBe(false);
  });

  it('borne notes à 2000 et les champs libres à 200', () => {
    expect(Equipment.record(props({ notes: 'n'.repeat(2000) })).ok).toBe(true);
    expect(Equipment.record(props({ notes: 'n'.repeat(2001) })).ok).toBe(false);
    expect(Equipment.record(props({ serialNumber: 's'.repeat(201) })).ok).toBe(false);
  });

  it('[revue n°2] notes de terrain MULTILIGNES : \\n et \\t admis, autres contrôles refusés — les champs mono-ligne restent stricts', () => {
    // La conception (§1.2/§1.3) ne borne notes qu'à 2000 caractères : une note de terrain
    // multiligne est légitime (miroir SQL translate(notes, \n\t, '') !~ '[[:cntrl:]]').
    const multiline = Equipment.record(
      props({ notes: 'Détartrage complet.\nPrévoir cartouche au prochain passage.\tRéf 88-4121' }),
    );
    expect(multiline.ok).toBe(true);
    if (multiline.ok)
      expect(multiline.value.toProps().notes).toBe(
        'Détartrage complet.\nPrévoir cartouche au prochain passage.\tRéf 88-4121',
      );
    // Les AUTRES caractères de contrôle restent interdits dans les notes.
    expect(Equipment.record(props({ notes: 'sonnerie \u0007' })).ok).toBe(false);
    expect(Equipment.record(props({ notes: 'nul \u0000' })).ok).toBe(false);
    // Les champs MONO-LIGNE (label, kind…) refusent toujours \n : rien n'est relâché ailleurs.
    expect(Equipment.record(props({ label: 'Fontaine\naccueil' })).ok).toBe(false);
    expect(Equipment.record(props({ kind: 'PAC\ngainable' })).ok).toBe(false);
  });

  it('cohérence TRIPLE : jamais un demi-état statut/retiredAt', () => {
    expect(Equipment.record(props({ status: 'retired', retiredAt: null })).ok).toBe(false);
    expect(Equipment.record(props({ status: 'active', retiredAt: '2026-05-02T08:00:00.000Z' })).ok).toBe(false);
    expect(Equipment.record(props({ status: 'retired', retiredAt: '2026-05-02T08:00:00.000Z' })).ok).toBe(true);
  });
});

describe('Equipment — cycle d’état (Bloc A §1.4)', () => {
  it('matrice des transitions : active↔retired uniquement', () => {
    expect(EQUIPMENT_TRANSITIONS).toEqual({ active: ['retired'], retired: ['active'] });
  });

  it('retire() pose retiredAt et incrémente la révision ; un second retrait est refusé', () => {
    const equipment = Equipment.rehydrate(props());
    const retired = equipment.retire('2026-05-02T08:00:00.000Z');
    expect(retired.ok).toBe(true);
    expect(equipment.status).toBe('retired');
    expect(equipment.retiredAt).toBe('2026-05-02T08:00:00.000Z');
    expect(equipment.revision).toBe(2);
    const again = equipment.retire('2026-05-03T08:00:00.000Z');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('reactivate() PURGE retiredAt — jamais un fait de retrait fantôme', () => {
    const equipment = Equipment.rehydrate(
      props({ status: 'retired', retiredAt: '2026-05-02T08:00:00.000Z', revision: 2 }),
    );
    const reactivated = equipment.reactivate();
    expect(reactivated.ok).toBe(true);
    expect(equipment.status).toBe('active');
    expect(equipment.retiredAt).toBeNull();
    expect(equipment.revision).toBe(3);
    expect(equipment.reactivate().ok).toBe(false);
  });

  it('update() revalide chaque champ, refuse un équipement retiré et une clé étrangère', () => {
    const equipment = Equipment.rehydrate(props());
    const updated = equipment.update({ label: 'Fontaine quai A', warrantyUntil: null });
    expect(updated.ok).toBe(true);
    expect(equipment.label).toBe('Fontaine quai A');
    expect(equipment.revision).toBe(2);

    expect(equipment.update({}).ok).toBe(false);
    expect(equipment.update({ status: 'retired' } as never).ok).toBe(false);
    expect(equipment.update({ warrantyUntil: '2020-01-01' }).ok).toBe(false); // < installedAt

    const retired = Equipment.rehydrate(
      props({ status: 'retired', retiredAt: '2026-05-02T08:00:00.000Z' }),
    );
    const refused = retired.update({ label: 'Nouveau nom' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatchObject({ code: 'VALIDATION', field: 'status' });
  });
});
