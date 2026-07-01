import { Injectable, type Provider } from '@nestjs/common';
import { type NotificationPort, type Notification } from '@bob/core';
import { AppLogger } from '../observability/logger';

export const NOTIFIER = Symbol('NOTIFIER');

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface BrevoOptions {
  apiKey: string;
  senderEmail: string;
  senderName: string;
  baseUrl: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textToHtml(s: string): string {
  return `<html><body><p>${escapeHtml(s).replace(/\n/g, '<br>')}</p></body></html>`;
}

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

/** Adapter Brevo Transactional Email API. Ne connaît que le port NotificationPort. */
export class BrevoEmailNotifier implements NotificationPort {
  constructor(
    private readonly logger: AppLogger,
    private readonly opts: BrevoOptions,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  async send(notification: Notification): Promise<void> {
    if (notification.channel !== 'email') throw new Error(`Canal non supporté par Brevo : ${notification.channel}`);
    const body = {
      sender: { name: this.opts.senderName, email: this.opts.senderEmail },
      to: [{ email: notification.to }],
      subject: notification.subject,
      textContent: notification.body,
      htmlContent: textToHtml(notification.body),
    };
    const res = await this.fetchFn(`${this.opts.baseUrl.replace(/\/$/, '')}/smtp/email`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': this.opts.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`Brevo HTTP ${res.status}`);
    this.logger.audit('notification.sent', {
      provider: 'brevo',
      channel: notification.channel,
      to: notification.to,
      subject: notification.subject,
    });
  }
}

export function buildNotifier(logger: AppLogger): NotificationPort {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) return new DemoNotifier(logger);
  return new BrevoEmailNotifier(logger, {
    apiKey,
    senderEmail,
    senderName: process.env.BREVO_SENDER_NAME ?? 'Bob Pro',
    baseUrl: process.env.BREVO_API_BASE_URL ?? 'https://api.brevo.com/v3',
  });
}

export const notifierProvider: Provider = {
  provide: NOTIFIER,
  inject: [AppLogger],
  useFactory: buildNotifier,
};
