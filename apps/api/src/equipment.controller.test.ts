import { describe, expect, it, vi } from 'vitest';
import { Chantier, type OcrPort, type PaymentGatewayPort, type PdfRendererPort } from '@bob/core';
import { seedCompany } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { EquipmentsController } from './api.controllers';

/**
 * PR-11b — câblage serveur du parc d'équipements : mêmes use cases que le mobile et la voix
 * (parité), gate module chantiers identique aux notes/photos, anti-IDOR fail-closed.
 */
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
  return { service, p, audit };
}

function asPrincipal<T>(principal: Principal, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ correlationId: 'test', principal }, fn);
}

async function seedTenant(p: InMemoryPersistence): Promise<string> {
  const company = seedCompany();
  await p.companies.save(company);
  // Gate module chantiers : le parc suit exactement la même porte que notes/photos.
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
      address: null,
      notes: null,
      status,
      openedAt: '2026-07-01',
    }),
  );
}

describe('parc d’équipements — service (PR-11b)', () => {
  it('créer → lister → modifier (CAS) → retirer → réactiver, sur le MÊME site', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedChantier(p, 'site-bastille', companyId);
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);

    const created = await run(() =>
      service.createEquipment('site-bastille', {
        label: 'Fontaine accueil R+2',
        kind: 'Fontaine réseau',
        warrantyUntil: '2027-03-12',
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const listed = await run(() => service.listChantierEquipments('site-bastille'));
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]).toMatchObject({ label: 'Fontaine accueil R+2', status: 'active', revision: 1 });

    const updated = await run(() =>
      service.updateEquipment({
        equipmentId: created.value.id,
        expectedRevision: 1,
        patch: { location: 'R+2, accueil' },
      }),
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value).toMatchObject({ location: 'R+2, accueil', revision: 2 });

    const stale = await run(() =>
      service.updateEquipment({ equipmentId: created.value.id, expectedRevision: 1, patch: { label: 'X' } }),
    );
    expect(stale.ok).toBe(false);

    const retired = await run(() =>
      service.retireEquipment({ equipmentId: created.value.id, expectedRevision: 2 }),
    );
    expect(retired.ok).toBe(true);
    if (!retired.ok) return;
    expect(retired.value.equipment.status).toBe('retired');
    expect(retired.value.equipment.retiredAt).not.toBeNull();
    expect(retired.value.contractWarning).toBeNull();

    const reactivated = await run(() =>
      service.reactivateEquipment({ equipmentId: created.value.id, expectedRevision: 3 }),
    );
    expect(reactivated.ok).toBe(true);
    if (!reactivated.ok) return;
    expect(reactivated.value).toMatchObject({ status: 'active', retiredAt: null });
  });

  it('site clôturé : création refusée avec message actionnable, puis réouverture débloque', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedChantier(p, 'site-clos', companyId, 'closed');
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);

    const refused = await run(() => service.createEquipment('site-clos', { label: 'Clim' }));
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.error.kind !== 'domain') throw new Error('refus domaine attendu');
    expect(refused.error.error).toMatchObject({ code: 'VALIDATION', field: 'chantierId' });

    const reopened = await run(() => service.reopenChantier('site-clos'));
    expect(reopened).toMatchObject({ ok: true, value: { changed: true } });
    const created = await run(() => service.createEquipment('site-clos', { label: 'Clim' }));
    expect(created.ok).toBe(true);
  });

  it('anti-IDOR : équipements et sites d’un autre tenant sont introuvables', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedChantier(p, 'site-autre', 'company-autre');
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);

    expect((await run(() => service.listChantierEquipments('site-autre'))).ok).toBe(false);
    expect((await run(() => service.createEquipment('site-autre', { label: 'Clim' }))).ok).toBe(false);
    expect(
      (await run(() => service.retireEquipment({ equipmentId: 'equip-fantome', expectedRevision: 1 }))).ok,
    ).toBe(false);
  });

  it('historique par équipement : notes/photos TAGUÉES seulement, note du site exclue', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedChantier(p, 'site-bastille', companyId);
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);

    const created = await run(() => service.createEquipment('site-bastille', { label: 'Fontaine accueil' }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const tagged = await run(() =>
      service.addChantierNote('site-bastille', {
        text: 'Détartrage complet',
        equipmentId: created.value.id,
      }),
    );
    expect(tagged.ok).toBe(true);
    const siteNote = await run(() =>
      service.addChantierNote('site-bastille', { text: 'Code portail 1234' }),
    );
    expect(siteNote.ok).toBe(true);

    const history = await run(() => service.getEquipmentHistory(created.value.id));
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value.equipment.id).toBe(created.value.id);
    expect(history.value.entries).toHaveLength(1);
    expect(history.value.entries[0]).toMatchObject({ type: 'note', text: 'Détartrage complet' });
  });

  it('note taguée vers un équipement d’un AUTRE site : refus (cohérence) — rien n’est écrit', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedChantier(p, 'site-bastille', companyId);
    await seedChantier(p, 'site-rouen', companyId);
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);

    const created = await run(() => service.createEquipment('site-rouen', { label: 'PAC toiture' }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const refused = await run(() =>
      service.addChantierNote('site-bastille', { text: 'Note égarée', equipmentId: created.value.id }),
    );
    expect(refused.ok).toBe(false);
    const notes = await run(() => service.listChantierNotes('site-bastille'));
    expect(notes.ok && notes.value.length === 0).toBe(true);
  });
});

describe('EquipmentsController — frontière HTTP stricte', () => {
  function controller(overrides: Partial<BackendService> = {}) {
    return new EquipmentsController(overrides as BackendService);
  }

  it('refuse un champ hors contrat et une révision invalide AVANT le domaine', async () => {
    const updateEquipment = vi.fn();
    const retireEquipment = vi.fn();
    const c = controller({ updateEquipment, retireEquipment } as never);
    await expect(c.update('e-1', { expectedRevision: 1, companyId: 'x' })).rejects.toMatchObject({ status: 422 });
    await expect(c.update('e-1', { expectedRevision: 0, label: 'ok' })).rejects.toMatchObject({ status: 422 });
    await expect(c.retire('e-1', { expectedRevision: 1, autre: true })).rejects.toMatchObject({ status: 422 });
    expect(updateEquipment).not.toHaveBeenCalled();
    expect(retireEquipment).not.toHaveBeenCalled();
  });

  it('transmet le patch canonique (null efface, absent inchangé)', async () => {
    const updateEquipment = vi.fn(async () => ({ ok: true as const, value: {} }));
    const c = controller({ updateEquipment } as never);
    await c.update('e-1', { expectedRevision: 2, label: 'Fontaine quai A', warrantyUntil: null });
    expect(updateEquipment).toHaveBeenCalledWith({
      equipmentId: 'e-1',
      expectedRevision: 2,
      patch: { label: 'Fontaine quai A', warrantyUntil: null },
    });
  });

  it('[revue n°2] notes MULTILIGNES acceptées à la frontière — autres contrôles toujours refusés, mono-lignes stricts', async () => {
    const multiline = 'Détartrage complet.\nPrévoir cartouche.\tRéf 88-4121';
    const updateEquipment = vi.fn(async () => ({ ok: true as const, value: {} }));
    const c = controller({ updateEquipment } as never);
    // \n et \t traversent la frontière pour notes (miroir domaine + CHECK SQL translate()).
    await c.update('e-1', { expectedRevision: 2, notes: multiline });
    expect(updateEquipment).toHaveBeenCalledWith({
      equipmentId: 'e-1',
      expectedRevision: 2,
      patch: { notes: multiline },
    });
    // Un caractère de contrôle NON admis (BEL) reste un 422 avant le domaine.
    await expect(
      c.update('e-1', { expectedRevision: 2, notes: 'sonnerie \u0007' }),
    ).rejects.toMatchObject({ status: 422 });
    // Les champs MONO-LIGNE (label, kind…) refusent toujours \n : rien n'est relâché ailleurs.
    await expect(
      c.update('e-1', { expectedRevision: 2, label: 'Fontaine\naccueil' }),
    ).rejects.toMatchObject({ status: 422 });
    expect(updateEquipment).toHaveBeenCalledTimes(1);
  });
});
