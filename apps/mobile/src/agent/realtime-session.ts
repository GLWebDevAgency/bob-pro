/**
 * CONTRÔLEUR DE SESSION TEMPS RÉEL (BOB LIVE) — la glue entre l'orchestrateur de résilience
 * (lane GPT) et la session agent. Toute la logique décisionnelle vit dans realtime-driver
 * (pur, testé) ; ici on ORDONNE : connect → publier le contexte → SEULEMENT ENSUITE ouvrir
 * le micro ; événements transport → hooks de session ; arrêt → publieur fermé d'abord.
 * EXCLUSIVITÉ : tant que ce contrôleur est actif, le pilote legacy (ASR/TTS historique)
 * ne tourne pas — l'orchestrateur ne démarre le repli qu'après fermeture COMPLÈTE du primaire.
 */
import type { AgentContext } from '@bob/ai';
import type {
  RealtimeAgentMissionSession,
  RealtimeVoiceConfig,
} from '@bob/api-client';
import type {
  LegacyVoiceFallbackPort,
  RealtimeResilienceEvent,
} from '../realtime/realtime-resilience-orchestrator';
import {
  legacyFallbackChannelFor,
  type LegacyFallbackChannel,
} from '../realtime/realtime-recovery-policy';
import type {
  RealtimeFallbackReason,
  RealtimeTransportEvent,
} from '../realtime/realtime-transport';
import type { RealtimeAgentControlReference } from '../realtime/realtime-event-codecs';
import type { RealtimeVoiceControlReference } from '@bob/api-client';
import type { AgentMissionRuntimeBridge } from './agent-mission-runtime';
import {
  RealtimeContextPublisher,
  decideAgentControl,
  mapTransportPhase,
  type RealtimeContextUpdateFn,
  type AgentControlDecision,
  type RealtimePublishedFence,
  type RealtimeSessionPhase,
} from './realtime-driver';

export interface RealtimeSessionHooks {
  readonly onPhase: (phase: RealtimeSessionPhase) => void;
  readonly onUserTranscript: (text: string, final: boolean) => void;
  readonly onBobTranscript: (text: string, final: boolean) => void;
  /** Proposition serveur : validation VISUELLE uniquement (CTA existant de la session). */
  readonly onReview: (proposalId: string | null, proposalExpiresAt: string | null) => void;
  /** Route DÉJÀ allowlistée par decideAgentControl. */
  readonly onNavigate: (route: string) => void;
  /** Le repli legacy a pris la main (transport fermé) — texte honnête + boucle historique. */
  readonly onFallback: (
    reason: RealtimeFallbackReason,
    channel: LegacyFallbackChannel,
  ) => void;
  /** Autorité Mission perdue : fermeture terminale de l'orbe, sans aucun pilote legacy. */
  readonly onFailedClosed: (reason: RealtimeFallbackReason) => void;
  /** Tour one-shot livré et acquitté : fermeture normale, jamais un fallback. */
  readonly onCompleted?: () => void;
  readonly getContextSnapshot: () => AgentContext;
}

/** Sous-ensemble de l'orchestrateur consommé ici — injectable en test. */
export interface RealtimeOrchestratorLike {
  subscribe(listener: (event: RealtimeResilienceEvent) => void): () => void;
  start(): Promise<{
    readonly phase: string;
    readonly fallbackChannel: unknown;
    readonly lastFailureReason: RealtimeFallbackReason | null;
  }>;
  stop(reason?: 'user' | 'background' | 'unmount'): Promise<void>;
}

/** Transport tel que vu par la glue — le contrat officiel (addendum 20:34). */
export interface RealtimeTransportLike {
  readonly completionMode: 'continuous' | 'one-shot';
  setMicrophoneEnabled(enabled: boolean): void;
  synchronizePublishedContext?(fence: RealtimePublishedFence): Promise<boolean>;
  finishUserInput?(): Promise<boolean>;
  interrupt(reason: 'user_speech' | 'tap' | 'navigation'): boolean;
  getSessionHandle(): string | null;
  takeAgentMissionSession(): RealtimeAgentMissionSession | null;
}

/** Gate d'ACK one-shot (lane GPT) : échange une référence provider NON FIABLE contre le
 * contrôle authentifié par NOTRE serveur, fencé sur le contexte réellement publié. */
export interface RealtimeControlGateLike {
  acknowledge(
    reference: RealtimeAgentControlReference | RealtimeVoiceControlReference,
  ): Promise<import('../realtime/realtime-event-codecs').RealtimeAgentControl | null>;
  close?(): void;
}

export interface RealtimeSessionDeps {
  /**
   * Une seule négociation par mission. Le snapshot exact est réutilisé par chaque tentative de
   * reconnexion : aucun second GET ne peut faire basculer de provider au milieu d'une session.
   */
  readonly negotiate: () => Promise<RealtimeVoiceConfig | null>;
  readonly updateContext: RealtimeContextUpdateFn;
  /** Fabrique l'orchestrateur ; `onPrimaryCreated` capture chaque transport primaire frais. */
  readonly createOrchestrator: (
    negotiation: RealtimeVoiceConfig,
    legacyFallback: LegacyVoiceFallbackPort,
    currentFence: () => RealtimePublishedFence | null,
    onPrimaryCreated: (transport: RealtimeTransportLike) => void,
  ) => RealtimeOrchestratorLike;
  /** Fabrique le gate d'ACK, alimenté par NOTRE fence (publication confirmée serveur). */
  readonly createControlGate: (
    currentFence: () => RealtimePublishedFence | null,
  ) => RealtimeControlGateLike;
  /**
   * Porte lifecycle applicative, évaluée juste avant CHAQUE ouverture du micro.
   * `false` ferme la mission en background, sans lancer un fallback audio invisible.
   */
  readonly allowMicrophoneActivation: () => Promise<boolean>;
  /**
   * Propriétaire durable optionnel de la capability. S'il accepte le transfert, ce contrôleur
   * oublie immédiatement le handle ; en son absence il conserve et détruit lui-même le handle.
   */
  readonly agentMissionRuntime?: AgentMissionRuntimeBridge;
}

export type RealtimeStartOutcome =
  | 'realtime'
  | 'unavailable'
  | 'fallback'
  | 'failed_closed';

export type RealtimeMissionResumeOutcome = 'resumed' | 'failed_closed';

const MISSION_RESUME_READY_TIMEOUT_MS = 15_000;
const MANUAL_HANDOFF_TURN_TIMEOUT_MS = 5_000;

export class RealtimeSessionController {
  private orchestrator: RealtimeOrchestratorLike | null = null;
  private unsubscribe: (() => void) | null = null;
  private publisher: RealtimeContextPublisher | null = null;
  private controlGate: RealtimeControlGateLike | null = null;
  private lastTransport: RealtimeTransportLike | null = null;
  private contextPublished = false;
  private activeFlag = false;
  /** Fence start/stop : chaque stop (ou prise de main du repli) invalide les bootstraps en
   * vol — un start() doublé ne peut JAMAIS rouvrir un micro après coup (P0 review 14/07). */
  private generation = 0;
  /** Une reconnexion conserve la mission et donc `generation`. Cette seconde génération
   * invalide pourtant toute continuation (PUT/ACK/completion) appartenant à l'ancien peer. */
  private primaryGeneration = 0;
  /** Le port terminal orchestrateur a pris la main. Selon l'autorité observée, il a soit émis
   * onFallback, soit fermé via onFailedClosed ; start() ne doit jamais relancer une boucle. */
  private fallbackTaken = false;
  /** Un primaire Mission dégradé ne terminalise l'UI qu'une fois, même si transport et
   * orchestrateur signalent tous deux la rupture. Réarmé uniquement par un nouveau start. */
  private failedClosedNotified = false;
  /**
   * ACK de contrôle partagé par tour. Le terminal du même tour l'attend avant de provoquer la
   * relecture mission : l'UI ne peut donc jamais relire entre contrôle authentifié et effet.
   */
  private readonly pendingControlAcks = new Map<string, Promise<boolean>>();
  /** Résultat du reçu HTTP jusqu'au terminal du même tour. Un contrôle annoncé mais non relu
   * interdit de solder la mission : la base et l'écran doivent converger ou échouer ensemble. */
  private readonly controlAckOutcomes = new Map<string, boolean>();
  /** Ledger borné par le budget de 60 tours : un reçu rejouable ne double jamais son effet UI. */
  private readonly appliedControlTurns = new Set<string>();
  /** Effet terminal authentifie, retenu jusqu'a la fermeture COMPLETE du transport one-shot. */
  private pendingTerminalDecision: AgentControlDecision | null = null;
  /** Deduplication du signal autoritatif et du fallback manuel de finishUserInput(). */
  private committedTurnId: string | null = null;
  /** READY technique ne doit pas ecraser THINKING entre le commit et le debut de Bob. */
  private responsePendingForCurrentInput = false;
  private agentMissionSession: RealtimeAgentMissionSession | null = null;
  private agentMissionSessionClaimed = false;
  /**
   * Latch de sécurité pour toute la session contrôleur. Dès qu'une capability Mission a été
   * observée, aucun repli legacy ne peut reprendre la conversation, même si la capability est
   * ensuite libérée par un remplacement de peer, le teardown ou un événement fallback anticipé.
   */
  private agentMissionCapabilityObserved = false;
  private agentMissionSessionTransferred = false;
  private agentMissionRealtimeSessionId: string | null = null;
  private requireMissionV1ForStart = false;
  private agentMissionContextConfirmed = false;
  private missionReadyWaiter: {
    readonly promise: Promise<boolean>;
    readonly resolve: (ready: boolean) => void;
  } | null = null;
  private readonly turnSettlementWaiters = new Map<
    string,
    Set<(settled: boolean) => void>
  >();

  constructor(
    private readonly deps: RealtimeSessionDeps,
    private readonly hooks: RealtimeSessionHooks,
  ) {}

  get active(): boolean {
    return this.activeFlag;
  }

  async start(): Promise<RealtimeStartOutcome> {
    return this.startInternal(false);
  }

  /**
   * Reprise froide Mission V1 : aucune sortie legacy n'est autorisée.
   *
   * `resumed` signifie capability transférée, contexte exact confirmé et micro ouvert. Un simple
   * socket `ready`, une négociation sans capability ou un fallback fournisseur échoue fermé.
   */
  async resumeMissionV1(): Promise<RealtimeMissionResumeOutcome> {
    const outcome = await this.startInternal(true);
    return outcome === 'realtime' ? 'resumed' : 'failed_closed';
  }

  private async startInternal(
    requireMissionV1: boolean,
  ): Promise<RealtimeStartOutcome> {
    if (this.activeFlag) {
      return !requireMissionV1
        || (this.agentMissionSessionTransferred && this.agentMissionContextConfirmed)
        ? 'realtime'
        : 'failed_closed';
    }
    const gen = ++this.generation;
    this.requireMissionV1ForStart = requireMissionV1;
    this.agentMissionContextConfirmed = false;
    this.prepareMissionReadyWaiter(requireMissionV1);
    this.fallbackTaken = false;
    this.failedClosedNotified = false;
    this.pendingTerminalDecision = null;
    this.resetCommittedInputLifecycle();
    // Un orchestrateur zombie (repli mid-call scellé sans stop explicite) meurt ici :
    // chaque start() repart d'un monde propre, jamais d'un transport mort.
    if (this.orchestrator) await this.teardown('user');
    this.agentMissionCapabilityObserved = false;
    let negotiation: RealtimeVoiceConfig | null;
    try {
      negotiation = await this.deps.negotiate();
    } catch {
      this.resolveMissionReady(false);
      return requireMissionV1 ? 'failed_closed' : 'unavailable';
    }
    if (!negotiation?.available) {
      this.resolveMissionReady(false);
      return requireMissionV1 ? 'failed_closed' : 'unavailable';
    }
    if (gen !== this.generation) {
      this.resolveMissionReady(false);
      return requireMissionV1 ? 'failed_closed' : 'unavailable';
    }
    this.contextPublished = false;
    const fallbackPort: LegacyVoiceFallbackPort = {
      start: async (input) => {
        const missionAuthorityObserved = this.hasObservedMissionAuthority();
        this.disposeAgentMissionSession();
        // Le primaire est ENTIÈREMENT fermé (garantie orchestrateur). La session temps réel
        // est TERMINÉE : on se scelle (génération invalidée, événements tardifs ignorés,
        // prochain start() propre) SANS stopper l'orchestrateur depuis son propre callback.
        this.generation += 1;
        this.activeFlag = false;
        this.fallbackTaken = true;
        this.resolveMissionReady(false);
        this.publisher?.close();
        this.publisher = null;
        this.controlGate?.close?.();
        this.controlGate = null;
        if (missionAuthorityObserved) {
          this.notifyFailedClosed(input.reason);
        } else if (!this.requireMissionV1ForStart) {
          this.hooks.onFallback(input.reason, input.channel);
        }
        return { close: async () => undefined };
      },
    };
    this.orchestrator = this.deps.createOrchestrator(
      negotiation,
      fallbackPort,
      () => this.publisher?.fence ?? null,
      (transport) => this.adoptPrimary(transport),
    );
    this.unsubscribe = this.orchestrator.subscribe((event) => {
      void this.handleEvent(event);
    });
    this.activeFlag = true;
    const state = await this.orchestrator.start();
    if (this.fallbackTaken) {
      return requireMissionV1 || this.hasObservedMissionAuthority()
        ? 'failed_closed'
        : 'fallback';
    }
    if (gen !== this.generation) {
      this.resolveMissionReady(false);
      return requireMissionV1 ? 'failed_closed' : 'unavailable';
    }
    if (state.phase === 'failed' || state.phase === 'stopped' || state.phase === 'legacy') {
      const failedClosed =
        requireMissionV1
        || this.hasObservedMissionAuthority()
        || state.lastFailureReason === 'agent_mission_negotiation_failed';
      await this.stop('user');
      return failedClosed ? 'failed_closed' : 'unavailable';
    }
    if (requireMissionV1 && !await this.waitForMissionReady(gen)) {
      if (gen === this.generation) await this.stop('user');
      return 'failed_closed';
    }
    return 'realtime';
  }

  /**
   * Coupe l'oreille sans détruire la capability nécessaire à l'annulation durable.
   * Si un tour a déjà été commité, la suspension n'est acquittée qu'après son terminal exact.
   */
  async suspendForManualHandoff(): Promise<boolean> {
    const transport = this.lastTransport;
    if (!this.activeFlag || transport === null) return false;
    transport.setMicrophoneEnabled(false);
    transport.interrupt('tap');
    const turnId = this.committedTurnId;
    if (turnId === null) return true;
    return this.waitForTurnSettlement(turnId);
  }

  /** Détruit la capability terminalisée puis ferme le transport, dans cet ordre. */
  async stopAfterManualHandoff(): Promise<void> {
    const realtimeSessionId = this.agentMissionRealtimeSessionId;
    let released = true;
    if (realtimeSessionId !== null && this.agentMissionSessionTransferred) {
      try {
        released =
          this.deps.agentMissionRuntime?.release(realtimeSessionId) === true;
      } catch {
        released = false;
      }
      if (released) {
        this.agentMissionSessionTransferred = false;
        this.agentMissionRealtimeSessionId = null;
      }
    }
    await this.stop('user');
    if (!released) throw new Error('agent_mission_release_failed');
  }

  /** Changement d'écran (addendum 20:34) : micro OFF → interrupt(navigation) → PUT exact ;
   * succès = micro rouvert sur le NOUVEAU contexte ; échec = stop/fallback (jamais un
   * cerveau parlant sur un contexte périmé). Inopérant hors session. */
  async publishContext(): Promise<void> {
    if (!this.activeFlag || this.publisher === null || this.lastTransport === null) return;
    const controllerGeneration = this.generation;
    const primaryGeneration = this.primaryGeneration;
    const transport = this.lastTransport;
    const publisher = this.publisher;
    const context = this.hooks.getContextSnapshot();
    this.invalidateAgentMissionContext();
    this.resetCommittedInputLifecycle();
    transport.setMicrophoneEnabled(false);
    transport.interrupt('navigation');
    const result = await publisher.publish(context);
    if (
      !this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport) ||
      this.publisher !== publisher
    )
      return;
    // Supersédée = une publication PLUS RÉCENTE est en vol : c'est ELLE qui rouvrira le
    // micro sur le contexte frais. La traiter en échec tuait la session à chaque navigation.
    if (result.status === 'superseded') return;
    if (result.status === 'failed') {
      await this.stopCurrentPrimaryWithFallback(
        controllerGeneration,
        primaryGeneration,
        transport,
        'provider_error',
      );
      return;
    }
    if (!await this.synchronizeTransportContext(
      controllerGeneration,
      primaryGeneration,
      transport,
      result.fence,
    )) return;
    if (!await this.confirmAgentMissionContext(
      controllerGeneration,
      primaryGeneration,
      transport,
      result.fence,
      context,
    )) return;
    await this.openMicrophoneIfActive(
      controllerGeneration,
      primaryGeneration,
      transport,
    );
  }

  /** Commit semi-duplex : conserve socket, feed audité et contrôle jusqu'à la réponse. */
  async finishUserInput(): Promise<boolean> {
    const transport = this.lastTransport;
    if (!this.activeFlag || transport === null) return false;
    const finishUserInput = transport.finishUserInput;
    if (finishUserInput === undefined) return false;
    let accepted = false;
    try {
      accepted = await finishUserInput.call(transport);
    } catch {
      accepted = false;
    }
    if (accepted && this.activeFlag && this.lastTransport === transport) {
      this.publishThinkingForCurrentInput();
    }
    return accepted;
  }

  async stop(reason: 'user' | 'background' | 'unmount' = 'user'): Promise<void> {
    this.generation += 1; // invalide tout start() encore en vol — jamais de micro posthume
    await this.teardown(reason);
  }

  private async teardown(reason: 'user' | 'background' | 'unmount'): Promise<void> {
    this.resolveMissionReady(false);
    this.resolveAllTurnSettlementWaiters(false);
    this.disposeAgentMissionSession();
    this.activeFlag = false;
    this.pendingControlAcks.clear();
    this.controlAckOutcomes.clear();
    this.appliedControlTurns.clear();
    this.pendingTerminalDecision = null;
    this.resetCommittedInputLifecycle();
    this.publisher?.close();
    this.publisher = null;
    this.controlGate?.close?.();
    this.controlGate = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const orchestrator = this.orchestrator;
    this.orchestrator = null;
    this.lastTransport = null;
    if (orchestrator) await orchestrator.stop(reason);
  }

  private async handleEvent(event: RealtimeResilienceEvent): Promise<void> {
    if (!this.activeFlag || event.type !== 'transport') return;
    await this.handleTransportEvent(event.event);
  }

  private async handleTransportEvent(event: RealtimeTransportEvent): Promise<void> {
    switch (event.type) {
      case 'state': {
        if (event.state.phase === 'user_speaking') {
          this.resetCommittedInputLifecycle();
        }
        const preserveThinking = event.state.phase === 'ready'
          && this.responsePendingForCurrentInput;
        if (event.state.phase === 'bob_speaking') {
          this.responsePendingForCurrentInput = false;
        }
        if (!preserveThinking) this.hooks.onPhase(mapTransportPhase(event.state.phase));
        if (event.state.phase === 'ready' && !this.contextPublished) {
          this.contextPublished = true;
          await this.publishThenOpenMicrophone();
        }
        return;
      }
      case 'user_input_committed':
        this.publishThinkingForCurrentInput(event.turnId);
        return;
      case 'user_transcript':
        this.hooks.onUserTranscript(event.text, event.final);
        return;
      case 'bob_transcript':
        this.hooks.onBobTranscript(event.text, event.final);
        return;
      case 'agent_control_candidate': {
        // Référence provider NON FIABLE → ACK one-shot par NOTRE serveur (gate, fencé sur la
        // publication confirmée) → décision UNIQUEMENT sur le contrôle authentifié non-null.
        const controllerGeneration = this.generation;
        const primaryGeneration = this.primaryGeneration;
        const transport = this.lastTransport;
        const publisher = this.publisher;
        const gate = this.controlGate;
        if (transport === null || publisher === null || gate === null) return;
        const turnId = event.reference.turnId;
        if (this.appliedControlTurns.has(turnId)) return;
        const existing = this.pendingControlAcks.get(turnId);
        if (existing !== undefined) {
          await existing;
          return;
        }
        const task = (async (): Promise<boolean> => {
          const control = await gate.acknowledge(event.reference);
          if (
            !control ||
            !this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport) ||
            this.publisher !== publisher ||
            this.controlGate !== gate
          ) {
            this.controlAckOutcomes.set(turnId, false);
            return false;
          }
          if (this.appliedControlTurns.has(turnId)) {
            this.controlAckOutcomes.set(turnId, true);
            return true;
          }
          this.appliedControlTurns.add(turnId);
          const decision = decideAgentControl(control);
          this.applyOrDeferDecision(decision);
          this.controlAckOutcomes.set(turnId, true);
          return true;
        })();
        this.pendingControlAcks.set(turnId, task);
        try {
          await task;
        } finally {
          if (this.pendingControlAcks.get(turnId) === task) {
            this.pendingControlAcks.delete(turnId);
          }
        }
        return;
      }
      case 'agent_control': {
        // Déjà authentifié (émis par une glue post-ACK, jamais par WebRTC) — décision directe.
        if (this.appliedControlTurns.has(event.control.turnId)) return;
        this.appliedControlTurns.add(event.control.turnId);
        const decision = decideAgentControl(event.control);
        this.applyOrDeferDecision(decision);
        return;
      }
      case 'turn_settled': {
        const controllerGeneration = this.generation;
        const primaryGeneration = this.primaryGeneration;
        const transport = this.lastTransport;
        const publisher = this.publisher;
        const realtimeSessionId = this.agentMissionRealtimeSessionId;
        if (transport === null || publisher === null) return;
        const controlAck = this.pendingControlAcks.get(event.turnId);
        if (controlAck !== undefined) await Promise.allSettled([controlAck]);
        if (
          !this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport)
          || this.publisher !== publisher
        ) {
          return;
        }
        if (this.controlAckOutcomes.get(event.turnId) === false) {
          await this.stopCurrentPrimaryWithFallback(
            controllerGeneration,
            primaryGeneration,
            transport,
            'provider_error',
          );
          return;
        }
        if (
          this.agentMissionSessionTransferred
          && (
            realtimeSessionId === null
            || this.deps.agentMissionRuntime?.settleTurn(realtimeSessionId, {
              turnId: event.turnId,
              status: event.status,
            }) !== true
          )
        ) {
          await this.stopCurrentPrimaryWithFallback(
            controllerGeneration,
            primaryGeneration,
            transport,
            'provider_error',
          );
          return;
        }
        this.controlAckOutcomes.delete(event.turnId);
        this.resolveTurnSettlementWaiters(event.turnId, true);
        if (this.committedTurnId === event.turnId) {
          this.resetCommittedInputLifecycle();
        }
        return;
      }
      case 'conversation_completed': {
        // Le candidat de contrôle est émis dans la même pile juste avant cette microtâche.
        // Attendre son échange one-shot évite de fermer le gate et de perdre une navigation.
        const controllerGeneration = this.generation;
        const primaryGeneration = this.primaryGeneration;
        const transport = this.lastTransport;
        const publisher = this.publisher;
        if (transport === null || publisher === null) return;
        await Promise.allSettled([...this.pendingControlAcks.values()]);
        if (
          !this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport) ||
          this.publisher !== publisher
        )
          return;
        const decision = this.pendingTerminalDecision;
        this.pendingTerminalDecision = null;
        const stoppedGeneration = this.generation + 1;
        await this.stop('user');
        // Une mission fraîche peut démarrer pendant la fermeture réseau de l'ancienne.
        if (this.generation !== stoppedGeneration || this.activeFlag) return;
        // Le controleur est deja inactif avant l'effet UI. Le composant peut donc naviguer sans
        // republier sur ce ticket, puis rendre son etat visuel idle via onCompleted.
        if (decision !== null) this.applyDecision(decision);
        this.hooks.onCompleted?.();
        return;
      }
      case 'fallback':
        // L'autorité Mission meurt au premier signal de dégradation, avant le hangup réseau,
        // même si l'orchestrateur attend encore la preuve de fermeture audio.
        this.disposeAgentMissionSession();
        return;
      default:
        return;
    }
  }

  private applyOrDeferDecision(decision: AgentControlDecision): void {
    if (decision.kind === 'none') return;
    if (this.lastTransport?.completionMode === 'one-shot') {
      // Le gate est one-shot. Un second effet sur le meme ticket est une derive : le premier
      // controle autoritatif gagne, les suivants restent sans effet.
      this.pendingTerminalDecision ??= decision;
      return;
    }
    this.applyDecision(decision);
  }

  private applyDecision(decision: AgentControlDecision): void {
    if (decision.kind === 'navigate') {
      // La route cible n'est pas encore rendue : fermer l'oreille et l'autorité de l'ancien
      // écran AVANT le premier effet de navigation. Le nouvel écran seul republiera son contexte
      // exact puis rouvrira le micro.
      this.resetCommittedInputLifecycle();
      this.lastTransport?.setMicrophoneEnabled(false);
      this.lastTransport?.interrupt('navigation');
      this.invalidateAgentMissionContext();
      this.hooks.onNavigate(decision.route);
    }
    else if (decision.kind === 'review') {
      this.hooks.onReview(decision.proposalId, decision.proposalExpiresAt);
    }
  }

  /** Une reconnexion ne change pas la génération de mission. Elle doit néanmoins rendre
   * immédiatement inertes le publieur, le gate et les décisions du peer remplacé. */
  private adoptPrimary(transport: RealtimeTransportLike): void {
    this.disposeAgentMissionSession();
    // Chaque primaire FRAIS naît micro fermé : le contexte part TOUJOURS avant la voix.
    transport.setMicrophoneEnabled(false);
    this.primaryGeneration += 1;
    const previousTransport = this.lastTransport;
    if (previousTransport !== null && previousTransport !== transport) {
      previousTransport.setMicrophoneEnabled(false);
    }
    this.publisher?.close();
    this.publisher = null;
    this.controlGate?.close?.();
    this.controlGate = null;
    this.pendingControlAcks.clear();
    this.controlAckOutcomes.clear();
    this.appliedControlTurns.clear();
    this.pendingTerminalDecision = null;
    this.resetCommittedInputLifecycle();
    this.lastTransport = transport;
    this.agentMissionSessionClaimed = false;
    this.contextPublished = false;
    this.controlGate = this.deps.createControlGate(() => this.publisher?.fence ?? null);
  }

  private isCurrentPrimary(
    controllerGeneration: number,
    primaryGeneration: number,
    transport: RealtimeTransportLike,
  ): boolean {
    return (
      this.activeFlag &&
      this.generation === controllerGeneration &&
      this.primaryGeneration === primaryGeneration &&
      this.lastTransport === transport
    );
  }

  private publishThinkingForCurrentInput(turnId?: string): void {
    if (turnId !== undefined) {
      if (this.committedTurnId === turnId) return;
      this.committedTurnId = turnId;
    }
    if (this.responsePendingForCurrentInput) return;
    this.responsePendingForCurrentInput = true;
    this.hooks.onPhase('thinking');
  }

  private resetCommittedInputLifecycle(): void {
    this.committedTurnId = null;
    this.responsePendingForCurrentInput = false;
  }

  private async stopCurrentPrimaryWithFallback(
    controllerGeneration: number,
    primaryGeneration: number,
    transport: RealtimeTransportLike,
    reason: RealtimeFallbackReason,
  ): Promise<void> {
    if (!this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport)) return;
    const missionAuthorityObserved = this.hasObservedMissionAuthority();
    const stoppedGeneration = this.generation + 1;
    await this.stop('user');
    // Le stop de l'ancien orchestrateur peut finir après le start d'une nouvelle mission.
    if (this.generation === stoppedGeneration && !this.activeFlag) {
      const channel = legacyFallbackChannelFor(reason);
      if (missionAuthorityObserved) {
        this.notifyFailedClosed(reason);
      } else if (channel !== null && !this.requireMissionV1ForStart) {
        this.hooks.onFallback(reason, channel);
      }
    }
  }

  private async openMicrophoneIfActive(
    controllerGeneration: number,
    primaryGeneration: number,
    transport: RealtimeTransportLike,
  ): Promise<boolean> {
    let allowed = false;
    try {
      allowed = await this.deps.allowMicrophoneActivation();
    } catch {
      allowed = false;
    }
    if (!this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport)) return false;
    if (!allowed) {
      // L'application n'est plus visible : aucun repli legacy ne doit démarrer en arrière-plan.
      await this.stop('background');
      return false;
    }
    if (!this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport)) return false;
    transport.setMicrophoneEnabled(true);
    if (
      this.requireMissionV1ForStart
      && this.agentMissionSessionTransferred
      && this.agentMissionContextConfirmed
    ) {
      this.resolveMissionReady(true);
    }
    return true;
  }

  /** Le PUT HTTP ne suffit pas au protocole Mistral v2 : sa fence doit aussi être appliquée
   * dans le stream WSS séquencé. Tout refus/timeout ferme la mission avant le micro. */
  private async synchronizeTransportContext(
    controllerGeneration: number,
    primaryGeneration: number,
    transport: RealtimeTransportLike,
    fence: RealtimePublishedFence,
  ): Promise<boolean> {
    const synchronize = transport.synchronizePublishedContext;
    if (synchronize === undefined) return true;
    let synchronized = false;
    try {
      synchronized = await synchronize.call(transport, fence);
    } catch {
      synchronized = false;
    }
    if (!this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport)) return false;
    if (synchronized) return true;
    await this.stopCurrentPrimaryWithFallback(
      controllerGeneration,
      primaryGeneration,
      transport,
      'provider_error',
    );
    return false;
  }

  /** L'ORDRE du contrat, FAIL-CLOSED (P0 GPT 20:24) : micro ON UNIQUEMENT si handle présent
   * ET PUT contexte confirmé — sinon stop + repli. Jamais une oreille sans contexte publié. */
  private async publishThenOpenMicrophone(): Promise<void> {
    const controllerGeneration = this.generation;
    const primaryGeneration = this.primaryGeneration;
    const transport = this.lastTransport;
    if (!transport) return;
    const handle = transport.getSessionHandle();
    if (handle === null) {
      await this.stopCurrentPrimaryWithFallback(
        controllerGeneration,
        primaryGeneration,
        transport,
        'provider_error',
      );
      return;
    }
    if (
      !this.agentMissionSessionClaimed
      && !this.claimAgentMissionSession(transport, handle)
    ) {
      await this.stopCurrentPrimaryWithFallback(
        controllerGeneration,
        primaryGeneration,
        transport,
        'provider_error',
      );
      return;
    }
    if (
      this.agentMissionRealtimeSessionId !== null
      && this.agentMissionRealtimeSessionId !== handle
    ) {
      await this.stopCurrentPrimaryWithFallback(
        controllerGeneration,
        primaryGeneration,
        transport,
        'provider_error',
      );
      return;
    }
    this.publisher?.close();
    const publisher = new RealtimeContextPublisher(handle, this.deps.updateContext);
    this.publisher = publisher;
    const context = this.hooks.getContextSnapshot();
    const result = await publisher.publish(context);
    if (
      !this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport) ||
      this.publisher !== publisher
    )
      return;
    if (result.status === 'superseded') return; // une publication plus récente rouvrira le micro
    if (result.status === 'failed') {
      await this.stopCurrentPrimaryWithFallback(
        controllerGeneration,
        primaryGeneration,
        transport,
        'provider_error',
      );
      return;
    }
    if (!await this.synchronizeTransportContext(
      controllerGeneration,
      primaryGeneration,
      transport,
      result.fence,
    )) return;
    if (!await this.confirmAgentMissionContext(
      controllerGeneration,
      primaryGeneration,
      transport,
      result.fence,
      context,
    )) return;
    await this.openMicrophoneIfActive(
      controllerGeneration,
      primaryGeneration,
      transport,
    );
  }

  private disposeAgentMissionSession(): void {
    this.invalidateAgentMissionContext();
    const session = this.agentMissionSession;
    this.agentMissionSession = null;
    this.agentMissionSessionClaimed = false;
    this.agentMissionSessionTransferred = false;
    this.agentMissionRealtimeSessionId = null;
    this.agentMissionContextConfirmed = false;
    session?.dispose();
  }

  private claimAgentMissionSession(
    transport: RealtimeTransportLike,
    expectedRealtimeSessionId: string,
  ): boolean {
    const session = transport.takeAgentMissionSession();
    this.agentMissionSessionClaimed = true;
    if (session === null) {
      return !this.requireMissionV1ForStart && !this.agentMissionCapabilityObserved;
    }
    this.agentMissionCapabilityObserved = true;
    if (session.realtimeSessionId !== expectedRealtimeSessionId) {
      this.agentMissionSession = session;
      this.agentMissionSessionTransferred = false;
      this.agentMissionRealtimeSessionId = null;
      return false;
    }
    this.agentMissionRealtimeSessionId = session.realtimeSessionId;
    let transferred = false;
    try {
      transferred = this.deps.agentMissionRuntime?.adopt(session) === true;
    } catch {
      transferred = false;
    }
    if (transferred) {
      this.agentMissionSession = null;
      this.agentMissionSessionTransferred = true;
      this.agentMissionContextConfirmed = false;
      return true;
    }
    if (this.deps.agentMissionRuntime !== undefined) {
      // Un provider présent mais incapable de prendre la capability est une rupture du contrat
      // M1-C. Continuer ouvrirait une conversation impossible à reprendre après navigation.
      session.dispose();
      this.agentMissionSession = null;
      this.agentMissionRealtimeSessionId = null;
      this.agentMissionSessionTransferred = false;
      return false;
    }
    this.agentMissionSession = session;
    this.agentMissionSessionTransferred = false;
    return true;
  }

  private hasObservedMissionAuthority(): boolean {
    return this.agentMissionCapabilityObserved || this.agentMissionSessionTransferred;
  }

  private notifyFailedClosed(reason: RealtimeFallbackReason): void {
    if (this.failedClosedNotified) return;
    this.failedClosedNotified = true;
    this.hooks.onFailedClosed(reason);
  }

  private invalidateAgentMissionContext(): void {
    const realtimeSessionId = this.agentMissionRealtimeSessionId;
    if (realtimeSessionId === null || !this.agentMissionSessionTransferred) return;
    this.agentMissionContextConfirmed = false;
    try {
      this.deps.agentMissionRuntime?.invalidateContext(realtimeSessionId);
    } catch {
      // Le provider n'est plus disponible. Le prochain confirm échouera fermé avant le micro.
    }
  }

  private async confirmAgentMissionContext(
    controllerGeneration: number,
    primaryGeneration: number,
    transport: RealtimeTransportLike,
    fence: RealtimePublishedFence,
    context: AgentContext,
  ): Promise<boolean> {
    if (!this.agentMissionSessionTransferred) return true;
    const realtimeSessionId = this.agentMissionRealtimeSessionId;
    let confirmed = false;
    try {
      confirmed = realtimeSessionId !== null
        && this.deps.agentMissionRuntime?.confirmContext(
          realtimeSessionId,
          fence,
          context,
        ) === true;
    } catch {
      confirmed = false;
    }
    if (!this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport)) return false;
    if (confirmed) {
      this.agentMissionContextConfirmed = true;
      return true;
    }
    await this.stopCurrentPrimaryWithFallback(
      controllerGeneration,
      primaryGeneration,
      transport,
      'provider_error',
    );
    return false;
  }

  private prepareMissionReadyWaiter(required: boolean): void {
    this.resolveMissionReady(false);
    if (!required) {
      this.missionReadyWaiter = null;
      return;
    }
    let resolve!: (ready: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    this.missionReadyWaiter = { promise, resolve };
  }

  private resolveMissionReady(ready: boolean): void {
    const waiter = this.missionReadyWaiter;
    this.missionReadyWaiter = null;
    waiter?.resolve(ready);
  }

  private async waitForMissionReady(generation: number): Promise<boolean> {
    if (this.agentMissionSessionTransferred && this.agentMissionContextConfirmed) {
      this.resolveMissionReady(true);
      return true;
    }
    const waiter = this.missionReadyWaiter;
    if (waiter === null) return false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([
      waiter.promise,
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(
          () => resolve(false),
          MISSION_RESUME_READY_TIMEOUT_MS,
        );
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    return ready
      && generation === this.generation
      && this.activeFlag
      && this.agentMissionSessionTransferred
      && this.agentMissionContextConfirmed;
  }

  private waitForTurnSettlement(turnId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const waiters = this.turnSettlementWaiters.get(turnId) ?? new Set();
      const settle = (settled: boolean): void => {
        clearTimeout(timeout);
        waiters.delete(settle);
        if (waiters.size === 0) this.turnSettlementWaiters.delete(turnId);
        resolve(settled);
      };
      waiters.add(settle);
      this.turnSettlementWaiters.set(turnId, waiters);
      const timeout = setTimeout(
        () => settle(false),
        MANUAL_HANDOFF_TURN_TIMEOUT_MS,
      );
    });
  }

  private resolveTurnSettlementWaiters(
    turnId: string,
    settled: boolean,
  ): void {
    const waiters = this.turnSettlementWaiters.get(turnId);
    if (waiters === undefined) return;
    for (const resolve of [...waiters]) resolve(settled);
  }

  private resolveAllTurnSettlementWaiters(settled: boolean): void {
    for (const turnId of [...this.turnSettlementWaiters.keys()]) {
      this.resolveTurnSettlementWaiters(turnId, settled);
    }
  }
}
