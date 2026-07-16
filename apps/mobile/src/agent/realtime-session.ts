/**
 * CONTRÔLEUR DE SESSION TEMPS RÉEL (BOB LIVE) — la glue entre l'orchestrateur de résilience
 * (lane GPT) et la session agent. Toute la logique décisionnelle vit dans realtime-driver
 * (pur, testé) ; ici on ORDONNE : connect → publier le contexte → SEULEMENT ENSUITE ouvrir
 * le micro ; événements transport → hooks de session ; arrêt → publieur fermé d'abord.
 * EXCLUSIVITÉ : tant que ce contrôleur est actif, le pilote legacy (ASR/TTS historique)
 * ne tourne pas — l'orchestrateur ne démarre le repli qu'après fermeture COMPLÈTE du primaire.
 */
import type { AgentContext } from '@bob/ai';
import type { RealtimeVoiceConfig } from '@bob/api-client';
import type {
  LegacyVoiceFallbackPort,
  RealtimeResilienceEvent,
} from '../realtime/realtime-resilience-orchestrator';
import type {
  RealtimeFallbackReason,
  RealtimeTransportEvent,
} from '../realtime/realtime-transport';
import type { RealtimeAgentControlReference } from '../realtime/realtime-event-codecs';
import type { RealtimeVoiceControlReference } from '@bob/api-client';
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
  readonly onFallback: (reason: RealtimeFallbackReason) => void;
  /** Tour one-shot livré et acquitté : fermeture normale, jamais un fallback. */
  readonly onCompleted?: () => void;
  readonly getContextSnapshot: () => AgentContext;
}

/** Sous-ensemble de l'orchestrateur consommé ici — injectable en test. */
export interface RealtimeOrchestratorLike {
  subscribe(listener: (event: RealtimeResilienceEvent) => void): () => void;
  start(): Promise<{ readonly phase: string; readonly fallbackChannel: unknown }>;
  stop(reason?: 'user' | 'background' | 'unmount'): Promise<void>;
}

/** Transport tel que vu par la glue — le contrat officiel (addendum 20:34). */
export interface RealtimeTransportLike {
  readonly completionMode: 'continuous' | 'one-shot';
  setMicrophoneEnabled(enabled: boolean): void;
  finishUserInput?(): Promise<boolean>;
  interrupt(reason: 'user_speech' | 'tap' | 'navigation'): boolean;
  getSessionHandle(): string | null;
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
}

export type RealtimeStartOutcome = 'realtime' | 'unavailable' | 'fallback';

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
  /** Le repli a pris la main via le port (onFallback DÉJÀ émis) — start() doit le dire à
   * l'appelant pour qu'il ne relance pas une DEUXIÈME boucle legacy. */
  private fallbackTaken = false;
  /** Les contrôles acoustiques déjà émis doivent finir leur ACK avant une clôture one-shot. */
  private readonly pendingControlAcks = new Set<Promise<void>>();
  /** Effet terminal authentifie, retenu jusqu'a la fermeture COMPLETE du transport one-shot. */
  private pendingTerminalDecision: AgentControlDecision | null = null;

  constructor(
    private readonly deps: RealtimeSessionDeps,
    private readonly hooks: RealtimeSessionHooks,
  ) {}

  get active(): boolean {
    return this.activeFlag;
  }

  async start(): Promise<RealtimeStartOutcome> {
    if (this.activeFlag) return 'realtime';
    const gen = ++this.generation;
    this.fallbackTaken = false;
    this.pendingTerminalDecision = null;
    // Un orchestrateur zombie (repli mid-call scellé sans stop explicite) meurt ici :
    // chaque start() repart d'un monde propre, jamais d'un transport mort.
    if (this.orchestrator) await this.teardown('user');
    let negotiation: RealtimeVoiceConfig | null;
    try {
      negotiation = await this.deps.negotiate();
    } catch {
      return 'unavailable';
    }
    if (!negotiation?.available) return 'unavailable';
    if (gen !== this.generation) return 'unavailable'; // stop() pendant le await — rien n'a démarré
    this.contextPublished = false;
    const fallbackPort: LegacyVoiceFallbackPort = {
      start: async (input) => {
        // Le primaire est ENTIÈREMENT fermé (garantie orchestrateur). La session temps réel
        // est TERMINÉE : on se scelle (génération invalidée, événements tardifs ignorés,
        // prochain start() propre) SANS stopper l'orchestrateur depuis son propre callback.
        this.generation += 1;
        this.activeFlag = false;
        this.fallbackTaken = true;
        this.publisher?.close();
        this.publisher = null;
        this.controlGate?.close?.();
        this.controlGate = null;
        this.hooks.onFallback(input.reason);
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
    if (this.fallbackTaken) return 'fallback'; // le repli a DÉJÀ relancé la boucle historique
    if (gen !== this.generation) return 'unavailable'; // stop() pendant le bootstrap — déjà démonté
    if (state.phase === 'failed' || state.phase === 'stopped' || state.phase === 'legacy') {
      await this.stop('user');
      return 'unavailable';
    }
    return 'realtime';
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
    transport.setMicrophoneEnabled(false);
    transport.interrupt('navigation');
    const result = await publisher.publish(this.hooks.getContextSnapshot());
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
    transport.setMicrophoneEnabled(true);
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
      this.hooks.onPhase('thinking');
    }
    return accepted;
  }

  async stop(reason: 'user' | 'background' | 'unmount' = 'user'): Promise<void> {
    this.generation += 1; // invalide tout start() encore en vol — jamais de micro posthume
    await this.teardown(reason);
  }

  private async teardown(reason: 'user' | 'background' | 'unmount'): Promise<void> {
    this.activeFlag = false;
    this.pendingControlAcks.clear();
    this.pendingTerminalDecision = null;
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
        this.hooks.onPhase(mapTransportPhase(event.state.phase));
        if (event.state.phase === 'ready' && !this.contextPublished) {
          this.contextPublished = true;
          await this.publishThenOpenMicrophone();
        }
        return;
      }
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
        const task = (async (): Promise<void> => {
          const control = await gate.acknowledge(event.reference);
          if (
            !control ||
            !this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport) ||
            this.publisher !== publisher ||
            this.controlGate !== gate
          )
            return;
          const decision = decideAgentControl(control);
          this.applyOrDeferDecision(decision);
        })();
        this.pendingControlAcks.add(task);
        try {
          await task;
        } finally {
          this.pendingControlAcks.delete(task);
        }
        return;
      }
      case 'agent_control': {
        // Déjà authentifié (émis par une glue post-ACK, jamais par WebRTC) — décision directe.
        const decision = decideAgentControl(event.control);
        this.applyOrDeferDecision(decision);
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
        await Promise.allSettled([...this.pendingControlAcks]);
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
    if (decision.kind === 'navigate') this.hooks.onNavigate(decision.route);
    else if (decision.kind === 'review') {
      this.hooks.onReview(decision.proposalId, decision.proposalExpiresAt);
    }
  }

  /** Une reconnexion ne change pas la génération de mission. Elle doit néanmoins rendre
   * immédiatement inertes le publieur, le gate et les décisions du peer remplacé. */
  private adoptPrimary(transport: RealtimeTransportLike): void {
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
    this.pendingTerminalDecision = null;
    this.lastTransport = transport;
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

  private async stopCurrentPrimaryWithFallback(
    controllerGeneration: number,
    primaryGeneration: number,
    transport: RealtimeTransportLike,
    reason: RealtimeFallbackReason,
  ): Promise<void> {
    if (!this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport)) return;
    const stoppedGeneration = this.generation + 1;
    await this.stop('user');
    // Le stop de l'ancien orchestrateur peut finir après le start d'une nouvelle mission.
    if (this.generation === stoppedGeneration && !this.activeFlag) {
      this.hooks.onFallback(reason);
    }
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
    this.publisher?.close();
    const publisher = new RealtimeContextPublisher(handle, this.deps.updateContext);
    this.publisher = publisher;
    const result = await publisher.publish(this.hooks.getContextSnapshot());
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
    transport.setMicrophoneEnabled(true);
  }
}
