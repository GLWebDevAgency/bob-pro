import { describe, expect, it } from 'vitest';
import { Chantier, ChantierNote, Company, type OcrPort, type PaymentGatewayPort, type PdfRendererPort } from '@bob/core';
import { seedCompany } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

function makeService() {
  const p = new InMemoryPersistence();
  const admin: SupabaseAdminPort = {
    setUserCompanyId: async () => undefined,
    deleteUser: async () => undefined,
  } as SupabaseAdminPort;
  const logger = { audit: () => undefined, error: () => undefined, warn: () => undefined, log: () => undefined } as unknown as AppLogger;
  const service = new BackendService(
    p,
    {} as PaymentGatewayPort,
    {} as PdfRendererPort,
    {} as OcrPort,
    admin,
    {} as NotificationDeliveryService,
    {} as Metrics,
    logger,
  );
  return { service, p };
}

function asPrincipal<T>(principal: Principal | null, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ correlationId: 'test', ...(principal ? { principal } : {}) }, fn);
}

/** Plombier (module Chantiers pertinent) + abonnement Solo actif : chantiersAllowed() = true.
 * seedCompany() renvoie toujours company-mercier : on clone les props avec un nouvel id pour
 * isoler deux tenants dans le même test (cf. scope tenant). */
async function seedBtpCompany(p: InMemoryPersistence, id: string): Promise<Company> {
  const props = seedCompany().toProps();
  const r = Company.of({ ...props, id });
  if (!r.ok) throw new Error('fixture company invalide');
  const cloned = r.value;
  await p.companies.save(cloned);
  await p.subscriptions.save({
    id: `sub-${id}`,
    companyId: id,
    plan: 'solo',
    status: 'active',
    trialEndsAt: null,
    currentPeriodEnd: '2099-01-01T00:00:00.000Z',
    store: null,
    storeRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  return cloned;
}

function seedChantier(p: InMemoryPersistence, id: string, companyId: string) {
  const r = Chantier.record({
    id,
    companyId,
    name: `Chantier ${id}`,
    customerId: null,
    address: null,
    notes: null,
    status: 'open',
    openedAt: '2026-07-01',
  });
  if (!r.ok) throw new Error('fixture chantier invalide');
  return p.chantiers.save(r.value);
}

function seedNote(p: InMemoryPersistence, id: string, companyId: string, chantierId: string) {
  const r = ChantierNote.record({
    id,
    companyId,
    chantierId,
    text: `Note ${id}`,
    authorLabel: 'Mercier Plomberie',
    createdAt: '2026-07-01T10:00:00.000Z',
  });
  if (!r.ok) throw new Error('fixture note invalide');
  return p.chantierNotes.save(r.value);
}

function seedPhoto(p: InMemoryPersistence, id: string, companyId: string, chantierId: string) {
  return p.worksiteMedia.save({
    id,
    companyId,
    chantierId,
    filename: `${id}.jpg`,
    mimeType: 'image/jpeg',
    byteSize: 1024,
    storageKey: `key-${id}`,
    createdAt: '2026-07-01T10:00:00.000Z',
  });
}

describe('GET /chantiers — compteurs notes/photos (agrégat bulk, tenant-scoped)', () => {
  it('renvoie noteCount/photoCount corrects par chantier, sans repli à 0 pour les chantiers avec pièces', async () => {
    const { service, p } = makeService();
    const company = await seedBtpCompany(p, 'co-a');
    await seedChantier(p, 'ch-1', company.id);
    await seedChantier(p, 'ch-2', company.id);
    await seedNote(p, 'n-1', company.id, 'ch-1');
    await seedNote(p, 'n-2', company.id, 'ch-1');
    await seedNote(p, 'n-3', company.id, 'ch-1');
    await seedPhoto(p, 'p-1', company.id, 'ch-1');
    // ch-2 : aucune note ni photo.

    const r = await asPrincipal({ userId: 'u-a', companyId: company.id }, () => service.listChantiers());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.value.map((c) => [c.id, c]));
    expect(byId.get('ch-1')).toMatchObject({ noteCount: 3, photoCount: 1 });
    expect(byId.get('ch-2')).toMatchObject({ noteCount: 0, photoCount: 0 });
  });

  it('scope tenant : les notes/photos d’un autre tenant ne contaminent jamais le compteur', async () => {
    const { service, p } = makeService();
    const companyA = await seedBtpCompany(p, 'co-a');
    const companyB = await seedBtpCompany(p, 'co-b');
    await seedChantier(p, 'ch-a', companyA.id);
    await seedChantier(p, 'ch-b', companyB.id);
    await seedNote(p, 'n-a1', companyA.id, 'ch-a');
    await seedNote(p, 'n-a2', companyA.id, 'ch-a');
    await seedPhoto(p, 'p-b1', companyB.id, 'ch-b');
    await seedPhoto(p, 'p-b2', companyB.id, 'ch-b');
    await seedPhoto(p, 'p-b3', companyB.id, 'ch-b');

    const rA = await asPrincipal({ userId: 'u-a', companyId: companyA.id }, () => service.listChantiers());
    const rB = await asPrincipal({ userId: 'u-b', companyId: companyB.id }, () => service.listChantiers());

    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);
    if (!rA.ok || !rB.ok) return;
    expect(rA.value).toHaveLength(1);
    expect(rA.value[0]).toMatchObject({ id: 'ch-a', noteCount: 2, photoCount: 0 });
    expect(rB.value).toHaveLength(1);
    expect(rB.value[0]).toMatchObject({ id: 'ch-b', noteCount: 0, photoCount: 3 });
  });

  it('module Chantiers non débloqué : forbidden, aucun agrégat exécuté', async () => {
    const { service, p } = makeService();
    const company = seedCompany();
    await p.companies.save(company);
    // Aucun abonnement enregistré → subscriptionFor() échoue → chantiersAllowed() = false.

    const r = await asPrincipal({ userId: 'u-a', companyId: company.id }, () => service.listChantiers());

    expect(r.ok).toBe(false);
  });
});
