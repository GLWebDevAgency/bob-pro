import { createHash } from 'node:crypto';
import { ReleaseFlag } from '@bob/core';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env';
import type { Persistence } from '../../persistence/persistence';
import {
  agentMissionPrincipalBindingHash,
  buildRealtimeAgentMissionAdmissionGate,
  DisabledRealtimeAgentMissionAdmissionGate,
  DurableRealtimeAgentMissionAdmissionGate,
} from './realtime-agent-mission-admission';

const COMPANY_ID = 'company-1';
const USER_ID = 'user-1';

function releaseFlag(enabled: boolean) {
  return ReleaseFlag.rehydrate({
    id: 'flag-1',
    key: 'bob.agent_missions.quote.v1',
    environment: 'staging',
    globallyEnabled: enabled,
    killSwitchActive: false,
    subjectOverrides: [],
    version: 7,
    createdAt: '2026-07-26T10:00:00.000Z',
    updatedAt: '2026-07-26T10:00:00.000Z',
    updatedByUserId: 'system:test',
  });
}

function persistence(flag: ReturnType<typeof releaseFlag> | null) {
  const findByKey = vi.fn(async () => flag);
  const runWithIdentity = vi.fn(async <T>(
    _userId: string,
    operation: () => Promise<T>,
  ) => operation());
  return {
    value: {
      cabinet: { flags: { findByKey } },
      runWithIdentity,
    } as unknown as Pick<Persistence, 'cabinet' | 'runWithIdentity'>,
    findByKey,
    runWithIdentity,
  };
}

function v1Input() {
  return {
    negotiation: { requested: 'v1', protocolVersion: 1 } as const,
    companyId: COMPANY_ID,
    userId: USER_ID,
    providerId: 'openai' as const,
    transport: 'webrtc' as const,
    speechDelivery: 'openai-native-webrtc-v1' as const,
  };
}

describe('RealtimeAgentMissionAdmissionGate', () => {
  it('lie une capability canonique à la décision flag exécutée sous l’identité utilisateur', async () => {
    const store = persistence(releaseFlag(true));
    const gate = new DurableRealtimeAgentMissionAdmissionGate(
      store.value,
      'staging',
      () => Uint8Array.from({ length: 32 }, (_, index) => index),
    );

    const prepared = await gate.prepare(v1Input());

    expect(prepared.capability).toMatch(/^bam1_[A-Za-z0-9_-]{43}$/u);
    if (prepared.binding === null || prepared.capability === null) {
      throw new Error('Expected a durable AgentMission binding.');
    }
    expect(prepared.binding).toEqual({
      protocolVersion: 1,
      capabilityHash: createHash('sha256')
        .update(prepared.capability, 'utf8')
        .digest('hex'),
      releaseFlagKey: 'bob.agent_missions.quote.v1',
      releaseEnvironment: 'staging',
      releaseFlagVersion: 7,
      principalBindingHash: agentMissionPrincipalBindingHash(COMPANY_ID, USER_ID),
    });
    expect(store.runWithIdentity).toHaveBeenCalledWith(USER_ID, expect.any(Function));
    expect(store.findByKey).toHaveBeenCalledWith(
      'staging',
      'bob.agent_missions.quote.v1',
    );
  });

  it.each([
    {
      label: 'champ omis',
      patch: { negotiation: { requested: 'omitted' as const } },
    },
    {
      label: 'null explicite',
      patch: {
        negotiation: {
          requested: 'null' as const,
          protocolVersion: null,
        },
      },
    },
    {
      label: 'Mistral',
      patch: {
        providerId: 'mistral' as const,
        transport: 'mistral-pcm' as const,
        speechDelivery: 'audited-signed-url-v1' as const,
      },
    },
  ])('ne consulte ni flag ni entropy pour $label', async ({ patch }) => {
    const store = persistence(releaseFlag(true));
    const entropy = vi.fn(() => new Uint8Array(32));
    const gate = new DurableRealtimeAgentMissionAdmissionGate(
      store.value,
      'staging',
      entropy,
    );

    await expect(gate.prepare({ ...v1Input(), ...patch })).resolves.toEqual({
      capability: null,
      binding: null,
    });
    expect(store.runWithIdentity).not.toHaveBeenCalled();
    expect(entropy).not.toHaveBeenCalled();
  });

  it('ferme sans capability lorsque le flag manque, est OFF ou devient indisponible', async () => {
    for (const flag of [null, releaseFlag(false)]) {
      const store = persistence(flag);
      const entropy = vi.fn(() => new Uint8Array(32));
      const gate = new DurableRealtimeAgentMissionAdmissionGate(
        store.value,
        'staging',
        entropy,
      );
      await expect(gate.prepare(v1Input())).resolves.toEqual({
        capability: null,
        binding: null,
      });
      expect(entropy).not.toHaveBeenCalled();
    }

    const unavailable = persistence(releaseFlag(true));
    unavailable.runWithIdentity.mockRejectedValueOnce(new Error('RLS unavailable'));
    const gate = new DurableRealtimeAgentMissionAdmissionGate(
      unavailable.value,
      'staging',
    );
    await expect(gate.prepare(v1Input())).resolves.toEqual({
      capability: null,
      binding: null,
    });
  });

  it('garde le master OFF dormant sans lire un keyring', async () => {
    const store = persistence(releaseFlag(true));
    const gate = buildRealtimeAgentMissionAdmissionGate(
      store.value,
      {
        BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'false',
      } as Env,
    );
    expect(gate).toBeInstanceOf(DisabledRealtimeAgentMissionAdmissionGate);
    await expect(gate.prepare(v1Input())).resolves.toEqual({
      capability: null,
      binding: null,
    });
    expect(store.findByKey).not.toHaveBeenCalled();
  });

  it('rejette une identité non canonique avant de produire un hash stable', () => {
    const first = agentMissionPrincipalBindingHash(COMPANY_ID, USER_ID);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(agentMissionPrincipalBindingHash(COMPANY_ID, USER_ID)).toBe(first);
    expect(agentMissionPrincipalBindingHash(COMPANY_ID, 'user-2')).not.toBe(first);
    expect(() => agentMissionPrincipalBindingHash(COMPANY_ID, 'bad\u0000user'))
      .toThrow(/principal binding input is invalid/u);
  });
});
