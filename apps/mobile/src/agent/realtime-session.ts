/**
 * CONTRÔLEUR DE SESSION TEMPS RÉEL (BOB LIVE) — la glue entre l'orchestrateur de résilience
 * (lane GPT) et la session agent. Toute la logique décisionnelle vit dans realtime-driver
 * (pur, testé) ; ici on ORDONNE : connect → publier le contexte → SEULEMENT ENSUITE ouvrir
 * le micro ; événements transport → hooks de session ; arrêt → publieur fermé d'abord.
 * EXCLUSIVITÉ : tant que ce contrôleur est actif, le pilote legacy (ASR/TTS historique)
 * ne tourne pas — l'orchestrateur ne démarre le repli qu'après fermeture COMPLÈTE du primaire.
 */
import type { AgentContext } from '@bob/ai';
import type { RealtimeVoiceClientPolicyCloseReason } from '@bob/core';
import type {
  RealtimeAgentMissionProtocolVersion,
  RealtimeAgentMissionSession,
  RealtimeVoiceDiagnosticTraceDisclosure,
  RealtimeVoiceConfig,
} from '@bob/api-client';
import {
  REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
  REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
} from '@bob/api-client';
import type {
  LegacyVoiceFallbackPort,
  RealtimeResilienceEvent,
  RealtimeStopReceipt,
} from '../realtime/realtime-resilience-orchestrator';
import {
  legacyFallbackChannelFor,
  type LegacyFallbackChannel,
} from '../realtime/realtime-recovery-policy';
import type {
  RealtimeClientDiagnosticUpdate,
  RealtimeCloseReason,
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
  /** Transparence staging déjà validée par config + bootstrap, avant la phase READY. */
  readonly onDiagnosticTrace: (disclosure: RealtimeVoiceDiagnosticTraceDisclosure) => void;
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
  stop(reason?: RealtimeCloseReason): Promise<RealtimeStopReceipt>;
}

export interface RealtimeSessionStopReceipt {
  readonly status: 'closed' | 'unconfirmed';
  readonly missionReleased: boolean;
  readonly transportClosed: boolean;
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
  reportClientDiagnostic?(update: RealtimeClientDiagnosticUpdate): void;
}

interface RealtimeContextAttempt {
  readonly controllerGeneration: number;
  readonly primaryGeneration: number;
  readonly transport: RealtimeTransportLike;
  readonly publisher: RealtimeContextPublisher;
  readonly epoch: number;
  readonly fence: RealtimePublishedFence;
}

type RealtimeConfirmedContextAuthority = RealtimeContextAttempt;

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
  /**
   * Porte de confirmation temporelle appelée uniquement après qu'une négociation autoritaire
   * a choisi le protocole Mission V2. V1, OpenAI natif sans Mission et les replis legacy ne
   * dépendent jamais de cette confirmation.
   */
  readonly ensureConfirmedTimeZoneForMissionV2: () => Promise<boolean>;
  /**
   * Consentement explicite du compte de test, résolu avant tout lease audio, permission micro,
   * peer WebRTC ou appel provider. Un refus annule proprement le bootstrap.
   */
  readonly confirmDiagnosticTraceBeforeListening: (
    disclosure: RealtimeVoiceDiagnosticTraceDisclosure,
  ) => Promise<boolean>;
  readonly updateContext: RealtimeContextUpdateFn;
  /** Fabrique l'orchestrateur ; `onPrimaryCreated` capture chaque transport primaire frais. */
  readonly createOrchestrator: (
    negotiation: RealtimeVoiceConfig,
    agentMissionProtocolVersion: RealtimeAgentMissionProtocolVersion | null,
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
  | 'cancelled'
  | 'failed_closed';

export type RealtimeMissionResumeOutcome =
  | 'resumed'
  | 'cancelled'
  | 'failed_closed';

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
  /**
   * L'outcome de `start()` est l'unique autorité UX tant que le bootstrap n'a pas réussi.
   * Le hook asynchrone n'est armé qu'après ce succès et reste lié à sa génération : une
   * continuation A ne peut donc jamais repeindre une session B.
   */
  private failedClosedHookGeneration: number | null = null;
  private failedClosedNotifiedGeneration: number | null = null;
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
  private agentMissionProtocolVersion: RealtimeAgentMissionProtocolVersion | null = null;
  /**
   * Premier protocole observé pour cette génération contrôleur. Une reconnexion ne peut jamais
   * rabaisser V2 vers V1 (ni l'inverse), même après transfert du handle au runtime.
   */
  private observedAgentMissionProtocolVersion:
    RealtimeAgentMissionProtocolVersion | null = null;
  private requiredMissionProtocolVersion: RealtimeAgentMissionProtocolVersion | null = null;
  /**
   * Protocole réellement demandé au transport courant. Il est non nul aussi lors d'un start
   * frais M2-A : l'absence de capability est alors une rupture de contrat, jamais une permission
   * de rallumer le cerveau legacy.
   */
  private requestedAgentMissionProtocolVersion:
    RealtimeAgentMissionProtocolVersion | null = null;
  private agentMissionContextConfirmed = false;
  /** Toute phase READY est seulement technique. L'UI n'entre en écoute qu'après contexte
   * confirmé et activation effective de la piste locale, quel que soit le fournisseur. */
  private confirmedListeningPhaseReady = false;
  /** Un transfert vers l'UI manuelle révoque durablement l'oreille pour cette session. Aucun
   * PUT contexte ou callback transport déjà en vol ne peut la rouvrir avant un nouveau start. */
  private manualHandoffSuspended = false;
  /** Autorité locale exacte du contexte autorisé à entendre/parler. La fence HTTP brute n'est
   * jamais suffisante : transport, runtime Mission et permission micro doivent avoir convergé. */
  private contextEpoch = 0;
  private confirmedContextAuthority: RealtimeConfirmedContextAuthority | null = null;
  /** Les PUT restent latest-wins et concurrents ; seule leur application transport/Mission est
   * sérialisée afin de respecter le waiter unique Mistral et l'ordre r2 → r3. */
  private contextSynchronizationTail: Promise<void> = Promise.resolve();
  private missionReadyWaiter: {
    readonly generation: number;
    readonly promise: Promise<boolean>;
    readonly resolve: (ready: boolean) => void;
  } | null = null;
  /** Une seule fermeture possède les ressources à la fois. Les appels concurrents rejoignent
   * le même reçu ; un verdict non confirmé est ensuite réessayable par un nouveau stop/start. */
  private teardownTask: Promise<RealtimeSessionStopReceipt> | null = null;
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
    return this.startInternal(null);
  }

  /**
   * Reprise froide N-1/M1-C. Elle reste disponible uniquement pour une mission durable V1
   * détectée avant transport ; elle ne constitue jamais un fallback d'une négociation V2.
   */
  async resumeMissionV1(): Promise<RealtimeMissionResumeOutcome> {
    const outcome = await this.startInternal(REALTIME_AGENT_MISSION_PROTOCOL_VERSION);
    return outcome === 'realtime'
      ? 'resumed'
      : outcome === 'cancelled'
        ? 'cancelled'
        : 'failed_closed';
  }

  /**
   * Reprise froide Mission M2-A/V2 : aucune sortie legacy n'est autorisée.
   *
   * `resumed` signifie capability transférée, contexte exact confirmé et micro ouvert. Un simple
   * socket `ready`, une capability V1, une négociation sans capability ou un fallback fournisseur
   * échoue fermé.
   */
  async resumeMissionV2(): Promise<RealtimeMissionResumeOutcome> {
    const outcome = await this.startInternal(REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION);
    return outcome === 'realtime'
      ? 'resumed'
      : outcome === 'cancelled'
        ? 'cancelled'
        : 'failed_closed';
  }

  private async startInternal(
    requiredMissionProtocolVersion: RealtimeAgentMissionProtocolVersion | null,
  ): Promise<RealtimeStartOutcome> {
    const missionRequired = requiredMissionProtocolVersion !== null;
    if (missionRequired && this.deps.agentMissionRuntime === undefined) {
      return 'failed_closed';
    }
    if (this.activeFlag) {
      return !missionRequired
        || (
          this.agentMissionSessionTransferred
          && this.agentMissionContextConfirmed
          && this.agentMissionProtocolVersion === requiredMissionProtocolVersion
        )
        ? 'realtime'
        : 'failed_closed';
    }
    // Un orchestrateur terminalisé peut encore exister après un repli mid-call. Le fermer AVANT
    // de créer le waiter frais évite que le teardown de A ne résolve celui de B.
    if (this.orchestrator || this.agentMissionSessionTransferred) {
      // Ce nouvel appel reprend l'autorité UX : son outcome, et non un callback terminal tardif
      // de l'ancien monde, expliquera tout refus de nettoyage.
      this.failedClosedHookGeneration = null;
      const cleanupGeneration = this.generation;
      if ((await this.teardown('user', cleanupGeneration)).status !== 'closed') {
        return 'failed_closed';
      }
    }
    const gen = ++this.generation;
    this.failedClosedHookGeneration = null;
    this.requiredMissionProtocolVersion = requiredMissionProtocolVersion;
    this.confirmedListeningPhaseReady = false;
    this.manualHandoffSuspended = false;
    this.revokeConfirmedContextAuthority();
    this.observedAgentMissionProtocolVersion = null;
    this.agentMissionContextConfirmed = false;
    this.prepareMissionReadyWaiter(missionRequired, gen);
    this.fallbackTaken = false;
    this.pendingTerminalDecision = null;
    this.resetCommittedInputLifecycle();
    this.agentMissionCapabilityObserved = false;
    let negotiation: RealtimeVoiceConfig | null;
    try {
      negotiation = await this.deps.negotiate();
    } catch {
      if (gen !== this.generation) {
        this.resolveMissionReady(false, gen);
        return 'cancelled';
      }
      this.resolveMissionReady(false, gen);
      return missionRequired ? 'failed_closed' : 'unavailable';
    }
    if (gen !== this.generation) {
      // negotiate() n'est pas abortable : une réponse tardive après stop/background ne doit
      // jamais ressusciter une erreur UI, une capability ou un transport de l'ancienne génération.
      this.resolveMissionReady(false, gen);
      return 'cancelled';
    }
    if (!negotiation?.available) {
      this.resolveMissionReady(false, gen);
      if (negotiation?.speechDelivery === 'openai-native-webrtc-v1') {
        // Le discriminant du rail, déjà compris par N-1, suffit : toute indisponibilité native
        // ferme le nouveau client. On ne casse pas le wire v4 avec un nouvel enum de diagnostic.
        return 'failed_closed';
      }
      return missionRequired ? 'failed_closed' : 'unavailable';
    }
    if (negotiation.diagnosticTrace !== undefined) {
      let accepted = false;
      try {
        accepted = await this.deps.confirmDiagnosticTraceBeforeListening(
          negotiation.diagnosticTrace,
        );
      } catch {
        accepted = false;
      }
      if (gen !== this.generation) {
        this.resolveMissionReady(false, gen);
        return 'cancelled';
      }
      if (!accepted) {
        this.resolveMissionReady(false, gen);
        return 'cancelled';
      }
    }
    if (
      missionRequired
      && negotiation.transport !== 'webrtc'
    ) {
      this.resolveMissionReady(false, gen);
      return 'failed_closed';
    }
    const requestedAgentMissionProtocolVersion:
      RealtimeAgentMissionProtocolVersion | null =
        negotiation.transport === 'webrtc'
          ? (
              requiredMissionProtocolVersion
              ?? REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
            )
          : null;
    if (
      requestedAgentMissionProtocolVersion
        === REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
    ) {
      let timeZoneConfirmed = false;
      try {
        timeZoneConfirmed =
          await this.deps.ensureConfirmedTimeZoneForMissionV2();
      } catch {
        timeZoneConfirmed = false;
      }
      if (gen !== this.generation) {
        this.resolveMissionReady(false, gen);
        return missionRequired ? 'failed_closed' : 'unavailable';
      }
      if (!timeZoneConfirmed) {
        this.resolveMissionReady(false, gen);
        return 'cancelled';
      }
    }
    if (
      requestedAgentMissionProtocolVersion !== null
      && this.deps.agentMissionRuntime === undefined
    ) {
      this.resolveMissionReady(false, gen);
      return 'failed_closed';
    }
    this.requestedAgentMissionProtocolVersion =
      requestedAgentMissionProtocolVersion;
    const mustAwaitMissionReady = missionRequired
      || negotiation.speechDelivery === 'openai-native-webrtc-v1';
    if (mustAwaitMissionReady && !missionRequired) {
      // Le bouton/orbe appelle start() sans protocole explicite. Le delivery natif négocié reste
      // néanmoins Mission V2 obligatoire et doit donc créer le même waiter que resumeMissionV2().
      this.prepareMissionReadyWaiter(true, gen);
    }
    if (gen !== this.generation) {
      this.resolveMissionReady(false, gen);
      return missionRequired ? 'failed_closed' : 'unavailable';
    }
    this.contextPublished = false;
    const fallbackPort: LegacyVoiceFallbackPort = {
      start: async (input) => {
        if (gen !== this.generation) return { close: async () => undefined };
        const missionAuthorityObserved = this.hasObservedMissionAuthority();
        const missionReleased = this.releaseAgentMissionSession();
        // Le primaire est ENTIÈREMENT fermé (garantie orchestrateur). La session temps réel
        // est TERMINÉE : on se scelle (génération invalidée, événements tardifs ignorés,
        // prochain start() propre) SANS stopper l'orchestrateur depuis son propre callback.
        this.generation += 1;
        this.activeFlag = false;
        this.fallbackTaken = true;
        this.resolveMissionReady(false, gen);
        this.publisher?.close();
        this.publisher = null;
        this.controlGate?.close?.();
        this.controlGate = null;
        if (!missionReleased) {
          this.notifyFailedClosed('agent_mission_negotiation_failed', gen);
        } else if (
          missionAuthorityObserved
          || this.requestedAgentMissionProtocolVersion !== null
        ) {
          this.notifyFailedClosed(input.reason, gen);
        } else {
          this.hooks.onFallback(input.reason, input.channel);
        }
        return { close: async () => undefined };
      },
    };
    this.orchestrator = this.deps.createOrchestrator(
      negotiation,
      requestedAgentMissionProtocolVersion,
      fallbackPort,
      () => this.currentConfirmedFence(),
      (transport) => this.adoptPrimary(transport),
    );
    this.unsubscribe = this.orchestrator.subscribe((event) => {
      void this.handleEvent(event, gen);
    });
    this.activeFlag = true;
    const state = await this.orchestrator.start();
    if (this.fallbackTaken) {
      return missionRequired
        || requestedAgentMissionProtocolVersion !== null
        || this.hasObservedMissionAuthority()
        ? 'failed_closed'
        : 'fallback';
    }
    if (gen !== this.generation) {
      this.resolveMissionReady(false, gen);
      return missionRequired ? 'failed_closed' : 'unavailable';
    }
    if (state.phase === 'failed' || state.phase === 'stopped' || state.phase === 'legacy') {
      const failedClosed =
        missionRequired
        || requestedAgentMissionProtocolVersion !== null
        || this.hasObservedMissionAuthority()
        || state.lastFailureReason === 'agent_mission_negotiation_failed';
      await this.stop('user');
      return failedClosed ? 'failed_closed' : 'unavailable';
    }
    if (mustAwaitMissionReady) {
      if (requestedAgentMissionProtocolVersion === null) {
        if (gen === this.generation) await this.stop('user');
        return 'failed_closed';
      }
      if (!await this.waitForMissionReady(gen, requestedAgentMissionProtocolVersion)) {
        if (gen === this.generation) await this.stop('user');
        return 'failed_closed';
      }
    }
    // À partir de ce point seulement, l'outcome a certifié une session réellement vivante.
    // Les ruptures suivantes sont asynchrones et passent par le hook, exactement une fois/gen.
    this.failedClosedHookGeneration = gen;
    return 'realtime';
  }

  /**
   * Coupe l'oreille sans détruire la capability nécessaire à l'annulation durable.
   * Si un tour a déjà été commité, la suspension n'est acquittée qu'après son terminal exact.
   */
  async suspendForManualHandoff(): Promise<boolean> {
    const transport = this.lastTransport;
    if (!this.activeFlag || transport === null) return false;
    this.manualHandoffSuspended = true;
    transport.setMicrophoneEnabled(false);
    this.revokeConfirmedContextAuthority();
    this.markContextTransitionNotListening();
    transport.interrupt('tap');
    const turnId = this.committedTurnId;
    if (turnId === null) return true;
    return this.waitForTurnSettlement(turnId);
  }

  /** Détruit la capability terminalisée puis ferme le transport, dans cet ordre. */
  async stopAfterManualHandoff(): Promise<void> {
    const originGeneration = this.generation;
    this.generation += 1;
    const receipt = await this.teardown('user', originGeneration);
    if (receipt.status !== 'closed') throw new Error('agent_mission_release_failed');
  }

  /** Changement d'écran (addendum 20:34) : micro OFF → interrupt(navigation) → PUT exact ;
   * succès = micro rouvert sur le NOUVEAU contexte ; échec = stop/fallback (jamais un
   * cerveau parlant sur un contexte périmé). Inopérant hors session. */
  async publishContext(): Promise<void> {
    if (
      !this.activeFlag
      || this.manualHandoffSuspended
      || this.publisher === null
      || this.lastTransport === null
    ) return;
    const controllerGeneration = this.generation;
    const primaryGeneration = this.primaryGeneration;
    const transport = this.lastTransport;
    const publisher = this.publisher;
    const context = this.hooks.getContextSnapshot();
    transport.setMicrophoneEnabled(false);
    this.revokeConfirmedContextAuthority();
    const contextEpoch = this.contextEpoch;
    this.markContextTransitionNotListening();
    this.invalidateAgentMissionContext();
    this.resetCommittedInputLifecycle();
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
      transport.reportClientDiagnostic?.({
        type: 'failure',
        failureCode: 'context_publish_failed',
      });
      await this.stopCurrentPrimaryWithFallback(
        controllerGeneration,
        primaryGeneration,
        transport,
        'provider_error',
      );
      return;
    }
    await this.enqueueConfirmedContextActivation({
      controllerGeneration,
      primaryGeneration,
      transport,
      publisher,
      epoch: contextEpoch,
      fence: result.fence,
    }, context);
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

  async stop(
    reason: 'user' | 'background' | 'unmount' = 'user',
  ): Promise<RealtimeSessionStopReceipt> {
    return this.stopWithCloseReason(reason);
  }

  private async stopWithCloseReason(
    reason: RealtimeCloseReason,
  ): Promise<RealtimeSessionStopReceipt> {
    if (this.teardownTask !== null) return this.teardownTask;
    const originGeneration = this.generation;
    this.generation += 1; // invalide tout start() encore en vol — jamais de micro posthume
    return this.teardown(reason, originGeneration);
  }

  async stopForPolicy(
    reason: RealtimeVoiceClientPolicyCloseReason,
  ): Promise<RealtimeSessionStopReceipt> {
    // Publier la cause AVANT orchestrator.stop(): son AbortSignal externe peut gagner la course
    // contre primary.close(), mais le transport conservera alors la policy au lieu de fabriquer
    // un arrêt `aborted` ou `user`.
    if (this.teardownTask === null) {
      this.lastTransport?.reportClientDiagnostic?.({ type: 'policy_stop', closeReason: reason });
    }
    return this.stopWithCloseReason('user');
  }

  private async teardown(
    reason: RealtimeCloseReason,
    originGeneration: number,
  ): Promise<RealtimeSessionStopReceipt> {
    if (this.teardownTask !== null) return this.teardownTask;
    const task = this.performTeardown(reason, originGeneration).finally(() => {
      if (this.teardownTask === task) this.teardownTask = null;
    });
    this.teardownTask = task;
    return task;
  }

  private async performTeardown(
    reason: RealtimeCloseReason,
    originGeneration: number,
  ): Promise<RealtimeSessionStopReceipt> {
    const transport = this.lastTransport;
    try {
      transport?.setMicrophoneEnabled(false);
    } catch {
      // La fermeture du peer reste obligatoire ci-dessous ; aucune exception UI ne rouvre le mic.
    }
    this.revokeConfirmedContextAuthority();
    this.markContextTransitionNotListening();
    this.resolveAllTurnSettlementWaiters(false);
    const missionReleased = this.releaseAgentMissionSession();
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
    const transportReceipt = orchestrator
      ? await orchestrator.stop(reason)
      : Object.freeze({
          status: 'closed',
          primaryClosed: true,
          fallbackClosed: true,
        } satisfies RealtimeStopReceipt);
    const transportClosed = transportReceipt.status === 'closed';
    if (transportClosed && this.orchestrator === orchestrator) {
      this.orchestrator = null;
      if (this.lastTransport === transport) this.lastTransport = null;
    }
    // Le résultat de bootstrap ne devient terminal qu'après le cleanup réel. La génération
    // empêche un teardown A tardif de résoudre le waiter d'une nouvelle session B.
    this.resolveMissionReady(false, originGeneration);
    return Object.freeze({
      status: missionReleased && transportClosed ? 'closed' : 'unconfirmed',
      missionReleased,
      transportClosed,
    });
  }

  private async handleEvent(
    event: RealtimeResilienceEvent,
    originGeneration: number,
  ): Promise<void> {
    if (
      !this.activeFlag
      || originGeneration !== this.generation
      || event.type !== 'transport'
    ) return;
    await this.handleTransportEvent(event.event, originGeneration);
  }

  private async handleTransportEvent(
    event: RealtimeTransportEvent,
    originGeneration: number,
  ): Promise<void> {
    switch (event.type) {
      case 'state': {
        if (
          this.currentConfirmedFence() === null
          && event.state.phase !== 'ready'
          && event.state.phase !== 'connecting'
          && event.state.phase !== 'authorizing'
          && event.state.phase !== 'degraded'
          && event.state.phase !== 'closing'
          && event.state.phase !== 'closed'
        ) return;
        if (event.state.phase === 'user_speaking') {
          this.resetCommittedInputLifecycle();
        }
        const preserveThinking = event.state.phase === 'ready'
          && this.responsePendingForCurrentInput;
        if (event.state.phase === 'bob_speaking') {
          this.responsePendingForCurrentInput = false;
        }
        const deferTechnicalListening = (
          event.state.phase === 'ready' || event.state.phase === 'user_speaking'
        )
          && !this.confirmedListeningPhaseReady;
        if (!preserveThinking && !deferTechnicalListening) {
          this.hooks.onPhase(mapTransportPhase(event.state.phase));
        }
        if (event.state.phase === 'ready' && !this.contextPublished) {
          this.contextPublished = true;
          await this.publishThenOpenMicrophone();
        }
        return;
      }
      case 'user_input_committed':
        if (this.currentConfirmedFence() === null) return;
        this.publishThinkingForCurrentInput(event.turnId);
        return;
      case 'user_transcript':
        if (this.currentConfirmedFence() === null) return;
        this.hooks.onUserTranscript(event.text, event.final);
        return;
      case 'bob_transcript':
        if (this.currentConfirmedFence() === null) return;
        this.hooks.onBobTranscript(event.text, event.final);
        return;
      case 'diagnostic_trace_disclosure':
        this.hooks.onDiagnosticTrace(event.disclosure);
        return;
      case 'agent_control_candidate': {
        const contextEpoch = this.contextEpoch;
        if (this.currentConfirmedFence() === null) return;
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
            contextEpoch !== this.contextEpoch ||
            !this.controlMatchesCurrentFence(control) ||
            !this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport) ||
            this.publisher !== publisher ||
            this.controlGate !== gate
          ) {
            if (contextEpoch === this.contextEpoch) this.controlAckOutcomes.set(turnId, false);
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
        if (!this.controlMatchesCurrentFence(event.control)) return;
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
        if (this.currentConfirmedFence() === null) return;
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
        const receipt = await this.stop('user');
        // Une mission fraîche peut démarrer pendant la fermeture réseau de l'ancienne.
        if (this.generation !== stoppedGeneration || this.activeFlag) return;
        if (receipt.status !== 'closed') {
          this.notifyFailedClosed('provider_error', controllerGeneration);
          return;
        }
        // Le controleur est deja inactif avant l'effet UI. Le composant peut donc naviguer sans
        // republier sur ce ticket, puis rendre son etat visuel idle via onCompleted.
        if (decision !== null) this.applyDecision(decision);
        this.hooks.onCompleted?.();
        return;
      }
      case 'fallback':
        // Un rail Mission ne se reconnecte jamais derrière une UI en erreur. L'invalidation de la
        // génération et le stop orchestrateur sont armés dans CETTE pile, avant scheduleRecovery.
        if (
          this.requestedAgentMissionProtocolVersion !== null
          || this.hasObservedMissionAuthority()
        ) {
          // Ce latch appartient aussi au bootstrap : sans lui, la génération invalidée ci-dessous
          // serait traduite en `unavailable` par startInternal(), puis l'appelant rallumerait le
          // pilote legacy alors que la négociation avait déjà choisi Mission V2.
          this.fallbackTaken = true;
          const stoppedGeneration = this.generation + 1;
          const receipt = await this.stopWithCloseReason('fallback');
          if (this.generation === stoppedGeneration && !this.activeFlag) {
            this.notifyFailedClosed(
              !receipt.missionReleased
                ? 'agent_mission_negotiation_failed'
                : receipt.transportClosed
                  ? event.reason
                  : 'provider_error',
              originGeneration,
            );
          }
        } else {
          // Pendant une récupération historique, l'ancien primaire n'a plus le droit d'afficher
          // « écoute » ni de laisser passer transcript/contrôle. Le primaire de remplacement
          // republiera son contexte avant de réarmer le micro.
          try {
            this.lastTransport?.setMicrophoneEnabled(false);
          } catch {
            // La fermeture/reconnexion orchestrateur reste l'autorité de cleanup.
          }
          this.revokeConfirmedContextAuthority();
          this.markContextTransitionNotListening();
        }
        return;
      case 'error':
        if (event.code === 'session_max_duration') {
          const stoppedGeneration = this.generation + 1;
          const receipt = await this.stopWithCloseReason('max_duration');
          if (this.generation === stoppedGeneration && !this.activeFlag) {
            this.notifyFailedClosed('provider_error', originGeneration);
          }
          if (receipt.status !== 'closed') return;
        } else if (event.code === 'data_channel_error') {
          try {
            this.lastTransport?.setMicrophoneEnabled(false);
          } catch {
            // Le recovery possédé reste obligatoire ; ne jamais repeindre listening entre pairs.
          }
          this.revokeConfirmedContextAuthority();
          this.markContextTransitionNotListening();
        }
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
      this.revokeConfirmedContextAuthority();
      this.markContextTransitionNotListening();
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
    // Chaque primaire FRAIS naît micro fermé : le contexte part TOUJOURS avant la voix.
    transport.setMicrophoneEnabled(false);
    const previousTransport = this.lastTransport;
    if (previousTransport !== null && previousTransport !== transport) {
      previousTransport.setMicrophoneEnabled(false);
    }
    this.revokeConfirmedContextAuthority();
    this.markContextTransitionNotListening();
    this.prepareAgentMissionPrimaryReplacement();
    this.primaryGeneration += 1;
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
    this.controlGate = this.deps.createControlGate(() => this.currentConfirmedFence());
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

  private markContextTransitionNotListening(): void {
    const wasTruthfullyListening = this.confirmedListeningPhaseReady;
    this.confirmedListeningPhaseReady = false;
    if (wasTruthfullyListening) this.hooks.onPhase('thinking');
  }

  private revokeConfirmedContextAuthority(): void {
    this.contextEpoch += 1;
    this.confirmedContextAuthority = null;
    this.pendingControlAcks.clear();
    this.controlAckOutcomes.clear();
    this.pendingTerminalDecision = null;
  }

  private currentConfirmedFence(): RealtimePublishedFence | null {
    const authority = this.confirmedContextAuthority;
    if (authority === null || !this.contextAttemptIsCurrent(authority)) return null;
    return authority.fence;
  }

  private controlMatchesCurrentFence(
    control: import('../realtime/realtime-event-codecs').RealtimeAgentControl,
  ): boolean {
    const fence = this.currentConfirmedFence();
    return fence !== null
      && control.contextRevision === fence.contextRevision
      && control.contextDigest === fence.contextDigest;
  }

  private contextAttemptIsCurrent(attempt: RealtimeContextAttempt): boolean {
    const publisherFence = attempt.publisher.fence;
    return !this.manualHandoffSuspended
      && this.contextEpoch === attempt.epoch
      && this.isCurrentPrimary(
        attempt.controllerGeneration,
        attempt.primaryGeneration,
        attempt.transport,
      )
      && this.publisher === attempt.publisher
      && publisherFence !== null
      && publisherFence.sessionHandle === attempt.fence.sessionHandle
      && publisherFence.contextRevision === attempt.fence.contextRevision
      && publisherFence.contextDigest === attempt.fence.contextDigest
      && attempt.transport.getSessionHandle() === attempt.fence.sessionHandle;
  }

  private async enqueueConfirmedContextActivation(
    attempt: RealtimeContextAttempt,
    context: AgentContext,
  ): Promise<void> {
    const previous = this.contextSynchronizationTail;
    const activation = previous
      .catch(() => undefined)
      .then(() => this.activateConfirmedContext(attempt, context));
    this.contextSynchronizationTail = activation.then(() => undefined, () => undefined);
    await activation;
  }

  private async activateConfirmedContext(
    attempt: RealtimeContextAttempt,
    context: AgentContext,
  ): Promise<void> {
    if (!this.contextAttemptIsCurrent(attempt)) return;
    if (!await this.synchronizeTransportContext(attempt)) return;
    if (!this.contextAttemptIsCurrent(attempt)) return;
    if (!await this.confirmAgentMissionContext(attempt, context)) return;
    if (!this.contextAttemptIsCurrent(attempt)) return;
    attempt.transport.reportClientDiagnostic?.({
      type: 'checkpoint',
      checkpoint: 'context_confirmed',
    });
    await this.openMicrophoneIfActive(attempt);
  }

  private async stopCurrentPrimaryWithFallback(
    controllerGeneration: number,
    primaryGeneration: number,
    transport: RealtimeTransportLike,
    reason: RealtimeFallbackReason,
  ): Promise<void> {
    if (!this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport)) return;
    // Ce helper représente toujours une fermeture automatique. Les appelants qui connaissent
    // une cause plus précise l'ont déjà publiée ; first-failure-wins la conserve.
    transport.reportClientDiagnostic?.({
      type: 'failure',
      failureCode: 'provider_connection_failed',
    });
    const missionAuthorityRequired =
      this.requestedAgentMissionProtocolVersion !== null
      || this.hasObservedMissionAuthority();
    const stoppedGeneration = this.generation + 1;
    const receipt = await this.stopWithCloseReason('fallback');
    // Le stop de l'ancien orchestrateur peut finir après le start d'une nouvelle mission.
    if (this.generation === stoppedGeneration && !this.activeFlag) {
      const channel = legacyFallbackChannelFor(reason);
      if (missionAuthorityRequired) {
        this.notifyFailedClosed(
          receipt.status === 'closed' ? reason : 'provider_error',
          controllerGeneration,
        );
      } else if (channel !== null) {
        this.hooks.onFallback(reason, channel);
      }
    }
  }

  private async openMicrophoneIfActive(attempt: RealtimeContextAttempt): Promise<boolean> {
    let allowed = false;
    try {
      allowed = await this.deps.allowMicrophoneActivation();
    } catch {
      allowed = false;
    }
    if (
      !this.contextAttemptIsCurrent(attempt)
    ) return false;
    if (!allowed) {
      // L'application n'est plus visible : aucun repli legacy ne doit démarrer en arrière-plan.
      await this.stop('background');
      return false;
    }
    if (
      !this.contextAttemptIsCurrent(attempt)
    ) return false;
    try {
      attempt.transport.setMicrophoneEnabled(true);
    } catch {
      attempt.transport.reportClientDiagnostic?.({
        type: 'failure',
        failureCode: 'microphone_activation_refused',
      });
      await this.stopCurrentPrimaryWithFallback(
        attempt.controllerGeneration,
        attempt.primaryGeneration,
        attempt.transport,
        'provider_error',
      );
      return false;
    }
    // `setMicrophoneEnabled` est une frontière native qui peut émettre synchroniquement. La
    // fence ne devient donc autoritative qu'APRÈS son succès et une dernière revalidation : aucun
    // événement réentrant ne peut traverser avec une autorité contextuelle prématurée.
    if (!this.contextAttemptIsCurrent(attempt)) {
      try {
        attempt.transport.setMicrophoneEnabled(false);
      } catch {
        // Le teardown possédé reste l'autorité de fermeture ; ne jamais réouvrir sur ce contexte.
      }
      return false;
    }
    this.confirmedContextAuthority = Object.freeze({ ...attempt });
    this.confirmedListeningPhaseReady = true;
    attempt.transport.reportClientDiagnostic?.({
      type: 'checkpoint',
      checkpoint: 'microphone_opened',
    });
    this.hooks.onPhase('listening');
    if (
      this.requestedAgentMissionProtocolVersion !== null
      && this.agentMissionSessionTransferred
      && this.agentMissionContextConfirmed
      && this.agentMissionProtocolVersion === this.requestedAgentMissionProtocolVersion
    ) {
      this.resolveMissionReady(true, attempt.controllerGeneration);
    }
    return true;
  }

  /** Le PUT HTTP ne suffit pas au protocole Mistral v2 : sa fence doit aussi être appliquée
   * dans le stream WSS séquencé. Tout refus/timeout ferme la mission avant le micro. */
  private async synchronizeTransportContext(
    attempt: RealtimeContextAttempt,
  ): Promise<boolean> {
    const synchronize = attempt.transport.synchronizePublishedContext;
    if (synchronize === undefined) return true;
    let synchronized = false;
    try {
      synchronized = await synchronize.call(attempt.transport, attempt.fence);
    } catch {
      synchronized = false;
    }
    if (!this.contextAttemptIsCurrent(attempt)) return false;
    if (synchronized) return true;
    attempt.transport.reportClientDiagnostic?.({
      type: 'failure',
      failureCode: 'context_synchronization_failed',
    });
    await this.stopCurrentPrimaryWithFallback(
      attempt.controllerGeneration,
      attempt.primaryGeneration,
      attempt.transport,
      'provider_error',
    );
    return false;
  }

  /** L'ORDRE du contrat, FAIL-CLOSED (P0 GPT 20:24) : micro ON UNIQUEMENT si handle présent
   * ET PUT contexte confirmé — sinon stop + repli. Jamais une oreille sans contexte publié. */
  private async publishThenOpenMicrophone(): Promise<void> {
    if (this.manualHandoffSuspended) return;
    const controllerGeneration = this.generation;
    const primaryGeneration = this.primaryGeneration;
    const transport = this.lastTransport;
    if (!transport) return;
    const handle = transport.getSessionHandle();
    if (handle === null) {
      transport.reportClientDiagnostic?.({
        type: 'failure',
        failureCode: 'provider_connection_failed',
      });
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
      transport.reportClientDiagnostic?.({
        type: 'failure',
        failureCode: 'mission_adoption_failed',
      });
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
      transport.reportClientDiagnostic?.({
        type: 'failure',
        failureCode: 'mission_adoption_failed',
      });
      await this.stopCurrentPrimaryWithFallback(
        controllerGeneration,
        primaryGeneration,
        transport,
        'provider_error',
      );
      return;
    }
    transport.reportClientDiagnostic?.({ type: 'checkpoint', checkpoint: 'mission_adopted' });
    this.publisher?.close();
    const publisher = new RealtimeContextPublisher(handle, this.deps.updateContext);
    this.publisher = publisher;
    this.revokeConfirmedContextAuthority();
    const contextEpoch = this.contextEpoch;
    const context = this.hooks.getContextSnapshot();
    transport.reportClientDiagnostic?.({ type: 'checkpoint', checkpoint: 'context_put_started' });
    const result = await publisher.publish(context);
    if (
      !this.isCurrentPrimary(controllerGeneration, primaryGeneration, transport) ||
      this.publisher !== publisher
    )
      return;
    if (result.status === 'superseded') return; // une publication plus récente rouvrira le micro
    if (result.status === 'failed') {
      transport.reportClientDiagnostic?.({
        type: 'failure',
        failureCode: 'context_publish_failed',
      });
      await this.stopCurrentPrimaryWithFallback(
        controllerGeneration,
        primaryGeneration,
        transport,
        'provider_error',
      );
      return;
    }
    await this.enqueueConfirmedContextActivation({
      controllerGeneration,
      primaryGeneration,
      transport,
      publisher,
      epoch: contextEpoch,
      fence: result.fence,
    }, context);
  }

  /**
   * Prépare un nouveau peer sans créer de trou de propriété : si la capability a déjà été
   * transférée, le runtime la conserve jusqu'à l'adoption atomique de la capability fraîche.
   * Toute négociation fraîche refusée terminera ensuite par `releaseAgentMissionSession()`.
   */
  private prepareAgentMissionPrimaryReplacement(): void {
    this.invalidateAgentMissionContext();
    const session = this.agentMissionSession;
    this.agentMissionSession = null;
    this.agentMissionSessionClaimed = false;
    this.agentMissionContextConfirmed = false;
    session?.dispose();
    if (!this.agentMissionSessionTransferred) {
      this.agentMissionRealtimeSessionId = null;
      this.agentMissionProtocolVersion = null;
    }
  }

  /**
   * Libération terminale. Une capability transférée appartient exclusivement au runtime :
   * seul `release()` peut la détruire. En cas de refus, ses coordonnées restent mémorisées pour
   * interdire tout nouveau start et permettre une nouvelle tentative explicite.
   */
  private releaseAgentMissionSession(): boolean {
    this.invalidateAgentMissionContext();
    const session = this.agentMissionSession;
    this.agentMissionSession = null;
    this.agentMissionSessionClaimed = false;
    this.agentMissionContextConfirmed = false;
    session?.dispose();

    const realtimeSessionId = this.agentMissionRealtimeSessionId;
    if (this.agentMissionSessionTransferred && realtimeSessionId !== null) {
      let released = false;
      try {
        released =
          this.deps.agentMissionRuntime?.release(realtimeSessionId) === true;
      } catch {
        released = false;
      }
      if (!released) return false;
    }

    this.agentMissionSessionTransferred = false;
    this.agentMissionRealtimeSessionId = null;
    this.agentMissionProtocolVersion = null;
    return true;
  }

  private claimAgentMissionSession(
    transport: RealtimeTransportLike,
    expectedRealtimeSessionId: string,
  ): boolean {
    const session = transport.takeAgentMissionSession();
    this.agentMissionSessionClaimed = true;
    if (session === null) {
      return this.requestedAgentMissionProtocolVersion === null
        && !this.agentMissionCapabilityObserved;
    }
    this.agentMissionCapabilityObserved = true;
    const expectedProtocolVersion =
      this.requiredMissionProtocolVersion
      ?? this.requestedAgentMissionProtocolVersion;
    if (
      expectedProtocolVersion !== null
      && session.protocolVersion !== expectedProtocolVersion
    ) {
      session.dispose();
      return false;
    }
    if (
      this.observedAgentMissionProtocolVersion !== null
      && session.protocolVersion !== this.observedAgentMissionProtocolVersion
    ) {
      session.dispose();
      return false;
    }
    this.observedAgentMissionProtocolVersion = session.protocolVersion;
    if (session.realtimeSessionId !== expectedRealtimeSessionId) {
      session.dispose();
      return false;
    }
    let transferred = false;
    try {
      transferred = this.deps.agentMissionRuntime?.adopt(session) === true;
    } catch {
      transferred = false;
    }
    if (transferred) {
      this.agentMissionSession = null;
      this.agentMissionSessionTransferred = true;
      this.agentMissionRealtimeSessionId = session.realtimeSessionId;
      this.agentMissionProtocolVersion = session.protocolVersion;
      this.agentMissionContextConfirmed = false;
      return true;
    }
    if (this.deps.agentMissionRuntime !== undefined) {
      // Un provider présent mais incapable de prendre la capability est une rupture du contrat
      // M1-C. Continuer ouvrirait une conversation impossible à reprendre après navigation.
      session.dispose();
      this.agentMissionSession = null;
      return false;
    }
    this.agentMissionSession = session;
    this.agentMissionSessionTransferred = false;
    this.agentMissionRealtimeSessionId = session.realtimeSessionId;
    this.agentMissionProtocolVersion = session.protocolVersion;
    return true;
  }

  private hasObservedMissionAuthority(): boolean {
    return this.agentMissionCapabilityObserved || this.agentMissionSessionTransferred;
  }

  private notifyFailedClosed(
    reason: RealtimeFallbackReason,
    originGeneration: number,
  ): void {
    if (
      this.failedClosedHookGeneration !== originGeneration
      || this.failedClosedNotifiedGeneration === originGeneration
    ) return;
    this.failedClosedNotifiedGeneration = originGeneration;
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
    attempt: RealtimeContextAttempt,
    context: AgentContext,
  ): Promise<boolean> {
    if (!this.agentMissionSessionTransferred) return true;
    if (!this.contextAttemptIsCurrent(attempt)) return false;
    const realtimeSessionId = this.agentMissionRealtimeSessionId;
    let confirmed = false;
    try {
      confirmed = realtimeSessionId !== null
        && this.deps.agentMissionRuntime?.confirmContext(
          realtimeSessionId,
          attempt.fence,
          context,
        ) === true;
    } catch {
      confirmed = false;
    }
    if (!this.contextAttemptIsCurrent(attempt)) return false;
    if (confirmed) {
      this.agentMissionContextConfirmed = true;
      return true;
    }
    attempt.transport.reportClientDiagnostic?.({
      type: 'failure',
      failureCode: 'mission_context_confirmation_failed',
    });
    await this.stopCurrentPrimaryWithFallback(
      attempt.controllerGeneration,
      attempt.primaryGeneration,
      attempt.transport,
      'provider_error',
    );
    return false;
  }

  private prepareMissionReadyWaiter(required: boolean, generation: number): void {
    this.resolveMissionReady(false);
    if (!required) {
      this.missionReadyWaiter = null;
      return;
    }
    let resolve!: (ready: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    this.missionReadyWaiter = { generation, promise, resolve };
  }

  private resolveMissionReady(ready: boolean, generation?: number): void {
    const waiter = this.missionReadyWaiter;
    if (generation !== undefined && waiter?.generation !== generation) return;
    this.missionReadyWaiter = null;
    waiter?.resolve(ready);
  }

  private async waitForMissionReady(
    generation: number,
    requiredProtocolVersion: RealtimeAgentMissionProtocolVersion,
  ): Promise<boolean> {
    if (
      this.agentMissionSessionTransferred
      && this.agentMissionContextConfirmed
      && this.agentMissionProtocolVersion === requiredProtocolVersion
    ) {
      this.resolveMissionReady(true, generation);
      return true;
    }
    const waiter = this.missionReadyWaiter;
    if (waiter === null || waiter.generation !== generation) return false;
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
      && this.agentMissionContextConfirmed
      && this.agentMissionProtocolVersion === requiredProtocolVersion;
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
