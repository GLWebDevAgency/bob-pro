import type { CorsOptions, CustomOrigin } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { Env } from './env';

type CorsEnv = Pick<Env, 'CORS_ORIGINS' | 'SIGN_WEB_BASE_URL'>;

const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const allowedHeaders = ['Authorization', 'Content-Type', 'X-Request-Id'];

function normalizeOrigin(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('Origine CORS vide');
  return new URL(value).origin;
}

export function allowedCorsOrigins(env: CorsEnv): string[] {
  const rawOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const origins = [...rawOrigins, env.SIGN_WEB_BASE_URL].map(normalizeOrigin);
  return [...new Set(origins)];
}

export function buildCorsOptions(env: CorsEnv, nodeEnv = process.env.NODE_ENV): CorsOptions {
  const base: CorsOptions = {
    methods: allowedMethods,
    allowedHeaders,
    credentials: false,
    optionsSuccessStatus: 204,
    maxAge: 86_400,
  };

  if (nodeEnv !== 'production') {
    return { ...base, origin: true };
  }

  const allowed = new Set(allowedCorsOrigins(env));
  const origin: CustomOrigin = (requestOrigin, callback) => {
    if (!requestOrigin) {
      callback(null, true);
      return;
    }

    let normalized: string;
    try {
      normalized = normalizeOrigin(requestOrigin);
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Origine CORS invalide'), false);
      return;
    }

    if (!allowed.has(normalized)) {
      callback(new Error(`Origine CORS refusee: ${requestOrigin}`), false);
      return;
    }

    callback(null, normalized);
  };

  return { ...base, origin };
}
