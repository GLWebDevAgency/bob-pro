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
 * - Les méthodes Jarvis du `BobClient` sont OPTIONNELLES : le hook borne current/submit et le
 *   provider L7 borne la lecture exacte. Un transport incomplet rend `unavailable` — l'hôte ne
 *   montre rien, il n'invente pas un canal.
 * - `refresh(receipt)` arme d'abord la convergence exacte depuis la postimage serveur, puis relit
 *   le run courant. Les projections métier ne sont invalidées qu'au règlement exact. Sans reçu
 *   (conflit ou retry manuel), `refresh()` les invalide immédiatement avant la relecture causale.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isJarvisRunEffectOutcomePending } from '@bob/core';
import type { JarvisCommandReceiptView, JarvisCurrentRunView, JarvisRunView } from '@bob/api-client';
import { useAuth } from '../data/auth';
import { useBobClient } from '../data/client';
import { AGENT_REFRESH_QUERY_KEY_PREFIXES } from '../assistant/refresh-after-action';
import { useAgentMissionCommandIdRegistry } from './agent-mission-provider';
import { useJarvisRunConvergence } from './jarvis-run-convergence-provider';
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
  | {
      readonly phase: 'unpresentable';
      readonly run: JarvisRunView;
      readonly ports: JarvisRunPorts;
      readonly refreshFailed: boolean;
    }
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
  readonly refresh: (receipt?: JarvisCommandReceiptView) => void;
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
 * Une présentation MÉTIER périmée ne survit jamais à une lecture ratée. Seule une frame de
 * contrôle déjà imprésentable conserve `run + ports`, afin qu'un échec de relecture ne retire
 * pas l'unique pouvoir d'annulation ; elle est marquée `refreshFailed` pour rester honnête.
 */
export function deriveJarvisRunFrameState(
  observation: JarvisRunFrameObservation,
): JarvisRunFrameState {
  if (!observation.authenticated || !observation.supported || observation.ports === null) {
    return { phase: 'unavailable' };
  }
  if (observation.failed) {
    // Une erreur de RELECTURE ne retire pas l'unique pouvoir de drain déjà prouvé par une vue
    // autoritaire. On ne conserve jamais une présentation métier périmée : seulement le run et
    // sa référence d'action serveur quand la présentation était déjà imprésentable.
    const stale = observation.data;
    if (stale?.run !== null && stale?.run !== undefined && stale.presentation === null) {
      return {
        phase: 'unpresentable',
        run: stale.run,
        ports: observation.ports,
        refreshFailed: true,
      };
    }
    return { phase: 'error' };
  }
  if (observation.pending || observation.data === undefined) return { phase: 'loading' };
  if (observation.data.run === null) return { phase: 'absent' };
  if (observation.data.presentation === null) {
    return {
      phase: 'unpresentable',
      run: observation.data.run,
      ports: observation.ports,
      refreshFailed: false,
    };
  }
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
  const convergence = useJarvisRunConvergence();
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
  // Le canal exact appartient à l'autorité globale L7 : sans elle, un second foreground pourrait
  // masquer un effet en vol et l'écran perdrait définitivement sa convergence.
  const supported = readCurrentRun !== null && convergence.supported && ports !== null;

  const queryKey = useMemo(() => ['jarvis-run', 'current', identity] as const, [identity]);
  const query = useQuery({
    queryKey,
    enabled: authenticated && supported,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    // Le current reste utile à l'UI pendant l'effet. La décision de cycle de vie vient du core,
    // exactement comme celle du scheduler global — aucune liste de phases n'est reconstruite ici.
    refetchInterval: (current: { state: { data?: JarvisCurrentRunView } }) =>
      current.state.data?.run !== null
      && current.state.data?.run !== undefined
      && isJarvisRunEffectOutcomePending(current.state.data.run.status)
        ? 1_500
        : false,
    queryFn: async ({ signal }): Promise<JarvisCurrentRunView> => {
      // Refus NOMMÉ : `enabled` interdit déjà ce chemin, mais un transport sans Jarvis ne doit
      // jamais échouer en « undefined n'est pas une fonction ».
      if (readCurrentRun === null) throw new Error('JARVIS_CURRENT_RUN_UNSUPPORTED');
      const result = await readCurrentRun(signal);
      if (!result.ok) throw result.error;
      return result.value;
    },
  });

  // Deuxième émetteur L7 : si la lecture courante voit elle-même un effet pendant (même sans
  // présentation), elle publie son run à l'autorité unique. Le premier émetteur — plus tôt et sans
  // course — est le reçu tactile transmis à `refresh(receipt)` ci-dessous.
  useEffect(() => {
    if (
      !authenticated
      || !supported
      || query.isPending
      || query.isError
      || query.data === undefined
    ) {
      return;
    }
    if (query.data.run !== null) convergence.observe(query.data.run);
  }, [authenticated, convergence, query.data, query.isError, query.isPending, supported]);

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

  const invalidateBusinessProjections = useCallback((): void => {
    for (const prefix of AGENT_REFRESH_QUERY_KEY_PREFIXES) {
      void queryClient.invalidateQueries({ queryKey: prefix });
    }
  }, [queryClient]);

  const refresh = useCallback((receipt?: JarvisCommandReceiptView): void => {
    // Le reçu est la première postimage autoritaire du geste. Il arme le suivi exact AVANT toute
    // relecture : un worker très rapide ou un nouveau foreground ne peuvent donc plus masquer A.
    if (receipt !== undefined) {
      convergence.observe(receipt.run);
    } else {
      // Sans reçu (conflit, retry manuel), une autre autorité peut déjà avoir écrit : relire les
      // projections est la seule réponse honnête. Avec reçu pendant, L7 attend le règlement exact
      // et évite cette invalidation prématurée.
      invalidateBusinessProjections();
    }
    // Relecture CAUSALE du run : toute lecture partie AVANT le geste est annulée, puis un GET
    //    neuf prouve l'état post-commit (patron `refreshAfterMutation` de la reprise froide).
    void queryClient
      .cancelQueries({ queryKey, exact: true })
      .then(() => queryClient.refetchQueries({ queryKey, exact: true }));
  }, [convergence, invalidateBusinessProjections, queryClient, queryKey]);

  return useMemo(() => ({ state, coordinator, refresh }), [coordinator, refresh, state]);
}
