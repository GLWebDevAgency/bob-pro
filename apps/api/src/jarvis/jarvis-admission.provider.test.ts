import {
  ACTION_CATALOG_V0,
  type AgentMissionFingerprint,
  type AgentMissionFingerprintPort,
  type JarvisAdmissionResult,
  type JarvisRunEnvelope,
  type JarvisStatelessReadResult,
  type JarvisSystemAdmissionEnvelope,
  type JarvisUserAdmissionEnvelope,
} from '@bob/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AGENT_MISSION_FINGERPRINTS } from '../agent-missions/agent-mission-fingerprint.provider';
import { JARVIS_DISPATCH_ADMISSION } from '../jobs/jarvis-work-item-dispatch.service';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import type { JarvisAdmissionDeps } from '../persistence/prisma/jarvis-admission.persistence';

import {
  JARVIS_CANONICALIZATION_VERSION,
  buildJarvisAdmission,
  jarvisAdmissionEnabled,
  jarvisAdmissionProvider,
  jarvisAdmissionUnitOfWork,
  jarvisDispatchAdmissionProvider,
  type JarvisAdmissionUnitOfWorkAuthority,
} from './jarvis-admission.provider';
import { JARVIS_ACTION_RELEASE_POLICY, JARVIS_ADMISSION } from './jarvis.tokens';

const ORIGINAL_KILL_SWITCH = process.env.BOB_JARVIS_ADMISSION_ENABLED;

const ADMITTED: JarvisAdmissionResult = {
  status: 'admitted',
  postimage: {
    kind: 'customer_contact',
    runId: '20000000-0000-4000-8000-000000000001',
    companyId: 'company-1',
    createdBy: 'owner-1',
    definitionVersion: 1,
    status: 'waiting_user',
    revision: 2,
    stateVersion: 1,
    state: null,
    nextWakeAt: null,
    terminalAt: null,
  },
  eventSequence: 2,
  workItemIds: [],
};

const TEST_FINGERPRINTS: AgentMissionFingerprintPort = {
  sign(): AgentMissionFingerprint | null {
    return { keyVersion: 1, hmac: 'a'.repeat(64) };
  },
  matches(): boolean | null {
    return true;
  },
};

function userEnvelope(): JarvisUserAdmissionEnvelope {
  return {
    companyId: 'company-1',
    ownerUserId: 'owner-1',
    kind: 'customer_contact',
    definitionVersion: 1,
    runId: '20000000-0000-4000-8000-000000000001',
    commandId: '30000000-0000-4000-8000-000000000001',
    expectedRevision: 1,
    actionId: 'client-creer',
    actionVersion: 1,
    authority: { source: 'authenticated_principal', principalBindingHash: 'b'.repeat(64) },
    command: { type: 'cancel_run', reason: 'user_cancelled' },
    canonicalInputDigest: 'c'.repeat(64),
    occurredAt: '2026-08-19T10:00:00.000Z',
  };
}

/** UoW capable : la forme exacte que la persistance expose (deps par appel). */
class RecordingUnitOfWork implements JarvisAdmissionUnitOfWorkAuthority {
  readonly deps: JarvisAdmissionDeps[] = [];

  runJarvisAdmission(
    _envelope: JarvisUserAdmissionEnvelope,
    deps: JarvisAdmissionDeps,
  ): Promise<JarvisAdmissionResult> {
    this.deps.push(deps);
    return Promise.resolve(ADMITTED);
  }

  runJarvisSystemAdmission(
    _envelope: JarvisSystemAdmissionEnvelope,
    deps: JarvisAdmissionDeps,
  ): Promise<JarvisAdmissionResult> {
    this.deps.push(deps);
    return Promise.resolve(ADMITTED);
  }

  async readJarvisStateless<T>(
    _owner: { readonly companyId: string; readonly ownerUserId: string },
    read: (view: {
      readonly runById: (runId: string) => Promise<JarvisRunEnvelope | null>;
    }) => Promise<T>,
  ): Promise<JarvisStatelessReadResult<T>> {
    return {
      status: 'executed',
      value: await read({ runById: () => Promise.resolve(null) }),
      readAt: '2026-08-19T10:00:00.000Z',
    };
  }
}

function persistenceWith(unitOfWork: unknown): Pick<Persistence, 'createAgentMissionUnitOfWork'> {
  return {
    createAgentMissionUnitOfWork: () => unitOfWork,
  } as unknown as Pick<Persistence, 'createAgentMissionUnitOfWork'>;
}

afterEach(() => {
  if (ORIGINAL_KILL_SWITCH === undefined) delete process.env.BOB_JARVIS_ADMISSION_ENABLED;
  else process.env.BOB_JARVIS_ADMISSION_ENABLED = ORIGINAL_KILL_SWITCH;
  vi.restoreAllMocks();
});

describe('kill switch d’admission Jarvis', () => {
  it('est fermé par défaut et ne s’ouvre que par la valeur littérale « true »', () => {
    delete process.env.BOB_JARVIS_ADMISSION_ENABLED;
    expect(jarvisAdmissionEnabled()).toBe(false);
    process.env.BOB_JARVIS_ADMISSION_ENABLED = 'true';
    expect(jarvisAdmissionEnabled()).toBe(true);
    process.env.BOB_JARVIS_ADMISSION_ENABLED = 'false';
    expect(jarvisAdmissionEnabled()).toBe(false);
    process.env.BOB_JARVIS_ADMISSION_ENABLED = 'TRUE';
    expect(jarvisAdmissionEnabled()).toBe(false);
  });

  it('se coupe À CHAUD : la MÊME instance d’adapter change de deps entre deux appels', async () => {
    process.env.BOB_JARVIS_ADMISSION_ENABLED = 'true';
    const unitOfWork = new RecordingUnitOfWork();
    const admission = buildJarvisAdmission(persistenceWith(unitOfWork), TEST_FINGERPRINTS);
    expect(admission).not.toBeNull();

    await admission?.runJarvisAdmission(userEnvelope());
    process.env.BOB_JARVIS_ADMISSION_ENABLED = 'false';
    await admission?.runJarvisAdmission(userEnvelope());

    expect(unitOfWork.deps.map((deps) => deps.admissionEnabled)).toEqual([true, false]);
  });
});

describe('adapter du port mono-argument (§5.2/§17)', () => {
  it('passe le keyring quote, la version de canonicalisation et REFUSE la fixture de certification', async () => {
    const unitOfWork = new RecordingUnitOfWork();
    const admission = buildJarvisAdmission(persistenceWith(unitOfWork), TEST_FINGERPRINTS);

    await admission?.runJarvisAdmission(userEnvelope());

    expect(unitOfWork.deps).toHaveLength(1);
    expect(unitOfWork.deps[0]?.fingerprints).toBe(TEST_FINGERPRINTS);
    expect(unitOfWork.deps[0]?.canonicalizationVersion).toBe(JARVIS_CANONICALIZATION_VERSION);
    expect(JARVIS_CANONICALIZATION_VERSION).toBe(1);
    expect(unitOfWork.deps[0]?.allowCertificationAuthority).toBe(false);
    const entry = ACTION_CATALOG_V0.find(
      (candidate) => candidate.actionId === 'client-modifier' && candidate.version === 1,
    );
    expect(entry).toBeDefined();
    expect(
      unitOfWork.deps[0]?.actionReleasePolicy.isPublished(
        {
          companyId: 'company-1',
          ownerUserId: 'owner-1',
          actionId: 'client-modifier',
          actionVersion: 1,
        },
        entry!,
      ),
    ).toBe(false);
  });

  it('sert AUSSI les signaux système et la lecture stateless avec les mêmes deps', async () => {
    const unitOfWork = new RecordingUnitOfWork();
    const admission = buildJarvisAdmission(persistenceWith(unitOfWork), TEST_FINGERPRINTS);

    await admission?.runJarvisSystemAdmission({
      companyId: 'company-1',
      ownerUserId: 'owner-1',
      kind: 'customer_contact',
      definitionVersion: 1,
      runId: '20000000-0000-4000-8000-000000000001',
      commandId: '40000000-0000-8000-8000-000000000001',
      expectedRevision: 2,
      command: { type: 'record_effect_receipt' },
      subject: {
        type: 'effect_observation',
        observationKind: 'effect_receipt',
        observationDigest: null,
        effectId: '50000000-0000-4000-8000-000000000001',
      },
      occurredAt: '2026-08-19T10:00:00.000Z',
    });
    const read = await admission?.readJarvisStateless(
      { companyId: 'company-1', ownerUserId: 'owner-1' },
      (view) => view.runById('20000000-0000-4000-8000-000000000001'),
    );

    expect(unitOfWork.deps[0]?.allowCertificationAuthority).toBe(false);
    expect(read).toEqual({
      status: 'executed',
      value: null,
      readAt: '2026-08-19T10:00:00.000Z',
    });
  });
});

describe('résolution fail-closed de l’autorité transactionnelle', () => {
  it('refuse un adapter de persistance sans UoW (null) — jamais une écriture à l’aveugle', () => {
    expect(jarvisAdmissionUnitOfWork(persistenceWith(null))).toBeNull();
    expect(buildJarvisAdmission(persistenceWith(null), TEST_FINGERPRINTS)).toBeNull();
  });

  it('refuse un UoW qui ne sait PAS prouver l’admission Jarvis (double mémoire)', () => {
    const halfAuthority = {
      readQuoteCreationOwner: () => Promise.reject(new Error('non pertinent')),
      runQuoteCreationOwner: () => Promise.reject(new Error('non pertinent')),
    };
    expect(jarvisAdmissionUnitOfWork(persistenceWith(halfAuthority))).toBeNull();
    expect(buildJarvisAdmission(persistenceWith(halfAuthority), TEST_FINGERPRINTS)).toBeNull();
  });

  it('accepte le UoW complet — et c’est la SEULE surface consommée', () => {
    const unitOfWork = new RecordingUnitOfWork();
    expect(jarvisAdmissionUnitOfWork(persistenceWith(unitOfWork))).toBe(unitOfWork);
  });
});

describe('providers du vertical', () => {
  it('injecte la persistance et le keyring quote, sans jamais re-déclarer de signeur', () => {
    expect(jarvisAdmissionProvider).toMatchObject({
      provide: JARVIS_ADMISSION,
      inject: [PERSISTENCE, AGENT_MISSION_FINGERPRINTS, JARVIS_ACTION_RELEASE_POLICY],
      useFactory: buildJarvisAdmission,
    });
  });

  it('donne au worker de dispatch LA MÊME instance (useExisting, jamais une seconde fabrique)', () => {
    expect(jarvisDispatchAdmissionProvider).toEqual({
      provide: JARVIS_DISPATCH_ADMISSION,
      useExisting: JARVIS_ADMISSION,
    });
  });
});
