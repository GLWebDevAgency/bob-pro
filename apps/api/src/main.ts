import 'reflect-metadata';
import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  type DateOnly,
  messageVeilleMentions,
  parisDateOnly,
  veilleMentionsLegales,
} from '@bob/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { buildCorsOptions } from './config/cors';
import { loadEnv } from './config/env';
import { AppLogger } from './observability/logger';
import type { MistralRealtimeIngressRuntime } from './voice/realtime/mistral-realtime-runtime';
import { MISTRAL_REALTIME_INGRESS_RUNTIME } from './voice/realtime/realtime.tokens';

export const DEFAULT_JSON_BODY_LIMIT = '256kb';
export const LARGE_JSON_BODY_LIMIT = '16mb';

const LARGE_JSON_PAYLOAD_ROUTES = new Set([
  'POST /documents/upload',
  'POST /documents/intakes',
  'POST /documents/ocr',
  'POST /expenses/import-facturx',
  'POST /expenses/import-facturx/confirm',
  'POST /voice/transcribe',
]);

function requestPath(request: IncomingMessage): string {
  const path = (request.url ?? '/').split('?', 1)[0] ?? '/';
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function isJsonContentType(request: IncomingMessage): boolean {
  const header = request.headers['content-type'];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

/**
 * Seules les routes qui transportent effectivement un document ou de l'audio encodé en JSON
 * peuvent consommer la fenêtre de 16 Mo. Le chemin et la méthode sont tous deux comparés afin
 * qu'une route voisine (ou un suffixe forgé) ne hérite jamais de cette exception.
 */
export function usesLargeJsonBodyParser(request: IncomingMessage): boolean {
  if (!isJsonContentType(request)) return false;
  const method = request.method?.toUpperCase() ?? '';
  const path = requestPath(request);
  if (LARGE_JSON_PAYLOAD_ROUTES.has(`${method} ${path}`)) return true;
  // Photos de chantier : POST /chantiers/:id/photos transporte l'image en base64 (≤ 10 Mo
  // décodés ≈ 13,4 Mo dans le JSON). Segment id borné et non vide, méthode et suffixe exacts —
  // les routes voisines (/notes, /photos/:photoId/…) gardent la petite enveloppe.
  if (method === 'POST' && /^\/chantiers\/[^/]{1,160}\/photos$/.test(path)) return true;
  // Seule la sortie structurée de l'analyse FEC transite : jamais le FEC brut. La route reste
  // bornée à un PUT exact et à un SIREN canonique, les endpoints voisins gardent 256 ko.
  return method === 'PUT'
    && /^\/cabinet\/v1\/cabinets\/[^/]{1,160}\/dossiers\/\d{9}$/.test(path);
}

export function usesDefaultJsonBodyParser(request: IncomingMessage): boolean {
  return isJsonContentType(request) && !usesLargeJsonBodyParser(request);
}

/**
 * Veille des mentions légales au DÉMARRAGE — second canal de l'alarme datée du bloc mentions
 * (@bob/core, `veille-mentions-legales.ts`). Le canal principal est le test-sentinelle, qui casse
 * la CI ; celui-ci couvre le cas qu'un test ne couvre pas : une instance déployée qui tourne des
 * mois sans qu'une PR repasse, et qui franchit l'échéance en production.
 *
 * Ne renvoie QU'UN MESSAGE : aucune mention n'est calculée, changée ni imprimée ici — le démarrage
 * de l'API ne doit jamais dépendre d'une échéance légale, et une échéance ne doit jamais faire
 * tomber le service. Exportée pour être testable sans booter Nest.
 */
export function veilleMentionsLegalesAuDemarrage(today: DateOnly): string | null {
  const alertes = veilleMentionsLegales(today);
  return alertes.length > 0 ? messageVeilleMentions(alertes) : null;
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // La signature Stripe porte sur les octets EXACTS reçus. Nest conserve `request.rawBody`
    // avant parsing ; aucun JSON re-sérialisé n'est admis par le contrôleur webhook.
    rawBody: true,
  });
  app.useLogger(app.get(AppLogger));
  // Ne jamais activer `trust proxy` globalement : Railway expose l'IP canonique via X-Real-IP,
  // consommé et validé uniquement par le throttler. X-Forwarded-For reste donc sans effet.
  // Les documents/audio base64 ont besoin d'une enveloppe plus grande. Toutes les autres routes
  // restent volontairement petites pour rejeter un corps abusif avant guards, throttlers et métier.
  app.useBodyParser('json', { limit: LARGE_JSON_BODY_LIMIT, type: usesLargeJsonBodyParser });
  app.useBodyParser('json', { limit: DEFAULT_JSON_BODY_LIMIT, type: usesDefaultJsonBodyParser });
  app.use(helmet());
  app.enableCors(buildCorsOptions(env));
  // Déclenche onApplicationShutdown sur SIGTERM/SIGINT : les appels Realtime sont alors fermés
  // ou confiés explicitement au reaper au lieu d'être abandonnés pendant un redéploiement.
  app.enableShutdownHooks();
  const realtimeIngress = app.get<MistralRealtimeIngressRuntime>(MISTRAL_REALTIME_INGRESS_RUNTIME);
  try {
    realtimeIngress.attach(app.getHttpServer() as HttpServer);
    await app.listen(env.PORT);
  } catch (error) {
    // L'upgrade WSS ne doit jamais survivre à un échec de bind HTTP ou à une composition invalide.
    await realtimeIngress.shutdown().catch(() => undefined);
    await app.close().catch(() => undefined);
    throw error;
  }
  const logger = app.get(AppLogger);
  logger.log(
    `Bob Pro API -> http://localhost:${env.PORT} (data=postgresql, auth=jwt, claude=${!!env.ANTHROPIC_API_KEY}, glm=${!!env.GLM_API_KEY})`,
    'Bootstrap',
  );
  // Jour métier Paris : la même source de vérité que les pièces émises.
  const veille = veilleMentionsLegalesAuDemarrage(parisDateOnly());
  if (veille !== null) logger.warn(veille, 'VeilleMentionsLegales');
}

if (require.main === module) void bootstrap();
