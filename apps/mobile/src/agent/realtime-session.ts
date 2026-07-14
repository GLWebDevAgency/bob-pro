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
import type { RealtimeFallbackReason, RealtimeTransportEvent } from '../realtime/realtime-transport';
import type { RealtimeAgentControlReference } from '../realtime/realtime-event-codecs';
import type { RealtimeVoiceControlReference } from '@bob/api-client';
import {
  RealtimeContextPublisher,
  decideAgentControl,
  mapTransportPhase,
  type RealtimeContextUpdateFn,
  type RealtimePublishedFence,
  type RealtimeSessionPhase,
} from './realtime-driver';

export interface RealtimeSessionHooks {
  readonly onPhase: (phase: RealtimeSessionPhase) => void;
  readonly onUserTranscript: (text: string, final: boolean) => void;
  readonly onBobTranscript: (text: string, final: boolean) => void;
  /** Proposition serveur : validation VISUELLE uniquement (CTA existant de la session). */
  readonly onReview: (proposalId: string | null) => void;
  /** Route DÉJÀ allowlistée par decideAgentControl. */
  readonly onNavigate: (route: string) => void;
  /** Le repli legacy a pris la main (transport fermé) — texte honnête + boucle historique. */
  readonly onFallback: (reason: RealtimeFallbackReason) => void;
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
  setMicrophoneEnabled(enabled: boolean): void;
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
  /** Le repli a pris la main via le port (onFallback DÉJÀ émis) — start() doit le dire à
   * l'appelant pour qu'il ne relance pas une DEUXIÈME boucle legacy. */
  private fallbackTaken = false;

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
      (transport) => {
      // Chaque primaire FRAIS naît micro fermé : le contexte part TOUJOURS avant la voix.
      transport.setMicrophoneEnabled(false);
      this.lastTransport = transport;
      this.contextPublished = false;
      },
    );
    this.controlGate = this.deps.createControlGate(() => this.publisher?.fence ?? null);
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
    const transport = this.lastTransport;
    transport.setMicrophoneEnabled(false);
    transport.interrupt('navigation');
    const result = await this.publisher.publish(this.hooks.getContextSnapshot());
    if (!this.activeFlag) return;
    // Supersédée = une publication PLUS RÉCENTE est en vol : c'est ELLE qui rouvrira le
    // micro sur le contexte frais. La traiter en échec tuait la session à chaque navigation.
    if (result.status === 'superseded') return;
    if (result.status === 'failed') {
      const reason: RealtimeFallbackReason = 'provider_error';
      await this.stop('user');
      this.hooks.onFallback(reason);
      return;
    }
    transport.setMicrophoneEnabled(true);
  }

  async stop(reason: 'user' | 'background' | 'unmount' = 'user'): Promise<void> {
    this.generation += 1; // invalide tout start() encore en vol — jamais de micro posthume
    await this.teardown(reason);
  }

  private async teardown(reason: 'user' | 'background' | 'unmount'): Promise<void> {
    this.activeFlag = false;
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
        const control = await this.controlGate?.acknowledge(event.reference);
        if (!control || !this.activeFlag) return;
        const decision = decideAgentControl(control);
        if (decision.kind === 'navigate') this.hooks.onNavigate(decision.route);
        else if (decision.kind === 'review') this.hooks.onReview(decision.proposalId);
        return;
      }
      case 'agent_control': {
        // Déjà authentifié (émis par une glue post-ACK, jamais par WebRTC) — décision directe.
        const decision = decideAgentControl(event.control);
        if (decision.kind === 'navigate') this.hooks.onNavigate(decision.route);
        else if (decision.kind === 'review') this.hooks.onReview(decision.proposalId);
        return;
      }
      default:
        return;
    }
  }

  /** L'ORDRE du contrat, FAIL-CLOSED (P0 GPT 20:24) : micro ON UNIQUEMENT si handle présent
   * ET PUT contexte confirmé — sinon stop + repli. Jamais une oreille sans contexte publié. */
  private async publishThenOpenMicrophone(): Promise<void> {
    const transport = this.lastTransport;
    if (!transport) return;
    const handle = transport.getSessionHandle();
    if (handle === null) {
      if (this.activeFlag) {
        await this.stop('user');
        this.hooks.onFallback('provider_error');
      }
      return;
    }
    this.publisher?.close();
    this.publisher = new RealtimeContextPublisher(handle, this.deps.updateContext);
    const result = await this.publisher.publish(this.hooks.getContextSnapshot());
    if (result.status === 'superseded') return; // une publication plus récente rouvrira le micro
    if (result.status === 'failed') {
      if (this.activeFlag) {
        await this.stop('user');
        this.hooks.onFallback('provider_error');
      }
      return;
    }
    if (this.activeFlag) transport.setMicrophoneEnabled(true);
  }
}
