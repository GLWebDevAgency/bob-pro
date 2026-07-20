import { type Provider } from '@nestjs/common';
import { AppLogger } from '../observability/logger';

/**
 * Canal push Expo (C25) — envoi direct à l'API Expo Push (aucun SDK : fetch nu, comme Brevo).
 * Chunké par 100 (limite documentée de l'API), erreurs remontées PAR TICKET (jamais silencieuses) ;
 * les tokens invalidés (DeviceNotRegistered) sont signalés à l'appelant pour purge.
 */

export const EXPO_PUSH = Symbol('EXPO_PUSH');

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  /** Payload de navigation non sensible — lu par le mobile au tap. */
  data?: Record<string, string>;
}

export interface ExpoPushRejection {
  token: string;
  /** Code d'erreur Expo (DeviceNotRegistered, MessageTooBig…) ou message brut. */
  error: string;
}

export interface ExpoPushOutcome {
  accepted: number;
  rejected: ExpoPushRejection[];
}

interface ExpoPushTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Limite de lot de l'API Expo Push. */
const CHUNK_SIZE = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Les erreurs réseau/provider ne sont pas une frontière de confiance : certains messages
 * peuvent réfléchir un token. On conserve l'erreur brute dans l'outcome (purge interne),
 * mais jamais dans les logs avant avoir retiré tout token du lot et toute forme Expo usuelle.
 */
function redactPushTokensForLog(error: string, batch: readonly ExpoPushMessage[]): string {
  let redacted = error;
  for (const message of batch) {
    if (message.to.length > 0) redacted = redacted.replaceAll(message.to, '[push-token-redacted]');
  }
  return redacted.replace(/(?:Exponent|Expo)PushToken(?:\[[^\]\s]*\]?)/giu, '[push-token-redacted]');
}

export class ExpoPushService {
  constructor(
    private readonly logger: AppLogger,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  /** Envoie les messages par lots de 100. Ne lève jamais : tout échec est un rejet loggé. */
  async send(messages: readonly ExpoPushMessage[]): Promise<ExpoPushOutcome> {
    if (messages.length === 0) return { accepted: 0, rejected: [] };
    const outcome: ExpoPushOutcome = { accepted: 0, rejected: [] };
    for (const batch of chunk(messages, CHUNK_SIZE)) {
      try {
        const res = await this.fetchFn(EXPO_PUSH_URL, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) {
          const error = `Expo Push HTTP ${res.status}`;
          for (const m of batch) outcome.rejected.push({ token: m.to, error });
          this.logger.warn(`Push Expo refusé (lot de ${batch.length}) : ${error}`, 'notifications');
          continue;
        }
        const payload = (await res.json()) as { data?: ExpoPushTicket[] };
        const tickets = payload.data ?? [];
        batch.forEach((message, i) => {
          const ticket = tickets[i];
          if (ticket && ticket.status === 'ok') {
            outcome.accepted += 1;
            return;
          }
          const error = ticket?.details?.error ?? ticket?.message ?? 'ticket manquant';
          outcome.rejected.push({ token: message.to, error });
          // Le token Expo est une capacité/pseudonyme : aucun préfixe ni hash corrélable en logs.
          this.logger.warn(
            `Push Expo en erreur (ticket ${i + 1}/${batch.length}) : ${redactPushTokensForLog(error, batch)}`,
            'notifications',
          );
        });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        for (const m of batch) outcome.rejected.push({ token: m.to, error });
        this.logger.warn(
          `Push Expo injoignable (lot de ${batch.length}) : ${redactPushTokensForLog(error, batch)}`,
          'notifications',
        );
      }
    }
    return outcome;
  }
}

export const expoPushProvider: Provider = {
  provide: EXPO_PUSH,
  inject: [AppLogger],
  useFactory: (logger: AppLogger) => new ExpoPushService(logger),
};
