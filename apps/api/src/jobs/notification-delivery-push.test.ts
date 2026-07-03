import { describe, expect, it, vi } from 'vitest';
import type { NotificationPort } from '@bob/core';
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';
import type { AppLogger } from '../observability/logger';
import { InMemoryPersistence } from '../persistence/persistence';
import { MisconfiguredEmailNotifier, buildNotifier, DemoNotifier } from '../notifications/notifier';
import type { ExpoPushService } from '../notifications/expo-push';

function makeLogger(): AppLogger {
  return { audit: vi.fn(), warn: vi.fn() } as unknown as AppLogger;
}

const RELANCE_INPUT = {
  companyId: 'co-1',
  kind: 'invoice-relance' as const,
  dedupeKey: 'invoice:inv-1:relance:2026-07-03',
  notification: { channel: 'email' as const, to: 'client@example.com', subject: 'Relance F-1', body: 'Merci de régler.' },
};

async function registerDevice(persistence: InMemoryPersistence, token: string): Promise<void> {
  await persistence.devices.register({
    id: `dev-${token}`,
    companyId: 'co-1',
    userId: 'demo',
    expoPushToken: token,
    platform: 'ios',
    now: '2026-07-03T10:00:00.000Z',
  });
}

describe('NotificationDeliveryService — canal push Expo (C25)', () => {
  it("MIROIR de l'envoi réussi : push vers les devices du tenant avec le deep link de la pièce", async () => {
    const persistence = new InMemoryPersistence();
    const logger = makeLogger();
    await registerDevice(persistence, 'ExponentPushToken[a]');
    const notifier = { send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined) } satisfies NotificationPort;
    const push = { send: vi.fn(async () => ({ accepted: 1, rejected: [] })) } as unknown as ExpoPushService;
    const service = new NotificationDeliveryService(persistence, notifier, new ScheduledTenantDirectory(persistence, logger), logger, push);

    const job = await service.enqueue(RELANCE_INPUT);
    const delivered = await service.tryDeliver('co-1', { ...job, notification: job.notification! });

    expect(delivered).toBe(true);
    expect(push.send).toHaveBeenCalledWith([
      expect.objectContaining({
        to: 'ExponentPushToken[a]',
        title: 'Relance F-1',
        data: { route: '/facture/inv-1' },
      }),
    ]);
    expect(logger.audit).toHaveBeenCalledWith(
      'notification.push.sent',
      expect.objectContaining({ companyId: 'co-1', devices: 1, accepted: 1, rejected: 0 }),
    );
  });

  it("email en ÉCHEC : le job passe failed, AUCUN push (on ne notifie pas « Bob a relancé » à tort)", async () => {
    const persistence = new InMemoryPersistence();
    const logger = makeLogger();
    await registerDevice(persistence, 'ExponentPushToken[a]');
    const notifier = { send: vi.fn<NotificationPort['send']>().mockRejectedValue(new Error('brevo down')) } satisfies NotificationPort;
    const push = { send: vi.fn() } as unknown as ExpoPushService;
    const service = new NotificationDeliveryService(persistence, notifier, new ScheduledTenantDirectory(persistence, logger), logger, push);

    const job = await service.enqueue(RELANCE_INPUT);
    const delivered = await service.tryDeliver('co-1', { ...job, notification: job.notification! });

    expect(delivered).toBe(false);
    expect(push.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('brevo down'), 'notifications');
  });

  it('aucun device : envoi email OK, absence de push TRACÉE (jamais silencieuse)', async () => {
    const persistence = new InMemoryPersistence();
    const logger = makeLogger();
    const notifier = { send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined) } satisfies NotificationPort;
    const push = { send: vi.fn() } as unknown as ExpoPushService;
    const service = new NotificationDeliveryService(persistence, notifier, new ScheduledTenantDirectory(persistence, logger), logger, push);

    const job = await service.enqueue(RELANCE_INPUT);
    const delivered = await service.tryDeliver('co-1', { ...job, notification: job.notification! });

    expect(delivered).toBe(true);
    expect(push.send).not.toHaveBeenCalled();
    expect(logger.audit).toHaveBeenCalledWith(
      'notification.push.skipped',
      expect.objectContaining({ companyId: 'co-1', reason: 'no_device_registered' }),
    );
  });

  it('DeviceNotRegistered : le token invalidé est PURGÉ de la table devices', async () => {
    const persistence = new InMemoryPersistence();
    const logger = makeLogger();
    await registerDevice(persistence, 'ExponentPushToken[dead]');
    await registerDevice(persistence, 'ExponentPushToken[alive]');
    const notifier = { send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined) } satisfies NotificationPort;
    const push = {
      send: vi.fn(async () => ({
        accepted: 1,
        rejected: [{ token: 'ExponentPushToken[dead]', error: 'DeviceNotRegistered' }],
      })),
    } as unknown as ExpoPushService;
    const service = new NotificationDeliveryService(persistence, notifier, new ScheduledTenantDirectory(persistence, logger), logger, push);

    const job = await service.enqueue(RELANCE_INPUT);
    await service.tryDeliver('co-1', { ...job, notification: job.notification! });

    const remaining = await persistence.devices.listByCompany('co-1');
    expect(remaining.map((d) => d.expoPushToken)).toEqual(['ExponentPushToken[alive]']);
  });
});

describe('mailer via env — clé absente = échec propre par job, jamais silencieux (C25)', () => {
  it('MisconfiguredEmailNotifier fait échouer le job avec une cause explicite', async () => {
    const persistence = new InMemoryPersistence();
    const logger = makeLogger();
    const service = new NotificationDeliveryService(
      persistence,
      new MisconfiguredEmailNotifier(),
      new ScheduledTenantDirectory(persistence, logger),
      logger,
    );

    const job = await service.enqueue(RELANCE_INPUT);
    const delivered = await service.tryDeliver('co-1', { ...job, notification: job.notification! });

    expect(delivered).toBe(false);
    const due = await persistence.notificationJobs.listRecent('co-1', 10);
    expect(due[0]).toMatchObject({ status: 'failed' });
    expect(due[0]!.lastError).toContain('BREVO_API_KEY');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('BREVO_API_KEY'), 'notifications');
  });

  it('buildNotifier : démo → DemoNotifier assumé ; hors démo sans clé → notifier qui échoue', () => {
    const logger = makeLogger();
    const env = { DEMO_MODE: process.env.DEMO_MODE, BREVO_API_KEY: process.env.BREVO_API_KEY, BREVO_SENDER_EMAIL: process.env.BREVO_SENDER_EMAIL };
    try {
      delete process.env.BREVO_API_KEY;
      delete process.env.BREVO_SENDER_EMAIL;
      process.env.DEMO_MODE = 'true';
      expect(buildNotifier(logger)).toBeInstanceOf(DemoNotifier);
      process.env.DEMO_MODE = 'false';
      expect(buildNotifier(logger)).toBeInstanceOf(MisconfiguredEmailNotifier);
    } finally {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
