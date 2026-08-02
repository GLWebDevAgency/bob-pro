import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationPort } from '@bob/core';
import { NotificationDeliveryService } from './notification-delivery.service';
import { ScheduledTenantDirectory } from './tenant-directory';
import type { AppLogger } from '../observability/logger';
import { InMemoryPersistence } from '../persistence/persistence.testing';
import { MisconfiguredEmailNotifier, buildNotifier } from '../notifications/notifier';
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

async function registerDevice(
  persistence: InMemoryPersistence,
  token: string,
  registeredAt?: string,
): Promise<void> {
  const installationId = randomUUID();
  await persistence.devices.register({
    id: `dev-${token}`,
    companyId: 'co-1',
    userId: 'demo',
    expoPushToken: token,
    platform: 'ios',
    installationId,
    bindingId: randomUUID(),
    bindingGeneration: 1,
    revocationSecretHash: 'a'.repeat(64),
    // UNE MINUTE AVANT LE PRÉSENT DU TEST — jamais un littéral qui vieillit : le service compare
    // ce `now` au VRAI clock (SystemClock interne) contre PUSH_BINDING_TTL_MS = 30 j. L'ancien
    // littéral '2026-07-03T10:00:00.000Z' a expiré le 2026-08-02 à 10:00 UTC et a fait détoner
    // 4 tests d'un coup (aucun appareil éligible, push jamais envoyé). Sous vi.useFakeTimers,
    // Date.now() est le présent GELÉ du test : les deux régimes restent valides.
    now: registeredAt ?? new Date(Date.now() - 60_000).toISOString(),
  });
}

describe('NotificationDeliveryService — canal push Expo (C25)', () => {
  it("MIROIR de l'envoi réussi : payload générique vers l'inbox, sans contenu ni identifiant métier", async () => {
    const persistence = new InMemoryPersistence();
    const logger = makeLogger();
    await registerDevice(persistence, 'ExponentPushToken[a]');
    const notifier = { send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined) } satisfies NotificationPort;
    const sendPush = vi.fn(async (_messages: readonly unknown[]) => ({ accepted: 1, rejected: [] }));
    const push = { send: sendPush } as unknown as ExpoPushService;
    const service = new NotificationDeliveryService(persistence, notifier, new ScheduledTenantDirectory(persistence, logger), logger, push);

    const confidentialInvoiceId = 'inv-confidential-4711';
    const confidentialClientId = 'client-confidential-8128';
    const confidentialSubject = `Relance facture ${confidentialInvoiceId}`;
    const confidentialBody = `Le client ${confidentialClientId} doit régler 1 240 €.`;
    const job = await service.enqueue({
      ...RELANCE_INPUT,
      dedupeKey: `invoice:${confidentialInvoiceId}:relance:2026-07-03`,
      notification: {
        ...RELANCE_INPUT.notification,
        subject: confidentialSubject,
        body: confidentialBody,
      },
    });
    expect(job.notification?.idempotencyKey).toBe(job.id);
    const delivered = await service.tryDeliver('co-1', { ...job, notification: job.notification! });

    expect(delivered).toBe('sent');
    expect(sendPush.mock.calls[0]?.[0]).toEqual([
      {
        to: 'ExponentPushToken[a]',
        title: 'Nouvelle notification',
        body: 'Ouvrez l’application pour consulter le détail.',
        data: {
          pushContract: '2',
          route: '/notifications',
          recipientBindingId: expect.any(String),
          recipientBindingGeneration: '1',
        },
      },
    ]);
    const serializedPush = JSON.stringify(sendPush.mock.calls[0]?.[0]);
    expect(serializedPush).not.toContain(confidentialInvoiceId);
    expect(serializedPush).not.toContain(confidentialClientId);
    expect(serializedPush).not.toContain(confidentialSubject);
    expect(serializedPush).not.toContain(confidentialBody);
    expect(serializedPush).not.toContain('/facture');
    expect(serializedPush).not.toContain('1 240');
    expect(logger.audit).toHaveBeenCalledWith(
      'notification.push.sent',
      expect.objectContaining({ companyId: 'co-1', devices: 1, accepted: 1, rejected: 0 }),
    );
  });

  it('rejoue la même clé provider si le worker tombe après envoi mais avant markDone', async () => {
    const persistence = new InMemoryPersistence();
    const logger = makeLogger();
    const seenKeys: (string | undefined)[] = [];
    const notifier = {
      send: vi.fn<NotificationPort['send']>(async (notification) => {
        seenKeys.push(notification.idempotencyKey);
      }),
    } satisfies NotificationPort;
    const service = new NotificationDeliveryService(
      persistence,
      notifier,
      new ScheduledTenantDirectory(persistence, logger),
      logger,
    );
    const job = await service.enqueue(RELANCE_INPUT);
    const markDone = vi.spyOn(persistence.notificationJobs, 'markDone');
    markDone.mockRejectedValueOnce(new Error('crash after provider acceptance'));

    expect(await service.tryDeliver('co-1', { ...job, notification: job.notification! })).toBe('failed');
    const reenqueued = await service.enqueue(RELANCE_INPUT);
    expect(reenqueued.id).toBe(job.id);
    expect(reenqueued.notification?.idempotencyKey).toBe(job.id);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(reenqueued.nextAttemptAt));
      expect(await service.tryDeliver('co-1', { ...reenqueued, notification: reenqueued.notification! })).toBe('sent');
    } finally {
      vi.useRealTimers();
    }
    expect(seenKeys).toEqual([job.id, job.id]);
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/i);
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

    expect(delivered).toBe('failed');
    expect(push.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('brevo down'), 'notifications');
  });

  it("push en échec après commit : l'email reste done et n'est jamais remis en retry", async () => {
    const persistence = new InMemoryPersistence();
    const logger = makeLogger();
    await registerDevice(persistence, 'ExponentPushToken[a]');
    const notifier = {
      send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined),
    } satisfies NotificationPort;
    const push = { send: vi.fn().mockRejectedValue(new Error('expo down')) } as unknown as ExpoPushService;
    const service = new NotificationDeliveryService(
      persistence,
      notifier,
      new ScheduledTenantDirectory(persistence, logger),
      logger,
      push,
    );

    const job = await service.enqueue(RELANCE_INPUT);
    const delivered = await service.tryDeliver('co-1', { ...job, notification: job.notification! });

    expect(delivered).toBe('sent');
    expect(notifier.send).toHaveBeenCalledOnce();
    expect((await persistence.notificationJobs.listRecent('co-1', 1))[0]).toMatchObject({ status: 'done' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('expo down'), 'notifications');
  });

  it('aucun device : envoi email OK, absence de push TRACÉE (jamais silencieuse)', async () => {
    const persistence = new InMemoryPersistence();
    const logger = makeLogger();
    const notifier = { send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined) } satisfies NotificationPort;
    const push = { send: vi.fn() } as unknown as ExpoPushService;
    const service = new NotificationDeliveryService(persistence, notifier, new ScheduledTenantDirectory(persistence, logger), logger, push);

    const job = await service.enqueue(RELANCE_INPUT);
    const delivered = await service.tryDeliver('co-1', { ...job, notification: job.notification! });

    expect(delivered).toBe('sent');
    expect(push.send).not.toHaveBeenCalled();
    expect(logger.audit).toHaveBeenCalledWith(
      'notification.push.skipped',
      expect.objectContaining({ companyId: 'co-1', reason: 'no_device_registered' }),
    );
  });

  it('deux workers sur le même job : un seul obtient le lease, un seul email et un seul push', async () => {
    const persistence = new InMemoryPersistence();
    const logger = makeLogger();
    await registerDevice(persistence, 'ExponentPushToken[a]');
    const notifier = {
      send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined),
    } satisfies NotificationPort;
    const push = { send: vi.fn(async () => ({ accepted: 1, rejected: [] })) } as unknown as ExpoPushService;
    const service = new NotificationDeliveryService(
      persistence,
      notifier,
      new ScheduledTenantDirectory(persistence, logger),
      logger,
      push,
    );
    const job = await service.enqueue(RELANCE_INPUT);

    expect(await service.tryDeliver('co-1', { ...job, notification: job.notification! })).toBe('sent');
    expect(await service.tryDeliver('co-1', { ...job, notification: job.notification! })).toBe('skipped');
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(push.send).toHaveBeenCalledTimes(1);
  });

  it('snapshot A puis collision B : B est refusé et seule la requête A peut partir', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
      const persistence = new InMemoryPersistence();
      const logger = makeLogger();
      const notifier = { send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined) } satisfies NotificationPort;
      const service = new NotificationDeliveryService(
        persistence,
        notifier,
        new ScheduledTenantDirectory(persistence, logger),
        logger,
      );
      const first = await service.enqueue(RELANCE_INPUT);

      vi.setSystemTime(new Date('2026-07-13T10:01:00.000Z'));
      await expect(service.enqueue({
        ...RELANCE_INPUT,
        notification: { ...RELANCE_INPUT.notification, subject: 'Payload B' },
      })).rejects.toThrow('désigne déjà un autre contenu');

      expect(await service.tryDeliver('co-1', { ...first, notification: first.notification! })).toBe('sent');
      expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Relance F-1' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('deux payloads dans la même milliseconde : la collision est refusée sans ambiguïté ABA', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
      const persistence = new InMemoryPersistence();
      const logger = makeLogger();
      const notifier = { send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined) } satisfies NotificationPort;
      const service = new NotificationDeliveryService(
        persistence,
        notifier,
        new ScheduledTenantDirectory(persistence, logger),
        logger,
      );
      const snapshotA = await service.enqueue(RELANCE_INPUT);
      await expect(service.enqueue({
        ...RELANCE_INPUT,
        notification: { ...RELANCE_INPUT.notification, subject: 'Payload B même milliseconde' },
      })).rejects.toThrow('désigne déjà un autre contenu');

      expect(await service.tryDeliver('co-1', { ...snapshotA, notification: snapshotA.notification! })).toBe('sent');
      expect(notifier.send).toHaveBeenCalledOnce();
      expect(notifier.send).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Relance F-1' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('lease orphelin hors TTL provider : quarantaine sans second email ni push', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
      const persistence = new InMemoryPersistence();
      const logger = makeLogger();
      const notifier = { send: vi.fn<NotificationPort['send']>() } satisfies NotificationPort;
      const push = { send: vi.fn() } as unknown as ExpoPushService;
      const service = new NotificationDeliveryService(
        persistence,
        notifier,
        new ScheduledTenantDirectory(persistence, logger),
        logger,
        push,
      );
      const job = await service.enqueue(RELANCE_INPUT);
      const orphan = await persistence.notificationJobs.claimForDelivery(
        job.id,
        job.companyId,
        job.updatedAt,
        '2026-07-13T10:00:00.000Z',
        '2026-07-13T10:05:00.000Z',
        'orphan-generation',
      );
      expect(orphan).toMatchObject({ outcome: 'claimed' });
      if (orphan.outcome !== 'claimed') throw new Error('fixture lease non claimée');

      vi.setSystemTime(new Date('2026-07-13T10:26:00.000Z'));
      expect(await service.tryDeliver(job.companyId, orphan.job)).toBe('failed');
      expect(notifier.send).not.toHaveBeenCalled();
      expect(push.send).not.toHaveBeenCalled();
      expect((await persistence.notificationJobs.listRecent(job.companyId, 1))[0]).toMatchObject({
        status: 'failed',
        nextAttemptAt: '9999-12-31T23:59:59.999Z',
        lastError: expect.stringContaining('manual-review:provider-outcome-uncertain'),
      });
      expect(logger.audit).toHaveBeenCalledWith(
        'notification.job.quarantined',
        expect.objectContaining({ jobId: job.id }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('cinq timeouts puis reprise à T+31 : quarantaine, jamais de sixième email hors TTL', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
      const persistence = new InMemoryPersistence();
      const logger = makeLogger();
      const notifier = {
        send: vi.fn<NotificationPort['send']>().mockRejectedValue(new Error('timeout outcome unknown')),
      } satisfies NotificationPort;
      const service = new NotificationDeliveryService(
        persistence,
        notifier,
        new ScheduledTenantDirectory(persistence, logger),
        logger,
      );
      const initial = await service.enqueue(RELANCE_INPUT);
      let current = { ...initial, notification: initial.notification! };

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(await service.tryDeliver(initial.companyId, current)).toBe('failed');
        const stored = (await persistence.notificationJobs.listRecent(initial.companyId, 1))[0]!;
        vi.setSystemTime(new Date(stored.nextAttemptAt));
        const due = await persistence.notificationJobs.listDue(initial.companyId, stored.nextAttemptAt, 1);
        expect(due).toHaveLength(1);
        current = due[0]!;
      }

      expect(await service.tryDeliver(initial.companyId, current)).toBe('failed');
      expect(notifier.send).toHaveBeenCalledTimes(5);
      expect((await persistence.notificationJobs.listRecent(initial.companyId, 1))[0]).toMatchObject({
        nextAttemptAt: '9999-12-31T23:59:59.999Z',
        lastError: expect.stringContaining('manual-review:provider-outcome-uncertain'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuse un job présenté sous le mauvais tenant avant tout appel fournisseur', async () => {
    const persistence = new InMemoryPersistence();
    const logger = makeLogger();
    const notifier = { send: vi.fn<NotificationPort['send']>() } satisfies NotificationPort;
    const service = new NotificationDeliveryService(
      persistence,
      notifier,
      new ScheduledTenantDirectory(persistence, logger),
      logger,
    );
    const job = await service.enqueue(RELANCE_INPUT);

    expect(await service.tryDeliver('co-2', { ...job, notification: job.notification! })).toBe('skipped');
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("fail-closed si le fence DB pré-provider est indisponible, sans interrompre par exception", async () => {
    const persistence = new InMemoryPersistence();
    const logger = makeLogger();
    const notifier = { send: vi.fn<NotificationPort['send']>() } satisfies NotificationPort;
    const service = new NotificationDeliveryService(
      persistence,
      notifier,
      new ScheduledTenantDirectory(persistence, logger),
      logger,
    );
    const job = await service.enqueue(RELANCE_INPUT);
    vi.spyOn(persistence.notificationJobs, 'authorizeDeliveryAttempt')
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(service.tryDeliver('co-1', { ...job, notification: job.notification! }))
      .resolves.toBe('failed');
    expect(notifier.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Autorisation notification impossible'),
      'notifications',
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

    const remaining = await persistence.devices.listDeliveryTargetsByCompany(
      'co-1',
      '1970-01-01T00:00:00.000Z',
    );
    expect(remaining.map((d) => d.expoPushToken)).toEqual(['ExponentPushToken[alive]']);
  });

  it('exclut fail-closed un binding v2 non réconcilié depuis plus de 30 jours', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-03T10:00:00.001Z'));
      const persistence = new InMemoryPersistence();
      const logger = makeLogger();
      // Enregistré le 03/07 10:00, présent gelé le 03/08 10:00:00.001 : 31 j + 1 ms — le seuil
      // des 30 j (cutoff = présent − PUSH_BINDING_TTL_MS = 04/07 10:00:00.001) est dépassé.
      // Les DEUX littéraux vivent côte à côte : ce test est le seul à vouloir un appareil périmé.
      await registerDevice(persistence, 'ExponentPushToken[stale]', '2026-07-03T10:00:00.000Z');
      const notifier = { send: vi.fn<NotificationPort['send']>().mockResolvedValue(undefined) } satisfies NotificationPort;
      const push = { send: vi.fn() } as unknown as ExpoPushService;
      const service = new NotificationDeliveryService(
        persistence,
        notifier,
        new ScheduledTenantDirectory(persistence, logger),
        logger,
        push,
      );

      const job = await service.enqueue(RELANCE_INPUT);
      await service.tryDeliver('co-1', { ...job, notification: job.notification! });

      expect(push.send).not.toHaveBeenCalled();
      expect(logger.audit).toHaveBeenCalledWith(
        'notification.push.skipped',
        expect.objectContaining({ reason: 'no_device_registered' }),
      );
    } finally {
      vi.useRealTimers();
    }
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

    expect(delivered).toBe('failed');
    const due = await persistence.notificationJobs.listRecent('co-1', 10);
    expect(due[0]).toMatchObject({ status: 'failed' });
    expect(due[0]!.lastError).toContain('BREVO_API_KEY');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('BREVO_API_KEY'), 'notifications');
  });

  it('buildNotifier : aucune clé → notifier qui échoue, y compris avec DEMO_MODE', () => {
    const logger = makeLogger();
    const env = { DEMO_MODE: process.env.DEMO_MODE, BREVO_API_KEY: process.env.BREVO_API_KEY, BREVO_SENDER_EMAIL: process.env.BREVO_SENDER_EMAIL };
    try {
      delete process.env.BREVO_API_KEY;
      delete process.env.BREVO_SENDER_EMAIL;
      process.env.DEMO_MODE = 'true';
      expect(buildNotifier(logger)).toBeInstanceOf(MisconfiguredEmailNotifier);
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
