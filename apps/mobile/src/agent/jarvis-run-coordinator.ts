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

import { JARVIS_RUN_TERMINAL_STATUSES, type AppError, type Result } from '@bob/core';
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

/** Les gestes humains du canal tactile — la voix a les siens, le système les autres. */
export type JarvisRunGesture =
  | 'presentation_ack'
  | 'confirm'
  | 'reject'
  | 'cancel'
  // U1-h — les deux issues de la revue de doublons, au doigt. `use_existing` n'ECRIT RIEN :
  // il acheve le run sur une fiche qui existait deja.
  | 'use_existing'
  | 'continue_create';

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

export type JarvisRunCancellationAvailability =
  | { readonly status: 'available' }
  | {
      readonly status: 'unavailable';
      readonly reason: 'terminal' | 'cancelling' | 'action_missing';
    };

/** Borne tactile unique : aucun hôte ne redécide localement pourquoi un run est annulable. */
export function evaluateJarvisRunCancellation(
  run: JarvisRunView,
): JarvisRunCancellationAvailability {
  if (run.terminalAt !== null || JARVIS_RUN_TERMINAL_STATUSES.has(run.status)) {
    return { status: 'unavailable', reason: 'terminal' };
  }
  if (run.status === 'cancelling') return { status: 'unavailable', reason: 'cancelling' };
  if (run.actionReference === null) return { status: 'unavailable', reason: 'action_missing' };
  return { status: 'available' };
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
    const common = this.customerContactCommon(frame);
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
    const common = this.customerContactCommon(frame);
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
    const common = this.customerContactCommon(frame);
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

  /**
   * « C'est celle-là » : l'artisan RETIENT une fiche que Bob vient d'énoncer.
   *
   * AUCUNE ÉCRITURE. Le run s'achève sur une fiche qui existait déjà — c'est précisément ce qui
   * distingue cette issue d'une adoption : une erreur de choix ne fait perdre qu'un run, jamais
   * l'identité d'un client (SPEC_U1H §2).
   *
   * LE CHOIX EST VÉRIFIÉ CONTRE CE QUI A ÉTÉ RENDU, sans réseau : un `choiceId` absent du jeu
   * affiché, ou un rang dont le nom ne s'est pas résolu, sont refusés ici. Un rang « introuvable »
   * n'est pas choisissable — laisser partir un rattachement durable vers une fiche que l'artisan
   * n'a pas pu lire serait exactement le geste aveugle que ce lot existe pour empêcher.
   */
  chooseExistingCustomer(
    frame: JarvisRunFrame,
    choiceId: string,
    ports: JarvisRunPorts,
  ): Promise<JarvisRunCall> {
    const common = this.customerContactCommon(frame);
    const review = frame.presentation.duplicateReview;
    if (
      common === null ||
      review === null ||
      frame.presentation.phase !== 'awaiting_duplicate_review'
    ) {
      return invalid();
    }
    const choix = review.choices.find((candidat) => candidat.choiceId === choiceId);
    if (choix === undefined || choix.label === null) return invalid();
    return this.submit(
      common,
      {
        type: 'choose_duplicate_resolution',
        reviewId: review.reviewId,
        decision: { kind: 'use_existing', choiceId: choix.choiceId },
      },
      ports,
    );
  }

  /**
   * « Créer quand même » : l'artisan a VU les fiches proches et poursuit la création.
   *
   * C'est un doublon assumé, en connaissance de cause — l'inverse d'un doublon subi, que la revue
   * existe pour éviter. Aucun choix n'est requis : la revue a été présentée, cela suffit.
   */
  continueCreation(frame: JarvisRunFrame, ports: JarvisRunPorts): Promise<JarvisRunCall> {
    const common = this.customerContactCommon(frame);
    const review = frame.presentation.duplicateReview;
    if (
      common === null ||
      review === null ||
      frame.presentation.phase !== 'awaiting_duplicate_review'
    ) {
      return invalid();
    }
    return this.submit(
      common,
      {
        type: 'choose_duplicate_resolution',
        reviewId: review.reviewId,
        decision: { kind: 'continue_create' },
      },
      ports,
    );
  }

  /** « Annuler » : l'utilisateur ferme le run. Un run terminal n'est jamais re-annulé. */
  cancel(run: JarvisRunView, ports: JarvisRunPorts): Promise<JarvisRunCall> {
    if (evaluateJarvisRunCancellation(run).status !== 'available') return invalid();
    const common = this.common(run);
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

  private common(run: JarvisRunView): JarvisRunCommon | null {
    const action = run.actionReference;
    if (
      action === null ||
      run.terminalAt !== null ||
      JARVIS_RUN_TERMINAL_STATUSES.has(run.status)
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

  private customerContactCommon(frame: JarvisRunFrame): JarvisRunCommon | null {
    const presentation = frame.presentation;
    if (
      frame.run.kind !== CUSTOMER_CONTACT_RUN_KIND ||
      presentation.schema !== PRESENTATION_SCHEMA ||
      presentation.version !== 1
    ) {
      return null;
    }
    return this.common(frame.run);
  }
}
