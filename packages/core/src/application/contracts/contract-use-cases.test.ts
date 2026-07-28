import { describe, expect, it } from 'vitest';
import { Chantier } from '../../domain/chantier/chantier';
import { Customer, type CustomerProps } from '../../domain/customer/customer';
import { Equipment } from '../../domain/equipment/equipment';
import {
  MaintenanceContract,
  CONTRACT_B2C_REFUSED_MESSAGE,
  type MaintenanceContractProps,
} from '../../domain/contract/maintenance-contract';
import { type ChantierRepository, type CustomerRepository } from '../ports/repositories';
import { type EquipmentRepository } from '../equipment/equipment-repository';
import { type MaintenanceContractRepository } from './maintenance-contract-repository';
import {
  ActivateContract,
  CHANTIER_CLOSED_CONTRACT_MESSAGE,
  CreateMaintenanceContract,
  DeleteDraftContract,
  TerminateContract,
  UpdateMaintenanceContract,
  nextComputedAnniversary,
} from './contract-use-cases';

const COMPANY = 'company-1';

function customerOf(id: string, type: CustomerProps['type']): Customer {
  const r = Customer.of({
    id,
    companyId: COMPANY,
    type,
    name: type === 'b2g' ? 'RATP CAP' : type === 'b2b' ? 'Carrefour Vitry' : 'Mme Girard',
    ...(type === 'b2c' ? {} : { siren: '789220118' }),
    address: { line1: '1 rue du Dépôt', zip: '75012', city: 'Paris' },
  });
  if (!r.ok) throw new Error('customer fixture');
  return r.value;
}

function chantierOf(id: string, status: 'open' | 'closed'): Chantier {
  return Chantier.rehydrate({
    id,
    companyId: COMPANY,
    name: `Site ${id}`,
    customerId: null,
    address: null,
    notes: null,
    status,
    openedAt: '2026-07-01',
  });
}

function equipmentOf(id: string, chantierId: string): Equipment {
  return Equipment.rehydrate({
    id,
    companyId: COMPANY,
    chantierId,
    label: `Fontaine ${id}`,
    kind: null,
    brand: null,
    serialNumber: null,
    location: null,
    installedAt: null,
    warrantyUntil: null,
    status: 'active',
    retiredAt: null,
    notes: null,
    revision: 1,
  });
}

function makeEnv(input: {
  customers?: Customer[];
  chantiers?: Chantier[];
  equipments?: Equipment[];
} = {}) {
  const customers = input.customers ?? [customerOf('cus-ratp', 'b2g'), customerOf('cus-girard', 'b2c')];
  const chantiers = input.chantiers ?? [chantierOf('site-bastille', 'open'), chantierOf('site-clos', 'closed')];
  const equipments = input.equipments ?? [
    equipmentOf('equip-fontaine', 'site-bastille'),
    equipmentOf('equip-ailleurs', 'site-clos'),
  ];
  const contractMap = new Map<string, MaintenanceContract>();
  const customerRepo: CustomerRepository = {
    findById: async (id) => customers.find((c) => c.id === id) ?? null,
    listByCompany: async () => customers,
    save: async () => {},
  };
  const chantierRepo: ChantierRepository = {
    findById: async (id) => chantiers.find((c) => c.id === id) ?? null,
    listByCompany: async () => chantiers,
    save: async () => {},
  };
  const equipmentRepo: EquipmentRepository = {
    findById: async (companyId, id) => {
      const equipment = equipments.find((e) => e.id === id);
      return equipment && equipment.companyId === companyId ? equipment : null;
    },
    listByChantier: async () => equipments,
    listByCompany: async () => equipments,
    save: async () => {},
  };
  const contractRepo: MaintenanceContractRepository = {
    findById: async (companyId, id) => {
      const contract = contractMap.get(id);
      return contract && contract.companyId === companyId ? contract : null;
    },
    lockById: async (companyId, id) => {
      const contract = contractMap.get(id);
      return contract && contract.companyId === companyId ? contract : null;
    },
    listByCompany: async (companyId) =>
      [...contractMap.values()].filter((c) => c.companyId === companyId),
    listByCustomer: async (companyId, customerId) =>
      [...contractMap.values()].filter(
        (c) => c.companyId === companyId && c.customerId === customerId,
      ),
    save: async (c) => {
      contractMap.set(c.id, c);
    },
    deleteById: async (_companyId, id) => {
      contractMap.delete(id);
    },
  };
  let sequence = 0;
  const ids = { newId: () => `contract-id-${(sequence += 1)}` };
  const clock = { now: () => '2026-07-28T09:00:00.000Z', today: () => '2026-07-28' };
  return { customerRepo, chantierRepo, equipmentRepo, contractRepo, contractMap, ids, clock };
}

function seedContract(
  env: ReturnType<typeof makeEnv>,
  overrides: Partial<MaintenanceContractProps> = {},
): MaintenanceContract {
  const contract = MaintenanceContract.rehydrate({
    id: 'contract-seed',
    companyId: COMPANY,
    customerId: 'cus-ratp',
    chantierId: 'site-bastille',
    label: 'Entretien fontaines 2026',
    status: 'draft',
    anniversaryDate: '2025-10-12',
    noticeDays: 30,
    visitsPerYear: 2,
    tacitRenewal: true,
    importCoveredUntil: null,
    activatedAt: null,
    terminatedAt: null,
    terminationEffectiveDate: null,
    terminationNote: null,
    notes: null,
    revision: 1,
    lines: [
      {
        id: 'line-1',
        catalogueItemId: null,
        label: 'Forfait entretien annuel',
        quantity: 2,
        unitPriceHtCents: 80_000,
        vatRate: 20,
        position: 0,
      },
    ],
    equipmentIds: [],
    ...overrides,
  });
  env.contractMap.set(contract.id, contract);
  return contract;
}

function createDeps(env: ReturnType<typeof makeEnv>) {
  return {
    contracts: env.contractRepo,
    customers: env.customerRepo,
    chantiers: env.chantierRepo,
    equipments: env.equipmentRepo,
    ids: env.ids,
  };
}

describe('CreateMaintenanceContract — gardes fail-closed (§2.6)', () => {
  it('crée un brouillon b2g avec site, lignes et équipements du site', async () => {
    const env = makeEnv();
    const created = await new CreateMaintenanceContract(createDeps(env)).execute({
      companyId: COMPANY,
      customerId: 'cus-ratp',
      label: 'Entretien fontaines 2026',
      chantierId: 'site-bastille',
      anniversaryDate: '2025-10-12',
      importCoveredUntil: '2026-10-12',
      lines: [{ label: 'Forfait entretien', quantity: 3, unitPriceHtCents: 40_000, vatRate: 20 }],
      equipmentIds: ['equip-fontaine'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const saved = env.contractMap.get(created.value.id)!;
    expect(saved.status).toBe('draft');
    expect(saved.annualTotals().ht).toBe(120_000);
    expect(saved.equipmentIds).toEqual(['equip-fontaine']);
  });

  it('[direction 5] refuse un client b2c à la CRÉATION, LegalHint Chatel cité', async () => {
    const env = makeEnv();
    const refused = await new CreateMaintenanceContract(createDeps(env)).execute({
      companyId: COMPANY,
      customerId: 'cus-girard',
      label: 'Contrat particulier',
      anniversaryDate: '2026-01-01',
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(JSON.stringify(refused.error)).toContain('L215-1');
    expect(env.contractMap.size).toBe(0);
  });

  it('refuse un site clôturé (refus actionnable) et un équipement d’un AUTRE site', async () => {
    const env = makeEnv();
    const closed = await new CreateMaintenanceContract(createDeps(env)).execute({
      companyId: COMPANY,
      customerId: 'cus-ratp',
      label: 'Contrat site clos',
      chantierId: 'site-clos',
      anniversaryDate: '2026-01-01',
    });
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(JSON.stringify(closed.error)).toContain(CHANTIER_CLOSED_CONTRACT_MESSAGE);
    const wrongSite = await new CreateMaintenanceContract(createDeps(env)).execute({
      companyId: COMPANY,
      customerId: 'cus-ratp',
      label: 'Contrat équipement volé',
      chantierId: 'site-bastille',
      anniversaryDate: '2026-01-01',
      equipmentIds: ['equip-ailleurs'],
    });
    expect(wrongSite.ok).toBe(false);
  });
});

describe('ActivateContract — revalidation b2b/b2g (§2.6)', () => {
  it('active un brouillon et pose activatedAt (client relu)', async () => {
    const env = makeEnv();
    seedContract(env);
    const activated = await new ActivateContract({
      contracts: env.contractRepo,
      customers: env.customerRepo,
      clock: env.clock,
    }).execute({ companyId: COMPANY, contractId: 'contract-seed', expectedRevision: 1 });
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(activated.value.status).toBe('active');
    expect(activated.value.activatedAt).toBe('2026-07-28T09:00:00.000Z');
  });

  it('refuse l’activation si la fiche client est devenue b2c (refus Chatel relu)', async () => {
    const env = makeEnv();
    seedContract(env, { customerId: 'cus-girard' });
    const refused = await new ActivateContract({
      contracts: env.contractRepo,
      customers: env.customerRepo,
      clock: env.clock,
    }).execute({ companyId: COMPANY, contractId: 'contract-seed', expectedRevision: 1 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(JSON.stringify(refused.error)).toContain(CONTRACT_B2C_REFUSED_MESSAGE.slice(0, 40));
  });

  it('CAS : révision périmée → conflit, rien n’est écrit', async () => {
    const env = makeEnv();
    seedContract(env);
    const conflict = await new ActivateContract({
      contracts: env.contractRepo,
      customers: env.customerRepo,
      clock: env.clock,
    }).execute({ companyId: COMPANY, contractId: 'contract-seed', expectedRevision: 7 });
    expect(conflict.ok).toBe(false);
    expect(env.contractMap.get('contract-seed')!.status).toBe('draft');
  });
});

describe('UpdateMaintenanceContract — CAS + gardes site/équipements', () => {
  it('remplace lignes et équipements (site revalidé)', async () => {
    const env = makeEnv();
    seedContract(env);
    const updated = await new UpdateMaintenanceContract({ ...createDeps(env) }).execute({
      companyId: COMPANY,
      contractId: 'contract-seed',
      expectedRevision: 1,
      lines: [{ label: 'Forfait 3 machines', quantity: 3, unitPriceHtCents: 40_000, vatRate: 20 }],
      equipmentIds: ['equip-fontaine'],
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.lines).toHaveLength(1);
    expect(updated.value.equipmentIds).toEqual(['equip-fontaine']);
    const wrongSite = await new UpdateMaintenanceContract({ ...createDeps(env) }).execute({
      companyId: COMPANY,
      contractId: 'contract-seed',
      expectedRevision: updated.value.revision,
      equipmentIds: ['equip-ailleurs'],
    });
    expect(wrongSite.ok).toBe(false);
  });
});

describe('TerminateContract — date d’effet par défaut = prochain anniversaire CALCULÉ', () => {
  it('nextComputedAnniversary : strictement futur, clampé', () => {
    expect(nextComputedAnniversary('2025-10-12', '2026-07-28')).toBe('2026-10-12');
    expect(nextComputedAnniversary('2025-10-12', '2026-10-12')).toBe('2027-10-12');
    expect(nextComputedAnniversary('2028-02-29', '2028-03-01')).toBe('2029-02-28');
  });

  it('résilie avec défaut calculé et motif tracé', async () => {
    const env = makeEnv();
    seedContract(env, { status: 'active', activatedAt: '2025-10-12T08:00:00.000Z' });
    const terminated = await new TerminateContract({
      contracts: env.contractRepo,
      clock: env.clock,
    }).execute({
      companyId: COMPANY,
      contractId: 'contract-seed',
      expectedRevision: 1,
      note: 'Résiliation reçue par courrier.',
    });
    expect(terminated.ok).toBe(true);
    if (!terminated.ok) return;
    expect(terminated.value.status).toBe('terminated');
    expect(terminated.value.terminationEffectiveDate).toBe('2026-10-12');
  });
});

describe('DeleteDraftContract — brouillon seulement', () => {
  it('supprime un brouillon, refuse un actif (un contrat vivant se résilie)', async () => {
    const env = makeEnv();
    seedContract(env);
    const deleted = await new DeleteDraftContract({ contracts: env.contractRepo }).execute({
      companyId: COMPANY,
      contractId: 'contract-seed',
      expectedRevision: 1,
    });
    expect(deleted.ok).toBe(true);
    expect(env.contractMap.size).toBe(0);
    seedContract(env, { status: 'active', activatedAt: '2025-10-12T08:00:00.000Z' });
    const refused = await new DeleteDraftContract({ contracts: env.contractRepo }).execute({
      companyId: COMPANY,
      contractId: 'contract-seed',
      expectedRevision: 1,
    });
    expect(refused.ok).toBe(false);
    expect(env.contractMap.size).toBe(1);
  });
});
