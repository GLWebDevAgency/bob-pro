import { describe, expect, it } from 'vitest';
import {
  createPublicPushCapabilityTracker,
  PublicPushCapabilityThrottle,
  shouldSkipPublicPushCapabilityThrottle,
} from './push-revocation-throttle';
import { createClientIpTracker } from '../config/client-ip';

const INSTALLATION_ID = '01999999-9999-4999-8999-999999999999';
const REVOCATION_SECRET = 'a'.repeat(64);
const publicPushCapabilityTracker = createPublicPushCapabilityTracker(
  createClientIpTracker({ railwayRuntime: false }),
);

describe('public push revocation throttle', () => {
  it('agrège une capacité exacte indépendamment de l’IP sans exposer son secret', () => {
    const first = publicPushCapabilityTracker({
      ip: '198.51.100.1',
      body: { installationId: INSTALLATION_ID.toUpperCase(), revocationSecret: REVOCATION_SECRET },
    });
    const second = publicPushCapabilityTracker({
      ip: '203.0.113.2',
      body: { installationId: INSTALLATION_ID, revocationSecret: REVOCATION_SECRET },
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^capability:[0-9a-f]{64}$/u);
    expect(first).not.toContain(INSTALLATION_ID);
    expect(first).not.toContain(REVOCATION_SECRET);
  });

  it('un UUID connu sans secret exact ne peut pas épuiser le quota de la vraie capacité', () => {
    const invalidRequest = (body: unknown) => ({
      socket: { remoteAddress: '198.51.100.4' },
      ip: '192.0.2.250',
      body,
    });
    expect(publicPushCapabilityTracker(invalidRequest({ installationId: 'random-a' }))).toBe(
      'invalid:peer:198.51.100.4',
    );
    expect(publicPushCapabilityTracker(invalidRequest({ installationId: INSTALLATION_ID }))).toBe(
      'invalid:peer:198.51.100.4',
    );
    expect(
      publicPushCapabilityTracker(
        invalidRequest({
          installationId: INSTALLATION_ID,
          revocationSecret: 'not-a-secret',
        }),
      ),
    ).toBe('invalid:peer:198.51.100.4');
    expect(publicPushCapabilityTracker(invalidRequest(null))).toBe('invalid:peer:198.51.100.4');
  });

  it('sépare deux capacités valides de la même installation', () => {
    const first = publicPushCapabilityTracker({
      ip: '198.51.100.4',
      body: { installationId: INSTALLATION_ID, revocationSecret: REVOCATION_SECRET },
    });
    const second = publicPushCapabilityTracker({
      ip: '198.51.100.4',
      body: { installationId: INSTALLATION_ID, revocationSecret: 'b'.repeat(64) },
    });
    expect(first).not.toBe(second);
  });

  it('active le throttler secondaire uniquement sur le handler explicitement marqué', () => {
    const marked = () => undefined;
    const ordinary = () => undefined;
    PublicPushCapabilityThrottle()(marked);
    const context = (handler: () => void) => ({
      getHandler: () => handler,
    });

    expect(shouldSkipPublicPushCapabilityThrottle(context(marked))).toBe(false);
    expect(shouldSkipPublicPushCapabilityThrottle(context(ordinary))).toBe(true);
  });
});
