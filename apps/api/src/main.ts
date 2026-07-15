import 'reflect-metadata';
import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
  return LARGE_JSON_PAYLOAD_ROUTES.has(`${request.method?.toUpperCase() ?? ''} ${requestPath(request)}`);
}

export function usesDefaultJsonBodyParser(request: IncomingMessage): boolean {
  return isJsonContentType(request) && !usesLargeJsonBodyParser(request);
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(AppLogger));
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
  app
    .get(AppLogger)
    .log(
      `Bob Pro API -> http://localhost:${env.PORT} (demo=${env.DEMO_MODE}, claude=${!!env.ANTHROPIC_API_KEY}, glm=${!!env.GLM_API_KEY})`,
      'Bootstrap',
    );
}

if (require.main === module) void bootstrap();
