import { describe, expect, it } from 'vitest';
import { clientIpSourceForRequest, createClientIpTracker, isRailwayRuntime } from './client-ip';

function request(
  remoteAddress: string,
  rawHeaders: string[] = [],
  ip = '203.0.113.250',
): Record<string, unknown> {
  return { socket: { remoteAddress }, rawHeaders, ip };
}

describe('client IP throttle tracker', () => {
  it('n’active le contrat Railway que si les cinq identifiants système sont des UUID', () => {
    expect(isRailwayRuntime({})).toBe(false);
    const id = '01999999-9999-4999-8999-999999999999';
    expect(isRailwayRuntime({ RAILWAY_ENVIRONMENT_ID: id })).toBe(false);
    const completeRuntime = {
      RAILWAY_PROJECT_ID: id,
      RAILWAY_ENVIRONMENT_ID: id,
      RAILWAY_SERVICE_ID: id,
      RAILWAY_DEPLOYMENT_ID: id,
      RAILWAY_REPLICA_ID: id,
    };
    expect(isRailwayRuntime(completeRuntime)).toBe(true);
    expect(
      clientIpSourceForRequest(
        request('10.0.0.4', ['X-Real-IP', '198.51.100.42']),
        completeRuntime,
      ),
    ).toBe('railway-x-real-ip');
    expect(clientIpSourceForRequest(request('10.0.0.4'), completeRuntime)).toBe('railway-invalid');
    expect(clientIpSourceForRequest(request('10.0.0.4'), {})).toBe('socket');
    expect(
      isRailwayRuntime({
        RAILWAY_PROJECT_ID: id,
        RAILWAY_ENVIRONMENT_ID: id,
        RAILWAY_SERVICE_ID: id,
        RAILWAY_DEPLOYMENT_ID: 'forged',
        RAILWAY_REPLICA_ID: id,
      }),
    ).toBe(false);
  });

  it('ignore tous les headers client hors Railway et conserve le peer TCP', () => {
    const tracker = createClientIpTracker({ railwayRuntime: false });
    expect(
      tracker(request('10.0.0.4', ['X-Real-IP', '198.51.100.42', 'X-Forwarded-For', '192.0.2.9'])),
    ).toBe('peer:10.0.0.4');
  });

  it.each([
    ['198.51.100.42', 'railway:198.51.100.42'],
    ['2001:0db8:0000:0000:0000:0000:0000:0042', 'railway:2001:db8::42'],
    ['::ffff:198.51.100.42', 'railway:198.51.100.42'],
    ['::ffff:c633:642a', 'railway:198.51.100.42'],
  ])('normalise un unique X-Real-IP Railway %s', (clientIp, expected) => {
    const tracker = createClientIpTracker({ railwayRuntime: true });
    expect(tracker(request('10.0.0.4', ['X-Real-IP', clientIp]))).toBe(expected);
  });

  it.each<string[][]>([
    [[]],
    [['X-Real-IP', 'not-an-ip']],
    [['X-Real-IP', '198.51.100.42, 192.0.2.4']],
    [['X-Real-IP', '198.51.100.42', 'x-real-ip', '192.0.2.4']],
    [['X-Real-IP', 'fe80::1%eth0']],
  ])('échoue fermé sur un header Railway absent, ambigu ou invalide', (rawHeaders) => {
    const tracker = createClientIpTracker({ railwayRuntime: true });
    expect(tracker(request('10.0.0.4', rawHeaders))).toBe('railway-invalid:10.0.0.4');
  });

  it('n’utilise jamais X-Forwarded-For, même sur Railway', () => {
    const tracker = createClientIpTracker({ railwayRuntime: true });
    expect(
      tracker(
        request('10.0.0.4', ['X-Real-IP', '198.51.100.42', 'X-Forwarded-For', '192.0.2.200']),
      ),
    ).toBe('railway:198.51.100.42');
  });
});
