/**
 * Découverte et état d'écran d'un run Jarvis `customer_contact@1` (spec U1-e §1 et §3).
 *
 * BLOQUEUR AMONT QUE CE HOOK LÈVE : l'appareil ne connaît AUCUN `runId`. La voix ne renvoie que
 * la parole (l'issue d'orchestration ne porte que `canonicalSpeech`/`speechPurpose`), et un tap ne
 * peut pas semer un run (`expectedRevision >= 1` côté controller comme côté transport). Sans une
 * lecture « run courant », la carte de confirmation reste structurellement invisible. Le hook
 * s'appelle donc SANS `runId` — c'est lui qui l'apprend, par `GET /jarvis/runs/current`.
 *
 * Patron repris tel quel de `AgentMissionRecoveryProvider` (la reprise froide du devis) :
 * cache mémoire owner-scopé, `gcTime: 0` (aucune vue contenant des libellés clients ne survit au
 * démontage du dernier observateur), `refetchOnMount/Focus/Reconnect: 'always'`, et une projection
 * PURE de la query (`deriveJarvisRunFrameState`) testable sans monter React.
 *
 * Trois décisions portées ici, et nulle part ailleurs :
 * - Le registre de `commandId` est INJECTÉ (`useAgentMissionCommandIdRegistry`), jamais le registre
 *   privé du coordinateur : deux hôtes montés en même temps (onglet assistant + fiche client) et un
 *   remontage de route rejouent alors le MÊME id, donc le serveur rend le reçu original au lieu
 *   d'exécuter deux fois. Un registre privé transformerait chaque remontage en seconde commande.
 * - Les méthodes Jarvis du `BobClient` sont OPTIONNELLES : elles sont narrowées ici, une seule fois.
 *   Un transport qui n'ouvre pas Jarvis rend `unavailable` — l'hôte ne montre rien, il n'invente
 *   pas un canal.
 * - `refresh()` (le `onAuthoritativeRefresh` de la carte) invalide les projections métier PUIS
 *   relit le run de façon CAUSALE. L'appareil ne sait pas ce que le serveur a écrit ; il ne parie
 *   donc jamais dessus — c'est la même loi que `refreshAfterAction` de l'onglet assistant.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { JarvisCurrentRunView } from '@bob/api-client';
import { useAuth } from '../data/auth';
import { useBobClient } from '../data/client';
import { AGENT_REFRESH_QUERY_KEY_PREFIXES } from '../assistant/refresh-after-action';
import { useAgentMissionCommandIdRegistry } from './agent-mission-provider';

/**
 * Phases où Bob ÉCRIT : la décision est admise, l'effet est en vol (work item pris par le worker),
 * mais rien n'est encore visible dans les projections métier. Ce sont les seules que l'écran
 * poursuit — et c'est en les QUITTANT vers `completed` qu'il relit les fiches.
 */
const JARVIS_WRITING_PHASES: ReadonlySet<string> = new Set([
  'committing',
  'awaiting_receipt',
  'cancelling',
]);
import {
  JarvisRunCoordinator,
  type JarvisRunFrame,
  type JarvisRunPorts,
} from './jarvis-run-coordinator';

/**
 * Projection fermée de la découverte. Aucune branche implicite : un run vivant dont la projection
 * serveur est refusée (`presentation: null`, greffe G4 — le digest des champs ne se revérifie pas)
 * a sa propre phase, il n'est JAMAIS confondu avec « pas de run ».
 *
 * `ready` transporte les ports : un hôte n'a donc aucun `null` à narrower avant de monter la carte,
 * et il lui est impossible de la monter sans transport.
 */
export type JarvisRunFrameState =
  | { readonly phase: 'unavailable' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'absent' }
  | { readonly phase: 'unpresentable' }
  | { readonly phase: 'error' }
  | {
      readonly phase: 'ready';
      readonly frame: JarvisRunFrame;
      readonly ports: JarvisRunPorts;
    };

export interface JarvisRunFrameObservation {
  readonly authenticated: boolean;
  /** Le transport expose RÉELLEMENT les deux méthodes Jarvis (découverte + canal tactile). */
  readonly supported: boolean;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly data: JarvisCurrentRunView | undefined;
  readonly ports: JarvisRunPorts | null;
}

export interface JarvisRunFrameBinding {
  readonly state: JarvisRunFrameState;
  readonly coordinator: JarvisRunCoordinator;
  /** Relecture autoritative après tout geste abouti — l'écran ne devine jamais un post-état. */
  readonly refresh: () => void;
}

/**
 * Projection PURE de la query.
 *
 * Contrairement à la reprise froide du devis, une donnée déjà servie SURVIT à un refetch en vol.
 * Deux raisons, et aucune n'est un confort d'affichage :
 * - la carte ne débloque aucun writer local : chaque geste repart avec `expectedRevision`, donc une
 *   frame périmée se fait refuser par le CAS serveur et déclenche une relecture — le fence est au
 *   serveur, pas dans cette projection ;
 * - démonter la carte à chaque relecture réinitialiserait son accusé de présentation (§7.1) et
 *   rejouerait un `record_presentation_ack` déjà abouti.
 * Un échec, lui, ferme : une donnée périmée ne survit jamais à une lecture RATÉE.
 */
export function deriveJarvisRunFrameState(
  observation: JarvisRunFrameObservation,
): JarvisRunFrameState {
  if (!observation.authenticated || !observation.supported || observation.ports === null) {
    return { phase: 'unavailable' };
  }
  if (observation.failed) return { phase: 'error' };
  if (observation.pending || observation.data === undefined) return { phase: 'loading' };
  if (observation.data.run === null) return { phase: 'absent' };
  if (observation.data.presentation === null) return { phase: 'unpresentable' };
  return {
    phase: 'ready',
    frame: { run: observation.data.run, presentation: observation.data.presentation },
    ports: observation.ports,
  };
}

/**
 * Gate de la fiche client : SEULE une modification de CETTE fiche s'y montre. Une création (aucune
 * cible) et la modification d'un AUTRE client n'ont rien à faire sur cet écran — la fiche est le
 * seul hôte qui possède l'« avant », elle n'héberge que la proposition qui parle d'elle.
 */
export function jarvisFrameTargetsCustomer(frame: JarvisRunFrame, customerId: string): boolean {
  return (
    frame.presentation.intent === 'update' &&
    customerId.length > 0 &&
    frame.presentation.targetCustomerId === customerId
  );
}

export function useJarvisRunFrame(): JarvisRunFrameBinding {
  const auth = useAuth();
  const client = useBobClient();
  const queryClient = useQueryClient();
  const commandIds = useAgentMissionCommandIdRegistry();
  // Le registre vient du provider global (vidé à la déconnexion et au dispose de la capability) :
  // c'est lui, et non l'instance de coordinateur, qui porte l'idempotence §5.4.
  const [coordinator] = useState(() => new JarvisRunCoordinator(randomUUID, commandIds));

  const session = auth.session;
  const authenticated = auth.enabled && session !== null && client.companyId !== 'public';
  const identity =
    authenticated && session !== null
      ? `${session.user.id}:${client.companyId}`
      : 'unauthenticated';

  const readCurrentRun = useMemo(
    () =>
      typeof client.jarvisCurrentRun === 'function' ? client.jarvisCurrentRun.bind(client) : null,
    [client],
  );
  const ports = useMemo<JarvisRunPorts | null>(
    () =>
      typeof client.jarvisSubmitCommand === 'function'
        ? Object.freeze({ submitCommand: client.jarvisSubmitCommand.bind(client) })
        : null,
    [client],
  );
  const supported = readCurrentRun !== null && ports !== null;

  const queryKey = useMemo(() => ['jarvis-run', 'current', identity] as const, [identity]);
  const query = useQuery({
    queryKey,
    enabled: authenticated && supported,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    // SUIVI DES PHASES OÙ BOB ÉCRIT. La confirmation ne fait qu'ADMETTRE la décision : l'écriture
    // métier part ensuite par un work item, exécutée par le worker. Sans ce suivi, l'écran resterait
    // sur « Bob enregistre… » jusqu'à un remontage — l'artisan ne verrait jamais son changement
    // arriver. On ne poursuit QUE ces phases, jamais en continu : un run au repos ne coûte rien.
    refetchInterval: (current: { state: { data?: JarvisCurrentRunView } }) =>
      JARVIS_WRITING_PHASES.has(current.state.data?.presentation?.phase ?? '') ? 1_500 : false,
    queryFn: async ({ signal }): Promise<JarvisCurrentRunView> => {
      // Refus NOMMÉ : `enabled` interdit déjà ce chemin, mais un transport sans Jarvis ne doit
      // jamais échouer en « undefined n'est pas une fonction ».
      if (readCurrentRun === null) throw new Error('JARVIS_CURRENT_RUN_UNSUPPORTED');
      const result = await readCurrentRun(signal);
      if (!result.ok) throw result.error;
      return result.value;
    },
  });

  const state = useMemo(
    () =>
      deriveJarvisRunFrameState({
        authenticated,
        supported,
        pending: query.isPending,
        failed: query.isError,
        data: query.data,
        ports,
      }),
    [authenticated, ports, query.data, query.isError, query.isPending, supported],
  );

  const refresh = useCallback((): void => {
    // 1) Les projections métier ont pu bouger (une fiche client vient peut-être d'être écrite).
    //    L'appareil ne sait pas ce que le serveur a écrit et ne le déduit pas d'un reçu : il
    //    invalide les MÊMES préfixes que toute action aboutie de Bob — `customers` y figure.
    for (const prefix of AGENT_REFRESH_QUERY_KEY_PREFIXES) {
      void queryClient.invalidateQueries({ queryKey: prefix });
    }
    // 2) Relecture CAUSALE du run : toute lecture partie AVANT le geste est annulée, puis un GET
    //    neuf prouve l'état post-commit (patron `refreshAfterMutation` de la reprise froide).
    void queryClient
      .cancelQueries({ queryKey, exact: true })
      .then(() => queryClient.refetchQueries({ queryKey, exact: true }));
  }, [queryClient, queryKey]);

  // CONVERGENCE. L'invalidation du geste (ci-dessus) part AVANT que l'écriture métier existe :
  // à cet instant le work item n'est pas encore exécuté, et relire ne rendrait que l'ancienne
  // fiche. La relecture qui COMPTE est celle-ci — déclenchée quand le run ARRIVE en `completed`,
  // c'est-à-dire quand le reçu d'effet est acté. Sans elle, l'artisan confirmerait, verrait
  // « enregistré », et sa fiche resterait visuellement inchangée jusqu'au prochain remontage.
  const phase = query.data?.presentation?.phase ?? null;
  const previousPhase = useRef<string | null>(null);
  useEffect(() => {
    const before = previousPhase.current;
    previousPhase.current = phase;
    if (phase !== 'completed' || before === 'completed' || before === null) return;
    for (const prefix of AGENT_REFRESH_QUERY_KEY_PREFIXES) {
      void queryClient.invalidateQueries({ queryKey: prefix });
    }
  }, [phase, queryClient]);

  return useMemo(() => ({ state, coordinator, refresh }), [coordinator, refresh, state]);
}
