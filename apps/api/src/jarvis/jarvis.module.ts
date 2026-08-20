/**
 * Tranche VERTICALE du vertical Jarvis (SPEC_U1D_CALLERS_REELS_20260819 §3 « TAP ») — lot U1-d.
 *
 * Le module possède ses providers ; `AppModule` n'en recopie AUCUN (patron `AgentMissionModule`) :
 * la DI testée ici est donc exactement celle qui démarre en production.
 *
 * Il fournit cinq choses, et rien d'autre :
 *   · `JARVIS_ADMISSION` — l'adapter du port mono-argument vers le UoW unique (§17) ;
 *   · `JARVIS_DISPATCH_ADMISSION` — la MÊME instance pour le worker de dispatch (§5.3) ;
 *   · `JARVIS_PROPOSAL_PAYLOAD_STORE` — le magasin PII scellé des propositions (§5.5), pris sur
 *     LA persistance (`Persistence.createJarvisProposalPayloadStore`, patron de tous les autres
 *     repositories Prisma) : sans ce provider le jeton résolvait `null` en production, et la
 *     charge confirmée à l'écran restait inatteignable pour la voix, le tap et le worker ;
 *   · `JARVIS_PROPOSAL_PAYLOAD_RETENTION_OWNERS` — l'annuaire d'autorité des propriétaires dont le
 *     PII de proposition est échu (U1-e §4) : sans lui, le balayage horaire s'arrêtait sur
 *     `owner_directory_absent` et la rétention du magasin PII restait une promesse creuse ;
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
  JARVIS_PROPOSAL_PAYLOAD_RETENTION_OWNERS,
  asJarvisProposalPayloadRetentionOwners,
} from '../jobs/jarvis-proposal-payload-purge.service';
import {
  JARVIS_DISPATCH_ADMISSION,
  JARVIS_DISPATCH_RUN_DIRECTORY,
  JARVIS_EFFECT_EXECUTORS,
  JARVIS_WORK_ITEMS_DISPATCH,
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
 * Annuaire des propriétaires à purger (U1-e §4) — pris sur LE MÊME magasin, jamais sur un second
 * client Prisma : l'autorité SECURITY DEFINER est un chemin de PLUS sur la même connexion, pas une
 * seconde persistance. La reconnaissance est STRUCTURELLE (`listRetentionOwners`), exactement
 * comme celle de `purgeExpired` : un adapter qui ne sait pas énumérer sous autorité rend `null`,
 * et `JarvisProposalPayloadPurgeService` retrouve son no-op audité `owner_directory_absent`.
 *
 * C'est ce provider qui ferme le dernier silence de la rétention : sans lui, le @Cron horaire
 * s'arrêtait AVANT de demander quoi que ce soit, et le PII échu restait en base indéfiniment.
 */
const jarvisProposalPayloadRetentionOwnersProvider: Provider = {
  provide: JARVIS_PROPOSAL_PAYLOAD_RETENTION_OWNERS,
  inject: [JARVIS_PROPOSAL_PAYLOAD_STORE],
  useFactory: asJarvisProposalPayloadRetentionOwners,
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

/**
 * U1-f §1 — LES TROIS LIAISONS QUI ARMENT LA CHAÎNE D'EFFET. Jusqu'ici, `JARVIS_WORK_ITEMS_DISPATCH`
 * et `JARVIS_DISPATCH_RUN_DIRECTORY` n'étaient liés par AUCUN provider du dépôt : le worker rendait
 * `dependencies_absent` à chaque minute, et une confirmation d'artisan n'écrivait JAMAIS sa fiche —
 * le run restait en `committing`, où même `cancel_run` ne fait qu'observer un reçu qui ne vient pas.
 *
 * Elles viennent de LA persistance, comme tous les autres adapters : une seule connexion, une seule
 * identité. `null` reste possible (adapter incapable de prouver ce qu'il avance) et le worker
 * retrouve alors son no-op AUDITÉ — jamais un demi-dispatch.
 */
/**
 * Reconnaissance STRUCTURELLE de la fabrique, exactement comme `asJarvisProposalPayloadRetention`
 * le fait pour la purge : un adapter d'une génération antérieure (ou un double de test) qui ne
 * porte pas la méthode rend `null` — le boot reste VERT et le worker garde son no-op audité. Un
 * `TypeError` au démarrage serait le pire des deux mondes : ni service, ni diagnostic.
 */
function fabriqueOuNull<K extends keyof Persistence>(
  persistence: Persistence,
  nom: K,
): ReturnType<Extract<Persistence[K], (...args: never[]) => unknown>> | null {
  // `nom` est contraint aux CLÉS de `Persistence` : un renommage de fabrique casse la
  // compilation ici, au lieu de désarmer la chaîne en silence à l'exécution.
  const candidate = persistence as unknown as Record<string, unknown>;
  const fabrique = candidate[nom as string];
  if (typeof fabrique !== 'function') return null;
  return (fabrique.call(persistence) ?? null) as ReturnType<
    Extract<Persistence[K], (...args: never[]) => unknown>
  > | null;
}

const jarvisWorkItemsDispatchProvider: Provider = {
  provide: JARVIS_WORK_ITEMS_DISPATCH,
  inject: [PERSISTENCE],
  useFactory: (persistence: Persistence) =>
    fabriqueOuNull(persistence, 'createJarvisWorkItemsDispatch'),
};

const jarvisDispatchRunDirectoryProvider: Provider = {
  provide: JARVIS_DISPATCH_RUN_DIRECTORY,
  inject: [PERSISTENCE],
  useFactory: (persistence: Persistence) =>
    fabriqueOuNull(persistence, 'createJarvisDispatchRunDirectory'),
};

/**
 * L'autorité métier de l'effet fiche client — le « livrable à part » annoncé par U1-d. Elle appelle
 * les use cases CANONIQUES sous `withTenant` : mêmes invariants, mêmes refus et même incrément de
 * révision que l'artisan qui édite sa fiche à la main (§9.1, parité humain↔Bob).
 */
const jarvisCustomerEffectAuthorityProvider: Provider = {
  provide: JARVIS_CUSTOMER_EFFECT_AUTHORITY,
  inject: [PERSISTENCE],
  useFactory: (persistence: Persistence) =>
fabriqueOuNull(persistence, 'createJarvisCustomerEffectAuthority'),
};

const jarvisEffectExecutorsProvider: Provider = {
  provide: JARVIS_EFFECT_EXECUTORS,
  inject: [
    JARVIS_ADMISSION,
    // Le magasin PII est désormais FOURNI par ce module : injection REQUISE. Sa valeur peut être
    // nulle (adapter incapable de prouver RLS), jamais son provider — un jeton non lié doit
    // casser le boot, pas désarmer le registre en silence.
    JARVIS_PROPOSAL_PAYLOAD_STORE,
    // L'autorité métier fiche client est désormais FOURNIE par ce module (U1-f §1) : injection
    // REQUISE. Sa valeur peut être nulle (adapter incapable), jamais son provider — un jeton non
    // lié doit casser le boot, pas désarmer le registre en silence.
    JARVIS_CUSTOMER_EFFECT_AUTHORITY,
  ],
  useFactory: (
    admission: JarvisAdmissionUnitOfWorkPort | null,
    payloads: JarvisProposalPayloadStorePort | null,
    customers: JarvisCustomerEffectAuthority | null,
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
    jarvisProposalPayloadRetentionOwnersProvider,
    jarvisTapAuthorityProvider,
    jarvisWorkItemsDispatchProvider,
    jarvisDispatchRunDirectoryProvider,
    jarvisCustomerEffectAuthorityProvider,
    jarvisEffectExecutorsProvider,
  ],
  // Exportés parce qu'ils sont injectés HORS de ce module : le worker de dispatch est déclaré
  // par AppModule, la voix par `RealtimeVoiceModule` — et un token non exporté reste invisible,
  // donc résolu `null` par une injection optionnelle (le silence exact que cette PR referme).
  exports: [
    JARVIS_ADMISSION,
    JARVIS_DISPATCH_ADMISSION,
    JARVIS_PROPOSAL_PAYLOAD_STORE,
    // Le service de purge est déclaré par AppModule : sans EXPORT, son injection @Optional
    // résoudrait `null` et le tick resterait `owner_directory_absent` — le silence exact que
    // ce lot referme.
    JARVIS_PROPOSAL_PAYLOAD_RETENTION_OWNERS,
    // Le worker de dispatch est déclaré par AppModule : sans EXPORT, ses injections @Optional
    // résoudraient `null` et le tick resterait `dependencies_absent` — le silence exact que
    // ce lot referme.
    JARVIS_WORK_ITEMS_DISPATCH,
    JARVIS_DISPATCH_RUN_DIRECTORY,
    JARVIS_CUSTOMER_EFFECT_AUTHORITY,
    JARVIS_EFFECT_EXECUTORS,
  ],
})
export class JarvisModule {}
