import { createHash } from 'node:crypto';
import {
  CUSTOMER_CONTACT_MISSION_KIND_V1,
  QUOTE_CREATION_MISSION_KIND_V1,
  ReleaseFlag,
} from '@bob/core';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env';
import type { Persistence } from '../../persistence/persistence';
import {
  admittedRealtimeMissionKindIds,
  agentMissionPrincipalBindingHash,
  buildRealtimeAgentMissionAdmissionGate,
  DisabledRealtimeAgentMissionAdmissionGate,
  DurableRealtimeAgentMissionAdmissionGate,
} from './realtime-agent-mission-admission';

const COMPANY_ID = 'company-1';
const USER_ID = 'user-1';

function releaseFlag(
  enabled: boolean,
  key:
    'bob.agent_missions.quote.v1' | 'bob.agent_missions.quote.m2a' = 'bob.agent_missions.quote.v1',
) {
  return ReleaseFlag.rehydrate({
    id: 'flag-1',
    key,
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
  const runWithIdentity = vi.fn(async <T>(_userId: string, operation: () => Promise<T>) =>
    operation(),
  );
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
    speechDelivery: 'audited-signed-url-v1' as const,
  };
}

function v2Input() {
  return {
    ...v1Input(),
    negotiation: { requested: 'v2', protocolVersion: 2 } as const,
  };
}

describe('RealtimeAgentMissionAdmissionGate', () => {
  it('lie une capability canonique à la décision flag exécutée sous l’identité utilisateur', async () => {
    const store = persistence(releaseFlag(true));
    const gate = new DurableRealtimeAgentMissionAdmissionGate(store.value, 'staging', () =>
      Uint8Array.from({ length: 32 }, (_, index) => index),
    );

    const prepared = await gate.prepare(v1Input());

    expect(prepared.capability).toMatch(/^bam1_[A-Za-z0-9_-]{43}$/u);
    if (prepared.binding === null || prepared.capability === null) {
      throw new Error('Expected a durable AgentMission binding.');
    }
    expect(prepared.binding).toEqual({
      protocolVersion: 1,
      capabilityHash: createHash('sha256').update(prepared.capability, 'utf8').digest('hex'),
      releaseFlagKey: 'bob.agent_missions.quote.v1',
      releaseEnvironment: 'staging',
      releaseFlagVersion: 7,
      principalBindingHash: agentMissionPrincipalBindingHash(COMPANY_ID, USER_ID),
    });
    expect(store.runWithIdentity).toHaveBeenCalledWith(USER_ID, expect.any(Function));
    expect(store.findByKey).toHaveBeenCalledWith('staging', 'bob.agent_missions.quote.v1');
  });

  it('n’accorde V2 que sur son master et son release flag, sans fallback V1', async () => {
    const store = persistence(releaseFlag(true, 'bob.agent_missions.quote.m2a'));
    const entropy = vi.fn(() => Buffer.alloc(32, 21));
    const v1Only = new DurableRealtimeAgentMissionAdmissionGate(store.value, 'staging', entropy);
    await expect(v1Only.prepare(v2Input())).resolves.toEqual({
      capability: null,
      binding: null,
      admittedKinds: [],
    });
    expect(store.runWithIdentity).not.toHaveBeenCalled();
    expect(entropy).not.toHaveBeenCalled();

    const m2a = new DurableRealtimeAgentMissionAdmissionGate(
      store.value,
      'staging',
      entropy,
      [1, 2],
    );
    const prepared = await m2a.prepare(v2Input());
    expect(prepared.capability).toMatch(/^bam2_[A-Za-z0-9_-]{43}$/u);
    expect(prepared.binding).toMatchObject({
      protocolVersion: 2,
      releaseFlagKey: 'bob.agent_missions.quote.m2a',
      releaseEnvironment: 'staging',
      releaseFlagVersion: 7,
    });
    expect(store.findByKey).toHaveBeenCalledWith('staging', 'bob.agent_missions.quote.m2a');
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
    const gate = new DurableRealtimeAgentMissionAdmissionGate(store.value, 'staging', entropy);

    await expect(gate.prepare({ ...v1Input(), ...patch })).resolves.toEqual({
      capability: null,
      binding: null,
      admittedKinds: [],
    });
    expect(store.runWithIdentity).not.toHaveBeenCalled();
    expect(entropy).not.toHaveBeenCalled();
  });

  it('accorde la même Mission au rail OpenAI natif et expose un préflight sans capability jetable', async () => {
    const store = persistence(releaseFlag(true, 'bob.agent_missions.quote.m2a'));
    const entropy = vi.fn(() => Buffer.alloc(32, 24));
    const gate = new DurableRealtimeAgentMissionAdmissionGate(
      store.value,
      'staging',
      entropy,
      [1, 2],
    );
    const native = {
      ...v2Input(),
      speechDelivery: 'openai-native-webrtc-v1' as const,
    };

    await expect(
      gate.available({
        protocolVersion: 2,
        companyId: native.companyId,
        userId: native.userId,
        providerId: native.providerId,
        transport: native.transport,
        speechDelivery: native.speechDelivery,
      }),
    ).resolves.toBe(true);
    expect(entropy).not.toHaveBeenCalled();

    const prepared = await gate.prepare(native);
    expect(prepared.capability).toMatch(/^bam2_[A-Za-z0-9_-]{43}$/u);
    expect(prepared.binding).toMatchObject({
      protocolVersion: 2,
      releaseFlagKey: 'bob.agent_missions.quote.m2a',
      releaseFlagVersion: 7,
    });
    expect(entropy).toHaveBeenCalledOnce();
  });

  it('ferme sans capability lorsque le flag manque, est OFF ou devient indisponible', async () => {
    for (const flag of [null, releaseFlag(false)]) {
      const store = persistence(flag);
      const entropy = vi.fn(() => new Uint8Array(32));
      const gate = new DurableRealtimeAgentMissionAdmissionGate(store.value, 'staging', entropy);
      await expect(gate.prepare(v1Input())).resolves.toEqual({
        capability: null,
        binding: null,
        admittedKinds: [],
      });
      expect(entropy).not.toHaveBeenCalled();
    }

    const unavailable = persistence(releaseFlag(true));
    unavailable.runWithIdentity.mockRejectedValueOnce(new Error('RLS unavailable'));
    const gate = new DurableRealtimeAgentMissionAdmissionGate(unavailable.value, 'staging');
    await expect(gate.prepare(v1Input())).resolves.toEqual({
      capability: null,
      binding: null,
      admittedKinds: [],
    });
  });

  it('garde le master OFF dormant sans lire un keyring', async () => {
    const store = persistence(releaseFlag(true));
    const gate = buildRealtimeAgentMissionAdmissionGate(store.value, {
      BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'false',
      BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED: 'false',
    } as Env);
    expect(gate).toBeInstanceOf(DisabledRealtimeAgentMissionAdmissionGate);
    await expect(
      gate.available({
        protocolVersion: 2,
        companyId: COMPANY_ID,
        userId: USER_ID,
        providerId: 'openai',
        transport: 'webrtc',
        speechDelivery: 'openai-native-webrtc-v1',
      }),
    ).resolves.toBe(false);
    await expect(gate.prepare(v1Input())).resolves.toEqual({
      capability: null,
      binding: null,
      admittedKinds: [],
    });
    expect(store.findByKey).not.toHaveBeenCalled();
  });

  it('rejette une identité non canonique avant de produire un hash stable', () => {
    const first = agentMissionPrincipalBindingHash(COMPANY_ID, USER_ID);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(agentMissionPrincipalBindingHash(COMPANY_ID, USER_ID)).toBe(first);
    expect(agentMissionPrincipalBindingHash(COMPANY_ID, 'user-2')).not.toBe(first);
    expect(() => agentMissionPrincipalBindingHash(COMPANY_ID, 'bad\u0000user')).toThrow(
      /principal binding input is invalid/u,
    );
  });
});

/**
 * Contrat nommé de la composition boot-time (matrice des masters, incident « signature B »).
 *
 * L'incident de référence : un APK V1 terrain voyait ses sessions tuées < 1 s après le SDP.
 * La cause compatible avec les observations est un `null/null` rendu à une demande `v1`
 * pendant une opération staging (flag DB V1 coupé ou master muté en vol) — le vieux transport
 * ferme alors la session APRÈS un bootstrap réussi. Ce bloc fige la table de décision de
 * l'admission composée par `buildRealtimeAgentMissionAdmissionGate` avec les env RÉELLES :
 * le remède est OPÉRATIONNEL (la matrice §17.3 exige V1 master ET flag DB v1 actifs pendant
 * toute activation préview M2-A ; `assertM2A3PreviewOff` verrouille le `false` explicite).
 * La moitié wire du contrat — `null/null` n'est jamais un 4xx et le bootstrap continue avec
 * son `answerSdp` — est prouvée par realtime-agent-mission-negotiation.test.ts et
 * realtime.service.test.ts ; ici on prouve la DÉCISION d'admission, rien de plus.
 */
describe('contrat nommé — matrice des masters V1/M2-A (reproduction de la signature B)', () => {
  const keyringEnv = {
    CABINET_RELEASE_ENV: 'staging',
    BOB_AGENT_MISSION_HMAC_KEY_VERSION: 1,
    BOB_AGENT_MISSION_HMAC_KEYRING: JSON.stringify({
      1: Buffer.alloc(32, 11).toString('base64url'),
    }),
  };

  it('sert un client V1 terrain pendant le préview : V1 master ON + flag DB v1 ON → capability littérale bam1_', async () => {
    const store = persistence(releaseFlag(true));
    const gate = buildRealtimeAgentMissionAdmissionGate(store.value, {
      ...keyringEnv,
      BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
      BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED: 'false',
    } as Env);

    const prepared = await gate.prepare(v1Input());

    expect(prepared.capability).toMatch(/^bam1_[A-Za-z0-9_-]{43}$/u);
    expect(prepared.binding).toMatchObject({
      protocolVersion: 1,
      releaseFlagKey: 'bob.agent_missions.quote.v1',
      releaseEnvironment: 'staging',
    });
    expect(store.findByKey).toHaveBeenCalledWith('staging', 'bob.agent_missions.quote.v1');
  });

  it('signature B contractuelle : demande v1 avec flag DB v1 OFF → null/null (jamais un refus HTTP)', async () => {
    // C'est exactement l'état serveur qui a produit l'incident terrain : le client V1 reçoit
    // un bootstrap SANS capability et se ferme lui-même. Le test documente que cette réponse
    // est bien la sortie contractuelle — la prévention est opérationnelle (§17.3), pas du code.
    const store = persistence(releaseFlag(false));
    const gate = buildRealtimeAgentMissionAdmissionGate(store.value, {
      ...keyringEnv,
      BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
      BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED: 'true',
    } as Env);

    await expect(gate.prepare(v1Input())).resolves.toEqual({
      capability: null,
      binding: null,
      admittedKinds: [],
    });
  });

  it('master M2-A littéralement false → demande v2 null/null sans même consulter le flag DB m2a', async () => {
    const store = persistence(releaseFlag(true, 'bob.agent_missions.quote.m2a'));
    const gate = buildRealtimeAgentMissionAdmissionGate(store.value, {
      ...keyringEnv,
      BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
      BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED: 'false',
    } as Env);

    await expect(gate.prepare(v2Input())).resolves.toEqual({
      capability: null,
      binding: null,
      admittedKinds: [],
    });
    expect(store.findByKey).not.toHaveBeenCalled();
    expect(store.runWithIdentity).not.toHaveBeenCalled();
  });

  it('master M2-A ON sans flag DB m2a → null/null, jamais un repli V1 silencieux', async () => {
    const store = persistence(null);
    const gate = buildRealtimeAgentMissionAdmissionGate(store.value, {
      ...keyringEnv,
      BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED: 'true',
      BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED: 'true',
    } as Env);

    await expect(gate.prepare(v2Input())).resolves.toEqual({
      capability: null,
      binding: null,
      admittedKinds: [],
    });
    expect(store.findByKey).toHaveBeenCalledWith('staging', 'bob.agent_missions.quote.m2a');
    expect(store.findByKey).not.toHaveBeenCalledWith('staging', 'bob.agent_missions.quote.v1');
  });
});

// ---------------------------------------------------------------------------
// U1-d — admission PAR KIND : un flag par vertical, OFF par défaut
// ---------------------------------------------------------------------------

function keyedPersistence(enabledKeys: readonly string[]) {
  const findByKey = vi.fn(
    async (_environment: 'development' | 'staging' | 'production', key: string) =>
      enabledKeys.includes(key)
        ? ReleaseFlag.rehydrate({
            id: `flag-${key}`,
            key,
            environment: 'staging',
            globallyEnabled: true,
            killSwitchActive: false,
            subjectOverrides: [],
            version: 7,
            createdAt: '2026-07-26T10:00:00.000Z',
            updatedAt: '2026-07-26T10:00:00.000Z',
            updatedByUserId: 'system:test',
          })
        : null,
  );
  const runWithIdentity = vi.fn(async <T>(_userId: string, operation: () => Promise<T>) =>
    operation(),
  );
  return {
    value: {
      cabinet: { flags: { findByKey } },
      runWithIdentity,
    } as unknown as Pick<Persistence, 'cabinet' | 'runWithIdentity'>,
    findByKey,
  };
}

describe('RealtimeAgentMissionAdmissionGate — kinds admis (U1-d)', () => {
  it('n’admet la fiche client QUE si son propre flag est activé', async () => {
    const closed = keyedPersistence(['bob.agent_missions.quote.v1']);
    const closedGate = new DurableRealtimeAgentMissionAdmissionGate(closed.value, 'staging');

    const withoutContact = await closedGate.prepare(v1Input());

    expect(admittedRealtimeMissionKindIds(withoutContact)).toEqual([
      QUOTE_CREATION_MISSION_KIND_V1,
    ]);
    expect(closed.findByKey).toHaveBeenCalledWith(
      'staging',
      'bob.agent_missions.customer_contact.v1',
    );

    const open = keyedPersistence([
      'bob.agent_missions.quote.v1',
      'bob.agent_missions.customer_contact.v1',
    ]);
    const openGate = new DurableRealtimeAgentMissionAdmissionGate(open.value, 'staging');

    const withContact = await openGate.prepare(v1Input());

    expect(admittedRealtimeMissionKindIds(withContact)).toEqual([
      QUOTE_CREATION_MISSION_KIND_V1,
      CUSTOMER_CONTACT_MISSION_KIND_V1,
    ]);
    expect(withContact.admittedKinds[1]).toEqual({
      missionKindId: CUSTOMER_CONTACT_MISSION_KIND_V1,
      releaseFlagKey: 'bob.agent_missions.customer_contact.v1',
      releaseEnvironment: 'staging',
      releaseFlagVersion: 7,
    });
    // La lease reste scellée par la clé devis : le binding persisté n'est pas élargi.
    expect(withContact.binding?.releaseFlagKey).toBe('bob.agent_missions.quote.v1');
  });

  it('n’admet aucun kind sans lease agent-mission', async () => {
    const gate = new DisabledRealtimeAgentMissionAdmissionGate();

    const prepared = await gate.prepare(v1Input());

    expect(prepared.capability).toBeNull();
    expect(admittedRealtimeMissionKindIds(prepared)).toEqual([]);
  });
});
