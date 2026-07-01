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
}
