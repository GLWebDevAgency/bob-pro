import { describe, expect, it, vi } from 'vitest';
import type { RealtimeDatabaseHardExpiryProof } from './realtime-admission';
import {
  MistralRealtimeTerminationAuthority,
  MistralRealtimeTerminationError,
} from './mistral-realtime-termination';

const NOW = Date.parse('2026-07-14T10:00:00.000Z');
const HARD_EXPIRES_AT = new Date(NOW + 60_000).toISOString();
const PROVIDER_SESSION_ID = 'mistral_session_1';

function proof(
  overrides: Partial<RealtimeDatabaseHardExpiryProof> = {},
): RealtimeDatabaseHardExpiryProof {
  return {
    source: 'database_hard_expiry',
    companyId: 'company-1',
    subjectHash: 'a'.repeat(64),
    sessionId: '11111111-1111-4111-8111-111111111111',
    providerId: 'mistral',
    providerCallId: PROVIDER_SESSION_ID,
    hardExpiresAt: HARD_EXPIRES_AT,
    databaseObservedAt: new Date(NOW + 60_001).toISOString(),
    leaseVersion: 4,
    ...overrides,
  };
}

describe('MistralRealtimeTerminationAuthority', () => {
  it('ferme réellement la connexion locale et rend les retries single-flight/idempotents', async () => {
    const close = vi.fn(async () => undefined);
    const authority = new MistralRealtimeTerminationAuthority(() => NOW);
    const registration = authority.register({
      connection: { providerSessionId: PROVIDER_SESSION_ID, close },
      hardExpiresAt: HARD_EXPIRES_AT,
    });

    await expect(Promise.all([
      authority.hangupCall(PROVIDER_SESSION_ID),
      registration.close(),
    ])).resolves.toEqual([undefined, undefined]);
    await expect(authority.hangupCall(PROVIDER_SESSION_ID)).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(authority.state()).toEqual({ activeConnections: 0, terminalProofs: 1 });
  });

  it('échoue fermé sur une autre réplique avant le hard cap', async () => {
    const authority = new MistralRealtimeTerminationAuthority(() => NOW);
    await expect(authority.hangupCall(PROVIDER_SESSION_ID)).rejects.toMatchObject({
      code: 'connection_not_local',
    });
    expect(authority.state()).toEqual({ activeConnections: 0, terminalProofs: 0 });
  });

  it('accepte sans egress uniquement une preuve DB post-hard-cap exactement liée', async () => {
    const authority = new MistralRealtimeTerminationAuthority(() => NOW);
    await expect(authority.hangupCall(PROVIDER_SESSION_ID, proof())).resolves.toBeUndefined();
    expect(authority.state()).toEqual({ activeConnections: 0, terminalProofs: 1 });

    const forged = new MistralRealtimeTerminationAuthority(() => NOW);
    await expect(forged.hangupCall(PROVIDER_SESSION_ID, proof({
      providerCallId: 'another_mistral_session',
    }))).rejects.toBeInstanceOf(MistralRealtimeTerminationError);
    await expect(forged.hangupCall(PROVIDER_SESSION_ID, proof({
      databaseObservedAt: new Date(NOW + 59_999).toISOString(),
    }))).rejects.toMatchObject({ code: 'invalid_hard_expiry_proof' });
  });

  it('tente toujours le close local avant d’utiliser la preuve hard-expired', async () => {
    const close = vi.fn(async () => {
      throw new Error('provider close unavailable');
    });
    const authority = new MistralRealtimeTerminationAuthority(() => NOW);
    authority.register({
      connection: { providerSessionId: PROVIDER_SESSION_ID, close },
      hardExpiresAt: HARD_EXPIRES_AT,
    });

    await expect(authority.hangupCall(PROVIDER_SESSION_ID)).rejects.toMatchObject({
      code: 'connection_close_unconfirmed',
    });
    await expect(authority.hangupCall(PROVIDER_SESSION_ID, proof())).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    expect(authority.state().activeConnections).toBe(0);
  });

  it('refuse les doublons de providerSessionId sans remplacer la connexion propriétaire', () => {
    const authority = new MistralRealtimeTerminationAuthority(() => NOW);
    authority.register({
      connection: { providerSessionId: PROVIDER_SESSION_ID, close: async () => undefined },
      hardExpiresAt: HARD_EXPIRES_AT,
    });
    expect(() => authority.register({
      connection: { providerSessionId: PROVIDER_SESSION_ID, close: async () => undefined },
      hardExpiresAt: HARD_EXPIRES_AT,
    })).toThrowError(MistralRealtimeTerminationError);
  });
});
