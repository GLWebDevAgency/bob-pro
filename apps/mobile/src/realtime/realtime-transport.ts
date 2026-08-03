export type RealtimeTransportPhase =
  | 'idle'
  | 'authorizing'
  | 'connecting'
  | 'ready'
  | 'user_speaking'
  | 'bob_speaking'
  | 'degraded'
  | 'closing'
  | 'closed';

export type RealtimeFallbackReason =
  | 'native_module_unavailable'
  | 'backend_disabled'
  | 'not_entitled'
  | 'entitlement_unavailable'
  | 'audio_busy'
  | 'microphone_denied'
  | 'bootstrap_failed'
  | 'agent_mission_negotiation_failed'
  | 'data_channel_timeout'
  | 'ice_failed'
  | 'provider_error'
  | 'aborted';

export type RealtimeCloseReason =
  | 'user'
  | 'background'
  | 'navigation'
  | 'fallback'
  | 'aborted'
  | 'unmount'
  | 'max_duration';

export interface RealtimeTransportState {
  phase: RealtimeTransportPhase;
  generation: number;
  turn: number;
  fallbackReason: RealtimeFallbackReason | null;
}

export interface RealtimeTransportMetrics {
  permissionToTrackMs: number | null;
  offerToAnswerMs: number | null;
  connectToDataChannelOpenMs: number | null;
  sessionReadyMs: number | null;
  /** Proxy control-plane provider, pas une mesure acoustique au haut-parleur. */
  speechStoppedEventToFirstAudioSignalMs: number | null;
  /** Premier paquet RTP audio effectivement reçu par le peer après la fin de parole utilisateur. */
  speechStoppedToFirstInboundRtpMs: number | null;
  /** Accusé de purge provider après interruption, pas seulement response.done. */
  bargeInToAudioClearedMs: number | null;
  reconnectCount: number;
  roundTripTimeMs: number | null;
  jitterMs: number | null;
  packetsLost: number | null;
}

export type RealtimeTurnSettlementStatus = 'done' | 'cancelled' | 'failed';

export type RealtimeClientDiagnosticUpdate =
  | {
      readonly type: 'checkpoint';
      readonly checkpoint: import('@bob/core').RealtimeVoiceClientCheckpoint;
    }
  | {
      readonly type: 'failure';
      readonly failureCode: import('@bob/core').RealtimeVoiceClientFailureCode;
    }
  | {
      readonly type: 'policy_stop';
      readonly closeReason: import('@bob/core').RealtimeVoiceClientPolicyCloseReason;
    };

export type RealtimeTransportEvent =
  | { type: 'state'; state: RealtimeTransportState }
  | { type: 'connectivity'; state: 'connected' | 'disconnected' }
  | { type: 'user_transcript'; text: string; final: boolean }
  | { type: 'bob_transcript'; text: string; final: boolean }
  /** Annonce contractuelle reçue du bootstrap réel, avant READY et avant ouverture du micro. */
  | {
      type: 'diagnostic_trace_disclosure';
      disclosure: import('@bob/api-client').RealtimeVoiceDiagnosticTraceDisclosure;
    }
  /**
   * Preuve transport autoritative que le commit a été accepté/corrélé (ACK provider ou
   * `turn_started` serveur). Une fin VAD, une annulation ou READY ne l'émettent jamais.
   */
  | { type: 'user_input_committed'; turnId: string }
  /**
   * Terminal autoritatif d'un tour. Le premier statut gagne ; `ready`, transcript et fermeture
   * de conversation ne peuvent jamais le fabriquer.
   */
  | {
      type: 'turn_settled';
      turnId: string;
      status: RealtimeTurnSettlementStatus;
    }
  | {
      type: 'agent_control_candidate';
      reference:
        | import('./realtime-event-codecs').RealtimeAgentControlReference
        | import('@bob/api-client').RealtimeVoiceControlReference;
    }
  /** Émis uniquement par une glue ayant obtenu l'ACK one-shot de notre API, jamais par WebRTC. */
  | { type: 'agent_control'; control: import('./realtime-event-codecs').RealtimeAgentControl }
  | { type: 'metrics'; metrics: RealtimeTransportMetrics }
  /**
   * Tour one-shot intégralement rendu et acquitté. Émis par la composition auditée, jamais
   * directement par un provider : le contrôleur peut alors fermer sans déclencher de repli.
   */
  | { type: 'conversation_completed' }
  | { type: 'fallback'; reason: RealtimeFallbackReason }
  | { type: 'error'; code: string };

export interface VoiceConversationTransport {
  readonly capabilities: {
    fullDuplex: boolean;
    bargeIn: boolean;
    /** Vrai uniquement si une sortie acoustique autorisée est effectivement composée. */
    remoteAudio: boolean;
  };
  readonly state: RealtimeTransportState;
  /** Handle opaque requis par les endpoints contexte/ACK/hangup ; null hors appel établi. */
  getSessionHandle(): string | null;
  /**
   * Transfère au contrôleur, au plus une fois, la capability Mission liée à cet appel.
   * Le transport reste propriétaire jusqu'à cette remise et la détruit lui-même sur tout échec.
   */
  takeAgentMissionSession(): import('@bob/api-client').RealtimeAgentMissionSession | null;
  /**
   * Journal local fermé, propagé au transport propriétaire puis envoyé avec le hangup.
   * Il n'accepte aucune donnée libre et ne déclenche jamais lui-même une requête réseau.
   */
  reportClientDiagnostic?(update: RealtimeClientDiagnosticUpdate): void;
  connect(input?: { signal?: AbortSignal }): Promise<void>;
  sendUserText(text: string): boolean;
  setMicrophoneEnabled(enabled: boolean): void;
  /**
   * Aligne le contexte durable du transport sur la fence confirmée par l'API avant toute
   * réouverture du micro. Les transports sans canal contextuel séquencé peuvent l'omettre.
   */
  synchronizePublishedContext?(
    fence: import('./realtime-control-gate').RealtimePublishedContextFence,
  ): Promise<boolean>;
  /**
   * Finalise l'utterance sans fermer la réponse. Absent pour un transport à VAD continu ;
   * `true` signifie que le commit a été accepté et que Bob est désormais en traitement.
   */
  finishUserInput?(): Promise<boolean>;
  interrupt(reason: 'user_speech' | 'tap' | 'navigation'): boolean;
  close(reason: RealtimeCloseReason): Promise<void>;
  subscribe(listener: (event: RealtimeTransportEvent) => void): () => void;
  metricsSnapshot(): RealtimeTransportMetrics;
}

export class RealtimeTransportError extends Error {
  constructor(readonly reason: RealtimeFallbackReason) {
    super(reason);
    this.name = 'RealtimeTransportError';
  }
}
