import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  Chantier,
  Company,
  Customer,
  Equipment,
  Intervention,
  type InterventionReportData,
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
import { ChantiersController, InterventionsController } from './api.controllers';
import { PdfRenderer } from './documents/pdf-renderer';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import { pdfVisibleText } from './documents/pdf-text.testing';

/**
 * PR-15b/PR-16 — câblage serveur de la fiche de passage : mêmes use cases que le mobile et la
 * voix (parité), gate module chantiers identique au parc/notes/photos, verrouillage
 * post-signature, séquence ERRATUM 6 acceptée, archive IMMUABLE + envoi confirmé + CTA facturer.
 */

interface EnqueuedJob {
  companyId: string;
  kind: string;
  dedupeKey: string;
  notification: { to: string; subject: string; body: string; attachments?: unknown[] };
}

function makeService(options: { withRenderer?: boolean } = {}) {
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
  const renderer = (
    options.withRenderer === false ? ({} as PdfRendererPort) : new PdfRenderer()
  ) as PdfRendererPort;
  const service = new BackendService(
    p,
    {} as PaymentGatewayPort,
    renderer,
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

async function seedTenant(
  p: InMemoryPersistence,
  overrides: { vatRegime?: 'franchise' | 'reel_simpl' | 'reel_normal' } = {},
): Promise<string> {
  const base = seedCompany();
  let company = base;
  if (overrides.vatRegime !== undefined) {
    const rebuilt = Company.of({ ...base.toProps(), vatRegime: overrides.vatRegime });
    if (!rebuilt.ok) throw new Error('fixture société invalide');
    company = rebuilt.value;
  }
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
    // [finding 8] Le geste passe par POST …/retirer — un corps de DELETE peut être dépouillé
    // en route et la photo partirait SANS sa note, sans que le use case puisse le détecter.
    const chantiers = new ChantiersController(service);
    const removed = await run(() =>
      chantiers.removePhoto(photo.value.id, {
        resolutionNote: '1 photo n’a pas pu être jointe à la fiche.',
      }),
    );
    expect(removed).toBeUndefined();
    // La note est OBLIGATOIRE sur ce geste : un corps vide n'y ressemble jamais par accident.
    await expect(run(() => chantiers.removePhoto(photo.value.id, {}))).rejects.toThrow();
    await expect(
      run(() => chantiers.removePhoto(photo.value.id, { bidon: 'x' })),
    ).rejects.toThrow();
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

  it('[finding 8] frontière : `lines` VALIDÉ comme partout en facturation (jamais un cast direct)', async () => {
    const { service } = makeService();
    const controller = new InterventionsController(service);
    // Ligne sans libellé, TVA hors référentiel, catégorie inconnue, quantité négative : 400.
    await expect(
      controller.invoiceDraft('x', { lines: [{ category: 'labor', qty: 1, unitPriceHT: 0, vatRate: 20 }] }),
    ).rejects.toThrow();
    await expect(
      controller.invoiceDraft('x', {
        lines: [{ label: 'Passage', category: 'labor', qty: 1, unitPriceHT: 0, vatRate: 17 }],
      }),
    ).rejects.toThrow();
    await expect(
      controller.invoiceDraft('x', {
        lines: [{ label: 'Passage', category: 'inconnue', qty: 1, unitPriceHT: 0, vatRate: 20 }],
      }),
    ).rejects.toThrow();
    await expect(controller.invoiceDraft('x', { lines: 'pas-un-tableau' })).rejects.toThrow();
    await expect(controller.invoiceDraft('x', { context: { bidon: true } })).rejects.toThrow();
    await expect(controller.invoiceDraft('x', { bidon: true })).rejects.toThrow();
  });
});

describe('fiche de passage PDF — archive immuable, envoi confirmé, CTA facturer (PR-16)', () => {
  async function completedIntervention(withEquipment = true) {
    const env = makeService();
    const companyId = await seedTenant(env.p);
    await seedChantier(env.p, 'site-bastille', companyId);
    await seedCustomer(env.p, 'cust-ratp', companyId);
    if (withEquipment) await seedEquipment(env.p, 'equip-fontaine', companyId, 'site-bastille');
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);
    const created = await run(() =>
      env.service.createIntervention('site-bastille', {
        customerId: 'cust-ratp',
        kind: 'Visite d’entretien',
        ...(withEquipment ? { equipmentId: 'equip-fontaine' } : {}),
        technicianLabel: 'Papa',
      }),
    );
    if (!created.ok) throw new Error('fiche non créée');
    await run(() =>
      env.service.startIntervention({ interventionId: created.value.id, expectedRevision: 1 }),
    );
    await run(() =>
      env.service.completeIntervention({
        interventionId: created.value.id,
        expectedRevision: 2,
        checklist: [{ label: 'Détartrage', done: true, note: 'Filtre remplacé' }],
        summary: 'Pression basse au démarrage, réglée.',
      }),
    );
    return { ...env, companyId, run, interventionId: created.value.id };
  }

  it('rend PUIS archive (A8) : second appel = archive servie, JAMAIS re-rendue', async () => {
    const env = await completedIntervention();
    const first = await env.run(() => env.service.generateInterventionReport(env.interventionId));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toMatchObject({ alreadyArchived: false, state: 'completed' });
    expect(first.value.filename).toMatch(/^fiche-de-passage-\d{4}-\d{2}-\d{2}\.pdf$/);

    const archived = await env.run(() =>
      env.p.documents.findById(env.companyId, first.value.documentId),
    );
    expect(archived).not.toBeNull();
    const props = archived!.toProps();
    expect(props.kind).toBe('intervention_report');
    expect(props.origin).toBe('generated');
    // Archive liée à l'ÉQUIPEMENT du passage (historique parc), jamais au hasard.
    expect(props.linkedEntityType).toBe('equipment');
    expect(props.linkedEntityId).toBe('equip-fontaine');

    const second = await env.run(() => env.service.generateInterventionReport(env.interventionId));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toMatchObject({ alreadyArchived: true, documentId: first.value.documentId });
    // Aucune seconde version : l'octet archivé est unique et immuable.
    expect(props.sha256).toBe(archived!.toProps().sha256);
  });

  it('sans équipement : l’archive suit le SITE (l’historique reste vrai)', async () => {
    const env = await completedIntervention(false);
    const generated = await env.run(() =>
      env.service.generateInterventionReport(env.interventionId),
    );
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const archived = await env.run(() =>
      env.p.documents.findById(env.companyId, generated.value.documentId),
    );
    expect(archived!.toProps().linkedEntityType).toBe('chantier');
    expect(archived!.toProps().linkedEntityId).toBe('site-bastille');
  });

  it('la signature crée une NOUVELLE archive ; l’ancienne reste intacte', async () => {
    const env = await completedIntervention();
    const beforeSign = await env.run(() =>
      env.service.generateInterventionReport(env.interventionId),
    );
    expect(beforeSign.ok).toBe(true);
    if (!beforeSign.ok) return;
    await env.run(() =>
      env.service.signIntervention({
        interventionId: env.interventionId,
        expectedRevision: 4,
        signerName: 'M. Responsable',
        proofDataUrl: TRACE,
      }),
    );
    const afterSign = await env.run(() =>
      env.service.generateInterventionReport(env.interventionId),
    );
    expect(afterSign.ok).toBe(true);
    if (!afterSign.ok) return;
    expect(afterSign.value.state).toBe('signed');
    expect(afterSign.value.documentId).not.toBe(beforeSign.value.documentId);
    const original = await env.run(() =>
      env.p.documents.findById(env.companyId, beforeSign.value.documentId),
    );
    expect(original!.toProps().status).toBe('active');
  });

  it('envoi = geste CONFIRMÉ : archive exigée, destinataire résolu, outbox dédiée', async () => {
    const env = await completedIntervention();
    const tooEarly = await env.run(() => env.service.sendInterventionReport(env.interventionId));
    expect(tooEarly.ok).toBe(false);
    if (tooEarly.ok) return;
    expect(JSON.stringify(tooEarly.error)).toContain('pas encore générée');
    expect(env.enqueued).toHaveLength(0);

    await env.run(() => env.service.generateInterventionReport(env.interventionId));
    const sent = await env.run(() => env.service.sendInterventionReport(env.interventionId));
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value).toMatchObject({ recipient: 'compta@ratp.example', deliveryStatus: 'queued' });
    expect(env.enqueued).toHaveLength(1);
    expect(env.enqueued[0]!.kind).toBe('intervention-report');
    // [finding 3] La clé porte la VERSION d'archive ET le DESTINATAIRE : l'intention d'envoi
    // est « cette pièce À CE destinataire » (un second contact n'est jamais un doublon).
    expect(env.enqueued[0]!.dedupeKey).toMatch(
      /^intervention:.+:report:[0-9a-f]{64}:to:compta@ratp\.example$/,
    );
    // Le PDF ARCHIVÉ est joint, et la mention « non signée » est HONNÊTE.
    expect(env.enqueued[0]!.notification.attachments).toHaveLength(1);
    expect(env.enqueued[0]!.notification.body).toContain('sans signature sur place');
  });

  it('archive d’AVANT la signature : l’envoi est REFUSÉ (jamais un corps qui ment sur la PJ)', async () => {
    const env = await completedIntervention();
    // Aperçu généré AVANT signature (latch posé sur l'état `completed`).
    const preview = await env.run(() =>
      env.service.generateInterventionReport(env.interventionId),
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const previewPdf = await env.run(() =>
      env.p.documents.findById(env.companyId, preview.value.documentId),
    );
    const previewBytes = await env.storage.get(env.companyId, previewPdf!.toProps().storageKey);
    const previewText = await pdfVisibleText(previewBytes!.bytes);
    expect(previewText).toContain('client etait absent');

    // Le client signe ENSUITE, sans que personne ne régénère.
    await env.run(() =>
      env.service.signIntervention({
        interventionId: env.interventionId,
        expectedRevision: 4,
        signerName: 'M. Responsable',
        proofDataUrl: TRACE,
      }),
    );
    const stale = await env.run(() => env.service.sendInterventionReport(env.interventionId));
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(JSON.stringify(stale.error)).toContain('régénère l’aperçu');
    expect(env.enqueued).toHaveLength(0);

    // Après régénération, l'envoi passe et la PJ EST celle de l'état signé.
    const regenerated = await env.run(() =>
      env.service.generateInterventionReport(env.interventionId),
    );
    expect(regenerated.ok).toBe(true);
    if (!regenerated.ok) return;
    expect(regenerated.value.state).toBe('signed');
    const sent = await env.run(() => env.service.sendInterventionReport(env.interventionId));
    expect(sent.ok).toBe(true);
    expect(env.enqueued).toHaveLength(1);
    expect(env.enqueued[0]!.notification.body).toContain('signée sur place');
    const signedPdf = await env.run(() =>
      env.p.documents.findById(env.companyId, regenerated.value.documentId),
    );
    const signedBytes = await env.storage.get(env.companyId, signedPdf!.toProps().storageKey);
    const signedText = await pdfVisibleText(signedBytes!.bytes);
    expect(signedText).toContain('Signataire');
    expect(signedText).not.toContain('client etait absent');
  });

  it('aucun destinataire : refus ACTIONNABLE (« ajoute un contact »), rien n’est parti', async () => {
    const env = makeService();
    const companyId = await seedTenant(env.p);
    await seedChantier(env.p, 'site-bastille', companyId);
    const customer = Customer.of({
      id: 'cust-sans-email',
      companyId,
      type: 'b2b',
      name: 'Client sans e-mail',
      address: { line1: '1 rue X', zip: '75001', city: 'Paris' },
    });
    if (!customer.ok) throw new Error('fixture invalide');
    await env.p.customers.save(customer.value);
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);
    const created = await run(() =>
      env.service.createIntervention('site-bastille', {
        customerId: 'cust-sans-email',
        kind: 'Dépannage',
      }),
    );
    if (!created.ok) throw new Error('fiche non créée');
    await run(() =>
      env.service.startIntervention({ interventionId: created.value.id, expectedRevision: 1 }),
    );
    await run(() =>
      env.service.completeIntervention({ interventionId: created.value.id, expectedRevision: 2 }),
    );
    await run(() => env.service.generateInterventionReport(created.value.id));
    const sent = await run(() => env.service.sendInterventionReport(created.value.id));
    expect(sent.ok).toBe(false);
    if (sent.ok) return;
    expect(JSON.stringify(sent.error)).toContain('Ajoute un contact');
    expect(env.enqueued).toHaveLength(0);
  });

  it('CTA facturer : brouillon pré-rempli, repasse par TOUS les invariants, jamais deux fois', async () => {
    const env = await completedIntervention();
    const drafted = await env.run(() =>
      env.service.prepareInterventionInvoiceDraft(env.interventionId),
    );
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;

    const invoice = await env.run(() => env.p.invoices.findById(drafted.value.invoiceId));
    expect(invoice).not.toBeNull();
    expect(invoice!.status).toBe('draft');
    expect(invoice!.customerId).toBe('cust-ratp');
    // Site du passage porté par le brouillon (PR-08) + référence LISIBLE du passage.
    expect(invoice!.chantierId).toBe('site-bastille');
    expect(invoice!.lines[0]!.label).toContain('Visite d’entretien');
    expect(invoice!.lines[0]!.label).toContain('Fontaine accueil R+2');

    const again = await env.run(() =>
      env.service.prepareInterventionInvoiceDraft(env.interventionId),
    );
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(JSON.stringify(again.error)).toContain('déjà');

    // Le brouillon supprimé DÉTACHE la fiche : le droit se rallume par l'état réel.
    const deleted = await env.run(() => env.service.deleteDraftInvoice(drafted.value.invoiceId));
    expect(deleted.ok).toBe(true);
    const redrafted = await env.run(() =>
      env.service.prepareInterventionInvoiceDraft(env.interventionId),
    );
    expect(redrafted.ok).toBe(true);
  });

  it('franchise 293 B : le CTA passe, la ligne par défaut porte le taux IMPOSÉ (0), pas 20', async () => {
    const env = makeService();
    const companyId = await seedTenant(env.p, { vatRegime: 'franchise' });
    await seedChantier(env.p, 'site-bastille', companyId);
    await seedCustomer(env.p, 'cust-ratp', companyId);
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);
    const created = await run(() =>
      env.service.createIntervention('site-bastille', {
        customerId: 'cust-ratp',
        kind: 'Visite d’entretien',
      }),
    );
    if (!created.ok) throw new Error('fiche non créée');
    await run(() =>
      env.service.startIntervention({ interventionId: created.value.id, expectedRevision: 1 }),
    );
    await run(() =>
      env.service.completeIntervention({ interventionId: created.value.id, expectedRevision: 2 }),
    );
    const drafted = await run(() => env.service.prepareInterventionInvoiceDraft(created.value.id));
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;
    const invoice = await run(() => env.p.invoices.findById(drafted.value.invoiceId));
    expect(invoice!.lines[0]!.vatRate).toBe(0);
  });

  it('autoliquidation BTP : même dérivation — le geste n’est jamais structurellement mort', async () => {
    const env = makeService();
    const companyId = await seedTenant(env.p);
    await seedChantier(env.p, 'site-bastille', companyId);
    const soustraitant = Customer.of({
      id: 'cust-st',
      companyId,
      type: 'b2b',
      name: 'Entreprise générale',
      siren: '821503646',
      address: { line1: 'ZA des Bruyères', zip: '92140', city: 'Clamart' },
      email: 'compta@eg.example',
      isSubcontractingBtp: true,
    });
    if (!soustraitant.ok) throw new Error('fixture client invalide');
    await env.p.customers.save(soustraitant.value);
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);
    const created = await run(() =>
      env.service.createIntervention('site-bastille', { customerId: 'cust-st', kind: 'Dépannage' }),
    );
    if (!created.ok) throw new Error('fiche non créée');
    await run(() =>
      env.service.startIntervention({ interventionId: created.value.id, expectedRevision: 1 }),
    );
    await run(() =>
      env.service.completeIntervention({ interventionId: created.value.id, expectedRevision: 2 }),
    );
    const drafted = await run(() => env.service.prepareInterventionInvoiceDraft(created.value.id));
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;
    const invoice = await run(() => env.p.invoices.findById(drafted.value.invoiceId));
    expect(invoice!.lines[0]!.vatRate).toBe(0);
  });

  it('double tap / écran + voix : UN SEUL brouillon, jamais d’orphelin émissible', async () => {
    const env = await completedIntervention();
    const [first, second] = await Promise.all([
      env.run(() => env.service.prepareInterventionInvoiceDraft(env.interventionId)),
      env.run(() => env.service.prepareInterventionInvoiceDraft(env.interventionId)),
    ]);
    const accepted = [first, second].filter((r) => r.ok);
    const refused = [first, second].filter((r) => !r.ok);
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(JSON.stringify(refused[0])).toContain('déjà');

    // La fiche référence l'UNIQUE brouillon créé — aucun second brouillon n'existe.
    const drafts = await env.run(() => env.p.invoices.listByCompany(env.companyId));
    expect(drafts).toHaveLength(1);
    const intervention = await env.run(() =>
      env.p.interventions.findById(env.companyId, env.interventionId),
    );
    expect(intervention!.billedInvoiceId).toBe(drafts[0]!.id);
  });

  it('composition refusée : AUCUN brouillon orphelin, la fiche reste libre (rollback)', async () => {
    const env = makeService();
    const companyId = await seedTenant(env.p);
    await seedChantier(env.p, 'site-bastille', companyId);
    await seedCustomer(env.p, 'cust-part', companyId, { type: 'b2c' });
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);
    const created = await run(() =>
      env.service.createIntervention('site-bastille', {
        customerId: 'cust-part',
        kind: 'Dépannage fontaine',
      }),
    );
    if (!created.ok) throw new Error('fiche non créée');
    await run(() =>
      env.service.startIntervention({ interventionId: created.value.id, expectedRevision: 1 }),
    );
    await run(() =>
      env.service.completeIntervention({ interventionId: created.value.id, expectedRevision: 2 }),
    );
    const refused = await run(() => env.service.prepareInterventionInvoiceDraft(created.value.id));
    expect(refused.ok).toBe(false);
    expect(await run(() => env.p.invoices.listByCompany(companyId))).toHaveLength(0);
    const intervention = await run(() => env.p.interventions.findById(companyId, created.value.id));
    expect(intervention!.billedInvoiceId).toBeNull();
  });

  it('B2C sans urgence qualifiée : la garde standalone s’applique INTÉGRALEMENT au CTA', async () => {
    const env = makeService();
    const companyId = await seedTenant(env.p);
    await seedChantier(env.p, 'site-bastille', companyId);
    await seedCustomer(env.p, 'cust-part', companyId, { type: 'b2c' });
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);
    const created = await run(() =>
      env.service.createIntervention('site-bastille', {
        customerId: 'cust-part',
        kind: 'Dépannage fontaine',
      }),
    );
    if (!created.ok) throw new Error('fiche non créée');
    await run(() =>
      env.service.startIntervention({ interventionId: created.value.id, expectedRevision: 1 }),
    );
    await run(() =>
      env.service.completeIntervention({ interventionId: created.value.id, expectedRevision: 2 }),
    );
    const refused = await run(() =>
      env.service.prepareInterventionInvoiceDraft(created.value.id),
    );
    expect(refused.ok).toBe(false);

    const urgent = await run(() =>
      env.service.prepareInterventionInvoiceDraft(created.value.id, { urgentOnSiteRepair: true }),
    );
    expect(urgent.ok).toBe(true);
  });

  it('« facturer sans délai » BRANCHÉ : le passage sort de la liste, et y REVIENT si la facture est annulée', async () => {
    const env = await completedIntervention();
    const controller = new InterventionsController(env.service);

    const due = await env.run(() => controller.billingDue());
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      interventionId: env.interventionId,
      kind: 'Visite d’entretien',
      chantierNom: 'Site site-bastille',
      customerNom: 'RATP CAP',
    });

    // Brouillon lié : la pièce est VIVANTE, le passage sort de la liste.
    const drafted = await env.run(() =>
      env.service.prepareInterventionInvoiceDraft(env.interventionId),
    );
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;
    expect(await env.run(() => controller.billingDue())).toHaveLength(0);

    // Facture ANNULÉE : le fait se RALLUME par l'ÉTAT RÉEL, sans aucun code dédié. Aucun use
    // case applicatif n'annule encore une pièce (l'avoir A6 est une pièce distincte) : on pose
    // donc l'état persisté à la main, ce que la dérivation doit déjà savoir lire.
    const invoice = await env.run(() => env.p.invoices.findById(drafted.value.invoiceId));
    const cancelled = invoice!.cancel('avoir', '2026-08-05T10:00:00.000Z');
    expect(cancelled.ok).toBe(true);
    await env.run(() => env.p.invoices.save(invoice!));
    const again = await env.run(() => controller.billingDue());
    expect(again.map((fact) => fact.interventionId)).toEqual([env.interventionId]);
  });

  it('une VISITE CONTRACTUELLE n’entre jamais dans « à facturer » (discriminant contractId)', async () => {
    const env = await completedIntervention();
    // contractId n'est jamais accepté par CreateIntervention dans ce train : on force l'état
    // persisté pour prouver que la DÉRIVATION, elle, le respecte déjà (direction 6).
    const stored = await env.run(() =>
      env.p.interventions.findById(env.companyId, env.interventionId),
    );
    await env.run(() =>
      env.p.interventions.save(
        Intervention.rehydrate({ ...stored!.toProps(), contractId: 'contract-1' }),
      ),
    );
    const controller = new InterventionsController(env.service);
    expect(await env.run(() => controller.billingDue())).toHaveLength(0);
  });

  it('réglages ÉCRIVABLES : le titre choisi devient l’identité du PDF ET du sujet d’e-mail', async () => {
    const env = await completedIntervention();
    const controller = new InterventionsController(env.service);

    // Lecture initiale : défaut produit, révision 0 (rien n'a encore été posé).
    const initial = await env.run(() => controller.settings());
    expect(initial).toMatchObject({
      reportTitle: null,
      effectiveReportTitle: 'Fiche de passage',
      revision: 0,
    });

    const saved = await env.run(() =>
      controller.updateSettings({
        reportTitle: 'Certificat sanitaire',
        checklistTemplates: { 'Visite d’entretien': ['Détartrage', 'Contrôle de pression'] },
        expectedRevision: 0,
      }),
    );
    expect(saved).toMatchObject({ reportTitle: 'Certificat sanitaire', revision: 1 });

    // Le titre traverse jusqu'à l'ARCHIVE : nom de fichier, texte du PDF, sujet de l'e-mail.
    const generated = await env.run(() =>
      env.service.generateInterventionReport(env.interventionId),
    );
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.filename).toMatch(/^certificat-sanitaire-\d{4}-\d{2}-\d{2}\.pdf$/);
    const archived = await env.run(() =>
      env.p.documents.findById(env.companyId, generated.value.documentId),
    );
    const bytes = await env.storage.get(env.companyId, archived!.toProps().storageKey);
    const text = await pdfVisibleText(bytes!.bytes);
    expect(text).toContain('Certificat sanitaire');

    const sent = await env.run(() => env.service.sendInterventionReport(env.interventionId));
    expect(sent.ok).toBe(true);
    expect(env.enqueued[0]!.notification.subject).toContain('Certificat sanitaire');

    // Le template de checklist est proposé à la création d'un passage du même type.
    const created = await env.run(() =>
      env.service.createIntervention('site-bastille', {
        customerId: 'cust-ratp',
        kind: 'visite d’entretien',
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const fiche = await env.run(() => env.service.getIntervention(created.value.id));
    expect(fiche.ok).toBe(true);
    if (!fiche.ok) return;
    expect(fiche.value.checklist.map((item) => item.label)).toEqual([
      'Détartrage',
      'Contrôle de pression',
    ]);
  });

  it('réglages : CAS honoré à la frontière et champ inconnu refusé (400)', async () => {
    const env = await completedIntervention();
    const controller = new InterventionsController(env.service);
    await env.run(() => controller.updateSettings({ reportTitle: 'Certificat', expectedRevision: 0 }));
    await expect(
      env.run(() => controller.updateSettings({ reportTitle: 'Autre', expectedRevision: 0 })),
    ).rejects.toThrow();
    await expect(env.run(() => controller.updateSettings({ bidon: true }))).rejects.toThrow();
    const still = await env.run(() => controller.settings());
    expect(still).toMatchObject({ reportTitle: 'Certificat', revision: 1 });
  });

  it('renderer indisponible : indisponibilité honnête, jamais un PDF de secours', async () => {
    const env = makeService({ withRenderer: false });
    const companyId = await seedTenant(env.p);
    await seedChantier(env.p, 'site-bastille', companyId);
    await seedCustomer(env.p, 'cust-ratp', companyId);
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);
    const created = await run(() =>
      env.service.createIntervention('site-bastille', {
        customerId: 'cust-ratp',
        kind: 'Dépannage',
      }),
    );
    if (!created.ok) throw new Error('fiche non créée');
    const generated = await run(() => env.service.generateInterventionReport(created.value.id));
    expect(generated).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
  });
});

describe('rendu PDF de la fiche — la vérité du terrain (PR-16)', () => {
  function reportData(overrides: Partial<InterventionReportData> = {}): InterventionReportData {
    return {
      title: 'Fiche de passage',
      companyName: 'Fly Services',
      customerName: 'RATP CAP',
      chantierName: 'Bastille',
      chantierAddress: '1 place de la Bastille, 75011 Paris',
      equipmentLabel: 'Fontaine accueil R+2',
      kind: 'Visite d’entretien',
      technicianLabel: 'Papa',
      plannedAt: '2026-08-04T07:00:00.000Z',
      startedAt: '2026-08-04T07:04:00.000Z',
      finishedAt: '2026-08-04T08:12:00.000Z',
      checklist: [
        { label: 'Détartrage', done: true, note: 'Filtre remplacé' },
        { label: 'Contrôle de pression', done: false },
      ],
      summary: 'Pression basse au démarrage, réglée.',
      photos: [{ filename: 'avant.jpg', phase: 'before', createdAt: '2026-08-04T07:10:00.000Z' }],
      notes: [
        {
          text: '1 photo n’a pas pu être jointe.',
          authorLabel: 'Fly Services',
          createdAt: '2026-08-04T08:20:00.000Z',
        },
      ],
      signature: null,
      ...overrides,
    };
  }

  it('fiche NON signée : la mention « client absent » est ÉCRITE, jamais suggérée', async () => {
    const bytes = await new PdfRenderer().renderInterventionReport(reportData());
    expect(Buffer.from(bytes.slice(0, 5)).toString('utf8')).toBe('%PDF-');
    const text = await pdfVisibleText(bytes);
    expect(text).toContain('Fiche de passage');
    expect(text).toContain('Bastille');
    expect(text).toContain('Fontaine accueil R+2');
    // Les points contrôlés disent OUI/NON par le texte, jamais par la couleur seule.
    expect(text).toContain('Détartrage');
    expect(text).toContain('[x]');
    expect(text).toContain('[ ]');
    expect(text).toContain('client etait absent');
    expect(text).not.toContain('Signataire');
    // Photos listées par phase, notes du passage reprises verbatim.
    expect(text).toContain('Avant');
    expect(text).toContain('avant.jpg');
  });

  it('titre PARAMÉTRABLE par société : il devient l’identité du document', async () => {
    const bytes = await new PdfRenderer().renderInterventionReport(
      reportData({ title: 'Certificat sanitaire' }),
    );
    const text = await pdfVisibleText(bytes);
    expect(text).toContain('Certificat sanitaire');
    expect(text).not.toContain('Fiche de passage');
  });

  it('signature hors-ligne : les DEUX horodatages sont rendus (convention §3.4)', async () => {
    const bytes = await new PdfRenderer().renderInterventionReport(
      reportData({
        signature: {
          signerName: 'M. Responsable',
          capturedAt: '2026-08-04T10:00:00.000Z',
          capturedAtDevice: '2026-08-04T08:41:00.000Z',
        },
      }),
    );
    const text = await pdfVisibleText(bytes);
    expect(text).toContain('M. Responsable');
    expect(text).toContain("horloge de l'appareil");
    expect(text).toContain('Synchronisee le');
    // Valeur probante dite telle quelle (LegalHint eIDAS), jamais surévaluée.
    expect(text).toContain('eIDAS');
    expect(text).not.toContain('client etait absent');
  });
});
