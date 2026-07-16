import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { Module, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { getStorageToken, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PublicPushRevocationsController } from '../api.controllers';
import { createClientIpTracker } from '../config/client-ip';
import { NotificationsApiService } from './notifications-api.service';
import { BoundedThrottlerStorage } from './bounded-throttler-storage';
import { createApiThrottlerOptions } from './push-revocation-throttle';

const INSTALLATION_ID = '01999999-9999-4999-8999-999999999999';
const REVOCATION_SECRET = 'a'.repeat(64);
const revokeDeviceBinding = vi.fn(async () => ({
  ok: true as const,
  value: { accepted: true as const },
}));

@Module({
  imports: [
    ThrottlerModule.forRoot(
      createApiThrottlerOptions(createClientIpTracker({ railwayRuntime: true })),
    ),
  ],
  controllers: [PublicPushRevocationsController],
  providers: [
    { provide: NotificationsApiService, useValue: { revokeDeviceBinding } },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
class PublicPushThrottleTestModule {}

async function revoke(baseUrl: string, secret = REVOCATION_SECRET): Promise<Response> {
  return fetch(`${baseUrl}/public/push-revocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      installationId: INSTALLATION_ID,
      throughGeneration: 1,
      revocationSecret: secret,
    }),
  });
}

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status === status) return;
  throw new Error(`HTTP ${response.status}, attendu ${status}: ${await response.text()}`);
}

async function revokeWithDuplicatedRailwayIp(baseUrl: string): Promise<number> {
  const payload = JSON.stringify({ installationId: 'invalid' });
  const url = new URL('/public/push-revocations', baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
          'x-real-ip': ['198.51.100.10', '203.0.113.20'],
        },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.once('error', reject);
    request.end(payload);
  });
}

describe('public push revocation throttle — HTTP réel', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(PublicPushThrottleTestModule, { logger: ['error'] });
    // Vitest/esbuild n'émet pas decoratorMetadata ; le runtime Nest de production (tsc) le fait.
    // Injecter explicitement le double conserve ici le vrai controller et tous ses decorators.
    const controller = app.get(PublicPushRevocationsController) as unknown as {
      notifications: { revokeDeviceBinding: typeof revokeDeviceBinding };
    };
    controller.notifications = { revokeDeviceBinding };
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('borne la capacité exacte sans laisser l’UUID public épuiser une autre capacité', async () => {
    expect(app.get(getStorageToken())).toBeInstanceOf(BoundedThrottlerStorage);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await expectStatus(await revoke(baseUrl), 202);
    }
    await expectStatus(await revoke(baseUrl), 429);

    // Même installation, secret différent : quota différent. Le secret brut n'est jamais la clé.
    await expectStatus(await revoke(baseUrl, 'b'.repeat(64)), 202);
    expect(revokeDeviceBinding).toHaveBeenCalledTimes(13);
  });

  it('rejette comme une seule source les X-Real-IP HTTP dupliqués', async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect(await revokeWithDuplicatedRailwayIp(baseUrl)).toBe(202);
    }
    expect(await revokeWithDuplicatedRailwayIp(baseUrl)).toBe(429);
  });
});
