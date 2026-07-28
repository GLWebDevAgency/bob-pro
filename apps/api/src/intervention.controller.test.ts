import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  Chantier,
  Customer,
  Equipment,
  type OcrPort,
  type PaymentGatewayPort,
  type PdfRendererPort,
} from '@bob/core';
import { seedCompany } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { InterventionsController } from './api.controllers';
import { InMemoryDocumentStorage } from './documents/storage.testing';

/**
 * PR-15b — câblage serveur de la fiche de passage : mêmes use cases que le mobile et la voix
 * (parité), gate module chantiers identique au parc/notes/photos, verrouillage post-signature
 * (photos, notes, retrait, édition), séquence ERRATUM 6 acceptée côté serveur.
 */

interface EnqueuedJob {
  companyId: string;
  kind: string;
  dedupeKey: string;
  notification: { to: string; subject: string; body: string; attachments?: unknown[] };
}

function makeService() {
  const p = new InMemoryPersistence();
  const admin: SupabaseAdminPort = {
    setUserCompanyId: async () => undefined,
    deleteUser: async () => undefined,
  } as SupabaseAdminPort;
  const audit = vi.fn();
  const logger = {
    audit,
    error: () => undefined,
    warn: () => undefined,
    log: () => undefined,
  } as unknown as AppLogger;
  const enqueued: EnqueuedJob[] = [];
  const notificationDelivery = {
    enqueue: async (order: EnqueuedJob) => {
      enqueued.push(order);
      return { id: `job-${enqueued.length}`, status: 'pending' as const };
    },
  } as unknown as NotificationDeliveryService;
  const storage = new InMemoryDocumentStorage();
  const service = new BackendService(
    p,
    {} as PaymentGatewayPort,
    {} as PdfRendererPort,
    {} as OcrPort,
    admin,
    notificationDelivery,
    {} as Metrics,
    logger,
    undefined,
    storage,
  );
  return { service, p, audit, enqueued, storage };
}

function asPrincipal<T>(principal: Principal, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ correlationId: 'test', principal }, fn);
}

async function seedTenant(p: InMemoryPersistence): Promise<string> {
  const company = seedCompany();
  await p.companies.save(company);
  await p.subscriptions.save({
    id: `sub-${company.id}`,
    companyId: company.id,
    plan: 'solo',
    status: 'active',
    trialEndsAt: null,
    currentPeriodEnd: '2099-01-01T00:00:00.000Z',
    store: null,
    storeRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  return company.id;
}

function seedChantier(
  p: InMemoryPersistence,
  id: string,
  companyId: string,
  status: 'open' | 'closed' = 'open',
): Promise<void> {
  return p.chantiers.save(
    Chantier.rehydrate({
      id,
      companyId,
      name: `Site ${id}`,
      customerId: null,
      address: '1 place de la Bastille, 75011 Paris',
      notes: null,
      status,
      openedAt: '2026-07-01',
    }),
  );
}

async function seedCustomer(
  p: InMemoryPersistence,
  id: string,
  companyId: string,
  overrides: { type?: 'b2b' | 'b2c'; email?: string } = {},
): Promise<void> {
  const customer = Customer.of({
    id,
    companyId,
    type: overrides.type ?? 'b2b',
    name: 'RATP CAP',
    address: { line1: '54 quai de la Rapée', zip: '75012', city: 'Paris' },
    ...(overrides.email === undefined ? { email: 'compta@ratp.example' } : { email: overrides.email }),
  });
  if (!customer.ok) throw new Error('fixture client invalide');
  await p.customers.save(customer.value);
}

async function seedEquipment(
  p: InMemoryPersistence,
  id: string,
  companyId: string,
  chantierId: string,
): Promise<void> {
  await p.equipments.save(
    Equipment.rehydrate({
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
    }),
  );
}

const TRACE = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';

describe('fiche de passage — service (PR-15b)', () => {
  it('crée → démarre → termine → signe, révisions chaînées, mêmes endpoints que la voix', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedChantier(p, 'site-bastille', companyId);
    await seedCustomer(p, 'cust-ratp', companyId);
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);

    const created = await run(() =>
      service.createIntervention('site-bastille', {
        customerId: 'cust-ratp',
        kind: 'Visite d’entretien',
        plannedAt: '2026-08-04T09:00:00.000Z',
        technicianLabel: 'Papa',
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const listed = await run(() => service.listChantierInterventions('site-bastille'));
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]).toMatchObject({ status: 'scheduled', revision: 1, contractId: null });

    const started = await run(() =>
      service.startIntervention({ interventionId: created.value.id, expectedRevision: 1 }),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value).toMatchObject({ status: 'in_progress', revision: 2 });

    const completed = await run(() =>
      service.completeIntervention({
        interventionId: created.value.id,
        expectedRevision: 2,
        checklist: [{ label: 'Détartrage', done: true }],
        summary: 'Pression basse, réglée.',
      }),
    );
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value).toMatchObject({ status: 'completed', revision: 3 });

    const signed = await run(() =>
      service.signIntervention({
        interventionId: created.value.id,
        expectedRevision: 3,
        signerName: 'M. Responsable',
        proofDataUrl: TRACE,
      }),
    );
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.value.status).toBe('signed');
    // sha256 calculé SERVEUR sur le tracé reçu — le client ne fournit jamais le hash.
    expect(signed.value.signature?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.value.signature?.capturedAtDevice).toBeUndefined();
  });

  it('id CLIENT uuid v4 accepté et REJOUÉ en 409 générique (offline-first, [P15])', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedChantier(p, 'site-bastille', companyId);
    await seedCustomer(p, 'cust-ratp', companyId);
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);
    const id = randomUUID();

    const first = await run(() =>
      service.createIntervention('site-bastille', { id, customerId: 'cust-ratp', kind: 'Dépannage' }),
    );
    expect(first).toMatchObject({ ok: true, value: { id } });

    const replayed = await run(() =>
      service.createIntervention('site-bastille', { id, customerId: 'cust-ratp', kind: 'Dépannage' }),
    );
    expect(replayed).toMatchObject({ ok: false, error: { kind: 'conflict', entity: 'intervention' } });

    const invalid = await run(() =>
      service.createIntervention('site-bastille', {
        id: 'pas-un-uuid',
        customerId: 'cust-ratp',
        kind: 'Dépannage',
      }),
    );
    expect(invalid.ok).toBe(false);
  });

  it('site clôturé et client d’un autre tenant : refus actionnable / introuvable', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedChantier(p, 'site-clos', companyId, 'closed');
    await seedChantier(p, 'site-bastille', companyId);
    await seedCustomer(p, 'cust-ratp', companyId);
    await seedCustomer(p, 'cust-autre', 'company-autre');
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);

    const closed = await run(() =>
      service.createIntervention('site-clos', { customerId: 'cust-ratp', kind: 'Dépannage' }),
    );
    expect(closed.ok).toBe(false);
    if (closed.ok) return;
    expect(JSON.stringify(closed.error)).toContain('clôturé');

    const crossTenant = await run(() =>
      service.createIntervention('site-bastille', { customerId: 'cust-autre', kind: 'Dépannage' }),
    );
    expect(crossTenant).toMatchObject({ ok: false, error: { kind: 'not_found', entity: 'customer' } });
  });

  it('photos taguées avant/après, VERROUILLAGE post-signature sur photos ET notes', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedChantier(p, 'site-bastille', companyId);
    await seedCustomer(p, 'cust-ratp', companyId);
    await seedEquipment(p, 'equip-fontaine', companyId, 'site-bastille');
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);

    const created = await run(() =>
      service.createIntervention('site-bastille', {
        customerId: 'cust-ratp',
        kind: 'Visite d’entretien',
        equipmentId: 'equip-fontaine',
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await run(() =>
      service.startIntervention({ interventionId: created.value.id, expectedRevision: 1 }),
    );

    const before = await run(() =>
      service.uploadWorksitePhoto('site-bastille', {
        contentBase64: Buffer.from([0xff, 0xd8, 0xff]).toString('base64'),
        mimeType: 'image/jpeg',
        filename: 'avant.jpg',
        interventionId: created.value.id,
        phase: 'before',
      }),
    );
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value).toMatchObject({ interventionId: created.value.id, phase: 'before' });

    await run(() =>
      service.completeIntervention({ interventionId: created.value.id, expectedRevision: 2 }),
    );
    await run(() =>
      service.signIntervention({
        interventionId: created.value.id,
        expectedRevision: 3,
        signerName: 'M. Responsable',
        proofDataUrl: TRACE,
      }),
    );

    const late = await run(() =>
      service.uploadWorksitePhoto('site-bastille', {
        contentBase64: Buffer.from([0xff, 0xd8, 0xff]).toString('base64'),
        mimeType: 'image/jpeg',
        filename: 'apres.jpg',
        interventionId: created.value.id,
        phase: 'after',
      }),
    );
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(JSON.stringify(late.error)).toContain('verrouillée');

    const lateNote = await run(() =>
      service.addChantierNote('site-bastille', {
        text: 'Trop tard',
        interventionId: created.value.id,
      }),
    );
    expect(lateNote.ok).toBe(false);

    const lateDelete = await run(() => service.deleteWorksitePhoto(before.value.id));
    expect(lateDelete.ok).toBe(false);

    const lateUpdate = await run(() =>
      service.updateIntervention({
        interventionId: created.value.id,
        expectedRevision: 4,
        patch: { summary: 'Retouche interdite' },
      }),
    );
    expect(lateUpdate.ok).toBe(false);
  });

  it('ERRATUM 6 : retrait de photo → note de résolution acceptée, PUIS le sign passe', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedChantier(p, 'site-bastille', companyId);
    await seedCustomer(p, 'cust-ratp', companyId);
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);

    const created = await run(() =>
      service.createIntervention('site-bastille', {
        customerId: 'cust-ratp',
        kind: 'Visite d’entretien',
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await run(() =>
      service.startIntervention({ interventionId: created.value.id, expectedRevision: 1 }),
    );
    const photo = await run(() =>
      service.uploadWorksitePhoto('site-bastille', {
        contentBase64: Buffer.from([0xff, 0xd8, 0xff]).toString('base64'),
        mimeType: 'image/jpeg',
        filename: 'avant.jpg',
        interventionId: created.value.id,
        phase: 'before',
      }),
    );
    expect(photo.ok).toBe(true);
    if (!photo.ok) return;
    await run(() =>
      service.completeIntervention({ interventionId: created.value.id, expectedRevision: 2 }),
    );

    // La file bloque sur la photo : le choix humain « Retirer » porte la note de résolution.
    const removed = await run(() =>
      service.deleteWorksitePhoto(photo.value.id, {
        resolutionNote: '1 photo n’a pas pu être jointe à la fiche.',
      }),
    );
    expect(removed.ok).toBe(true);
    const notes = await run(() => service.listChantierNotes('site-bastille'));
    expect(notes.ok).toBe(true);
    if (!notes.ok) return;
    expect(notes.value).toHaveLength(1);
    expect(notes.value[0]).toMatchObject({ interventionId: created.value.id });

    // Le sign resté derrière dans la file passe ENSUITE — jamais un blocage définitif.
    const signed = await run(() =>
      service.signIntervention({
        interventionId: created.value.id,
        expectedRevision: 3,
        signerName: 'M. Responsable',
        proofDataUrl: TRACE,
        capturedAtDevice: '2026-08-04T09:41:00.000Z',
      }),
    );
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.value.status).toBe('signed');
    // Convention §3.4 (P12) : geste appareil ≠ réception serveur, jamais confondus.
    expect(signed.value.signature?.capturedAtDevice).toBe('2026-08-04T09:41:00.000Z');
    expect(signed.value.signature?.syncedAt).toBe(signed.value.signature?.capturedAt);
  });

  it('frontière HTTP : champ inconnu, phase sans fiche, révision absente → 400 explicites', async () => {
    const { service } = makeService();
    const controller = new InterventionsController(service);
    await expect(controller.start('x', { expectedRevision: 1, bidon: true })).rejects.toThrow();
    await expect(controller.sign('x', { expectedRevision: 1, signerName: 'A' })).rejects.toThrow();
    await expect(controller.update('x', { expectedRevision: 0 })).rejects.toThrow();
  });
});
