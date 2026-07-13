import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { SystemClock, appNotFound, ok, type AppError, type Result } from '@bob/core';
import { PERSISTENCE, type Persistence } from '../persistence/persistence';
import { type NotificationJob } from '../persistence/notification-jobs';
import { getPrincipal, requireTenant } from '../observability/logger';
import { notificationRoute } from './notification-route';

/**
 * Surface HTTP du fil de notifications (C25) — le mobile lit ce que les JOBS produisent
 * (notification_jobs = source de vérité, company-scoped par le Principal + RLS), marque lu,
 * et enregistre ses appareils push Expo. Service volontairement séparé de BackendService
 * (éditions minimales — chantier OCR parallèle).
 */

export interface NotificationItemDto {
  id: string;
  kind: NotificationJob['kind'];
  /** Sujet du message (seul contenu conservé après livraison — le payload est purgé). */
  title: string;
  /** Corps disponible tant que le job n'est pas livré (purgé ensuite, hygiène PII). */
  body: string | null;
  channel: string;
  status: NotificationJob['status'];
  /** Deep link mobile (ex. /facture/inv-1) — dérivé de la clé de dédup métier. */
  route: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface RegisterDeviceDto {
  id: string;
  expoPushToken: string;
  platform: string | null;
}

export interface NotificationUnreadPreviewDto {
  unreadCount: number;
  /** Cutoff serveur à rejouer tel quel dans POST /notifications/read-through. */
  throughCreatedAt: string;
}

export interface NotificationReadThroughDto {
  updatedCount: number;
  readAt: string;
}

const MAX_FEED_LIMIT = 100;
const DEFAULT_FEED_LIMIT = 50;
/** Format des tokens Expo (ExponentPushToken[...] / ExpoPushToken[...]) — refusé sinon. */
const EXPO_TOKEN_PATTERN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,64}\]$/;
const PLATFORMS = new Set(['ios', 'android', 'web']);

function invalidCutoff(message: string): Result<never, AppError> {
  return {
    ok: false,
    error: { kind: 'validation', issues: [{ field: 'throughCreatedAt', message }] },
  };
}

function toItem(job: NotificationJob): NotificationItemDto {
  return {
    id: job.id,
    kind: job.kind,
    title: job.subject,
    body: job.notification?.body ?? null,
    channel: job.channel,
    status: job.status,
    route: notificationRoute(job),
    readAt: job.readAt,
    createdAt: job.createdAt,
  };
}

@Injectable()
export class NotificationsApiService {
  private readonly clock = new SystemClock();

  constructor(@Inject(PERSISTENCE) private readonly p: Persistence) {}

  /** Tenant courant — même règle que BackendService (C24b : tenant OBLIGATOIRE, zéro repli démo). */
  private companyId(): string {
    return requireTenant();
  }

  async list(limitRaw?: string): Promise<Result<NotificationItemDto[], AppError>> {
    const parsed = Number(limitRaw);
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), MAX_FEED_LIMIT) : DEFAULT_FEED_LIMIT;
    const jobs = await this.p.notificationJobs.listRecent(this.companyId(), limit);
    return ok(jobs.map(toItem));
  }

  async markRead(id: string): Promise<Result<NotificationItemDto, AppError>> {
    const job = await this.p.notificationJobs.markRead(id, this.companyId(), this.clock.now());
    if (!job) return { ok: false, error: appNotFound('notification', id) };
    return ok(toItem(job));
  }

  /**
   * Aperçu temporel non paginé : le cutoff est émis par le serveur, puis borne la portée de la
   * commande. Une notification créée après cet instant ne sera jamais absorbée par confirmation.
   */
  async unreadPreview(): Promise<Result<NotificationUnreadPreviewDto, AppError>> {
    const preview = await this.p.notificationJobs.previewUnread(
      this.companyId(),
      this.clock.now(),
    );
    return ok(preview);
  }

  async markReadThrough(input: {
    throughCreatedAt?: unknown;
  }): Promise<Result<NotificationReadThroughDto, AppError>> {
    const cutoff = input.throughCreatedAt;
    if (typeof cutoff !== 'string') return invalidCutoff('Cutoff serveur manquant.');
    const cutoffMs = Date.parse(cutoff);
    if (!Number.isFinite(cutoffMs) || new Date(cutoffMs).toISOString() !== cutoff) {
      return invalidCutoff('Cutoff serveur invalide. Demandez un nouvel aperçu.');
    }
    const result = await this.p.notificationJobs.markReadThrough(
      this.companyId(),
      cutoff,
      this.clock.now(),
    );
    if (!result.cutoffAccepted) {
      return invalidCutoff('Cutoff futur refusé. Demandez un nouvel aperçu.');
    }
    return ok({ updatedCount: result.updatedCount, readAt: result.readAt });
  }

  async registerDevice(input: { expoPushToken?: unknown; platform?: unknown }): Promise<Result<RegisterDeviceDto, AppError>> {
    const token = input.expoPushToken;
    if (typeof token !== 'string' || !EXPO_TOKEN_PATTERN.test(token)) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'expoPushToken', message: 'Token Expo Push invalide (attendu ExponentPushToken[…]).' }],
        },
      };
    }
    const platform = typeof input.platform === 'string' && PLATFORMS.has(input.platform) ? input.platform : null;
    const device = await this.p.devices.register({
      id: randomUUID(),
      companyId: this.companyId(),
      userId: getPrincipal()?.userId ?? null,
      expoPushToken: token,
      platform,
      now: this.clock.now(),
    });
    return ok({ id: device.id, expoPushToken: device.expoPushToken, platform: device.platform });
  }
}
