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

export type RealtimeTransportEvent =
  | { type: 'state'; state: RealtimeTransportState }
  | { type: 'connectivity'; state: 'connected' | 'disconnected' }
  | { type: 'user_transcript'; text: string; final: boolean }
  | { type: 'bob_transcript'; text: string; final: boolean }
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
  connect(input?: { signal?: AbortSignal }): Promise<void>;
  sendUserText(text: string): boolean;
  setMicrophoneEnabled(enabled: boolean): void;
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
