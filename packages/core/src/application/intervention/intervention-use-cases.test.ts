import { describe, expect, it } from 'vitest';
import { Chantier } from '../../domain/chantier/chantier';
import { ChantierNote } from '../../domain/chantier/chantier-note';
import { Customer } from '../../domain/customer/customer';
import { Equipment } from '../../domain/equipment/equipment';
import {
  Intervention,
  INTERVENTION_SIGNED_LOCKED_MESSAGE,
  type InterventionProps,
} from '../../domain/intervention/intervention';
import { type ChantierRepository, type ChantierNoteRepository, type CustomerRepository } from '../ports/repositories';
import { type EquipmentRepository } from '../equipment/equipment-repository';
import { type WorksiteMediaItem, type WorksiteMediaStorage } from '../ports/worksite-media';
import { type DocumentStoragePort } from '../ports/document-storage';
import { AddChantierNote } from '../chantier/add-chantier-note';
import { UploadWorksitePhoto } from '../chantier/upload-worksite-photo';
import { DeleteWorksitePhoto } from '../chantier/delete-worksite-photo';
import { CHANTIER_CLOSED_INTERVENTION_MESSAGE, CreateIntervention } from './create-intervention';
import { StartIntervention } from './start-intervention';
import { CompleteIntervention } from './complete-intervention';
import { CancelIntervention } from './cancel-intervention';
import { UpdateIntervention } from './update-intervention';
import { SignIntervention } from './sign-intervention';
import { type InterventionRepository } from './intervention-repository';

const COMPANY = 'co-1';
const OTHER = 'co-2';
const SITE = 'site-bastille';
const CUSTOMER = 'cust-ratp';
const SHA = 'b'.repeat(64);
const UUID = '5f0c9a52-8e5c-4a4f-9d21-3f6b1a2c4d5e';

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

function customerOf(id: string, companyId = COMPANY): Customer {
  const customer = Customer.of({
    id,
    companyId,
    type: 'b2b',
    name: 'RATP CAP',
    email: 'compta@ratp.example',
    address: { line1: '1 place de la Bastille', zip: '75011', city: 'Paris' },
  });
  if (!customer.ok) throw new Error('fixture client invalide');
  return customer.value;
}

function equipmentOf(id: string, chantierId: string, companyId = COMPANY): Equipment {
  return Equipment.rehydrate({
    id,
    companyId,
    chantierId,
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
  });
}

/** Environnement de test : doubles EN MÉMOIRE des ports (aucun framework, aucune I/O réelle). */
function makeEnv() {
  const chantiers = new Map<string, Chantier>([
    [SITE, chantierOf(SITE, 'open')],
    ['site-clos', chantierOf('site-clos', 'closed')],
    ['site-autre-tenant', chantierOf('site-autre-tenant', 'open', OTHER)],
  ]);
  const customers = new Map<string, Customer>([
    [CUSTOMER, customerOf(CUSTOMER)],
    ['cust-autre', customerOf('cust-autre', OTHER)],
  ]);
  const equipments = new Map<string, Equipment>([
    ['equip-fontaine', equipmentOf('equip-fontaine', SITE)],
    ['equip-autre-site', equipmentOf('equip-autre-site', 'site-clos')],
  ]);
  const interventions = new Map<string, Intervention>();
  const notes: ChantierNote[] = [];
  const photos = new Map<string, WorksiteMediaItem>();
  const removedBytes: string[] = [];

  const chantierRepo: ChantierRepository = {
    findById: async (id) => chantiers.get(id) ?? null,
    listByCompany: async (companyId) =>
      [...chantiers.values()].filter((c) => c.companyId === companyId),
    save: async (c) => {
      chantiers.set(c.id, c);
    },
  };
  const customerRepo: Pick<CustomerRepository, 'findById'> = {
    findById: async (id) => customers.get(id) ?? null,
  };
  const equipmentRepo: EquipmentRepository = {
    findById: async (companyId, id) => {
      const equipment = equipments.get(id);
      return equipment && equipment.companyId === companyId ? equipment : null;
    },
    listByChantier: async (companyId, chantierId) =>
      [...equipments.values()].filter(
        (e) => e.companyId === companyId && e.chantierId === chantierId,
      ),
    listByCompany: async (companyId) =>
      [...equipments.values()].filter((e) => e.companyId === companyId),
    save: async (e) => {
      equipments.set(e.id, e);
    },
  };
  const interventionRepo: InterventionRepository = {
    findById: async (companyId, id) => {
      const found = interventions.get(id);
      return found && found.companyId === companyId
        ? Intervention.rehydrate(found.toProps())
        : null;
    },
    lockById: async (companyId, id) => {
      const found = interventions.get(id);
      return found && found.companyId === companyId
        ? Intervention.rehydrate(found.toProps())
        : null;
    },
    create: async (intervention) => {
      if (interventions.has(intervention.id)) return { outcome: 'id_collision' };
      interventions.set(intervention.id, Intervention.rehydrate(intervention.toProps()));
      return { outcome: 'created' };
    },
    save: async (intervention) => {
      interventions.set(intervention.id, Intervention.rehydrate(intervention.toProps()));
    },
    listByChantier: async (companyId, chantierId) =>
      [...interventions.values()].filter(
        (i) => i.companyId === companyId && i.chantierId === chantierId,
      ),
    listByCompany: async (companyId) =>
      [...interventions.values()].filter((i) => i.companyId === companyId),
    detachByInvoice: async (companyId, invoiceId) => {
      for (const intervention of interventions.values()) {
        if (intervention.companyId === companyId && intervention.billedInvoiceId === invoiceId) {
          intervention.detachBilledInvoice();
        }
      }
    },
  };
  const noteRepo: ChantierNoteRepository = {
    save: async (note) => {
      notes.push(note);
    },
    listByChantier: async (companyId, chantierId) =>
      notes.filter((n) => n.companyId === companyId && n.chantierId === chantierId),
    countByCompany: async () => new Map(),
  };
  const media: WorksiteMediaStorage = {
    save: async (item) => {
      photos.set(item.id, item);
    },
    listByChantier: async (companyId, chantierId) =>
      [...photos.values()].filter((p) => p.companyId === companyId && p.chantierId === chantierId),
    findById: async (companyId, id) => {
      const photo = photos.get(id);
      return photo && photo.companyId === companyId ? photo : null;
    },
    remove: async (companyId, id) => {
      photos.delete(id);
    },
    countByCompany: async () => new Map(),
  };
  const storage: DocumentStoragePort = {
    put: async ({ key, bytes, contentType }) => ({
      key,
      sizeBytes: bytes.byteLength,
      sha256: 'f'.repeat(64),
      contentType,
      created: true,
    }),
    get: async () => null,
    getSignedUrl: async () => 'https://example.test/signed',
    stat: async () => null,
    remove: async (_companyId, storageKey) => {
      removedBytes.push(storageKey);
    },
  };
  const companies = {
    findById: async () => null,
    lockById: async () => null,
    lockForShareById: async (id: string) =>
      ({ id, isClosed: () => false }) as unknown as never,
    list: async () => [],
    save: async () => undefined,
  };
  let sequence = 0;
  const ids = { newId: () => `id-${(sequence += 1)}` };
  const clock = { now: () => '2026-08-04T10:00:00.000Z', today: () => '2026-08-04' };
  const uow = { runInTransaction: async <T>(fn: () => Promise<T>) => fn() };
  return {
    chantierRepo,
    customerRepo,
    equipmentRepo,
    interventionRepo,
    noteRepo,
    media,
    storage,
    companies,
    ids,
    clock,
    uow,
    interventions,
    notes,
    photos,
    removedBytes,
  };
}

type Env = ReturnType<typeof makeEnv>;

function seed(env: Env, overrides: Partial<InterventionProps> = {}): Intervention {
  const intervention = Intervention.rehydrate({
    id: UUID,
    companyId: COMPANY,
    chantierId: SITE,
    customerId: CUSTOMER,
    contractId: null,
    equipmentId: null,
    kind: 'Visite d’entretien',
    status: 'scheduled',
    plannedAt: '2026-08-04T09:00:00.000Z',
    technicianLabel: 'Papa',
    startedAt: null,
    finishedAt: null,
    checklist: [{ label: 'Détartrage', done: false }],
    summary: null,
    signature: null,
    reportDocumentId: null,
    billedInvoiceId: null,
    revision: 1,
    ...overrides,
  });
  env.interventions.set(intervention.id, intervention);
  return intervention;
}

function createUseCase(env: Env): CreateIntervention {
  return new CreateIntervention({
    interventions: env.interventionRepo,
    chantiers: env.chantierRepo,
    customers: env.customerRepo,
    ids: env.ids,
    clock: env.clock,
    equipments: env.equipmentRepo,
  });
}

describe('CreateIntervention — gardes cross-agrégat fail-closed (§3.5)', () => {
  it('crée une fiche `scheduled` sur un site OUVERT du tenant', async () => {
    const env = makeEnv();
    const r = await createUseCase(env).execute({
      companyId: COMPANY,
      chantierId: SITE,
      customerId: CUSTOMER,
      kind: 'Dépannage fontaine',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const created = env.interventions.get(r.value.id)!;
    expect(created.status).toBe('scheduled');
    expect(created.contractId).toBeNull();
    expect(created.revision).toBe(1);
  });

  it('site CLÔTURÉ → refus ACTIONNABLE (jamais un bouton grisé mystère)', async () => {
    const env = makeEnv();
    const r = await createUseCase(env).execute({
      companyId: COMPANY,
      chantierId: 'site-clos',
      customerId: CUSTOMER,
      kind: 'Dépannage',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.error)).toContain(CHANTIER_CLOSED_INTERVENTION_MESSAGE);
  });

  it('anti-IDOR : site d’un AUTRE tenant introuvable (jamais un oracle)', async () => {
    const env = makeEnv();
    const r = await createUseCase(env).execute({
      companyId: COMPANY,
      chantierId: 'site-autre-tenant',
      customerId: CUSTOMER,
      kind: 'Dépannage',
    });
    expect(r).toMatchObject({ ok: false, error: { kind: 'not_found', entity: 'chantier' } });
  });

  it('équipement d’un AUTRE site refusé (cohérence équipement↔site prouvée)', async () => {
    const env = makeEnv();
    const r = await createUseCase(env).execute({
      companyId: COMPANY,
      chantierId: SITE,
      customerId: CUSTOMER,
      kind: 'Dépannage',
      equipmentId: 'equip-autre-site',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.error)).toContain('autre site');
  });

  it('id CLIENT : uuid v4 exigé, collision → 409 GÉNÉRIQUE sans oracle inter-tenant [P15]', async () => {
    const env = makeEnv();
    const invalid = await createUseCase(env).execute({
      companyId: COMPANY,
      id: 'pas-un-uuid',
      chantierId: SITE,
      customerId: CUSTOMER,
      kind: 'Dépannage',
    });
    expect(invalid.ok).toBe(false);

    seed(env, { companyId: OTHER });
    const collision = await createUseCase(env).execute({
      companyId: COMPANY,
      id: UUID,
      chantierId: SITE,
      customerId: CUSTOMER,
      kind: 'Dépannage',
    });
    expect(collision).toMatchObject({ ok: false, error: { kind: 'conflict', entity: 'intervention' } });
    if (collision.ok) return;
    // Le message ne révèle NI l'existence NI le tenant : seul « régénère » est dit.
    expect(JSON.stringify(collision.error)).not.toContain(OTHER);
  });

  it('checklist absente : pré-remplie par le template société du kind (reste LIBRE)', async () => {
    const env = makeEnv();
    const r = await new CreateIntervention({
      interventions: env.interventionRepo,
      chantiers: env.chantierRepo,
      customers: env.customerRepo,
      ids: env.ids,
      clock: env.clock,
      interventionSettings: {
        find: async () => ({
          companyId: COMPANY,
          reportTitle: null,
          checklistTemplates: { 'visite d’entretien': ['Détartrage', 'Contrôle de pression'] },
          revision: 1,
        }),
        save: async () => undefined,
      },
    }).execute({
      companyId: COMPANY,
      chantierId: SITE,
      customerId: CUSTOMER,
      kind: '  Visite d’entretien ',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(env.interventions.get(r.value.id)!.checklist).toEqual([
      { label: 'Détartrage', done: false },
      { label: 'Contrôle de pression', done: false },
    ]);
  });
});

describe('Machine à états au niveau USE CASE — CAS de révision chaîné (§3.6.4)', () => {
  it('chemin nominal : start → complete → sign, révisions chaînées', async () => {
    const env = makeEnv();
    seed(env);
    const started = await new StartIntervention({
      interventions: env.interventionRepo,
      uow: env.uow,
      clock: env.clock,
    }).execute({ companyId: COMPANY, interventionId: UUID, expectedRevision: 1 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.status).toBe('in_progress');
    expect(started.value.revision).toBe(2);

    const completed = await new CompleteIntervention({
      interventions: env.interventionRepo,
      uow: env.uow,
      clock: env.clock,
    }).execute({
      companyId: COMPANY,
      interventionId: UUID,
      expectedRevision: 2,
      checklist: [{ label: 'Détartrage', done: true }],
      summary: 'Pression basse, réglée.',
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.status).toBe('completed');
    expect(completed.value.checklist).toEqual([{ label: 'Détartrage', done: true }]);

    const signed = await new SignIntervention({
      interventions: env.interventionRepo,
      companies: env.companies,
      uow: env.uow,
      clock: env.clock,
    }).execute({
      companyId: COMPANY,
      interventionId: UUID,
      expectedRevision: 3,
      signerName: 'M. Responsable',
      proofSha256: SHA,
    });
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.value.status).toBe('signed');
    // capturedAt = horodatage SERVEUR de réception (jamais l'heure déclarée par l'appareil).
    expect(signed.value.signature).toEqual({
      signerName: 'M. Responsable',
      method: 'onsite_draw',
      sha256: SHA,
      capturedAt: '2026-08-04T10:00:00.000Z',
    });
  });

  it('capture HORS-LIGNE : capturedAtDevice conservé, capturedAt/syncedAt = réception serveur', async () => {
    const env = makeEnv();
    seed(env, { status: 'completed', startedAt: '2026-08-04T09:04:00.000Z', finishedAt: '2026-08-04T09:40:00.000Z' });
    const signed = await new SignIntervention({
      interventions: env.interventionRepo,
      companies: env.companies,
      uow: env.uow,
      clock: env.clock,
    }).execute({
      companyId: COMPANY,
      interventionId: UUID,
      expectedRevision: 1,
      signerName: 'M. Responsable',
      proofSha256: SHA,
      capturedAtDevice: '2026-08-04T09:41:00.000Z',
    });
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.value.signature).toMatchObject({
      capturedAtDevice: '2026-08-04T09:41:00.000Z',
      capturedAt: '2026-08-04T10:00:00.000Z',
      syncedAt: '2026-08-04T10:00:00.000Z',
    });
  });

  it('CAS : une révision périmée est un CONFLIT explicite, jamais un écrasement silencieux', async () => {
    const env = makeEnv();
    seed(env, { revision: 3 });
    const r = await new StartIntervention({
      interventions: env.interventionRepo,
      uow: env.uow,
      clock: env.clock,
    }).execute({ companyId: COMPANY, interventionId: UUID, expectedRevision: 2 });
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'conflict', entity: 'intervention', reason: 'stale_revision' },
    });
    expect(env.interventions.get(UUID)!.status).toBe('scheduled');
  });

  it('anti-IDOR : une fiche d’un AUTRE tenant est introuvable pour toutes les mutations', async () => {
    const env = makeEnv();
    seed(env, { companyId: OTHER });
    const r = await new CompleteIntervention({
      interventions: env.interventionRepo,
      uow: env.uow,
      clock: env.clock,
    }).execute({ companyId: COMPANY, interventionId: UUID, expectedRevision: 1 });
    expect(r).toMatchObject({ ok: false, error: { kind: 'not_found', entity: 'intervention' } });
  });

  it('annulation impossible après completed (le passage a eu lieu)', async () => {
    const env = makeEnv();
    seed(env, { status: 'completed', startedAt: '2026-08-04T09:00:00.000Z', finishedAt: '2026-08-04T09:40:00.000Z' });
    const r = await new CancelIntervention({
      interventions: env.interventionRepo,
      uow: env.uow,
    }).execute({ companyId: COMPANY, interventionId: UUID, expectedRevision: 1 });
    expect(r.ok).toBe(false);
    expect(env.interventions.get(UUID)!.status).toBe('completed');
  });

  it('UpdateIntervention : retag d’équipement d’un autre site refusé, port absent = refus', async () => {
    const env = makeEnv();
    seed(env);
    const noPort = await new UpdateIntervention({
      interventions: env.interventionRepo,
      uow: env.uow,
    }).execute({
      companyId: COMPANY,
      interventionId: UUID,
      expectedRevision: 1,
      patch: { equipmentId: 'equip-fontaine' },
    });
    expect(noPort).toMatchObject({ ok: false, error: { kind: 'dependency' } });

    const wrongSite = await new UpdateIntervention({
      interventions: env.interventionRepo,
      uow: env.uow,
      equipments: env.equipmentRepo,
    }).execute({
      companyId: COMPANY,
      interventionId: UUID,
      expectedRevision: 1,
      patch: { equipmentId: 'equip-autre-site' },
    });
    expect(wrongSite.ok).toBe(false);

    const ok = await new UpdateIntervention({
      interventions: env.interventionRepo,
      uow: env.uow,
      equipments: env.equipmentRepo,
    }).execute({
      companyId: COMPANY,
      interventionId: UUID,
      expectedRevision: 1,
      patch: { equipmentId: 'equip-fontaine' },
    });
    expect(ok.ok).toBe(true);
  });
});

describe('VERROUILLAGE post-signature (§3.4) — la fiche signée n’accepte plus AUCUNE mutation', () => {
  function signedEnv(): Env {
    const env = makeEnv();
    seed(env, {
      status: 'signed',
      startedAt: '2026-08-04T09:00:00.000Z',
      finishedAt: '2026-08-04T09:40:00.000Z',
      signature: {
        signerName: 'M. Responsable',
        method: 'onsite_draw',
        sha256: SHA,
        capturedAt: '2026-08-04T09:41:00.000Z',
      },
    });
    return env;
  }

  it('update refusé avec le MESSAGE UNIQUE (écran ET voix)', async () => {
    const env = signedEnv();
    const r = await new UpdateIntervention({
      interventions: env.interventionRepo,
      uow: env.uow,
    }).execute({
      companyId: COMPANY,
      interventionId: UUID,
      expectedRevision: 1,
      patch: { summary: 'Retouche interdite' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.error)).toContain(INTERVENTION_SIGNED_LOCKED_MESSAGE);
  });

  it('photo REFUSÉE après signature (le média re-vérifie l’état de la fiche)', async () => {
    const env = signedEnv();
    const r = await new UploadWorksitePhoto({
      chantiers: env.chantierRepo,
      media: env.media,
      storage: env.storage,
      ids: env.ids,
      clock: env.clock,
      interventions: env.interventionRepo,
    }).execute({
      companyId: COMPANY,
      chantierId: SITE,
      contentType: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'apres.jpg',
      interventionId: UUID,
      phase: 'after',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.error)).toContain(INTERVENTION_SIGNED_LOCKED_MESSAGE);
    expect(env.photos.size).toBe(0);
  });

  it('note REFUSÉE après signature', async () => {
    const env = signedEnv();
    const r = await new AddChantierNote({
      chantiers: env.chantierRepo,
      notes: env.noteRepo,
      ids: env.ids,
      clock: env.clock,
      interventions: env.interventionRepo,
    }).execute({
      companyId: COMPANY,
      chantierId: SITE,
      text: 'Trop tard',
      authorLabel: 'Fly Services',
      interventionId: UUID,
    });
    expect(r.ok).toBe(false);
    expect(env.notes).toHaveLength(0);
  });

  it('retrait de photo REFUSÉ après signature (l’archive de preuve est intouchable)', async () => {
    const env = signedEnv();
    env.photos.set('photo-1', {
      id: 'photo-1',
      companyId: COMPANY,
      chantierId: SITE,
      filename: 'avant.jpg',
      mimeType: 'image/jpeg',
      byteSize: 3,
      storageKey: 'key-1',
      createdAt: '2026-08-04T09:10:00.000Z',
      interventionId: UUID,
      phase: 'before',
    });
    const r = await new DeleteWorksitePhoto({
      media: env.media,
      storage: env.storage,
      interventions: env.interventionRepo,
    }).execute({ companyId: COMPANY, id: 'photo-1' });
    expect(r.ok).toBe(false);
    expect(env.photos.has('photo-1')).toBe(true);
    expect(env.removedBytes).toHaveLength(0);
  });
});

describe('Photos taguées (interventionId, phase) — chaîne photos existante (§3.2)', () => {
  it('accepte une photo AVANT signature, phase transportée', async () => {
    const env = makeEnv();
    seed(env, { status: 'in_progress', startedAt: '2026-08-04T09:04:00.000Z' });
    const r = await new UploadWorksitePhoto({
      chantiers: env.chantierRepo,
      media: env.media,
      storage: env.storage,
      ids: env.ids,
      clock: env.clock,
      interventions: env.interventionRepo,
    }).execute({
      companyId: COMPANY,
      chantierId: SITE,
      contentType: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'avant.jpg',
      interventionId: UUID,
      phase: 'before',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ interventionId: UUID, phase: 'before' });
  });

  it('la phase SANS fiche est refusée (avant/après n’a de sens que dans un passage)', async () => {
    const env = makeEnv();
    const r = await new UploadWorksitePhoto({
      chantiers: env.chantierRepo,
      media: env.media,
      storage: env.storage,
      ids: env.ids,
      clock: env.clock,
      interventions: env.interventionRepo,
    }).execute({
      companyId: COMPANY,
      chantierId: SITE,
      contentType: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'photo.jpg',
      phase: 'after',
    });
    expect(r.ok).toBe(false);
  });

  it('fiche d’un AUTRE site refusée (cohérence fiche↔site fail-closed)', async () => {
    const env = makeEnv();
    seed(env, { chantierId: 'site-clos', status: 'in_progress', startedAt: '2026-08-04T09:00:00.000Z' });
    const r = await new UploadWorksitePhoto({
      chantiers: env.chantierRepo,
      media: env.media,
      storage: env.storage,
      ids: env.ids,
      clock: env.clock,
      interventions: env.interventionRepo,
    }).execute({
      companyId: COMPANY,
      chantierId: SITE,
      contentType: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'photo.jpg',
      interventionId: UUID,
      phase: 'before',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.error)).toContain('autre site');
  });
});

describe('ERRATUM 6 — retrait de photo → note de résolution ACCEPTÉE, PUIS le sign passe', () => {
  it('la note de résolution est portée par la mutation de retrait, avant le sign', async () => {
    const env = makeEnv();
    // Fiche TERMINÉE (le geste de signature est déjà en file côté appareil).
    seed(env, {
      status: 'completed',
      startedAt: '2026-08-04T09:00:00.000Z',
      finishedAt: '2026-08-04T09:40:00.000Z',
    });
    env.photos.set('photo-corrompue', {
      id: 'photo-corrompue',
      companyId: COMPANY,
      chantierId: SITE,
      filename: 'avant.jpg',
      mimeType: 'image/jpeg',
      byteSize: 3,
      storageKey: 'key-corrompue',
      createdAt: '2026-08-04T09:10:00.000Z',
      interventionId: UUID,
      phase: 'before',
    });

    // 1. Résolution humaine « Retirer cette photo de la fiche » — la note prend sa PLACE.
    const removed = await new DeleteWorksitePhoto({
      media: env.media,
      storage: env.storage,
      interventions: env.interventionRepo,
      notes: env.noteRepo,
      ids: env.ids,
      clock: env.clock,
    }).execute({
      companyId: COMPANY,
      id: 'photo-corrompue',
      resolutionNote: {
        text: '1 photo n’a pas pu être jointe à la fiche.',
        authorLabel: 'Fly Services',
      },
    });
    expect(removed.ok).toBe(true);
    expect(env.photos.has('photo-corrompue')).toBe(false);
    expect(env.removedBytes).toEqual(['key-corrompue']);
    expect(env.notes).toHaveLength(1);
    expect(env.notes[0]!.interventionId).toBe(UUID);
    expect(env.notes[0]!.text).toContain('n’a pas pu être jointe');

    // 2. Le sign, resté derrière dans la file, passe ENSUITE — jamais un blocage définitif.
    const signed = await new SignIntervention({
      interventions: env.interventionRepo,
      companies: env.companies,
      uow: env.uow,
      clock: env.clock,
    }).execute({
      companyId: COMPANY,
      interventionId: UUID,
      expectedRevision: 1,
      signerName: 'M. Responsable',
      proofSha256: SHA,
    });
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.value.status).toBe('signed');
  });

  it('même séquence par une note taguée explicite (AddChantierNote) sur fiche `completed`', async () => {
    const env = makeEnv();
    seed(env, {
      status: 'completed',
      startedAt: '2026-08-04T09:00:00.000Z',
      finishedAt: '2026-08-04T09:40:00.000Z',
    });
    const note = await new AddChantierNote({
      chantiers: env.chantierRepo,
      notes: env.noteRepo,
      ids: env.ids,
      clock: env.clock,
      interventions: env.interventionRepo,
    }).execute({
      companyId: COMPANY,
      chantierId: SITE,
      text: '1 photo n’a pas pu être jointe à la fiche.',
      authorLabel: 'Fly Services',
      interventionId: UUID,
    });
    expect(note.ok).toBe(true);

    const signed = await new SignIntervention({
      interventions: env.interventionRepo,
      companies: env.companies,
      uow: env.uow,
      clock: env.clock,
    }).execute({
      companyId: COMPANY,
      interventionId: UUID,
      expectedRevision: 1,
      signerName: 'M. Responsable',
      proofSha256: SHA,
    });
    expect(signed.ok).toBe(true);
  });

  it('note de résolution SANS les ports requis : refus fail-closed (jamais une note perdue en silence)', async () => {
    const env = makeEnv();
    seed(env, {
      status: 'completed',
      startedAt: '2026-08-04T09:00:00.000Z',
      finishedAt: '2026-08-04T09:40:00.000Z',
    });
    env.photos.set('photo-1', {
      id: 'photo-1',
      companyId: COMPANY,
      chantierId: SITE,
      filename: 'avant.jpg',
      mimeType: 'image/jpeg',
      byteSize: 3,
      storageKey: 'key-1',
      createdAt: '2026-08-04T09:10:00.000Z',
      interventionId: UUID,
      phase: 'before',
    });
    const r = await new DeleteWorksitePhoto({
      media: env.media,
      storage: env.storage,
      interventions: env.interventionRepo,
    }).execute({
      companyId: COMPANY,
      id: 'photo-1',
      resolutionNote: { text: 'Photo retirée', authorLabel: 'Fly Services' },
    });
    expect(r).toMatchObject({ ok: false, error: { kind: 'dependency' } });
  });
});
