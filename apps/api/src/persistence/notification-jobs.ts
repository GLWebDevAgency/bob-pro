import { createHash } from 'node:crypto';
import { type Notification } from '@bob/core';

export type NotificationJobStatus = 'pending' | 'done' | 'failed';

export interface NotificationJob {
  id: string;
  companyId: string;
  /** `retractation-acknowledgment` : accusé de réception de la rétractation en ligne, sur
   *  support durable (courriel choisi par le consommateur — art. D221-5, IV c. conso). */
  kind: 'quote-signature' | 'invoice-relance' | 'weekly-digest' | 'retractation-acknowledgment';
  dedupeKey: string;
  channel: Notification['channel'];
  recipient: string;
  subject: string;
  notification: Notification | null;
  /** Empreinte immuable de channel/to/subject/body, hors clé provider. */
  payloadFingerprint: string | null;
  status: NotificationJobStatus;
  attempts: number;
  nextAttemptAt: string;
  /** Fence générationnel du worker courant ; null hors livraison active. */
  leaseToken: string | null;
  /** Horloge autoritaire de la toute première tentative provider ; ne peut jamais glisser. */
  providerAttemptedAt: string | null;
  lastError: string | null;
  /** Lu par l'utilisateur (fil de notifications C25) — null tant que non lu. */
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliverableNotificationJob extends Omit<NotificationJob, 'notification'> {
  notification: Notification;
}

export interface EnqueueNotificationJobInput {
  id: string;
  companyId: string;
  kind: NotificationJob['kind'];
  dedupeKey: string;
  notification: Notification;
  now: string;
}

export function notificationPayloadFingerprint(notification: Notification): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([
      notification.channel,
      notification.to,
      notification.subject,
      notification.body,
    ]))
    .digest('hex')}`;
}

export class NotificationDedupeConflictError extends Error {
  constructor(readonly dedupeKey: string) {
    super(`La clé de déduplication notification « ${dedupeKey} » désigne déjà un autre contenu.`);
    this.name = 'NotificationDedupeConflictError';
  }
}

export type NotificationDeliveryClaim =
  | { outcome: 'claimed'; job: DeliverableNotificationJob }
  | { outcome: 'quarantined'; reason: 'provider-window-expired' | 'channel-without-idempotency' }
  | { outcome: 'skipped' };

export interface NotificationUnreadPreview {
  unreadCount: number;
  /** Borne exclusive autoritaire ; PostgreSQL la produit avec la même horloge que createdAt. */
  throughCreatedAt: string;
}

export interface NotificationReadThroughResult {
  updatedCount: number;
  readAt: string;
  /** Faux si le cutoff ne peut pas provenir d'un aperçu antérieur selon l'horloge autoritaire. */
  cutoffAccepted: boolean;
}

export interface NotificationJobRepository {
  /** Une dedupeKey identifie une requête immuable : un ré-enqueue ne remplace jamais son payload. */
  enqueue(input: EnqueueNotificationJobInput): Promise<NotificationJob>;
  /** Lecture exacte et tenant-scoped pour Bob/notifications ; null masque aussi l'autre tenant. */
  findById(companyId: string, id: string): Promise<NotificationJob | null>;
  listDue(companyId: string, now: string, limit: number): Promise<DeliverableNotificationJob[]>;
  /**
   * Lease atomique avant I/O : true pour un seul worker si le job est encore dû.
   * `leaseUntil` rend le job récupérable après crash, sans nouveau statut ni lock long.
   */
  claimForDelivery(
    id: string,
    companyId: string,
    expectedUpdatedAt: string,
    now: string,
    leaseUntil: string,
    leaseToken: string,
  ): Promise<NotificationDeliveryClaim>;
  /**
   * Dernière validation juste avant l'I/O externe. Elle réduit la fenêtre d'un worker suspendu :
   * le token, le lease et la fenêtre provider doivent encore être valides selon l'horloge DB.
   */
  authorizeDeliveryAttempt(
    id: string,
    companyId: string,
    leaseToken: string,
    observedAt: string,
  ): Promise<boolean>;
  /** Transition atomique pending|failed -> done, clôturée uniquement par le détenteur du lease. */
  markDone(id: string, companyId: string, leaseToken: string, at: string): Promise<boolean>;
  /** Un worker dont le lease a expiré ne peut jamais écraser l'état de son successeur. */
  markFailed(
    id: string,
    companyId: string,
    leaseToken: string,
    observedAt: string,
    retryDelayMs: number,
    error: string,
  ): Promise<boolean>;
  // —— Fil de notifications (C25) : le mobile lit ce que les jobs produisent ——
  /** Dernières notifications du tenant (tous statuts), les plus récentes d'abord. */
  listRecent(companyId: string, limit: number): Promise<NotificationJob[]>;
  /** Snapshot temporel non paginé. `observedAt` sert seulement aux adaptateurs sans horloge DB. */
  previewUnread(companyId: string, observedAt: string): Promise<NotificationUnreadPreview>;
  /** Marque lue (idempotent). null si le job n'existe pas dans le tenant courant. */
  markRead(id: string, companyId: string, at: string): Promise<NotificationJob | null>;
  /**
   * Marque atomiquement les notifications non lues du tenant strictement antérieures au cutoff.
   * Les notifications créées après l'aperçu restent non lues ; un rejeu retourne zéro.
   */
  markReadThrough(
    companyId: string,
    throughCreatedAt: string,
    observedAt: string,
  ): Promise<NotificationReadThroughResult>;
}
