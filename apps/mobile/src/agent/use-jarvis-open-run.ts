/**
 * Jarvis U1-f §3 — OUVRIR UNE MODIFICATION DEPUIS LA FICHE CLIENT.
 *
 * La route `POST /jarvis/runs`, son client typé et ses preuves existaient depuis U1-e ; AUCUN
 * écran ne les appelait. Ce hook est le geste manquant : il sème un run `client-modifier@1` sur
 * la fiche que l'artisan a sous les yeux, puis relit — la carte de confirmation apparaît EN
 * PLACE, sans navigation.
 *
 * TROIS INVARIANTS, chacun payé par un défaut réel :
 *
 * 1. Le `commandId` est MÉMOÏSÉ dans le registre INJECTÉ, jamais dans un état local. Le `runId`
 *    serveur est DÉRIVÉ du `commandId` : un identifiant régénéré au remontage sèmerait un SECOND
 *    run. Il est LIBÉRÉ au reçu — le garder ferait rejouer, au geste suivant, un run déjà clos.
 *
 * 2. La méthode du transport est NARROWÉE : `jarvisOpenRun` est optionnelle sur `BobClient`. Un
 *    transport qui ne la porte pas rend `unsupported` et l'écran n'offre pas le geste, plutôt que
 *    d'échouer sur « undefined n'est pas une fonction ».
 *
 * 3. Le refus `foreground_busy` (409) est PRÉSENTÉ. Le premier plan est unique par propriétaire :
 *    une demande déjà en cours est un fait normal, pas une panne — l'artisan doit savoir où la
 *    retrouver. Le taire laisserait un bouton qui « ne fait rien ».
 */
import { useCallback, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import type { BobClient } from '@bob/api-client';

import { useAgentMissionCommandIdRegistry } from './agent-mission-provider';

/** Action pincée par la route ; la publication reste fermée tant que la vue serveur manque. */
const OPEN_ACTION_ID = 'client-modifier';

export type JarvisOpenRunState =
  /** Le transport ne porte pas l'ouverture : le geste n'est pas offert. */
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'opening' }
  /** Une demande occupe déjà le premier plan de l'artisan — dit, jamais tu. */
  | { readonly kind: 'busy' }
  | { readonly kind: 'failed' };

export interface JarvisOpenRunHandle {
  readonly state: JarvisOpenRunState;
  /** Transport techniquement capable ; la disponibilité produit vient toujours du serveur. */
  readonly supported: boolean;
  readonly open: (customerId: string) => void;
  readonly dismiss: () => void;
}

export function useJarvisOpenRun(input: {
  readonly client: Pick<BobClient, 'jarvisOpenRun'>;
  /** Relecture autoritative après un reçu — c'est elle qui fait apparaître la carte. */
  readonly onOpened: () => void;
}): JarvisOpenRunHandle {
  const commandIds = useAgentMissionCommandIdRegistry();
  const [state, setState] = useState<JarvisOpenRunState>({ kind: 'idle' });
  const inFlight = useRef(false);

  const openRun = typeof input.client.jarvisOpenRun === 'function'
    ? input.client.jarvisOpenRun.bind(input.client)
    : null;
  // Le transport présent ne prouve aucune publication. Tant que l'API ne projette pas la décision
  // de l'unique policy serveur, le CTA de création reste masqué ; cancel/replay d'un run existant
  // passent par le coordinateur dédié et ne dépendent pas de cette offre.
  const supported = false;

  const open = useCallback(
    (customerId: string): void => {
      if (openRun === null || !supported) return;
      // Un seul départ : le double-tap ne sème jamais deux fois (le registre le rattraperait,
      // mais deux requêtes en vol pour un même geste restent du bruit inutile).
      if (inFlight.current) return;
      inFlight.current = true;
      setState({ kind: 'opening' });
      const key = JSON.stringify(['jarvis-open-run', OPEN_ACTION_ID, customerId]);
      const commandId = commandIds.getOrCreate(key, randomUUID);
      void openRun({ commandId, intent: { mode: 'update', target: { customerId } } })
        .then((result) => {
          if (result.ok) {
            // LE REÇU NE SUFFIT PAS : l'ouverture est un DOUBLE maillon serveur (semis puis
            // résolution de cible §8). Si la résolution a été différée — le serveur rend alors
            // honnêtement le postimage du semis —, le run est PARKÉ en `resolving_customer` et
            // aucune commande humaine ne l'en sortira. On garde donc la mémoïsation : le geste
            // suivant rejouera le MÊME commandId et le serveur reprendra où il s'est arrêté.
            const parke = result.value.presentation?.phase === 'resolving_customer';
            if (!parke) commandIds.release(key);
            setState({ kind: 'idle' });
            input.onOpened();
            return;
          }
          const error = result.error as { readonly reason?: unknown } | undefined;
          if (error?.reason === 'foreground_busy') {
            // Refus MÉTIER, pas panne : le serveur a répondu, donc le geste est joué. On libère
            // aussi — la prochaine tentative, une fois la demande en cours terminée, est un geste
            // neuf qui mérite son propre run.
            commandIds.release(key);
            setState({ kind: 'busy' });
            return;
          }
          // Tout autre refus : la mémoïsation SURVIT — un retry doit rejouer le même geste.
          setState({ kind: 'failed' });
        })
        .catch(() => {
          // Réseau coupé : aucun reçu, donc aucune libération. Le retry rejouera le MÊME
          // `commandId`, et le serveur rendra son reçu original au lieu de semer un second run.
          setState({ kind: 'failed' });
        })
        .finally(() => {
          inFlight.current = false;
        });
    },
    [commandIds, input, openRun, supported],
  );

  const dismiss = useCallback((): void => {
    setState({ kind: 'idle' });
  }, []);

  return {
    state: supported ? state : { kind: 'unsupported' },
    supported,
    open,
    dismiss,
  };
}
