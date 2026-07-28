import { describe, expect, it } from 'vitest';
import { Chantier } from '../../domain/chantier/chantier';
import { Equipment, type EquipmentProps } from '../../domain/equipment/equipment';
import { type ChantierRepository } from '../ports/repositories';
import { type EquipmentRepository } from './equipment-repository';
import { CHANTIER_CLOSED_EQUIPMENT_MESSAGE, CreateEquipment } from './create-equipment';
import { UpdateEquipment } from './update-equipment';
import { ReactivateEquipment, RetireEquipment } from './retire-equipment';
import { ReopenChantier } from '../chantier/reopen-chantier';
import { AddChantierNote } from '../chantier/add-chantier-note';

const COMPANY = 'company-1';

function chantierOf(id: string, status: 'open' | 'closed', companyId = COMPANY): Chantier {
  return Chantier.rehydrate({
    id,
    companyId,
    name: `Site ${id}`,
    customerId: null,
    address: null,
    notes: null,
    status,
    openedAt: '2026-07-01',
  });
}

function makeEnv(chantiers: Chantier[] = [chantierOf('chantier-bastille', 'open')]) {
  const chantierMap = new Map(chantiers.map((c) => [c.id, c]));
  const equipmentMap = new Map<string, Equipment>();
  const chantierRepo: ChantierRepository = {
    findById: async (id) => chantierMap.get(id) ?? null,
    listByCompany: async (companyId) =>
      [...chantierMap.values()].filter((c) => c.companyId === companyId),
    save: async (c) => {
      chantierMap.set(c.id, c);
    },
  };
  const equipmentRepo: EquipmentRepository = {
    findById: async (companyId, id) => {
      const equipment = equipmentMap.get(id);
      return equipment && equipment.companyId === companyId ? equipment : null;
    },
    listByChantier: async (companyId, chantierId) =>
      [...equipmentMap.values()].filter(
        (e) => e.companyId === companyId && e.chantierId === chantierId,
      ),
    listByCompany: async (companyId) =>
      [...equipmentMap.values()].filter((e) => e.companyId === companyId),
    save: async (e) => {
      equipmentMap.set(e.id, e);
    },
  };
  let sequence = 0;
  const ids = { newId: () => `equip-${(sequence += 1)}` };
  const clock = { now: () => '2026-07-28T09:00:00.000Z', today: () => '2026-07-28' };
  return { chantierRepo, equipmentRepo, equipmentMap, chantierMap, ids, clock };
}

function seedEquipment(
  env: ReturnType<typeof makeEnv>,
  overrides: Partial<EquipmentProps> = {},
): Equipment {
  const equipment = Equipment.rehydrate({
    id: 'equip-existant',
    companyId: COMPANY,
    chantierId: 'chantier-bastille',
    label: 'Fontaine accueil R+2',
    kind: 'Fontaine réseau',
    brand: null,
    serialNumber: null,
    location: null,
    installedAt: null,
    warrantyUntil: null,
    status: 'active',
    retiredAt: null,
    notes: null,
    revision: 1,
    ...overrides,
  });
  env.equipmentMap.set(equipment.id, equipment);
  return equipment;
}

describe('CreateEquipment — site prouvé, ouvert, fail-closed (Bloc A §1.5)', () => {
  it('crée un équipement ACTIF sur un site ouvert du tenant', async () => {
    const env = makeEnv();
    const created = await new CreateEquipment({
      equipments: env.equipmentRepo,
      chantiers: env.chantierRepo,
      ids: env.ids,
      clock: env.clock,
    }).execute({
      companyId: COMPANY,
      chantierId: 'chantier-bastille',
      label: '  Fontaine accueil R+2  ',
      kind: 'Fontaine réseau',
      warrantyUntil: '2027-03-12',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const saved = env.equipmentMap.get(created.value.id)!.toProps();
    expect(saved).toMatchObject({
      label: 'Fontaine accueil R+2',
      status: 'active',
      retiredAt: null,
      revision: 1,
    });
  });

  it('anti-IDOR : chantier d’un autre tenant = introuvable, rien n’est créé', async () => {
    const env = makeEnv([chantierOf('chantier-autre', 'open', 'company-autre')]);
    const created = await new CreateEquipment({
      equipments: env.equipmentRepo,
      chantiers: env.chantierRepo,
      ids: env.ids,
      clock: env.clock,
    }).execute({ companyId: COMPANY, chantierId: 'chantier-autre', label: 'Clim' });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.kind).toBe('not_found');
    expect(env.equipmentMap.size).toBe(0);
  });

  it('site clôturé : refus ACTIONNABLE (message unique écran/voix), rien n’est créé', async () => {
    const env = makeEnv([chantierOf('chantier-clos', 'closed')]);
    const created = await new CreateEquipment({
      equipments: env.equipmentRepo,
      chantiers: env.chantierRepo,
      ids: env.ids,
      clock: env.clock,
    }).execute({ companyId: COMPANY, chantierId: 'chantier-clos', label: 'Clim' });
    expect(created.ok).toBe(false);
    if (created.ok || created.error.kind !== 'domain') throw new Error('refus domaine attendu');
    expect(created.error.error).toMatchObject({
      code: 'VALIDATION',
      message: CHANTIER_CLOSED_EQUIPMENT_MESSAGE,
    });
    expect(env.equipmentMap.size).toBe(0);
  });

  it('après ReopenChantier, la création passe (le refus actionnable tient sa promesse)', async () => {
    const env = makeEnv([chantierOf('chantier-clos', 'closed')]);
    const reopened = await new ReopenChantier({ chantiers: env.chantierRepo }).execute({
      companyId: COMPANY,
      chantierId: 'chantier-clos',
    });
    expect(reopened).toEqual({ ok: true, value: { changed: true } });
    const again = await new ReopenChantier({ chantiers: env.chantierRepo }).execute({
      companyId: COMPANY,
      chantierId: 'chantier-clos',
    });
    expect(again).toEqual({ ok: true, value: { changed: false } });
    const created = await new CreateEquipment({
      equipments: env.equipmentRepo,
      chantiers: env.chantierRepo,
      ids: env.ids,
      clock: env.clock,
    }).execute({ companyId: COMPANY, chantierId: 'chantier-clos', label: 'Clim' });
    expect(created.ok).toBe(true);
  });

  it('ReopenChantier anti-IDOR : site d’un autre tenant introuvable', async () => {
    const env = makeEnv([chantierOf('chantier-autre', 'closed', 'company-autre')]);
    const refused = await new ReopenChantier({ chantiers: env.chantierRepo }).execute({
      companyId: COMPANY,
      chantierId: 'chantier-autre',
    });
    expect(refused.ok).toBe(false);
  });
});

describe('UpdateEquipment — CAS par révision', () => {
  it('applique le patch à la révision attendue et incrémente', async () => {
    const env = makeEnv();
    seedEquipment(env);
    const updated = await new UpdateEquipment({ equipments: env.equipmentRepo }).execute({
      companyId: COMPANY,
      equipmentId: 'equip-existant',
      expectedRevision: 1,
      patch: { location: 'R+2, accueil' },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value).toMatchObject({ location: 'R+2, accueil', revision: 2 });
  });

  it('révision périmée = conflit, AUCUNE écriture (deux appareils)', async () => {
    const env = makeEnv();
    seedEquipment(env, { revision: 3 });
    const stale = await new UpdateEquipment({ equipments: env.equipmentRepo }).execute({
      companyId: COMPANY,
      equipmentId: 'equip-existant',
      expectedRevision: 2,
      patch: { label: 'Autre nom' },
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.kind).toBe('conflict');
    expect(env.equipmentMap.get('equip-existant')!.label).toBe('Fontaine accueil R+2');
  });

  it('anti-IDOR : équipement d’un autre tenant introuvable', async () => {
    const env = makeEnv();
    seedEquipment(env, { companyId: 'company-autre' });
    const refused = await new UpdateEquipment({ equipments: env.equipmentRepo }).execute({
      companyId: COMPANY,
      equipmentId: 'equip-existant',
      expectedRevision: 1,
      patch: { label: 'Autre nom' },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.kind).toBe('not_found');
  });
});

describe('RetireEquipment / ReactivateEquipment — retrait logique + avertissement contrat', () => {
  it('retire pose retiredAt ; sans port contrat, aucun avertissement inventé', async () => {
    const env = makeEnv();
    seedEquipment(env);
    const retired = await new RetireEquipment({
      equipments: env.equipmentRepo,
      clock: env.clock,
    }).execute({ companyId: COMPANY, equipmentId: 'equip-existant', expectedRevision: 1 });
    expect(retired.ok).toBe(true);
    if (!retired.ok) return;
    expect(retired.value.equipment).toMatchObject({
      status: 'retired',
      retiredAt: '2026-07-28T09:00:00.000Z',
      revision: 2,
    });
    expect(retired.value.contractWarning).toBeNull();
  });

  it('[Amélioration 4] couvert par un contrat actif : avertissement honnête NON bloquant', async () => {
    const env = makeEnv();
    seedEquipment(env);
    const retired = await new RetireEquipment({
      equipments: env.equipmentRepo,
      clock: env.clock,
      contractCoverage: {
        activeContractLabels: async () => ['Entretien fontaines 2026'],
      },
    }).execute({ companyId: COMPANY, equipmentId: 'equip-existant', expectedRevision: 1 });
    expect(retired.ok).toBe(true);
    if (!retired.ok) return;
    // Le retrait a EU LIEU (la réalité du terrain prime), l'avertissement accompagne.
    expect(retired.value.equipment.status).toBe('retired');
    expect(retired.value.contractWarning).toContain('Entretien fontaines 2026');
  });

  it('réactivation purge retiredAt ; double retrait refusé par la machine', async () => {
    const env = makeEnv();
    seedEquipment(env, { status: 'retired', retiredAt: '2026-05-02T08:00:00.000Z', revision: 2 });
    const secondRetire = await new RetireEquipment({
      equipments: env.equipmentRepo,
      clock: env.clock,
    }).execute({ companyId: COMPANY, equipmentId: 'equip-existant', expectedRevision: 2 });
    expect(secondRetire.ok).toBe(false);

    const reactivated = await new ReactivateEquipment({ equipments: env.equipmentRepo }).execute({
      companyId: COMPANY,
      equipmentId: 'equip-existant',
      expectedRevision: 2,
    });
    expect(reactivated.ok).toBe(true);
    if (!reactivated.ok) return;
    expect(reactivated.value).toMatchObject({ status: 'active', retiredAt: null, revision: 3 });
  });
});

describe('AddChantierNote — tag équipement (PR-11, fail-closed)', () => {
  const deps = (env: ReturnType<typeof makeEnv>, withEquipments = true) => ({
    chantiers: env.chantierRepo,
    notes: {
      saved: [] as { equipmentId: string | null }[],
      save: async function (note: { toProps(): { equipmentId?: string | null } }) {
        this.saved.push({ equipmentId: note.toProps().equipmentId ?? null });
      },
      listByChantier: async () => [],
      countByCompany: async () => new Map<string, number>(),
    },
    ids: env.ids,
    clock: env.clock,
    ...(withEquipments ? { equipments: env.equipmentRepo } : {}),
  });

  it('tague la note quand l’équipement appartient AU MÊME site du tenant', async () => {
    const env = makeEnv();
    seedEquipment(env);
    const d = deps(env);
    const added = await new AddChantierNote(d as never).execute({
      companyId: COMPANY,
      chantierId: 'chantier-bastille',
      text: 'Détartrage complet',
      authorLabel: 'Fly Services',
      equipmentId: 'equip-existant',
    });
    expect(added.ok).toBe(true);
    expect(d.notes.saved).toEqual([{ equipmentId: 'equip-existant' }]);
  });

  it('équipement d’un AUTRE site : refus (cohérence équipement↔site)', async () => {
    const env = makeEnv([
      chantierOf('chantier-bastille', 'open'),
      chantierOf('chantier-rouen', 'open'),
    ]);
    seedEquipment(env, { chantierId: 'chantier-rouen' });
    const d = deps(env);
    const refused = await new AddChantierNote(d as never).execute({
      companyId: COMPANY,
      chantierId: 'chantier-bastille',
      text: 'Détartrage complet',
      authorLabel: 'Fly Services',
      equipmentId: 'equip-existant',
    });
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.error.kind !== 'domain') throw new Error('refus domaine attendu');
    expect(refused.error.error).toMatchObject({ code: 'VALIDATION', field: 'equipmentId' });
    expect(d.notes.saved).toEqual([]);
  });

  it('équipement inconnu/autre tenant : introuvable ; sans port : dependency (fail-closed)', async () => {
    const env = makeEnv();
    const d = deps(env);
    const unknown = await new AddChantierNote(d as never).execute({
      companyId: COMPANY,
      chantierId: 'chantier-bastille',
      text: 'Détartrage',
      authorLabel: 'Fly Services',
      equipmentId: 'equip-fantome',
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.kind).toBe('not_found');

    const noPort = deps(env, false);
    const refused = await new AddChantierNote(noPort as never).execute({
      companyId: COMPANY,
      chantierId: 'chantier-bastille',
      text: 'Détartrage',
      authorLabel: 'Fly Services',
      equipmentId: 'equip-existant',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe('dependency');
  });

  it('sans equipmentId : comportement historique inchangé (note du site, null honnête)', async () => {
    const env = makeEnv();
    const d = deps(env, false);
    const added = await new AddChantierNote(d as never).execute({
      companyId: COMPANY,
      chantierId: 'chantier-bastille',
      text: 'RDV code portail 1234',
      authorLabel: 'Fly Services',
    });
    expect(added.ok).toBe(true);
    expect(d.notes.saved).toEqual([{ equipmentId: null }]);
  });
});
