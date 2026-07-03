import { type Notification } from '@bob/core';

export type NotificationJobStatus = 'pending' | 'done' | 'failed';

export interface NotificationJob {
  id: string;
  companyId: string;
  kind: 'quote-signature' | 'invoice-relance';
  dedupeKey: string;
  channel: Notification['channel'];
  recipient: string;
  subject: string;
  notification: Notification | null;
  status: NotificationJobStatus;
  attempts: number;
  nextAttemptAt: string;
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

export interface NotificationJobRepository {
  enqueue(input: EnqueueNotificationJobInput): Promise<NotificationJob>;
  listDue(companyId: string, now: string, limit: number): Promise<DeliverableNotificationJob[]>;
  markDone(id: string, at: string): Promise<void>;
  markFailed(id: string, at: string, nextAttemptAt: string, error: string): Promise<void>;
  // —— Fil de notifications (C25) : le mobile lit ce que les jobs produisent ——
  /** Dernières notifications du tenant (tous statuts), les plus récentes d'abord. */
  listRecent(companyId: string, limit: number): Promise<NotificationJob[]>;
  /** Marque lue (idempotent). null si le job n'existe pas dans le tenant courant. */
  markRead(id: string, companyId: string, at: string): Promise<NotificationJob | null>;
}
