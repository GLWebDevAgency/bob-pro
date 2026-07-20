export type BobLiveAudioProcessingStatus = 'enabled' | 'unavailable' | 'unknown';

export type BobLiveAudioStopReason =
  | 'requested'
  | 'background'
  | 'context_destroyed'
  | 'capture_error'
  | 'backpressure'
  | 'watchdog_timeout'
  | 'interruption';

export type BobLiveAudioErrorCode =
  | 'microphone_permission_denied'
  | 'capture_busy'
  | 'capture_initialization_failed'
  | 'capture_runtime_failed'
  | 'capture_backpressure_exhausted'
  | 'capture_watchdog_expired'
  | 'capture_interrupted'
  | 'capture_protocol_failed';

export type BobLiveAudioCapabilities = {
  readonly sessionId: string;
  /** Identite native unique d'une generation de capture, y compris apres reconnexion. */
  readonly captureId: string;
  readonly encoding: 'pcm_s16le';
  readonly sampleRateHz: 16_000;
  readonly channels: 1;
  readonly frameDurationMs: 40;
  /** Fenetre native maximale non acquittee avant arret fail-closed. */
  readonly maxInFlightFrames: 16;
  /** Borne dure native, independante du runtime JS. */
  readonly maxCaptureDurationMs: number;
  readonly acousticEchoCancellation: BobLiveAudioProcessingStatus;
  readonly noiseSuppression: BobLiveAudioProcessingStatus;
  readonly automaticGainControl: BobLiveAudioProcessingStatus;
  /** Profil VAD effectivement charge par le moteur natif pour cette capture. */
  readonly vadConfigVersion: 'bob-live-vad-foundation-1';
  /** Le PCM doit traverser le bridge avant sa transition VAD pour conserver le pre-roll. */
  readonly vadEventOrdering: 'pcm_before_vad';
  readonly vadAnalysisWindowMs: 20;
  readonly vadPreRollMs: 240;
  readonly vadSpeechStartMs: 60;
  readonly vadSpeechEndMs: 700;
  readonly vadMaximumUtteranceMs: 30_000;
  /** Reste faux tant que la matrice appareil/casque/haut-parleur n'est pas certifiée. */
  readonly fullDuplexCertified: false;
};

export type BobLiveAudioPcmChunkEvent = {
  readonly sessionId: string;
  readonly captureId: string;
  readonly sequence: number;
  readonly capturedAtMonotonicMs: number;
  /** Trame PCM16 mono de 40 ms, soit exactement 1 280 octets avant encodage. */
  readonly pcmBase64: string;
};

export type BobLiveAudioVadEventKind = 'speech_started' | 'speech_ended';

/**
 * Métadonnées VAD uniquement : le pré-roll PCM reste dans le ring borné de l'adaptateur mobile.
 * Les horodatages viennent de la même horloge monotone native que les trames PCM.
 */
export type BobLiveAudioVadEvent = {
  readonly sessionId: string;
  readonly captureId: string;
  readonly kind: BobLiveAudioVadEventKind;
  readonly configVersion: string;
  readonly utteranceIndex: number;
  readonly detectedAtMonotonicMs: number;
  readonly preRollMs: number;
  readonly startedAtMonotonicMs: number;
  readonly endedAtMonotonicMs: number | null;
  readonly forcedEnd: boolean;
  readonly energyDbfs: number;
  readonly noiseFloorDbfs: number;
};

export type BobLiveAudioErrorEvent = {
  readonly sessionId: string;
  readonly captureId: string;
  readonly code: BobLiveAudioErrorCode;
};

export type BobLiveAudioStoppedEvent = {
  readonly sessionId: string;
  readonly captureId: string;
  readonly reason: BobLiveAudioStopReason;
};

export type BobLiveAudioModuleEvents = {
  onPcmChunk: (event: BobLiveAudioPcmChunkEvent) => void;
  onVadEvent: (event: BobLiveAudioVadEvent) => void;
  onCaptureError: (event: BobLiveAudioErrorEvent) => void;
  onCaptureStopped: (event: BobLiveAudioStoppedEvent) => void;
};
