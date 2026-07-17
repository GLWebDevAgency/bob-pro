import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { SystemClock, appNotFound, ok, type AppError, type Result } from '@bob/core';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
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
  status: 'bound' | 'superseded';
}

export interface UnregisterDeviceDto {
  unregistered: true;
}

export interface RevokeDeviceBindingDto {
  /** Réponse volontairement indistinguable : ne révèle jamais l'existence d'une installation. */
  accepted: true;
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
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_SECRET_PATTERN = /^[0-9a-f]{64}$/;
const MAX_BINDING_GENERATION = 2_147_483_647;
const PLATFORMS = new Set(['ios', 'android']);

function exactJsonObject(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Result<Record<string, unknown>, AppError> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return invalidDeviceField('body', 'Objet JSON attendu.');
  }
  const body = input as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(body);
  const unknown = keys.find((key) => !allowed.has(key));
  if (unknown !== undefined) return invalidDeviceField(unknown, 'Champ non autorisé.');
  const missing = required.find((key) => !Object.hasOwn(body, key));
  if (missing !== undefined) return invalidDeviceField(missing, 'Champ requis.');
  return ok(body);
}

function invalidCutoff(message: string): Result<never, AppError> {
  return {
    ok: false,
    error: { kind: 'validation', issues: [{ field: 'throughCreatedAt', message }] },
  };
}

function validateExpoPushToken(token: unknown): Result<string, AppError> {
  if (typeof token === 'string' && EXPO_TOKEN_PATTERN.test(token)) return ok(token);
  return {
    ok: false,
    error: {
      kind: 'validation',
      issues: [
        {
          field: 'expoPushToken',
          message: 'Token Expo Push invalide (attendu ExponentPushToken[…]).',
        },
      ],
    },
  };
}

function invalidDeviceField(field: string, message: string): Result<never, AppError> {
  return { ok: false, error: { kind: 'validation', issues: [{ field, message }] } };
}

function validateUuidV4(field: string, value: unknown): Result<string, AppError> {
  if (typeof value === 'string' && UUID_V4_PATTERN.test(value)) return ok(value.toLowerCase());
  return invalidDeviceField(field, 'Identifiant UUID v4 invalide.');
}

function validateBindingGeneration(
  value: unknown,
  field = 'bindingGeneration',
): Result<number, AppError> {
  if (
    Number.isSafeInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= MAX_BINDING_GENERATION
  ) {
    return ok(Number(value));
  }
  return invalidDeviceField(field, 'Génération de binding invalide.');
}

function validateInstallationSecret(value: unknown): Result<string, AppError> {
  if (typeof value === 'string' && INSTALLATION_SECRET_PATTERN.test(value)) return ok(value);
  return invalidDeviceField('revocationSecret', 'Capacité de révocation invalide.');
}

function hashInstallationSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
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
    const limit =
      Number.isFinite(parsed) && parsed > 0
        ? Math.min(Math.floor(parsed), MAX_FEED_LIMIT)
        : DEFAULT_FEED_LIMIT;
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
    const preview = await this.p.notificationJobs.previewUnread(this.companyId(), this.clock.now());
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

  async registerDevice(input: unknown): Promise<Result<RegisterDeviceDto, AppError>> {
    const decoded = exactJsonObject(
      input,
      ['expoPushToken', 'installationId', 'bindingId', 'bindingGeneration', 'revocationSecret'],
      ['platform'],
    );
    if (!decoded.ok) return decoded;
    const tokenResult = validateExpoPushToken(decoded.value.expoPushToken);
    if (!tokenResult.ok) return tokenResult;
    const installationId = validateUuidV4('installationId', decoded.value.installationId);
    if (!installationId.ok) return installationId;
    const bindingId = validateUuidV4('bindingId', decoded.value.bindingId);
    if (!bindingId.ok) return bindingId;
    const bindingGeneration = validateBindingGeneration(decoded.value.bindingGeneration);
    if (!bindingGeneration.ok) return bindingGeneration;
    const revocationSecret = validateInstallationSecret(decoded.value.revocationSecret);
    if (!revocationSecret.ok) return revocationSecret;
    const token = tokenResult.value;
    const platformRaw = decoded.value.platform;
    if (
      platformRaw !== undefined &&
      (typeof platformRaw !== 'string' || !PLATFORMS.has(platformRaw))
    ) {
      return invalidDeviceField('platform', 'Plateforme invalide (ios ou android attendue).');
    }
    const platform = typeof platformRaw === 'string' ? platformRaw : null;
    const device = await this.p.devices.register({
      id: randomUUID(),
      companyId: this.companyId(),
      userId: getPrincipal()?.userId ?? null,
      expoPushToken: token,
      platform,
      installationId: installationId.value,
      bindingId: bindingId.value,
      bindingGeneration: bindingGeneration.value,
      revocationSecretHash: hashInstallationSecret(revocationSecret.value),
      now: this.clock.now(),
    });
    // Ni token, ni installation, ni owner ne sont ré-émis dans la réponse HTTP.
    return ok({ status: device.status });
  }

  async revokeDeviceBinding(
    input: unknown,
    scope: 'authenticated' | 'public',
  ): Promise<Result<RevokeDeviceBindingDto, AppError>> {
    const decoded = exactJsonObject(input, [
      'installationId',
      'throughGeneration',
      'revocationSecret',
    ]);
    if (!decoded.ok) return decoded;
    const installationId = validateUuidV4('installationId', decoded.value.installationId);
    if (!installationId.ok) return installationId;
    const throughGeneration = validateBindingGeneration(
      decoded.value.throughGeneration,
      'throughGeneration',
    );
    if (!throughGeneration.ok) return throughGeneration;
    const secret = validateInstallationSecret(decoded.value.revocationSecret);
    if (!secret.ok) return secret;
    const principal = scope === 'authenticated' ? getPrincipal() : undefined;
    await this.p.devices.revokeThroughGeneration({
      installationId: installationId.value,
      throughGeneration: throughGeneration.value,
      revocationSecretHash: hashInstallationSecret(secret.value),
      scope:
        scope === 'authenticated'
          ? {
              kind: 'authenticated',
              companyId: this.companyId(),
              userId: principal?.userId ?? null,
            }
          : { kind: 'public' },
    });
    return ok({ accepted: true });
  }

  /**
   * Révocation best-effort avant déconnexion. Idempotente et strictement tenant-scopée : si le
   * token a déjà été transféré vers un autre compte, cet ancien principal ne peut pas le retirer.
   */
  async unregisterDevice(input: unknown): Promise<Result<UnregisterDeviceDto, AppError>> {
    const decoded = exactJsonObject(input, ['expoPushToken']);
    if (!decoded.ok) return decoded;
    const tokenResult = validateExpoPushToken(decoded.value.expoPushToken);
    if (!tokenResult.ok) return tokenResult;
    await this.p.devices.revokeLegacyOwnerToken(
      this.companyId(),
      getPrincipal()?.userId ?? null,
      tokenResult.value,
    );
    return ok({ unregistered: true });
  }
}
