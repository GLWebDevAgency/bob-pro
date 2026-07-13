import { Injectable, type Provider } from '@nestjs/common';
import { type NotificationPort, type Notification } from '@bob/core';
import { AppLogger } from '../observability/logger';
import { isDemoMode } from '../config/env';

export const NOTIFIER = Symbol('NOTIFIER');

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface BrevoOptions {
  apiKey: string;
  senderEmail: string;
  senderName: string;
  baseUrl: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function isDuplicateAcknowledgement(response: Response): Promise<boolean> {
  try {
    const payload: unknown = await response.json();
    return typeof payload === 'object'
      && payload !== null
      && 'code' in payload
      && payload.code === 'duplicate_parameter';
  } catch {
    return false;
  }
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

/** Notifier de démo : trace uniquement le résultat technique, jamais le contenu ou le destinataire. */
@Injectable()
export class DemoNotifier implements NotificationPort {
  constructor(private readonly logger: AppLogger) {}
  async send(notification: Notification): Promise<void> {
    this.logger.audit('notification.sent', {
      provider: 'demo',
      channel: notification.channel,
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
    if (notification.idempotencyKey && !UUID_PATTERN.test(notification.idempotencyKey)) {
      throw new Error('La clé d’idempotence Brevo doit être un UUID.');
    }
    const body = {
      sender: { name: this.opts.senderName, email: this.opts.senderEmail },
      to: [{ email: notification.to }],
      subject: notification.subject,
      textContent: notification.body,
      htmlContent: textToHtml(notification.body),
      ...(notification.idempotencyKey
        ? { headers: { idempotencyKey: notification.idempotencyKey } }
        : {}),
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
    if (!res.ok) {
      // Brevo répond duplicate_parameter lorsqu'une requête portant la même clé
      // a déjà été acceptée dans sa fenêtre d'idempotence. C'est un accusé de
      // réception, pas un échec à retenter : le job local peut donc passer done.
      const duplicate = Boolean(notification.idempotencyKey)
        && await isDuplicateAcknowledgement(res);
      if (!duplicate) throw new Error(`Brevo HTTP ${res.status}`);
      this.logger.audit('notification.deduplicated', {
        provider: 'brevo',
        channel: notification.channel,
      });
      return;
    }
    this.logger.audit('notification.sent', {
      provider: 'brevo',
      channel: notification.channel,
    });
  }
}

/** Clé absente HORS démo : chaque envoi échoue EXPLICITEMENT (le job passe failed, cause loggée
 * par le delivery service) — jamais un faux succès silencieux (directive C25). */
export class MisconfiguredEmailNotifier implements NotificationPort {
  async send(): Promise<void> {
    throw new Error('BREVO_API_KEY / BREVO_SENDER_EMAIL manquants — envoi email impossible (configurer le mailer).');
  }
}

export function buildNotifier(logger: AppLogger): NotificationPort {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) {
    // Démo assumée (DEMO_MODE=true) : trace d'audit sans envoi réel. En prod : échec propre par job.
    return isDemoMode() ? new DemoNotifier(logger) : new MisconfiguredEmailNotifier();
  }
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
