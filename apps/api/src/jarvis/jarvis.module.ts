/**
 * Tranche VERTICALE du vertical Jarvis (SPEC_U1D_CALLERS_REELS_20260819 §3 « TAP ») — lot U1-d.
 *
 * Le module possède ses providers ; `AppModule` n'en recopie AUCUN (patron `AgentMissionModule`) :
 * la DI testée ici est donc exactement celle qui démarre en production.
 *
 * Il fournit quatre choses, et rien d'autre :
 *   · `JARVIS_ADMISSION` — l'adapter du port mono-argument vers le UoW unique (§17) ;
 *   · `JARVIS_DISPATCH_ADMISSION` — la MÊME instance pour le worker de dispatch (§5.3) ;
 *   · `JARVIS_PROPOSAL_PAYLOAD_STORE` — le magasin PII scellé des propositions (§5.5), pris sur
 *     LA persistance (`Persistence.createJarvisProposalPayloadStore`, patron de tous les autres
 *     repositories Prisma) : sans ce provider le jeton résolvait `null` en production, et la
 *     charge confirmée à l'écran restait inatteignable pour la voix, le tap et le worker ;
 *   · `JARVIS_EFFECT_EXECUTORS` — le registre d'exécuteurs d'effets du worker.
 *
 * Le keyring HMAC vient d'`AgentMissionModule` (`AGENT_MISSION_FINGERPRINTS`) : une seule
 * instance, une seule readiness au boot — ce module ne re-déclare jamais un signeur.
 */

import { Module, type Provider } from '@nestjs/common';
import {
  CUSTOMER_CONTACT_ACTION_VERSION,
  CUSTOMER_CONTACT_CREATE_ACTION_ID,
  CUSTOMER_CONTACT_UPDATE_ACTION_ID,
  isU1OpenAction,
  type JarvisAdmissionUnitOfWorkPort,
  type JarvisProposalPayloadStorePort,
} from '@bob/core';

import { AgentMissionModule } from '../agent-missions/agent-mission.module';
import {
  JarvisCustomerEffectExecutor,
  type JarvisCustomerEffectAuthority,
} from '../jobs/jarvis-customer-effect.executor';
import {
  JARVIS_DISPATCH_ADMISSION,
  JARVIS_EFFECT_EXECUTORS,
  jarvisEffectExecutorKey,
  type JarvisEffectExecutor,
} from '../jobs/jarvis-work-item-dispatch.service';
import { ObservabilityModule } from '../observability/observability.module';
import type { Persistence } from '../persistence/persistence';
import { PersistenceModule } from '../persistence/persistence.module';
import { PERSISTENCE } from '../persistence/persistence-token';

import {
  JARVIS_CUSTOMER_EFFECT_AUTHORITY,
  jarvisAdmissionProvider,
  jarvisDispatchAdmissionProvider,
} from './jarvis-admission.provider';
import { JarvisRunController, jarvisTapAuthorityProvider } from './jarvis-run.controller';
import { JARVIS_ADMISSION, JARVIS_PROPOSAL_PAYLOAD_STORE } from './jarvis.tokens';

/**
 * Magasin PII des propositions (§5.5), pris sur LA persistance — jamais un second client Prisma,
 * jamais une instanciation directe : c'est le patron de tous les ports Prisma du dépôt
 * (`createAgentMissionUnitOfWork`, `createRealtimeControlRepository`, …), et c'est ce qui garantit
 * que le magasin parle à la même connexion, donc sous les mêmes GUC et les mêmes policies RLS.
 *
 * `null` reste possible et reste FERMÉ : un adapter qui ne sait pas prouver RLS + sceau + rétention
 * (double mémoire) n'en fournit pas une moitié. Les appelants (voix, tap, worker) échouent alors
 * exactement comme avant ce câblage — `PAYLOAD_UNAVAILABLE`, présentation absente, registre vide.
 */
export function buildJarvisProposalPayloadStore(
  persistence: Pick<Persistence, 'createJarvisProposalPayloadStore'>,
): JarvisProposalPayloadStorePort | null {
  return persistence.createJarvisProposalPayloadStore();
}

const jarvisProposalPayloadStoreProvider: Provider = {
  provide: JARVIS_PROPOSAL_PAYLOAD_STORE,
  inject: [PERSISTENCE],
  useFactory: buildJarvisProposalPayloadStore,
};

/**
 * Registre d'exécuteurs du worker (§5.3). Le registre statique de U1-c est VIDE : cette tranche
 * y ouvre la PREMIÈRE porte — `client-creer@1` et `client-modifier@1`, les deux seules actions de
 * `U1_OPEN_ACTIONS` (source unique G2, revérifiée ici). Tout le reste demeure
 * `executor_unregistered`, fail-closed.
 *
 * Une dépendance manquante ne donne JAMAIS un demi-exécuteur : sans transaction d'admission, sans
 * charge PII scellée ou sans autorité métier, le registre reste vide et le worker règle
 * `outcome_unknown` motif `executor_unregistered` — exactement comme avant, jamais un effet
 * exécuté sans son autorité.
 */
export function buildJarvisCustomerEffectExecutors(deps: {
  readonly admission: JarvisAdmissionUnitOfWorkPort | null;
  readonly payloads: JarvisProposalPayloadStorePort | null;
  readonly customers: JarvisCustomerEffectAuthority | null;
}): ReadonlyMap<string, JarvisEffectExecutor> {
  const registry = new Map<string, JarvisEffectExecutor>();
  const { admission, payloads, customers } = deps;
  if (admission === null || payloads === null || customers === null) return registry;
  // `certificationCustomerType` est ABSENT : le harnais seul le fournit, jamais la production.
  const executor = new JarvisCustomerEffectExecutor({ admission, payloads, customers });
  for (const actionId of [CUSTOMER_CONTACT_CREATE_ACTION_ID, CUSTOMER_CONTACT_UPDATE_ACTION_ID]) {
    if (!isU1OpenAction(actionId, CUSTOMER_CONTACT_ACTION_VERSION)) continue;
    registry.set(jarvisEffectExecutorKey(actionId, CUSTOMER_CONTACT_ACTION_VERSION), executor);
  }
  return registry;
}

const jarvisEffectExecutorsProvider: Provider = {
  provide: JARVIS_EFFECT_EXECUTORS,
  inject: [
    JARVIS_ADMISSION,
    // Le magasin PII est désormais FOURNI par ce module : injection REQUISE. Sa valeur peut être
    // nulle (adapter incapable de prouver RLS), jamais son provider — un jeton non lié doit
    // casser le boot, pas désarmer le registre en silence.
    JARVIS_PROPOSAL_PAYLOAD_STORE,
    // L'autorité métier fiche client, elle, n'a pas encore d'adapter (livrable à part : portée
    // tenant/principal sur `BackendService.createCustomer`/`updateCustomer`). Optionnelle donc :
    // le boot reste vert et le registre reste vide, jamais à moitié armé.
    { token: JARVIS_CUSTOMER_EFFECT_AUTHORITY, optional: true },
  ],
  useFactory: (
    admission: JarvisAdmissionUnitOfWorkPort | null,
    payloads: JarvisProposalPayloadStorePort | null,
    customers?: JarvisCustomerEffectAuthority | null,
  ) =>
    buildJarvisCustomerEffectExecutors({
      admission,
      payloads,
      customers: customers ?? null,
    }),
};

@Module({
  imports: [ObservabilityModule, PersistenceModule, AgentMissionModule],
  controllers: [JarvisRunController],
  providers: [
    jarvisAdmissionProvider,
    jarvisDispatchAdmissionProvider,
    jarvisProposalPayloadStoreProvider,
    jarvisTapAuthorityProvider,
    jarvisEffectExecutorsProvider,
  ],
  // Exportés parce qu'ils sont injectés HORS de ce module : le worker de dispatch est déclaré
  // par AppModule, la voix par `RealtimeVoiceModule` — et un token non exporté reste invisible,
  // donc résolu `null` par une injection optionnelle (le silence exact que cette PR referme).
  exports: [
    JARVIS_ADMISSION,
    JARVIS_DISPATCH_ADMISSION,
    JARVIS_PROPOSAL_PAYLOAD_STORE,
    JARVIS_EFFECT_EXECUTORS,
  ],
})
export class JarvisModule {}
