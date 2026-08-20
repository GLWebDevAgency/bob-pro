/**
 * Coordinateur tactile d'un run Jarvis `customer_contact@1` (spec §5.4/§7.1 — lot U1-d).
 *
 * Il ne décide RIEN : il transforme un geste (rendu réel de la carte, Confirmer, Modifier,
 * Annuler) en enveloppe d'admission scellée, puis laisse le serveur relire toutes les fences.
 *
 * Trois propriétés portées ici, et nulle part ailleurs :
 * - §5.4 — le `commandId` est un UUID v4 généré UNE fois et MÉMOÏSÉ par
 *   `AgentMissionCommandIdRegistry` (le registre déjà lié au principal, partagé avec les
 *   coordinateurs devis) : une réponse perdue puis rejouée porte le MÊME id, donc le serveur
 *   rend le reçu original au lieu d'exécuter deux fois. Deux appareils construisent deux
 *   registres distincts : leurs ids diffèrent, et le CAS `expectedRevision` désigne un seul
 *   gagnant (greffe G5).
 * - §7.1 — l'`ack` de présentation ne part qu'à l'affichage RÉEL de la proposition et
 *   seulement tant que la confirmation est `issued` ; `confirm` n'est offert qu'après le
 *   passage à `presented`. La carte ne peut pas court-circuiter cet enchaînement.
 * - Écho de reçu vérifié : un reçu qui ne parle pas du même run, ou dont la postimage recule,
 *   est traité comme une réponse invalide — jamais appliqué à l'écran.
 *
 * Le binding d'écran du devis (`captureForQuoteScreen`, pincé sur `/devis/new`) n'est PAS touché
 * (greffe G3) : ce coordinateur vit à côté du writer N-1, jamais dedans.
 */

import {
  CUSTOMER_CONTACT_ACTION_VERSION,
  CUSTOMER_CONTACT_CREATE_ACTION_ID,
  CUSTOMER_CONTACT_UPDATE_ACTION_ID,
  JARVIS_RUN_TERMINAL_STATUSES,
  type AppError,
  type Result,
} from '@bob/core';
import type {
  CustomerContactPresentationV1,
  JarvisCommandReceiptView,
  JarvisRunCommandV1,
  JarvisRunView,
  JarvisSubmitCommandClientInput,
} from '@bob/api-client';
import { AgentMissionCommandIdRegistry } from './agent-mission-command-id-registry';

/** Le couple autoritatif que l'écran a sous les yeux : run relu + projection serveur. */
export interface JarvisRunFrame {
  readonly run: JarvisRunView;
  readonly presentation: CustomerContactPresentationV1;
}

export interface JarvisRunPorts {
  readonly submitCommand: (
    input: JarvisSubmitCommandClientInput,
  ) => Promise<Result<JarvisCommandReceiptView, AppError>>;
}

/** Résultat fermé (patron `AgentMissionRuntimeCall`) — l'appelant n'a jamais à deviner. */
export type JarvisRunCall =
  | { readonly status: 'completed'; readonly value: JarvisCommandReceiptView }
  | { readonly status: 'failed'; readonly error: AppError }
  | { readonly status: 'invalid_response' };

/** Les quatre gestes humains du canal tactile — la voix a les siens, le système les autres. */
export type JarvisRunGesture = 'presentation_ack' | 'confirm' | 'reject' | 'cancel';

interface JarvisRunCommon {
  readonly runId: string;
  readonly kind: JarvisRunView['kind'];
  readonly definitionVersion: number;
  readonly expectedRevision: number;
  readonly actionId: string;
  readonly actionVersion: number;
}

const CUSTOMER_CONTACT_RUN_KIND: JarvisRunView['kind'] = 'customer_contact';
const PRESENTATION_SCHEMA: CustomerContactPresentationV1['schema'] =
  'bob.jarvis-run.customer-contact-presentation';

function invalid(): Promise<JarvisRunCall> {
  return Promise.resolve({ status: 'invalid_response' });
}

/**
 * Référence d'action pincée par les constantes de la définition. La disponibilité produit reste
 * une décision serveur ; ce coordinateur doit toujours pouvoir rejouer ou annuler un run existant.
 */
function actionForIntent(
  intent: CustomerContactPresentationV1['intent'],
): { readonly actionId: string; readonly actionVersion: number } {
  const actionId =
    intent === 'create' ? CUSTOMER_CONTACT_CREATE_ACTION_ID : CUSTOMER_CONTACT_UPDATE_ACTION_ID;
  const actionVersion: number = CUSTOMER_CONTACT_ACTION_VERSION;
  return { actionId, actionVersion };
}

export class JarvisRunCoordinator {
  private readonly flights = new Map<string, Promise<JarvisRunCall>>();

  constructor(
    private readonly createCommandId: () => string,
    private readonly commandIds = new AgentMissionCommandIdRegistry(),
  ) {}

  /**
   * Accusé de présentation §7.1, émis AU RENDU RÉEL de la carte — jamais au montage d'un écran
   * qui ne montre encore rien. Une confirmation déjà `presented` n'en réémet aucun : le domaine
   * refuserait (`confirmation_already_presented`) et le rejeu doit rester silencieux.
   */
  acknowledgePresentation(frame: JarvisRunFrame, ports: JarvisRunPorts): Promise<JarvisRunCall> {
    const common = this.common(frame);
    const confirmation = frame.presentation.confirmation;
    if (
      common === null ||
      confirmation === null ||
      frame.presentation.proposal === null ||
      frame.presentation.phase !== 'awaiting_confirmation' ||
      confirmation.status !== 'issued'
    ) {
      return invalid();
    }
    return this.submit(
      common,
      {
        type: 'record_presentation_ack',
        confirmationId: confirmation.confirmationId,
        ack: 'screen_ack',
      },
      ports,
    );
  }

  /** One-shot §7.1 : la proposition doit avoir été PRÉSENTÉE avant d'être consommée. */
  confirm(frame: JarvisRunFrame, ports: JarvisRunPorts): Promise<JarvisRunCall> {
    const common = this.common(frame);
    const confirmation = frame.presentation.confirmation;
    const proposal = frame.presentation.proposal;
    if (
      common === null ||
      confirmation === null ||
      proposal === null ||
      frame.presentation.phase !== 'awaiting_confirmation' ||
      confirmation.status !== 'presented'
    ) {
      return invalid();
    }
    return this.submit(
      common,
      {
        type: 'confirm',
        confirmationId: confirmation.confirmationId,
        proposalHash: proposal.proposalHash,
      },
      ports,
    );
  }

  /** « Modifier » : la proposition est REJETÉE, le run reste vivant et Bob en reprépare une. */
  reject(frame: JarvisRunFrame, ports: JarvisRunPorts): Promise<JarvisRunCall> {
    const common = this.common(frame);
    const confirmation = frame.presentation.confirmation;
    if (
      common === null ||
      confirmation === null ||
      frame.presentation.proposal === null ||
      frame.presentation.phase !== 'awaiting_confirmation' ||
      (confirmation.status !== 'issued' && confirmation.status !== 'presented')
    ) {
      return invalid();
    }
    return this.submit(
      common,
      {
        type: 'reject_proposal',
        confirmationId: confirmation.confirmationId,
      },
      ports,
    );
  }

  /** « Annuler » : l'utilisateur ferme le run. Un run terminal n'est jamais re-annulé. */
  cancel(frame: JarvisRunFrame, ports: JarvisRunPorts): Promise<JarvisRunCall> {
    const common = this.common(frame);
    if (common === null) return invalid();
    return this.submit(common, { type: 'cancel_run', reason: 'user_cancelled' }, ports);
  }

  private submit(
    common: JarvisRunCommon,
    command: JarvisRunCommandV1,
    ports: JarvisRunPorts,
  ): Promise<JarvisRunCall> {
    const key = JSON.stringify([common, command]);
    const inFlight = this.flights.get(key);
    // Le rendu réel peut rappeler l'ack pendant que le premier essai vole : un seul départ.
    if (inFlight !== undefined) return inFlight;
    const commandId = this.commandIds.getOrCreate(key, this.createCommandId);
    const flight = ports
      .submitCommand({ ...common, commandId, command })
      .then((result): JarvisRunCall => {
        if (!result.ok) return { status: 'failed', error: result.error };
        const run = result.value.run;
        // Écho de reçu : un autre run, un autre kind ou une postimage qui recule ne décrivent
        // pas ce geste — l'écran ne doit jamais afficher une autorité qu'il n'a pas demandée.
        return run.runId === common.runId &&
          run.kind === common.kind &&
          run.revision >= common.expectedRevision
          ? { status: 'completed', value: result.value }
          : { status: 'invalid_response' };
      })
      .finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
      });
    this.flights.set(key, flight);
    return flight;
  }

  private common(frame: JarvisRunFrame): JarvisRunCommon | null {
    const run = frame.run;
    const presentation = frame.presentation;
    const action = actionForIntent(presentation.intent);
    if (
      run.kind !== CUSTOMER_CONTACT_RUN_KIND ||
      run.terminalAt !== null ||
      JARVIS_RUN_TERMINAL_STATUSES.has(run.status) ||
      presentation.schema !== PRESENTATION_SCHEMA ||
      presentation.version !== 1
    ) {
      return null;
    }
    return {
      runId: run.runId,
      kind: run.kind,
      definitionVersion: run.definitionVersion,
      expectedRevision: run.revision,
      actionId: action.actionId,
      actionVersion: action.actionVersion,
    };
  }
}
