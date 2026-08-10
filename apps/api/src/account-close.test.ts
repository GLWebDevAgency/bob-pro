import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationPort, OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { Company } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import { NotificationDeliveryService } from './jobs/notification-delivery.service';
import { ScheduledTenantDirectory } from './jobs/tenant-directory';
import type { ExpoPushService } from './notifications/expo-push';
import type { Metrics } from './observability/metrics';
import {
  CLOSED_ACCOUNT_NOTIFICATION_RECIPIENT,
  CLOSED_ACCOUNT_NOTIFICATION_SUBJECT,
} from './persistence/notification-jobs';

function makeService() {
  const p = new InMemoryPersistence();
  const admin: SupabaseAdminPort = {
    setUserCompanyId: vi.fn(async () => undefined),
    deleteUser: vi.fn(async () => undefined),
  };
  const logger = { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger;
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
  return { service, p, admin, logger };
}

/** Exécute fn avec un Principal explicite (comme le guard en requête réelle) — sync ou async. */
function asPrincipal<T>(principal: Principal | null, fn: () => T): T {
  return requestContext.run({ correlationId: 'test', ...(principal ? { principal } : {}) }, fn);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function seedCompanyAs(p: InMemoryPersistence, companyId: string): Promise<void> {
  const c = Company.of({ ...MERCIER_PROPS, id: companyId });
  if (!c.ok) throw new Error('fixture company invalide');
  await p.companies.save(c.value);
}

async function seedDevice(p: InMemoryPersistence, companyId: string, token: string): Promise<void> {
  await p.devices.register({
    id: `dev-${token}`,
    companyId,
    userId: 'u-1',
    expoPushToken: token,
    platform: 'ios',
    installationId: randomUUID(),
    bindingId: randomUUID(),
    bindingGeneration: 1,
    revocationSecretHash: 'a'.repeat(64),
    now: '2026-07-16T09:00:00.000Z',
  });
}

describe('DELETE /account — BackendService.closeAccount (Apple 5.1.1(v))', () => {
  const USER_ID = 'u-1';
  const COMPANY_ID = 'company-u-1';

  it('confirmationText EXACT → clôture et demande Auth atomiques, sans appel Supabase synchrone', async () => {
    const { service, p, admin, logger } = makeService();
    await seedCompanyAs(p, COMPANY_ID);
    const now = new Date().toISOString();
    await p.subscriptions.startTrial({
      id: `sub-${COMPANY_ID}`,
      companyId: COMPANY_ID,
      plan: 'pro',
      trialEndsAt: new Date(Date.now() + 86_400_000).toISOString(),
      now,
    });
    await seedDevice(p, COMPANY_ID, 'ExponentPushToken[abc]');
    const publicGrant = await p.publicAccessTokens.create({
      companyId: COMPANY_ID,
      resourceType: 'invoice',
      resourceId: 'inv-public-before-close',
      scope: 'document_view',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const notification = await p.notificationJobs.enqueue({
      id: 'notification-before-close',
      companyId: COMPANY_ID,
      kind: 'invoice-relance',
      dedupeKey: 'invoice:before-close:relance:v1',
      notification: {
        channel: 'email',
        to: 'client-personnel@example.com',
        subject: 'Relance confidentielle',
        body: 'Contenu personnel à purger.',
      },
      now,
    });

    const r = await asPrincipal({ userId: USER_ID, companyId: COMPANY_ID }, () =>
      service.closeAccount({ confirmationText: MERCIER_PROPS.name }),
    );

    expect(r.ok).toBe(true);

    const closed = await p.companies.findById(COMPANY_ID);
    expect(closed?.isClosed()).toBe(true);
    // La fiche légale n'a pas bougé — rétention légale des pièces déjà émises.
    expect(closed?.name).toBe(MERCIER_PROPS.name);
    expect(closed?.siret).toBe(MERCIER_PROPS.siret);

    const sub = await p.subscriptions.findByCompanyId(COMPANY_ID);
    expect(sub?.status).toBe('canceled');

    const targets = await p.devices.listDeliveryTargetsByCompany(COMPANY_ID, '2000-01-01T00:00:00.000Z');
    expect(targets).toHaveLength(0);

    expect(await p.publicAccessTokens.findActive(publicGrant.token, now)).toBeNull();
    expect(await p.notificationJobs.findById(COMPANY_ID, notification.id)).toMatchObject({
      status: 'cancelled',
      notification: null,
      recipient: CLOSED_ACCOUNT_NOTIFICATION_RECIPIENT,
      subject: CLOSED_ACCOUNT_NOTIFICATION_SUBJECT,
      payloadFingerprint: null,
      leaseToken: null,
      lastError: null,
    });

    const deletion = await p.authUserDeletionJobs.findByCompanyId(COMPANY_ID);
    expect(deletion).toMatchObject({
      companyId: COMPANY_ID,
      userId: USER_ID,
      status: 'pending',
      attempts: 0,
    });
    expect(admin.deleteUser).not.toHaveBeenCalled();
    expect(logger.audit).toHaveBeenCalledWith(
      'account.closed',
      expect.objectContaining({
        companyId: COMPANY_ID,
        identityDeletionRequestId: deletion?.id,
        identityDeletionStatus: 'pending',
      }),
    );
    const audit = vi.mocked(logger.audit).mock.calls.find(([event]) => event === 'account.closed');
    expect(audit?.[1]).not.toHaveProperty('userId');
  });

  it('confirmationText FAUX → validation, aucune outbox et la company reste ouverte', async () => {
    const { service, p, admin } = makeService();
    await seedCompanyAs(p, COMPANY_ID);

    const r = await asPrincipal({ userId: USER_ID, companyId: COMPANY_ID }, () =>
      service.closeAccount({ confirmationText: 'Mauvais Nom' }),
    );

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('validation');
    const stillOpen = await p.companies.findById(COMPANY_ID);
    expect(stillOpen?.isClosed()).toBe(false);
    expect(await p.authUserDeletionJobs.findByCompanyId(COMPANY_ID)).toBeNull();
    expect(admin.deleteUser).not.toHaveBeenCalled();
  });

  it('panne de l’outbox → rollback : company ouverte et aucun effet durable', async () => {
    const { service, p, admin } = makeService();
    await seedCompanyAs(p, COMPANY_ID);
    vi.spyOn(p.authUserDeletionJobs, 'ensureRequested').mockRejectedValueOnce(
      new Error('outbox unavailable'),
    );

    await expect(
      asPrincipal({ userId: USER_ID, companyId: COMPANY_ID }, () =>
        service.closeAccount({ confirmationText: MERCIER_PROPS.name }),
      ),
    ).rejects.toThrow('outbox unavailable');

    expect((await p.companies.findById(COMPANY_ID))?.isClosed()).toBe(false);
    expect(await p.authUserDeletionJobs.findByCompanyId(COMPANY_ID)).toBeNull();
    expect(admin.deleteUser).not.toHaveBeenCalled();
  });

  it('panne au dernier effet local → rollback intégral de toutes les mutations précédentes', async () => {
    const { service, p, admin, logger } = makeService();
    await seedCompanyAs(p, COMPANY_ID);
    const seededAt = '2026-08-02T09:00:00.000Z';
    await p.subscriptions.startTrial({
      id: `sub-${COMPANY_ID}`,
      companyId: COMPANY_ID,
      plan: 'pro',
      trialEndsAt: '2099-01-01T00:00:00.000Z',
      now: seededAt,
    });
    const publicGrant = await p.publicAccessTokens.create({
      companyId: COMPANY_ID,
      resourceType: 'quote',
      resourceId: 'quote-before-rollback',
      scope: 'quote_signature',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const notification = await p.notificationJobs.enqueue({
      id: 'notification-before-rollback',
      companyId: COMPANY_ID,
      kind: 'quote-signature',
      dedupeKey: 'quote:before-rollback:signature:v1',
      notification: {
        channel: 'email',
        to: 'client-before-rollback@example.com',
        subject: 'Votre devis',
        body: 'Lien public encore actif avant la tentative.',
      },
      now: seededAt,
    });
    await seedDevice(p, COMPANY_ID, 'ExponentPushToken[rollback]');

    // Dernier effet de l'orchestration : on simule une panne APRÈS la suppression locale afin
    // de prouver que le snapshot transactionnel restaure aussi les mutations déjà effectuées.
    const deleteAllForCompany = p.devices.deleteAllForCompany.bind(p.devices);
    vi.spyOn(p.devices, 'deleteAllForCompany').mockImplementationOnce(async (companyId) => {
      await deleteAllForCompany(companyId);
      throw new Error('device store unavailable after delete');
    });

    await expect(
      asPrincipal({ userId: USER_ID, companyId: COMPANY_ID }, () =>
        service.closeAccount({ confirmationText: MERCIER_PROPS.name }),
      ),
    ).rejects.toThrow('device store unavailable after delete');

    expect((await p.companies.findById(COMPANY_ID))?.isClosed()).toBe(false);
    expect(await p.authUserDeletionJobs.findByCompanyId(COMPANY_ID)).toBeNull();
    expect(await p.subscriptions.findByCompanyId(COMPANY_ID)).toMatchObject({ status: 'trialing' });
    expect(await p.publicAccessTokens.findActive(publicGrant.token, seededAt)).toMatchObject({
      id: publicGrant.id,
      revokedAt: null,
    });
    expect(await p.notificationJobs.findById(COMPANY_ID, notification.id)).toMatchObject({
      status: 'pending',
      recipient: 'client-before-rollback@example.com',
      subject: 'Votre devis',
      notification: expect.objectContaining({ body: 'Lien public encore actif avant la tentative.' }),
    });
    expect(
      await p.devices.listDeliveryTargetsByCompany(COMPANY_ID, '2000-01-01T00:00:00.000Z'),
    ).toHaveLength(1);
    expect(admin.deleteUser).not.toHaveBeenCalled();
    expect(logger.audit).not.toHaveBeenCalledWith('account.closed', expect.anything());
  });

  it('course réelle : une clôture commitée entre claim et fence interdit tout provider', async () => {
    const { service, p, logger } = makeService();
    await seedCompanyAs(p, COMPANY_ID);
    const notifier = { send: vi.fn<NotificationPort['send']>() } satisfies NotificationPort;
    const push = { send: vi.fn() } as unknown as ExpoPushService;
    const delivery = new NotificationDeliveryService(
      p,
      notifier,
      new ScheduledTenantDirectory(p, logger),
      logger,
      push,
    );
    const job = await delivery.enqueue({
      companyId: COMPANY_ID,
      kind: 'invoice-relance',
      dedupeKey: 'invoice:close-race:relance:v1',
      notification: {
        channel: 'email',
        to: 'client-close-race@example.com',
        subject: 'Ne doit jamais partir',
        body: 'Contenu personnel.',
      },
    });

    const reachedFinalFence = deferred();
    const releaseFinalFence = deferred();
    const originalCompanyLock = p.companies.lockForShareById.bind(p.companies);
    let companyLockCalls = 0;
    vi.spyOn(p.companies, 'lockForShareById').mockImplementation(async (companyId) => {
      companyLockCalls += 1;
      if (companyLockCalls === 2) {
        reachedFinalFence.resolve();
        await releaseFinalFence.promise;
      }
      return originalCompanyLock(companyId);
    });

    const attempt = delivery.tryDeliver(COMPANY_ID, {
      ...job,
      notification: job.notification!,
    });
    await reachedFinalFence.promise;
    const closed = await asPrincipal({ userId: USER_ID, companyId: COMPANY_ID }, () =>
      service.closeAccount({ confirmationText: MERCIER_PROPS.name }),
    );
    expect(closed.ok).toBe(true);
    releaseFinalFence.resolve();

    await expect(attempt).resolves.toBe('skipped');
    expect(notifier.send).not.toHaveBeenCalled();
    expect(push.send).not.toHaveBeenCalled();
    expect(await p.notificationJobs.findById(COMPANY_ID, job.id)).toMatchObject({
      status: 'cancelled',
      notification: null,
      recipient: CLOSED_ACCOUNT_NOTIFICATION_RECIPIENT,
      leaseToken: null,
    });
  });

  it('course push : email gagnant avant clôture, Expo reste interdit après le commit', async () => {
    const { service, p, logger } = makeService();
    await seedCompanyAs(p, COMPANY_ID);
    await seedDevice(p, COMPANY_ID, 'ExponentPushToken[push-close-race]');
    const notifier = {
      send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined),
    } satisfies NotificationPort;
    const push = { send: vi.fn() } as unknown as ExpoPushService;
    const delivery = new NotificationDeliveryService(
      p,
      notifier,
      new ScheduledTenantDirectory(p, logger),
      logger,
      push,
    );
    const job = await delivery.enqueue({
      companyId: COMPANY_ID,
      kind: 'invoice-relance',
      dedupeKey: 'invoice:push-close-race:relance:v1',
      notification: {
        channel: 'email',
        to: 'client-push-close-race@example.com',
        subject: 'Email autorisé avant fermeture',
        body: 'Le push ne doit plus partir ensuite.',
      },
    });

    const reachedPushFence = deferred();
    const releasePushFence = deferred();
    const originalCompanyLock = p.companies.lockForShareById.bind(p.companies);
    let companyLockCalls = 0;
    vi.spyOn(p.companies, 'lockForShareById').mockImplementation(async (companyId) => {
      companyLockCalls += 1;
      if (companyLockCalls === 3) {
        reachedPushFence.resolve();
        await releasePushFence.promise;
      }
      return originalCompanyLock(companyId);
    });
    const listDevices = vi.spyOn(p.devices, 'listDeliveryTargetsByCompany');

    const attempt = delivery.tryDeliver(COMPANY_ID, {
      ...job,
      notification: job.notification!,
    });
    await reachedPushFence.promise;
    expect(notifier.send).toHaveBeenCalledOnce();
    const closed = await asPrincipal({ userId: USER_ID, companyId: COMPANY_ID }, () =>
      service.closeAccount({ confirmationText: MERCIER_PROPS.name }),
    );
    expect(closed.ok).toBe(true);
    releasePushFence.resolve();

    await expect(attempt).resolves.toBe('sent');
    expect(push.send).not.toHaveBeenCalled();
    expect(listDevices).not.toHaveBeenCalled();
    expect(logger.audit).toHaveBeenCalledWith(
      'notification.push.skipped',
      expect.objectContaining({ companyId: COMPANY_ID, jobId: job.id, reason: 'account_closed' }),
    );
    expect(await p.notificationJobs.findById(COMPANY_ID, job.id)).toMatchObject({
      status: 'done',
      notification: null,
      recipient: CLOSED_ACCOUNT_NOTIFICATION_RECIPIENT,
    });
  });

  it('binding propriétaire non canonique → refus avant toute mutation', async () => {
    const { service, p, admin } = makeService();
    await seedCompanyAs(p, 'company-victim');

    const r = await asPrincipal({ userId: 'attacker', companyId: 'company-victim' }, () =>
      service.closeAccount({ confirmationText: MERCIER_PROPS.name }),
    );

    expect(r).toEqual({
      ok: false,
      error: { kind: 'forbidden', reason: 'COMPANY_OWNER_BINDING_MISMATCH' },
    });
    expect((await p.companies.findById('company-victim'))?.isClosed()).toBe(false);
    expect(await p.authUserDeletionJobs.findByCompanyId('company-victim')).toBeNull();
    expect(admin.deleteUser).not.toHaveBeenCalled();
  });

  it('membership Cabinet non révoquée → conflit sans closedAt ni job', async () => {
    const { service, p } = makeService();
    await seedCompanyAs(p, COMPANY_ID);
    p.authUserDeletionJobs.setBlockingCabinetMembership(USER_ID, true);

    const r = await asPrincipal({ userId: USER_ID, companyId: COMPANY_ID }, () =>
      service.closeAccount({ confirmationText: MERCIER_PROPS.name }),
    );

    expect(r).toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'account_deletion',
        reason: 'active_cabinet_memberships',
      },
    });
    expect((await p.companies.findById(COMPANY_ID))?.isClosed()).toBe(false);
    expect(await p.authUserDeletionJobs.findByCompanyId(COMPANY_ID)).toBeNull();
  });

  it('idempotent : le second appel conserve closedAt et la même demande Auth', async () => {
    const { service, p } = makeService();
    await seedCompanyAs(p, COMPANY_ID);

    const first = await asPrincipal({ userId: USER_ID, companyId: COMPANY_ID }, () =>
      service.closeAccount({ confirmationText: MERCIER_PROPS.name }),
    );
    expect(first.ok).toBe(true);
    const firstJob = await p.authUserDeletionJobs.findByCompanyId(COMPANY_ID);

    const second = await asPrincipal({ userId: USER_ID, companyId: COMPANY_ID }, () =>
      service.closeAccount({ confirmationText: MERCIER_PROPS.name }),
    );

    expect(second.ok).toBe(true);
    expect(second.ok && second.value).toEqual(first.ok ? first.value : undefined);
    const secondJob = await p.authUserDeletionJobs.findByCompanyId(COMPANY_ID);
    expect(secondJob?.id).toBe(firstJob?.id);
  });
});
