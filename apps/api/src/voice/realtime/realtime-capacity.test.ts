import { describe, expect, it } from 'vitest';
import {
  classifyRealtimeGlobalCapacityAuthority,
  realtimeGlobalCapacityMatches,
  type RealtimeGlobalCapacitySnapshot,
} from './realtime-capacity';

const expected = {
  providerId: 'openai' as const,
  providerModel: 'gpt-realtime-2.1',
  globalMaxSessions: 50,
  providerMaxSessions: 60,
  configVersion: 3,
};

function snapshot(
  overrides: Partial<RealtimeGlobalCapacitySnapshot> = {},
): RealtimeGlobalCapacitySnapshot {
  return {
    mode: 'active',
    providerId: 'openai',
    providerModel: 'gpt-realtime-2.1',
    globalMaxSessions: 50,
    providerMaxSessions: 60,
    configVersion: 3,
    retryAfterSeconds: 10,
    usedSessions: 7,
    revision: 11n,
    updatedAt: '2026-07-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('Realtime global capacity authority contract', () => {
  it('distingue l’autorité active de l’autorité fermée exacte du rollout', () => {
    expect(realtimeGlobalCapacityMatches(snapshot(), expected)).toBe(true);
    expect(classifyRealtimeGlobalCapacityAuthority(snapshot(), expected)).toBe('active_exact');

    const closed = snapshot({ mode: 'closed', usedSessions: 0 });
    expect(realtimeGlobalCapacityMatches(closed, expected)).toBe(false);
    expect(classifyRealtimeGlobalCapacityAuthority(closed, expected)).toBe('closed_safe');
  });

  it('accepte sous closed le drainage et les bindings N-1 sans ouvrir les admissions', () => {
    expect(classifyRealtimeGlobalCapacityAuthority(
      snapshot({
        mode: 'closed',
        providerModel: 'gpt-realtime-previous',
        globalMaxSessions: 40,
        providerMaxSessions: 45,
        configVersion: 2,
        usedSessions: 3,
      }),
      expected,
    )).toBe('closed_safe');
    expect(classifyRealtimeGlobalCapacityAuthority(
      snapshot({
        mode: 'closed',
        providerId: null,
        providerModel: null,
        globalMaxSessions: null,
        providerMaxSessions: null,
        configVersion: null,
        retryAfterSeconds: null,
        usedSessions: 3,
      }),
      expected,
    )).toBe('closed_safe');
  });

  it('refuse tracking et toute divergence active de binding', () => {
    expect(classifyRealtimeGlobalCapacityAuthority(
      snapshot({
        mode: 'tracking',
        providerId: null,
        providerModel: null,
        globalMaxSessions: null,
        providerMaxSessions: null,
        configVersion: null,
        retryAfterSeconds: null,
        usedSessions: 0,
      }),
      expected,
    )).toBe('invalid');
    expect(classifyRealtimeGlobalCapacityAuthority(
      snapshot({ mode: 'active', configVersion: 2 }),
      expected,
    )).toBe('invalid');
    expect(classifyRealtimeGlobalCapacityAuthority(
      snapshot({ mode: 'closed', usedSessions: -1 }),
      expected,
    )).toBe('invalid');
  });
});
