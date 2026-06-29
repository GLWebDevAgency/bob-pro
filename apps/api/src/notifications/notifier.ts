import { Injectable } from '@nestjs/common';
import { type NotificationPort, type Notification } from '@bob/core';
import { AppLogger } from '../observability/logger';

export const NOTIFIER = Symbol('NOTIFIER');

/** Notifier de démo : trace l'envoi (audit). Adapters réels (SMTP/SMS) derrière le même port. */
@Injectable()
export class DemoNotifier implements NotificationPort {
  constructor(private readonly logger: AppLogger) {}
  async send(notification: Notification): Promise<void> {
    this.logger.audit('notification.sent', {
      channel: notification.channel,
      to: notification.to,
      subject: notification.subject,
    });
  }
}
