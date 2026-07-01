import { describe, expect, it } from 'vitest';
import type { CorsOptions, CustomOrigin } from '@nestjs/common/interfaces/external/cors-options.interface';
import { allowedCorsOrigins, buildCorsOptions } from './cors';

const env = {
  CORS_ORIGINS: 'https://app.bobpro.fr, https://admin.bobpro.fr/',
  SIGN_WEB_BASE_URL: 'https://sign.bobpro.fr/signature',
};

function customOrigin(options: CorsOptions): CustomOrigin {
  if (typeof options.origin !== 'function') throw new Error('Expected custom CORS origin function');
  return options.origin;
}

function resolveOrigin(origin: CustomOrigin, requestOrigin?: string): Promise<string | boolean | RegExp | (string | RegExp)[] | undefined> {
  return new Promise((resolve, reject) => {
    origin(requestOrigin, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

describe('buildCorsOptions', () => {
  it('reste permissif hors production pour le dev local', () => {
    expect(buildCorsOptions(env, 'development').origin).toBe(true);
  });

  it('construit une allowlist de production depuis CORS_ORIGINS et SIGN_WEB_BASE_URL', () => {
    expect(allowedCorsOrigins(env)).toEqual(['https://app.bobpro.fr', 'https://admin.bobpro.fr', 'https://sign.bobpro.fr']);
  });

  it('autorise uniquement les origines browser connues en production', async () => {
    const origin = customOrigin(buildCorsOptions(env, 'production'));

    await expect(resolveOrigin(origin, 'https://app.bobpro.fr')).resolves.toBe('https://app.bobpro.fr');
    await expect(resolveOrigin(origin, 'https://evil.example')).rejects.toThrow('Origine CORS refusee');
  });

  it('autorise les requetes sans Origin pour mobile natif et server-to-server', async () => {
    const origin = customOrigin(buildCorsOptions(env, 'production'));

    await expect(resolveOrigin(origin)).resolves.toBe(true);
  });
});
