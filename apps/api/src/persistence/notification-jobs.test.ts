import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { NotificationPort } from '@bob/core';
import { NotificationDeliveryService } from '../jobs/notification-delivery.service';
import { ScheduledTenantDirectory } from '../jobs/tenant-directory';
import type { AppLogger } from '../observability/logger';
import { InMemoryNotificationJobRepository } from './in-memory';
import {
  NOTIFICATION_PAYLOAD_INTEGRITY_ERROR,
  NOTIFICATION_PAYLOAD_QUARANTINE_AT,
  embargoScheduledPaymentDedupeKey,
  isLegacyNotificationPayloadSealed,
  notificationPayloadFingerprint,
  quoteIdOfEmbargoScheduledPaymentDedupeKey,
  type NotificationJob,
} from './notification-jobs';
import { InMemoryPersistence } from './persistence.testing';

const logger = {
  audit: vi.fn(),
  warn: vi.fn(),
} as unknown as AppLogger;

function jobId(label: string): string {
  const hex = createHash('sha256').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

describe('InMemoryNotificationJobRepository', () => {
  it('ferme toute extension que l’empreinte V1 ne scelle pas', () => {
    const minimal = {
      channel: 'email' as const,
      to: 'client@example.com',
      subject: 'Facture',
      body: 'Bonjour',
    };
    const fingerprint = notificationPayloadFingerprint(minimal);
    expect(isLegacyNotificationPayloadSealed(minimal, fingerprint)).toBe(true);
    expect(isLegacyNotificationPayloadSealed({ ...minimal, senderName: 'Fly Services' }, fingerprint))
      .toBe(false);
    expect(isLegacyNotificationPayloadSealed(minimal, `${fingerprint}-altéré`)).toBe(false);
    expect(isLegacyNotificationPayloadSealed(
      { channel: 'sms', to: '+33600000000', subject: 'Rappel', body: 'Bonjour', idempotencyKey: 42 },
      notificationPayloadFingerprint({
        channel: 'sms',
        to: '+33600000000',
        subject: 'Rappel',
        body: 'Bonjour',
      }),
    )).toBe(false);
  });

  it('enqueue de façon idempotente et liste les jobs dus par tenant', async () => {
    const repo = new InMemoryNotificationJobRepository();
    const notification = { channel: 'email' as const, to: 'client@example.com', subject: 'Devis', body: 'Lien' };

    await repo.enqueue({
      id: jobId('job-1'),
      companyId: 'co-1',
      kind: 'quote-signature',
      dedupeKey: 'quote:q-1:token:h-1',
      notification,
      now: '2026-07-01T10:00:00.000Z',
    });
    await expect(repo.enqueue({
      id: jobId('job-duplicate'),
      companyId: 'co-1',
      kind: 'quote-signature',
      dedupeKey: 'quote:q-1:token:h-1',
      notification: { ...notification, subject: 'Devis relancé' },
      now: '2026-07-01T10:01:00.000Z',
    })).rejects.toThrow('désigne déjà un autre contenu');
    await repo.enqueue({
      id: jobId('job-other-tenant'),
      companyId: 'co-2',
      kind: 'quote-signature',
      dedupeKey: 'quote:q-1:token:h-1',
      notification,
      now: '2026-07-01T10:00:00.000Z',
    });

    const due = await repo.listDue('co-1', '2026-07-01T10:01:00.000Z', 10);
    expect(due).toHaveLength(1);
    expect(due[0]!).toMatchObject({ id: jobId('job-1'), status: 'pending', subject: 'Devis' });
  });

  it('quarantaine les payloads étendus sans affamer le job valide suivant', async () => {
    const repo = new InMemoryNotificationJobRepository();
    const persisted = repo as unknown as { map: Map<string, NotificationJob> };
    for (const [index, label] of ['invalid-a', 'invalid-b', 'valid'].entries()) {
      const id = jobId(label);
      await repo.enqueue({
        id,
        companyId: 'co-1',
        kind: 'invoice-relance',
        dedupeKey: `invoice:inv-${index}:relance:auto:v1:cordial`,
        notification: {
          channel: 'email',
          to: 'client@example.com',
          subject: `Relance ${index}`,
          body: 'Merci.',
        },
        now: `2026-07-01T10:00:0${index}.000Z`,
      });
    }
    for (const label of ['invalid-a', 'invalid-b']) {
      const id = jobId(label);
      const current = persisted.map.get(id);
      if (!current?.notification) throw new Error(`fixture absente: ${id}`);
      persisted.map.set(id, {
        ...current,
        notification: { ...current.notification, senderName: 'Champ non scellé' },
      });
    }

    await expect(repo.listDue('co-1', '2026-07-01T11:00:00.000Z', 1)).resolves.toEqual([
      expect.objectContaining({ id: jobId('valid') }),
    ]);
    await expect(repo.findById('co-1', jobId('invalid-a'))).resolves.toMatchObject({
      status: 'failed',
      notification: null,
      nextAttemptAt: NOTIFICATION_PAYLOAD_QUARANTINE_AT,
      lastError: NOTIFICATION_PAYLOAD_INTEGRITY_ERROR,
    });
  });

  it('quarantaine un payload recomputé qui diverge de l’enveloppe autoritaire', async () => {
    const repo = new InMemoryNotificationJobRepository();
    const persisted = repo as unknown as { map: Map<string, NotificationJob> };
    await repo.enqueue({
      id: jobId('job-authority'),
      companyId: 'co-1',
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-authority:relance:auto:v1:cordial',
      notification: {
        channel: 'email',
        to: 'client@example.com',
        subject: 'Relance',
        body: 'Merci.',
      },
      now: '2026-07-01T10:00:00.000Z',
    });
    const current = persisted.map.get(jobId('job-authority'));
    if (!current?.notification) throw new Error('fixture absente');
    const altered = { ...current.notification, to: 'intrus@example.com' };
    persisted.map.set(current.id, {
      ...current,
      notification: altered,
      payloadFingerprint: notificationPayloadFingerprint(altered),
    });

    await expect(repo.listDue('co-1', '2026-07-01T11:00:00.000Z', 1)).resolves.toEqual([]);
    await expect(repo.findById('co-1', current.id)).resolves.toMatchObject({
      status: 'failed',
      notification: null,
      lastError: NOTIFICATION_PAYLOAD_INTEGRITY_ERROR,
    });
  });

  it('quarantaine un payload NULL avec la même sémantique que Prisma', async () => {
    const repo = new InMemoryNotificationJobRepository();
    const persisted = repo as unknown as { map: Map<string, NotificationJob> };
    await repo.enqueue({
      id: jobId('job-null-payload'),
      companyId: 'co-1',
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-null:relance:auto:v1:cordial',
      notification: {
        channel: 'email',
        to: 'client@example.com',
        subject: 'Relance',
        body: 'Merci.',
      },
      now: '2026-07-01T10:00:00.000Z',
    });
    const current = persisted.map.get(jobId('job-null-payload'));
    if (!current) throw new Error('fixture absente');
    persisted.map.set(current.id, { ...current, notification: null });

    await expect(repo.listDue('co-1', '2026-07-01T11:00:00.000Z', 1)).resolves.toEqual([]);
    await expect(repo.findById('co-1', current.id)).resolves.toMatchObject({
      status: 'failed',
      notification: null,
      nextAttemptAt: NOTIFICATION_PAYLOAD_QUARANTINE_AT,
      lastError: NOTIFICATION_PAYLOAD_INTEGRITY_ERROR,
    });
  });

  it('quarantaine une clé email non-UUID même recalculée et égale à l’identifiant', async () => {
    const repo = new InMemoryNotificationJobRepository();
    const persisted = repo as unknown as { map: Map<string, NotificationJob> };
    const validId = jobId('job-corrupted-provider-key');
    await repo.enqueue({
      id: validId,
      companyId: 'co-1',
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-corrupted-key:relance:auto:v1:cordial',
      notification: {
        channel: 'email',
        to: 'client@example.com',
        subject: 'Relance',
        body: 'Merci.',
      },
      now: '2026-07-01T10:00:00.000Z',
    });
    const current = persisted.map.get(validId);
    if (!current?.notification) throw new Error('fixture absente');
    const corruptedId = 'job-non-uuid';
    const corrupted = { ...current.notification, idempotencyKey: corruptedId };
    persisted.map.delete(validId);
    persisted.map.set(corruptedId, {
      ...current,
      id: corruptedId,
      notification: corrupted,
      payloadFingerprint: notificationPayloadFingerprint(corrupted),
    });

    await expect(repo.listDue('co-1', '2026-07-01T11:00:00.000Z', 1)).resolves.toEqual([]);
    await expect(repo.findById('co-1', corruptedId)).resolves.toMatchObject({
      status: 'failed',
      notification: null,
      lastError: NOTIFICATION_PAYLOAD_INTEGRITY_ERROR,
    });
  });

  it('cancelByDedupeKey : pending -> cancelled, payload purgé, jamais relisté ni réactivé, hors du fil', async () => {
    const repo = new InMemoryNotificationJobRepository();
    const dedupeKey = embargoScheduledPaymentDedupeKey('q-1');
    // Aller-retour de la clé partagée : la garde de livraison retrouve exactement le devis.
    expect(quoteIdOfEmbargoScheduledPaymentDedupeKey(dedupeKey)).toBe('q-1');
    expect(quoteIdOfEmbargoScheduledPaymentDedupeKey('quote:q-1:relance:v1')).toBeNull();
    const notification = {
      channel: 'email' as const,
      to: 'client@example.com',
      subject: 'Règlement possible',
      body: 'Invite de paiement planifiée.',
    };
    const job = await repo.enqueue({
      id: jobId('job-embargo'),
      companyId: 'co-1',
      kind: 'embargo-scheduled-payment',
      dedupeKey,
      notification,
      now: '2026-07-01T10:00:00.000Z',
      notBefore: '2026-07-08T00:00:00.000Z',
    });

    // Mauvais tenant / mauvaise clé : rien n'est annulé (anti-IDOR, fail-closed).
    await expect(
      repo.cancelByDedupeKey('co-2', 'embargo-scheduled-payment', dedupeKey, '2026-07-03T00:00:00.000Z'),
    ).resolves.toBe(false);
    await expect(
      repo.cancelByDedupeKey('co-1', 'embargo-scheduled-payment', dedupeKey, '2026-07-03T00:00:00.000Z'),
    ).resolves.toBe(true);
    // Idempotent : une seconde annulation ne trouve plus rien à annuler.
    await expect(
      repo.cancelByDedupeKey('co-1', 'embargo-scheduled-payment', dedupeKey, '2026-07-03T00:01:00.000Z'),
    ).resolves.toBe(false);

    const after = await repo.findById('co-1', job.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.notification).toBeNull();
    // Plus jamais dû (même après l'échéance), invisible dans le fil et les non-lus.
    await expect(repo.listDue('co-1', '2026-07-09T00:00:00.000Z', 10)).resolves.toHaveLength(0);
    await expect(repo.listRecent('co-1', 10)).resolves.toHaveLength(0);
    const unread = await repo.previewUnread('co-1', '2026-07-09T00:00:00.000Z');
    expect(unread.unreadCount).toBe(0);
    // Un ré-enqueue ne RESSUSCITE jamais une intention révoquée (parité Prisma).
    const reenqueued = await repo.enqueue({
      id: jobId('job-embargo-retry'),
      companyId: 'co-1',
      kind: 'embargo-scheduled-payment',
      dedupeKey,
      notification,
      now: '2026-07-10T00:00:00.000Z',
    });
    expect(reenqueued.id).toBe(job.id);
    expect(reenqueued.status).toBe('cancelled');
    await expect(repo.listDue('co-1', '2026-07-11T00:00:00.000Z', 10)).resolves.toHaveLength(0);
  });

  it('retrouve un job par id uniquement dans son tenant', async () => {
    const repo = new InMemoryNotificationJobRepository();
    await repo.enqueue({
      id: jobId('job-contextuel'),
      companyId: 'co-1',
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-contextuelle:relance:auto:v1:cordial',
      notification: {
        channel: 'email',
        to: 'client@example.com',
        subject: 'Relance F-2026-0042',
        body: 'La facture reste due.',
      },
      now: '2026-07-01T10:00:00.000Z',
    });

    await expect(repo.findById('co-1', jobId('job-contextuel'))).resolves.toMatchObject({
      id: jobId('job-contextuel'),
      companyId: 'co-1',
      subject: 'Relance F-2026-0042',
      notification: { body: 'La facture reste due.' },
    });
    await expect(repo.findById('co-2', jobId('job-contextuel'))).resolves.toBeNull();
    await expect(repo.findById('co-1', jobId('job-absent'))).resolves.toBeNull();
  });

  it('fige plus de 50 non-lues au cutoff, exclut le futur et rejoue sans effet', async () => {
    const repo = new InMemoryNotificationJobRepository();
    const cutoff = '2026-07-01T12:00:00.000Z';
    for (let index = 0; index < 75; index += 1) {
      await repo.enqueue({
        id: jobId(`job-batch-${index}`),
        companyId: 'co-1',
        kind: 'invoice-relance',
        dedupeKey: `invoice:inv-batch-${index}:relance:manual:2026-07-01`,
        notification: {
          channel: 'email',
          to: 'client@example.com',
          subject: `Relance ${index}`,
          body: 'Merci.',
        },
        now: `2026-07-01T11:${String(index % 60).padStart(2, '0')}:00.000Z`,
      });
    }
    await repo.markRead(jobId('job-batch-0'), 'co-1', '2026-07-01T11:30:00.000Z');

    await expect(repo.previewUnread('co-1', cutoff)).resolves.toEqual({
      unreadCount: 74,
      throughCreatedAt: cutoff,
    });
    // Ces lignes arrivent APRÈS l'aperçu. Même celle qui partage exactement son milliseconde
    // reste hors de la portée, car le cutoff est une borne exclusive.
    await repo.enqueue({
      id: jobId('job-at-cutoff'),
      companyId: 'co-1',
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-at:relance:manual:2026-07-01',
      notification: { channel: 'email', to: 'client@example.com', subject: 'Au cutoff', body: 'Après.' },
      now: cutoff,
    });
    await repo.enqueue({
      id: jobId('job-after-cutoff'),
      companyId: 'co-1',
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-after:relance:manual:2026-07-01',
      notification: { channel: 'email', to: 'client@example.com', subject: 'Après', body: 'Après.' },
      now: '2026-07-01T12:00:00.001Z',
    });
    await repo.enqueue({
      id: jobId('job-other-company'),
      companyId: 'co-2',
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-other:relance:manual:2026-07-01',
      notification: { channel: 'email', to: 'other@example.com', subject: 'Autre', body: 'Autre.' },
      now: '2026-07-01T11:00:00.000Z',
    });

    await expect(repo.markReadThrough('co-1', cutoff, '2026-07-01T12:01:00.000Z')).resolves.toEqual({
      updatedCount: 74,
      readAt: '2026-07-01T12:01:00.000Z',
      cutoffAccepted: true,
    });
    await expect(repo.markReadThrough('co-1', cutoff, '2026-07-01T12:02:00.000Z')).resolves.toEqual({
      updatedCount: 0,
      readAt: '2026-07-01T12:02:00.000Z',
      cutoffAccepted: true,
    });
    await expect(repo.previewUnread('co-1', cutoff)).resolves.toEqual({
      unreadCount: 0,
      throughCreatedAt: cutoff,
    });
    await expect(repo.findById('co-1', jobId('job-at-cutoff'))).resolves.toMatchObject({ readAt: null });
    await expect(repo.findById('co-1', jobId('job-after-cutoff'))).resolves.toMatchObject({ readAt: null });
    await expect(repo.findById('co-2', jobId('job-other-company'))).resolves.toMatchObject({ readAt: null });
  });

  it('préserve le premier readAt lors de deux lectures individuelles concurrentes', async () => {
    const repo = new InMemoryNotificationJobRepository();
    await repo.enqueue({
      id: jobId('job-concurrent-read'),
      companyId: 'co-1',
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-concurrent:relance:manual:2026-07-01',
      notification: { channel: 'email', to: 'client@example.com', subject: 'Relance', body: 'Merci.' },
      now: '2026-07-01T10:00:00.000Z',
    });

    const [first, second] = await Promise.all([
      repo.markRead(jobId('job-concurrent-read'), 'co-1', '2026-07-01T10:01:00.000Z'),
      repo.markRead(jobId('job-concurrent-read'), 'co-1', '2026-07-01T10:02:00.000Z'),
    ]);

    expect(first?.readAt).toBe('2026-07-01T10:01:00.000Z');
    expect(second?.readAt).toBe('2026-07-01T10:01:00.000Z');
  });

  it('un ré-enqueue immuable ne réactive pas une notification déjà lue après le snapshot', async () => {
    const repo = new InMemoryNotificationJobRepository();
    const input = {
      id: jobId('job-read-reenqueue'),
      companyId: 'co-1',
      kind: 'invoice-relance' as const,
      dedupeKey: 'invoice:inv-read:relance:manual:2026-07-01',
      notification: { channel: 'email' as const, to: 'client@example.com', subject: 'Relance', body: 'Merci.' },
      now: '2026-07-01T10:00:00.000Z',
    };
    await repo.enqueue(input);
    await repo.markRead(input.id, input.companyId, '2026-07-01T10:01:00.000Z');
    const preview = await repo.previewUnread(input.companyId, '2026-07-01T10:02:00.000Z');

    await repo.enqueue({ ...input, id: jobId('unused-new-id'), now: '2026-07-01T10:03:00.000Z' });

    await expect(repo.findById(input.companyId, input.id)).resolves.toMatchObject({
      readAt: '2026-07-01T10:01:00.000Z',
    });
    await expect(
      repo.markReadThrough(input.companyId, preview.throughCreatedAt, '2026-07-01T10:04:00.000Z'),
    ).resolves.toMatchObject({ updatedCount: 0 });
  });

  it('efface le payload après livraison réussie', async () => {
    const repo = new InMemoryNotificationJobRepository();
    const input = {
      id: jobId('job-1'),
      companyId: 'co-1',
      kind: 'quote-signature' as const,
      dedupeKey: 'quote:q-1:token:h-1',
      notification: { channel: 'email' as const, to: 'client@example.com', subject: 'Devis', body: 'Lien secret' },
      now: '2026-07-01T10:00:00.000Z',
    };
    await repo.enqueue(input);
    const lease = '2026-07-01T10:05:00.000Z';
    const token = 'lease-token-1';
    expect(await repo.claimForDelivery(jobId('job-1'), 'co-1', input.now, input.now, lease, token)).toMatchObject({
      outcome: 'claimed',
    });
    expect(await repo.markDone(jobId('job-1'), 'co-1', token, '2026-07-01T10:00:05.000Z')).toBe(true);
    expect(await repo.markDone(jobId('job-1'), 'co-1', token, '2026-07-01T10:00:06.000Z')).toBe(false);

    expect(await repo.listDue('co-1', '2026-07-01T11:00:00.000Z', 10)).toHaveLength(0);
    const replay = await repo.enqueue({ ...input, id: jobId('job-replay'), now: '2026-07-01T11:00:00.000Z' });
    expect(replay).toMatchObject({ id: jobId('job-1'), status: 'done', notification: null });
  });

  it('accorde un lease à un seul worker puis rend le job récupérable à expiration', async () => {
    const repo = new InMemoryNotificationJobRepository();
    await repo.enqueue({
      id: jobId('job-lease'),
      companyId: 'co-1',
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-1:relance:auto:v1:cordial',
      notification: { channel: 'email', to: 'client@example.com', subject: 'Relance', body: 'Merci.' },
      now: '2026-07-01T10:00:00.000Z',
    });

    expect(
      await repo.claimForDelivery(
        jobId('job-lease'),
        'co-1',
        '2026-07-01T10:00:00.000Z',
        '2026-07-01T10:00:00.000Z',
        '2026-07-01T10:05:00.000Z',
        'lease-token-1',
      ),
    ).toMatchObject({ outcome: 'claimed' });
    expect(
      await repo.claimForDelivery(
        jobId('job-lease'),
        'co-1',
        '2026-07-01T10:00:00.000Z',
        '2026-07-01T10:00:01.000Z',
        '2026-07-01T10:05:01.000Z',
        'lease-token-other',
      ),
    ).toEqual({ outcome: 'skipped' });
    expect(await repo.listDue('co-1', '2026-07-01T10:04:59.000Z', 10)).toHaveLength(0);
    const nextLease = '2026-07-01T10:10:00.000Z';
    expect(
      await repo.claimForDelivery(
        jobId('job-lease'),
        'co-1',
        '2026-07-01T10:00:00.000Z',
        '2026-07-01T10:05:00.000Z',
        nextLease,
        'lease-token-2',
      ),
    ).toMatchObject({ outcome: 'claimed' });
    expect(await repo.markDone(jobId('job-lease'), 'co-1', 'lease-token-1', '2026-07-01T10:05:01.000Z')).toBe(
      false,
    );
    await repo.markFailed(
      jobId('job-lease'),
      'co-1',
      'lease-token-1',
      '2026-07-01T10:05:01.000Z',
      60_000,
      'ancien worker',
    );
    expect(await repo.markDone(jobId('job-lease'), 'co-1', 'lease-token-2', '2026-07-01T10:05:02.000Z')).toBe(true);
  });

  it('refuse une collision de dedupeKey et ne raccourcit pas un lease actif', async () => {
    const repo = new InMemoryNotificationJobRepository();
    const base = {
      id: jobId('job-lease'),
      companyId: 'co-1',
      kind: 'invoice-relance' as const,
      dedupeKey: 'invoice:inv-1:relance:auto:v1:cordial',
      notification: { channel: 'email' as const, to: 'client@example.com', subject: 'Initial', body: 'A' },
      now: '2026-07-01T10:00:00.000Z',
    };
    await repo.enqueue(base);
    const lease = '2026-07-01T10:05:00.000Z';
    const token = 'lease-token-active';
    expect(await repo.claimForDelivery(base.id, base.companyId, base.now, base.now, lease, token)).toMatchObject({
      outcome: 'claimed',
    });

    await expect(repo.enqueue({
      ...base,
      id: jobId('job-new-id'),
      notification: { ...base.notification, subject: 'Ne doit pas remplacer' },
      now: '2026-07-01T10:01:00.000Z',
    })).rejects.toThrow('désigne déjà un autre contenu');
    const reenqueued = await repo.enqueue({ ...base, id: jobId('job-new-id'), now: '2026-07-01T10:01:00.000Z' });

    expect(reenqueued).toMatchObject({ id: base.id, subject: 'Initial', nextAttemptAt: lease });
    expect(
      await repo.claimForDelivery(
        base.id,
        base.companyId,
        base.now,
        '2026-07-01T10:01:01.000Z',
        '2026-07-01T10:06:01.000Z',
        'lease-token-other',
      ),
    ).toEqual({ outcome: 'skipped' });
    expect(await repo.markDone(base.id, base.companyId, token, '2026-07-01T10:02:00.000Z')).toBe(true);
  });

  it('à l’instant exact d’expiration, le successeur fence l’ancien worker sans muter le payload', async () => {
    const repo = new InMemoryNotificationJobRepository();
    const base = {
      id: jobId('job-expiry'),
      companyId: 'co-1',
      kind: 'invoice-relance' as const,
      dedupeKey: 'invoice:inv-expiry:relance:auto:v1:cordial',
      notification: { channel: 'email' as const, to: 'client@example.com', subject: 'A', body: 'A' },
      now: '2026-07-01T10:00:00.000Z',
    };
    await repo.enqueue(base);
    const expiresAt = '2026-07-01T10:05:00.000Z';
    expect(
      await repo.claimForDelivery(base.id, base.companyId, base.now, base.now, expiresAt, 'generation-A'),
    ).toMatchObject({ outcome: 'claimed' });

    expect(
      await repo.claimForDelivery(
        base.id,
        base.companyId,
        base.now,
        expiresAt,
        '2026-07-01T10:10:00.000Z',
        'generation-B',
      ),
    ).toMatchObject({ outcome: 'claimed', job: { subject: 'A', leaseToken: 'generation-B' } });
    expect(await repo.markDone(base.id, base.companyId, 'generation-A', expiresAt)).toBe(false);
  });

  it('quarantaine un résultat provider incertain hors TTL et ne le reliste plus', async () => {
    const repo = new InMemoryNotificationJobRepository();
    const base = {
      id: jobId('job-uncertain'),
      companyId: 'co-1',
      kind: 'invoice-relance' as const,
      dedupeKey: 'invoice:inv-uncertain:relance:auto:v1:cordial',
      notification: { channel: 'email' as const, to: 'client@example.com', subject: 'A', body: 'A' },
      now: '2026-07-01T10:00:00.000Z',
    };
    await repo.enqueue(base);
    expect(
      await repo.claimForDelivery(
        base.id,
        base.companyId,
        base.now,
        base.now,
        '2026-07-01T10:05:00.000Z',
        'generation-A',
      ),
    ).toMatchObject({ outcome: 'claimed' });

    expect(
      await repo.claimForDelivery(
        base.id,
        base.companyId,
        base.now,
        '2026-07-01T10:26:00.000Z',
        '2026-07-01T10:31:00.000Z',
        'generation-B',
      ),
    ).toEqual({ outcome: 'quarantined', reason: 'provider-window-expired' });
    expect(await repo.listDue(base.companyId, '9999-01-01T00:00:00.000Z', 10)).toHaveLength(0);
    expect(await repo.listRecent(base.companyId, 1)).toEqual([
      expect.objectContaining({
        status: 'failed',
        leaseToken: null,
        lastError: expect.stringContaining('manual-review:provider-outcome-uncertain'),
      }),
    ]);
  });
});

describe('NotificationDeliveryService', () => {
  it('garde le même UUID provider et refuse un payload différent sous la même dedupeKey', async () => {
    const persistence = new InMemoryPersistence();
    const notifier = { send: vi.fn<NotificationPort['send']>() } satisfies NotificationPort;
    const service = new NotificationDeliveryService(
      persistence,
      notifier,
      new ScheduledTenantDirectory(persistence, logger),
      logger,
    );
    const input = {
      companyId: 'co-1',
      kind: 'invoice-relance' as const,
      dedupeKey: 'invoice:inv-1:relance:auto:v1:cordial',
      notification: { channel: 'email' as const, to: 'client@example.com', subject: 'Relance', body: 'Merci.' },
    };

    const first = await service.enqueue(input);
    await expect(service.enqueue({
      ...input,
      notification: { ...input.notification, subject: 'Relance mise à jour' },
    })).rejects.toThrow('désigne déjà un autre contenu');
    const second = await service.enqueue(input);

    expect(second.id).toBe(first.id);
    expect(second.notification?.idempotencyKey).toBe(first.notification?.idempotencyKey);
    expect(second.notification?.idempotencyKey).toBe(first.id);
    expect(second.notification?.subject).toBe('Relance');
  });

  it('marque failed puis retry avant de passer done', async () => {
    const persistence = new InMemoryPersistence();
    const notifier = {
      send: vi.fn<NotificationPort['send']>().mockRejectedValueOnce(new Error('brevo down')).mockResolvedValueOnce(undefined),
    } satisfies NotificationPort;
    const service = new NotificationDeliveryService(persistence, notifier, new ScheduledTenantDirectory(persistence, logger), logger);

    const job = await service.enqueue({
      companyId: 'co-1',
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-1:relance:2026-07-01',
      notification: { channel: 'email', to: 'client@example.com', subject: 'Relance', body: 'Merci de régler.' },
    });
    expect(job.notification).not.toBeNull();

    const first = await service.tryDeliver('co-1', { ...job, notification: job.notification! });
    expect(first).toBe('failed');
    expect(notifier.send).toHaveBeenCalledTimes(1);

    const due = await persistence.notificationJobs.listDue('co-1', '2030-01-01T00:00:00.000Z', 10);
    expect(due).toHaveLength(1);
    expect(due[0]!).toMatchObject({ status: 'failed', attempts: 1, lastError: 'brevo down' });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(due[0]!.nextAttemptAt));
      const second = await service.tryDeliver('co-1', due[0]!);
      expect(second).toBe('sent');
      expect(notifier.send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    expect(await persistence.notificationJobs.listDue('co-1', '2030-01-01T00:00:00.000Z', 10)).toHaveLength(0);
  });
});
