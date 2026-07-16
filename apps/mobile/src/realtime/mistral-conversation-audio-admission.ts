import {
  MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
  MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES,
  MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES,
  MISTRAL_CONVERSATION_MAX_TURN_AUDIO_BYTES,
  encodeMistralConversationAudioFrame,
} from '@bob/ai';

const UINT32_MAX = 0xffff_ffff;

export type MistralConversationAudioAdmissionErrorCode =
  | 'invalid_configuration'
  | 'invalid_frame'
  | 'invalid_state'
  | 'sequence_exhausted'
  | 'audio_budget_exceeded'
  | 'send_failed';

/** Erreur opaque : ni PCM, ni détail transport ne doit atteindre les logs. */
export class MistralConversationAudioAdmissionError extends Error {
  constructor(readonly code: MistralConversationAudioAdmissionErrorCode) {
    super(code);
    this.name = 'MistralConversationAudioAdmissionError';
  }
}

export interface MistralConversationAudioAdmissionConfig {
  /** Ordinal positif attribué au tour par `turn.started`. */
  readonly turnOrdinal: number;
  /** Curseur global autoritaire reçu du serveur, jamais dérivé de la capture native. */
  readonly nextAudioSequence: number;
  /** Budget restant autoritaire du tour, exprimé en octets PCM (hors enveloppe BOB2). */
  readonly remainingTurnAudioBytes: number;
  /** Budget restant autoritaire de la mission, exprimé en octets PCM. */
  readonly remainingMissionAudioBytes: number;
}

export interface MistralConversationCapturedAudioFrame {
  /** Séquence propre à la génération de capture native ; elle ne devient jamais audioSequence. */
  readonly captureSequence: number;
  readonly pcm: Uint8Array;
}

export type MistralConversationAudioAdmissionResult =
  | {
      readonly kind: 'admitted';
      readonly captureSequence: number;
      readonly audioSequence: number;
      readonly audioBytes: number;
    }
  | {
      readonly kind: 'backpressured';
      readonly captureSequence: number;
      readonly audioSequence: number;
    };

export interface MistralConversationAudioAdmissionSnapshot {
  readonly phase: 'admitting' | 'committed' | 'cancelled' | 'recovering';
  readonly turnOrdinal: number;
  readonly nextAudioSequence: number | null;
  readonly lastAdmittedAudioSequence: number | null;
  readonly admittedAudioBytes: number;
  readonly remainingTurnAudioBytes: number;
  readonly remainingMissionAudioBytes: number;
}

export type MistralConversationAudioTrySend = (encodedFrame: Uint8Array) => boolean;

function isUint32(value: number): boolean {
  return Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0 && value <= UINT32_MAX;
}

function isPositiveUint32(value: number): boolean {
  return isUint32(value) && value > 0;
}

function validBudget(value: number, maximum: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= 0 &&
    value <= maximum &&
    value % MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES === 0
  );
}

function validPcm(pcm: unknown): pcm is Uint8Array {
  return (
    pcm instanceof Uint8Array &&
    pcm.byteLength >= MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES &&
    pcm.byteLength <= MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES &&
    pcm.byteLength % MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES === 0
  );
}

/**
 * Frontière d'admission PCM du protocole conversationnel v2.
 *
 * Elle ne conserve aucun octet PCM. Une trame n'avance le curseur global et ne consomme les
 * budgets qu'après un `trySend` strictement égal à `true`. Un refus peut donc être drainé par le
 * transport sans créer de trou. Une annulation ou une reprise ferme définitivement cette instance
 * : le nouvel owner repart du curseur serveur avec une nouvelle capture, jamais avec du PCM local.
 */
export class MistralConversationAudioAdmission {
  private readonly turnOrdinal: number;
  private phase: MistralConversationAudioAdmissionSnapshot['phase'] = 'admitting';
  private nextSequence: number | null;
  private lastAdmittedSequence: number | null = null;
  private admittedBytes = 0;
  private remainingTurnBytes: number;
  private remainingMissionBytes: number;
  private sending = false;

  constructor(config: MistralConversationAudioAdmissionConfig) {
    if (
      !isPositiveUint32(config.turnOrdinal) ||
      !isUint32(config.nextAudioSequence) ||
      !validBudget(config.remainingTurnAudioBytes, MISTRAL_CONVERSATION_MAX_TURN_AUDIO_BYTES) ||
      !validBudget(config.remainingMissionAudioBytes, MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES)
    ) {
      throw new MistralConversationAudioAdmissionError('invalid_configuration');
    }
    this.turnOrdinal = config.turnOrdinal;
    this.nextSequence = config.nextAudioSequence;
    this.remainingTurnBytes = config.remainingTurnAudioBytes;
    this.remainingMissionBytes = config.remainingMissionAudioBytes;
  }

  get snapshot(): MistralConversationAudioAdmissionSnapshot {
    return {
      phase: this.phase,
      turnOrdinal: this.turnOrdinal,
      nextAudioSequence: this.nextSequence,
      lastAdmittedAudioSequence: this.lastAdmittedSequence,
      admittedAudioBytes: this.admittedBytes,
      remainingTurnAudioBytes: this.remainingTurnBytes,
      remainingMissionAudioBytes: this.remainingMissionBytes,
    };
  }

  tryAdmit(
    frame: MistralConversationCapturedAudioFrame,
    trySend: MistralConversationAudioTrySend,
  ): MistralConversationAudioAdmissionResult {
    this.assertAdmitting();
    if (!isUint32(frame.captureSequence) || !validPcm(frame.pcm)) {
      throw new MistralConversationAudioAdmissionError('invalid_frame');
    }
    const audioSequence = this.nextSequence;
    if (audioSequence === null) {
      throw new MistralConversationAudioAdmissionError('sequence_exhausted');
    }
    const audioBytes = frame.pcm.byteLength;
    if (audioBytes > this.remainingTurnBytes || audioBytes > this.remainingMissionBytes) {
      throw new MistralConversationAudioAdmissionError('audio_budget_exceeded');
    }

    let encodedFrame: Uint8Array;
    try {
      encodedFrame = encodeMistralConversationAudioFrame({
        turnOrdinal: this.turnOrdinal,
        audioSequence,
        pcm: frame.pcm,
      });
    } catch {
      throw new MistralConversationAudioAdmissionError('invalid_frame');
    }

    let sent: unknown;
    this.sending = true;
    try {
      sent = trySend(encodedFrame);
    } catch {
      throw new MistralConversationAudioAdmissionError('send_failed');
    } finally {
      this.sending = false;
    }
    if (sent !== true && sent !== false) {
      throw new MistralConversationAudioAdmissionError('send_failed');
    }
    if (!sent) {
      return {
        kind: 'backpressured',
        captureSequence: frame.captureSequence,
        audioSequence,
      };
    }

    this.lastAdmittedSequence = audioSequence;
    this.nextSequence = audioSequence === UINT32_MAX ? null : audioSequence + 1;
    this.admittedBytes += audioBytes;
    this.remainingTurnBytes -= audioBytes;
    this.remainingMissionBytes -= audioBytes;
    return {
      kind: 'admitted',
      captureSequence: frame.captureSequence,
      audioSequence,
      audioBytes,
    };
  }

  /** Scelle l'uplink et retourne la séquence réellement admise, jamais la séquence de capture. */
  commit(): number {
    this.assertNotSending();
    if (this.phase === 'committed' && this.lastAdmittedSequence !== null) {
      return this.lastAdmittedSequence;
    }
    if (this.phase !== 'admitting') {
      throw new MistralConversationAudioAdmissionError('invalid_state');
    }
    if (this.lastAdmittedSequence === null) {
      throw new MistralConversationAudioAdmissionError('invalid_state');
    }
    this.phase = 'committed';
    return this.lastAdmittedSequence;
  }

  cancel(): void {
    this.assertNotSending();
    if (this.phase === 'cancelled') return;
    if (this.phase !== 'admitting' && this.phase !== 'committed') {
      throw new MistralConversationAudioAdmissionError('invalid_state');
    }
    this.phase = 'cancelled';
  }

  beginRecovery(): void {
    this.assertNotSending();
    if (this.phase === 'recovering') return;
    if (this.phase !== 'admitting' && this.phase !== 'committed') {
      throw new MistralConversationAudioAdmissionError('invalid_state');
    }
    this.phase = 'recovering';
  }

  private assertAdmitting(): void {
    this.assertNotSending();
    if (this.phase !== 'admitting') {
      throw new MistralConversationAudioAdmissionError('invalid_state');
    }
  }

  private assertNotSending(): void {
    if (this.sending) {
      throw new MistralConversationAudioAdmissionError('invalid_state');
    }
  }
}
