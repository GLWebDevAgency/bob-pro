import { Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type {
  JarvisAdmissionOwner,
  JarvisAdmissionResult,
  JarvisAdmissionUnitOfWorkPort,
  JarvisProposalPayloadStorePort,
  JarvisProposalPayloadV1,
  JarvisRunEnvelope,
  JarvisStatelessReadResult,
} from '@bob/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentMissionModule } from '../agent-missions/agent-mission.module';
import { AGENT_MISSION_FINGERPRINTS } from '../agent-missions/agent-mission-fingerprint.provider';
import { AppModule } from '../app.module';
import { CustomerUpdateAuthority } from '../customers/customer-update.authority';
import { CustomerUpdateModule } from '../customers/customer-update.module';
import { DOCUMENT_STORAGE, UnavailableDocumentStorage } from '../documents/storage';
import { JarvisCustomerEffectExecutor } from '../jobs/jarvis-customer-effect.executor';
import type { JarvisCustomerEffectAuthority } from '../jobs/jarvis-customer-effect.executor';
import {
  JARVIS_DISPATCH_ADMISSION,
  JARVIS_DISPATCH_RUN_DIRECTORY,
  JARVIS_WORK_ITEMS_DISPATCH,
  JARVIS_EFFECT_EXECUTORS,
} from '../jobs/jarvis-work-item-dispatch.service';
import { JARVIS_CUSTOMER_EFFECT_AUTHORITY } from './jarvis-admission.provider';
import { AppLogger } from '../observability/logger';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import { InMemoryPersistence } from '../persistence/persistence.testing';
import type { JarvisAdmissionDeps } from '../persistence/prisma/jarvis-admission.persistence';
import {
  PrismaJarvisProposalPayloadStore,
} from '../persistence/prisma/jarvis-proposal-payloads.persistence';
import { PrismaPersistence } from '../persistence/prisma/prisma-persistence';
import type { PrismaService } from '../persistence/prisma/prisma.service';
import { RealtimeVoiceModule } from '../voice/realtime/realtime.module';

import {
  jarvisAdmissionProvider,
  jarvisDispatchAdmissionProvider,
} from './jarvis-admission.provider';
import { JarvisRunController, jarvisTapAuthorityProvider } from './jarvis-run.controller';
import {
  JarvisModule,
  buildJarvisCustomerEffectExecutors,
  buildJarvisProposalPayloadStore,
  jarvisActionReleasePolicyProvider,
} from './jarvis.module';
import {
  JARVIS_ACTION_RELEASE_POLICY,
  JARVIS_ADMISSION,
  JARVIS_PROPOSAL_PAYLOAD_STORE,
} from './jarvis.tokens';

function metadata(key: string, target: unknown): readonly unknown[] {
  return (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];
}

/** UoW capable, minimal : la surface exacte que la persistance réelle expose. */
const CAPABLE_UNIT_OF_WORK = {
  runJarvisAdmission(
    _envelope: unknown,
    _deps: JarvisAdmissionDeps,
  ): Promise<JarvisAdmissionResult> {
    return Promise.resolve({ status: 'command_conflict' });
  },
  runJarvisSystemAdmission(
    _envelope: unknown,
    _deps: JarvisAdmissionDeps,
  ): Promise<JarvisAdmissionResult> {
    return Promise.resolve({ status: 'command_conflict' });
  },
  async readJarvisStateless<T>(
    _owner: JarvisAdmissionOwner,
    read: (view: {
      readonly runById: (runId: string) => Promise<JarvisRunEnvelope | null>;
    }) => Promise<T>,
  ): Promise<JarvisStatelessReadResult<T>> {
    return {
      status: 'executed',
      value: await read({ runById: () => Promise.resolve(null) }),
      readAt: '2026-08-19T10:00:00.000Z',
    };
  },
};

const FAKE_ADMISSION = {
  runJarvisAdmission: () => Promise.resolve<JarvisAdmissionResult>({ status: 'command_conflict' }),
  runJarvisSystemAdmission: () =>
    Promise.resolve<JarvisAdmissionResult>({ status: 'command_conflict' }),
  readJarvisStateless: () =>
    Promise.reject(new Error('non pertinent')),
} as unknown as JarvisAdmissionUnitOfWorkPort;

const FAKE_PAYLOADS = {
  sealProposalPayload: () => Promise.resolve({ status: 'unavailable' as const }),
  readProposalPayload: () => Promise.resolve<JarvisProposalPayloadV1 | null>(null),
} satisfies JarvisProposalPayloadStorePort;

const FAKE_CUSTOMERS = {
  readCustomer: () => Promise.resolve(null),
  createCustomer: () => Promise.resolve({ status: 'unavailable' as const }),
  updateCustomerAtRevision: () => Promise.resolve({ status: 'unavailable' as const }),
} satisfies JarvisCustomerEffectAuthority;

/**
 * Consommateur EXTERNE du jeton, calqué sur `RealtimeVoiceModule` : il importe `JarvisModule` et
 * injecte le magasin. C'est la seule façon de prouver un EXPORT — un jeton fourni mais non
 * exporté reste invisible ici.
 */
const VOICE_LIKE_CONSUMER = Symbol('VOICE_LIKE_CONSUMER');

@Module({
  imports: [JarvisModule],
  providers: [
    {
      provide: VOICE_LIKE_CONSUMER,
      inject: [JARVIS_PROPOSAL_PAYLOAD_STORE],
      useFactory: (payloads: JarvisProposalPayloadStorePort | null) => payloads,
    },
  ],
  exports: [VOICE_LIKE_CONSUMER],
})
class VoiceLikeConsumerModule {}

afterEach(() => vi.restoreAllMocks());

describe('tranche verticale Jarvis (U1-d)', () => {
  it('est importée par AppModule et déclare elle-même ses providers', () => {
    expect(metadata(MODULE_METADATA.IMPORTS, AppModule)).toContain(JarvisModule);
    expect(metadata(MODULE_METADATA.IMPORTS, AppModule)).toContain(CustomerUpdateModule);
    expect(metadata(MODULE_METADATA.CONTROLLERS, JarvisModule)).toEqual([JarvisRunController]);
    const providers = metadata(MODULE_METADATA.PROVIDERS, JarvisModule);
    expect(providers).toContain(jarvisActionReleasePolicyProvider);
    expect(providers).toContain(jarvisAdmissionProvider);
    expect(providers).toContain(jarvisDispatchAdmissionProvider);
    expect(providers).toContain(jarvisTapAuthorityProvider);
    // AppModule ne recopie AUCUN provider du vertical : la DI testée est celle du runtime.
    const appProviders = metadata(MODULE_METADATA.PROVIDERS, AppModule);
    expect(appProviders).not.toContain(jarvisAdmissionProvider);
    expect(appProviders).not.toContain(jarvisTapAuthorityProvider);
  });

  it('importe ses dépendances et l’autorité client canonique — sans service historique', () => {
    expect(metadata(MODULE_METADATA.IMPORTS, JarvisModule)).toHaveLength(4);
    expect(metadata(MODULE_METADATA.IMPORTS, JarvisModule)).toContain(AgentMissionModule);
    expect(metadata(MODULE_METADATA.IMPORTS, JarvisModule)).toContain(CustomerUpdateModule);
  });

  it('EXPORTE ce qui est injecté hors du module (worker de dispatch d’AppModule)', () => {
    const exports = metadata(MODULE_METADATA.EXPORTS, JarvisModule);
    expect(exports).toContain(JARVIS_ACTION_RELEASE_POLICY);
    expect(exports).toContain(JARVIS_ADMISSION);
    expect(exports).toContain(JARVIS_DISPATCH_ADMISSION);
    // Injecté par `RealtimeVoiceModule` (voix) : non exporté, il resterait invisible donc nul.
    expect(exports).toContain(JARVIS_PROPOSAL_PAYLOAD_STORE);
    expect(exports).toContain(JARVIS_EFFECT_EXECUTORS);
    // Aucun export fantôme : tout ce qui sort est fourni ici.
    const providers = metadata(MODULE_METADATA.PROVIDERS, JarvisModule);
    for (const exported of exports) {
      expect(providers.some((provider) =>
        provider === exported
        || (typeof provider === 'object'
          && provider !== null
          && (provider as { provide?: unknown }).provide === exported))).toBe(true);
    }
  });

  it('reçoit le keyring HMAC du devis, EXPORTÉ — jamais un second signeur', () => {
    expect(metadata(MODULE_METADATA.EXPORTS, AgentMissionModule))
      .toContain(AGENT_MISSION_FINGERPRINTS);
  });

  it('est importée par RealtimeVoiceModule : la voix voit enfin l’admission (TODO vague A)', () => {
    expect(metadata(MODULE_METADATA.IMPORTS, RealtimeVoiceModule)).toContain(JarvisModule);
  });
});

describe('registre d’exécuteurs d’effets du worker', () => {
  it('ouvre EXACTEMENT les deux actions du lot, sur une seule instance d’exécuteur', () => {
    const registry = buildJarvisCustomerEffectExecutors({
      admission: FAKE_ADMISSION,
      payloads: FAKE_PAYLOADS,
      customers: FAKE_CUSTOMERS,
    });

    expect([...registry.keys()].sort()).toEqual(['client-creer@1', 'client-modifier@1']);
    expect(registry.get('client-creer@1')).toBeInstanceOf(JarvisCustomerEffectExecutor);
    expect(registry.get('client-creer@1')).toBe(registry.get('client-modifier@1'));
  });

  it('reste VIDE tant qu’une dépendance manque — jamais un effet sans son autorité', () => {
    expect(buildJarvisCustomerEffectExecutors({
      admission: null,
      payloads: FAKE_PAYLOADS,
      customers: FAKE_CUSTOMERS,
    }).size).toBe(0);
    expect(buildJarvisCustomerEffectExecutors({
      admission: FAKE_ADMISSION,
      payloads: null,
      customers: FAKE_CUSTOMERS,
    }).size).toBe(0);
    expect(buildJarvisCustomerEffectExecutors({
      admission: FAKE_ADMISSION,
      payloads: FAKE_PAYLOADS,
      customers: null,
    }).size).toBe(0);
  });
});

describe('magasin PII des propositions (§5.5) — la liaison de persistance', () => {
  it('branche l’adapter Prisma RÉEL sur LE client de la persistance, jamais un second', () => {
    const prisma = {} as PrismaService;
    const persistence = {
      prisma,
      createJarvisProposalPayloadStore:
        PrismaPersistence.prototype.createJarvisProposalPayloadStore,
    } as unknown as Pick<Persistence, 'createJarvisProposalPayloadStore'>;

    const store = buildJarvisProposalPayloadStore(persistence);

    expect(store).toBeInstanceOf(PrismaJarvisProposalPayloadStore);
    // Même connexion ⇒ mêmes GUC (`withIsolatedOwner` + `app.current_agent_mission_id`), donc
    // mêmes policies RLS que le reste du vertical. Un second client les contournerait.
    expect((store as unknown as { prisma: PrismaService }).prisma).toBe(prisma);
  });

  it('reste FERMÉ sur un adapter incapable de prouver RLS, sceau et rétention', () => {
    expect(buildJarvisProposalPayloadStore(new InMemoryPersistence())).toBeNull();
  });
});

describe('graphe d’injection réel', () => {
  /** Persistance minimale du boot : ce que JarvisModule consomme, et rien d’autre. */
  function bootPersistence(store: JarvisProposalPayloadStorePort | null) {
    return {
      createAgentMissionUnitOfWork: vi.fn(() => CAPABLE_UNIT_OF_WORK),
      createJarvisProposalPayloadStore: vi.fn(() => store),
      createJarvisCustomerEffectAuthority: vi.fn(() => null),
    };
  }

  function compileJarvis(persistence: ReturnType<typeof bootPersistence>) {
    return Test.createTestingModule({ imports: [JarvisModule] })
      .overrideProvider(PERSISTENCE)
      .useValue(persistence as unknown as Persistence)
      .overrideProvider(DOCUMENT_STORAGE)
      .useValue(new UnavailableDocumentStorage())
      .overrideProvider(AppLogger)
      .useValue({ audit: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() })
      .overrideProvider(AGENT_MISSION_FINGERPRINTS)
      .useValue({ sign: () => null, matches: () => null })
      .compile();
  }

  it('compile, sert le controller et donne au worker LA MÊME instance d’admission', async () => {
    const persistence = bootPersistence(FAKE_PAYLOADS);
    const moduleRef = await compileJarvis(persistence);

    try {
      expect(moduleRef.get(JarvisRunController)).toBeInstanceOf(JarvisRunController);
      const admission = moduleRef.get(JARVIS_ADMISSION);
      expect(admission).not.toBeNull();
      expect(moduleRef.get(JARVIS_DISPATCH_ADMISSION)).toBe(admission);
    } finally {
      await moduleRef.close();
    }
  });

  it('RÉSOUT le magasin PII — une seule instance, prise sur la persistance', async () => {
    const persistence = bootPersistence(FAKE_PAYLOADS);
    const moduleRef = await compileJarvis(persistence);

    try {
      // Le jeton cesse de résoudre `null` : c'est LA correction de cette PR (revue C2/C5/C13).
      expect(moduleRef.get(JARVIS_PROPOSAL_PAYLOAD_STORE)).toBe(FAKE_PAYLOADS);
      // Le controller tactile reçoit CETTE instance, pas une seconde fabrique.
      expect(
        (moduleRef.get(JarvisRunController) as unknown as {
          payloads: JarvisProposalPayloadStorePort | null;
        }).payloads,
      ).toBe(FAKE_PAYLOADS);
      expect(persistence.createJarvisProposalPayloadStore).toHaveBeenCalledTimes(1);
    } finally {
      await moduleRef.close();
    }
  });

  it('EXPORTE le magasin : un module importateur (la voix) le résout vraiment', async () => {
    // Forme EXACTE de l'incident du 20/07 : un jeton non exporté reste invisible au module qui
    // l'importe. Ici l'injection est REQUISE — sans export, cette compilation lèverait
    // `UnknownDependenciesException` au lieu de rendre silencieusement `null`.
    const persistence = bootPersistence(FAKE_PAYLOADS);
    const moduleRef = await Test.createTestingModule({ imports: [VoiceLikeConsumerModule] })
      .overrideProvider(PERSISTENCE)
      .useValue(persistence as unknown as Persistence)
      .overrideProvider(DOCUMENT_STORAGE)
      .useValue(new UnavailableDocumentStorage())
      .overrideProvider(AppLogger)
      .useValue({ audit: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() })
      .overrideProvider(AGENT_MISSION_FINGERPRINTS)
      .useValue({ sign: () => null, matches: () => null })
      .compile();

    try {
      expect(moduleRef.get(VOICE_LIKE_CONSUMER)).toBe(FAKE_PAYLOADS);
    } finally {
      await moduleRef.close();
    }
  });

  it('sur un adapter incapable, le jeton vaut null et le boot reste vert', async () => {
    const persistence = bootPersistence(null);
    const moduleRef = await compileJarvis(persistence);

    try {
      expect(moduleRef.get(JARVIS_PROPOSAL_PAYLOAD_STORE)).toBeNull();
      expect((moduleRef.get(JARVIS_EFFECT_EXECUTORS) as ReadonlyMap<string, unknown>).size).toBe(0);
    } finally {
      await moduleRef.close();
    }
  });

  it('U1-f : une persistance COMPLÈTE arme la chaîne — dispatch, annuaire, autorité, registre', async () => {
    // LE FAIT QUE CE LOT ÉTABLIT. Jusqu'ici `JARVIS_WORK_ITEMS_DISPATCH` et
    // `JARVIS_DISPATCH_RUN_DIRECTORY` n'étaient liés par AUCUN provider : le worker rendait
    // `dependencies_absent` à chaque minute et un `confirm` d'artisan n'écrivait JAMAIS sa fiche.
    // Ici la persistance porte les trois fabriques : les trois jetons se résolvent NON NULS et
    // le registre ouvre les deux actions du lot. C'est la preuve d'ARMEMENT, pas de câblage.
    const dispatch = { claimDue: vi.fn(), listPendingSignals: vi.fn() };
    const directory = { listDispatchCoordinates: vi.fn() };
    const persistence = {
      ...bootPersistence(FAKE_PAYLOADS),
      createJarvisWorkItemsDispatch: vi.fn(() => dispatch),
      createJarvisDispatchRunDirectory: vi.fn(() => directory),
      createJarvisCustomerEffectAuthority: vi.fn(() => FAKE_CUSTOMERS),
    };
    const moduleRef = await compileJarvis(persistence as unknown as ReturnType<typeof bootPersistence>);

    try {
      expect(moduleRef.get(JARVIS_WORK_ITEMS_DISPATCH)).toBe(dispatch);
      expect(moduleRef.get(JARVIS_DISPATCH_RUN_DIRECTORY)).toBe(directory);
      expect(moduleRef.get(JARVIS_CUSTOMER_EFFECT_AUTHORITY)).toBe(FAKE_CUSTOMERS);
      expect(persistence.createJarvisCustomerEffectAuthority).toHaveBeenCalledWith(
        moduleRef.get(CustomerUpdateAuthority),
      );
      const registry = moduleRef.get(JARVIS_EFFECT_EXECUTORS) as ReadonlyMap<string, unknown>;
      expect([...registry.keys()].sort()).toEqual(['client-creer@1', 'client-modifier@1']);
    } finally {
      await moduleRef.close();
    }
  });

  it('registre : une fabrique qui refuse l’autorité métier laisse le registre vide (fail-closed)', async () => {
    const persistence = bootPersistence(FAKE_PAYLOADS);
    const moduleRef = await compileJarvis(persistence);

    try {
      // La fabrique obligatoire peut refuser de fournir une autorité quand l'adapter ne peut pas
      // la prouver : le registre reste VIDE et le worker règle `executor_unregistered`, jamais un
      // effet exécuté sans son autorité. C'est le pendant fail-closed de l'armement.
      expect((moduleRef.get(JARVIS_EFFECT_EXECUTORS) as ReadonlyMap<string, unknown>).size).toBe(0);
      // Et dès que cette autorité arrive, le MÊME magasin arme les deux actions du lot.
      const registry = buildJarvisCustomerEffectExecutors({
        admission: moduleRef.get(JARVIS_ADMISSION),
        payloads: moduleRef.get(JARVIS_PROPOSAL_PAYLOAD_STORE),
        customers: FAKE_CUSTOMERS,
      });
      expect([...registry.keys()].sort()).toEqual(['client-creer@1', 'client-modifier@1']);
    } finally {
      await moduleRef.close();
    }
  });

  it('NON-RÉGRESSION : kill switches coupés, le boot est identique et muet', async () => {
    // « Sans le flag Jarvis, rien ne change au boot » : les deux kill switches Jarvis coupés,
    // le graphe se compile à l'identique, résout les mêmes jetons — et n'a TOUCHÉ À RIEN :
    // aucune lecture, aucune écriture, aucune connexion. Le magasin est fabriqué, jamais appelé.
    vi.stubEnv('BOB_JARVIS_ADMISSION_ENABLED', 'false');
    vi.stubEnv('BOB_JARVIS_DISPATCH_ENABLED', 'false');
    const seal = vi.fn(() => Promise.resolve({ status: 'unavailable' as const }));
    const read = vi.fn(() => Promise.resolve(null));
    const store: JarvisProposalPayloadStorePort = {
      sealProposalPayload: seal,
      readProposalPayload: read,
    };
    const persistence = bootPersistence(store);
    const moduleRef = await compileJarvis(persistence);

    try {
      expect(moduleRef.get(JARVIS_PROPOSAL_PAYLOAD_STORE)).toBe(store);
      expect(moduleRef.get(JARVIS_DISPATCH_ADMISSION)).toBe(moduleRef.get(JARVIS_ADMISSION));
      expect((moduleRef.get(JARVIS_EFFECT_EXECUTORS) as ReadonlyMap<string, unknown>).size).toBe(0);
      expect(persistence.createJarvisProposalPayloadStore).toHaveBeenCalledTimes(1);
      expect(seal).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      await moduleRef.close();
      vi.unstubAllEnvs();
    }
  });
});
