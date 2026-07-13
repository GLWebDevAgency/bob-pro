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
  LegacyVoiceFallbackPort,
  RealtimeResilienceEvent,
} from '../realtime/realtime-resilience-orchestrator';
import type { RealtimeFallbackReason, RealtimeTransportEvent } from '../realtime/realtime-transport';
import {
  RealtimeContextPublisher,
  decideAgentControl,
  mapTransportPhase,
  type RealtimeContextUpdateFn,
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

/** Transport tel que vu par la glue : micro pilotable + handle de session (voir note). */
export interface RealtimeTransportLike {
  setMicrophoneEnabled(enabled: boolean): void;
}

export interface RealtimeSessionDeps {
  /** Le serveur fait foi : entitlement voice_live + rollout intégrés dans `available`. */
  readonly isAvailable: () => Promise<boolean>;
  readonly updateContext: RealtimeContextUpdateFn;
  /** Fabrique l'orchestrateur ; `onPrimaryCreated` capture chaque transport primaire frais. */
  readonly createOrchestrator: (
    legacyFallback: LegacyVoiceFallbackPort,
    onPrimaryCreated: (transport: RealtimeTransportLike) => void,
  ) => RealtimeOrchestratorLike;
  /**
   * Lit le handle de session du transport prêt. CONTOURNEMENT temporaire : le champ est
   * privé chez le transport (trou de contrat signalé, handoff 21:25) — accès runtime
   * défensif, null = pas de publication de contexte (dégradé honnête, jamais un crash).
   */
  readonly readSessionHandle: (transport: RealtimeTransportLike) => string | null;
}

export type RealtimeStartOutcome = 'realtime' | 'unavailable';

export class RealtimeSessionController {
  private orchestrator: RealtimeOrchestratorLike | null = null;
  private unsubscribe: (() => void) | null = null;
  private publisher: RealtimeContextPublisher | null = null;
  private lastTransport: RealtimeTransportLike | null = null;
  private contextPublished = false;
  private activeFlag = false;

  constructor(
    private readonly deps: RealtimeSessionDeps,
    private readonly hooks: RealtimeSessionHooks,
  ) {}

  get active(): boolean {
    return this.activeFlag;
  }

  async start(): Promise<RealtimeStartOutcome> {
    if (this.activeFlag) return 'realtime';
    if (!(await this.deps.isAvailable())) return 'unavailable';
    this.contextPublished = false;
    const fallbackPort: LegacyVoiceFallbackPort = {
      start: async (input) => {
        // Le primaire est ENTIÈREMENT fermé (garantie orchestrateur) — la session peut
        // relancer sa boucle historique sans double cerveau.
        this.publisher?.close();
        this.publisher = null;
        this.hooks.onFallback(input.reason);
        return { close: async () => undefined };
      },
    };
    this.orchestrator = this.deps.createOrchestrator(fallbackPort, (transport) => {
      // Chaque primaire FRAIS naît micro fermé : le contexte part TOUJOURS avant la voix.
      transport.setMicrophoneEnabled(false);
      this.lastTransport = transport;
      this.contextPublished = false;
    });
    this.unsubscribe = this.orchestrator.subscribe((event) => {
      void this.handleEvent(event);
    });
    this.activeFlag = true;
    const state = await this.orchestrator.start();
    if (state.phase === 'failed' || state.phase === 'stopped') {
      await this.stop('user');
      return 'unavailable';
    }
    return 'realtime';
  }

  /** Republie le contexte focalisé (changement d'écran) — fencé, inopérant hors session. */
  publishContext(): void {
    if (!this.activeFlag || this.publisher === null) return;
    void this.publisher.publish(this.hooks.getContextSnapshot());
  }

  async stop(reason: 'user' | 'background' | 'unmount' = 'user'): Promise<void> {
    this.activeFlag = false;
    this.publisher?.close();
    this.publisher = null;
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
      case 'agent_control': {
        const decision = decideAgentControl(event.control);
        if (decision.kind === 'navigate') this.hooks.onNavigate(decision.route);
        else if (decision.kind === 'review') this.hooks.onReview(decision.proposalId);
        return;
      }
      default:
        return;
    }
  }

  /** L'ORDRE du contrat : contexte publié d'abord, micro ouvert ENSUITE — jamais l'inverse. */
  private async publishThenOpenMicrophone(): Promise<void> {
    const transport = this.lastTransport;
    if (!transport) return;
    const handle = this.deps.readSessionHandle(transport);
    if (handle !== null) {
      this.publisher?.close();
      this.publisher = new RealtimeContextPublisher(handle, this.deps.updateContext);
      await this.publisher.publish(this.hooks.getContextSnapshot());
    }
    if (this.activeFlag) transport.setMicrophoneEnabled(true);
  }
}
