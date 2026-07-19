import {
  MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES,
  decodeMistralConversationServerEvent,
  type MistralConversationClientControl,
  type MistralConversationServerEvent,
} from '@bob/ai';

const UINT32_MAX = 0xffff_ffff;
const OPAQUE_ID = /^[A-Za-z0-9_-]{16,128}$/u;

export type MistralConversationEventStreamErrorCode =
  | 'invalid_server_frame'
  | 'invalid_server_handshake'
  | 'server_sequence_gap'
  | 'server_event_after_close';

/** Erreur volontairement opaque : aucun transcript ni payload fournisseur n'est journalisable. */
export class MistralConversationEventStreamError extends Error {
  constructor(readonly code: MistralConversationEventStreamErrorCode) {
    super(code);
    this.name = 'MistralConversationEventStreamError';
  }
}

export type MistralConversationEventAcceptance =
  | {
      readonly kind: 'accepted';
      readonly event: MistralConversationServerEvent;
    }
  | {
      readonly kind: 'duplicate';
      readonly serverSequence: number;
    };

export interface MistralConversationEventStreamResume {
  /** Première séquence qui n'a pas encore produit d'effet local. */
  readonly nextServerSequence: number;
  /** Preuve locale que `session.ready` a déjà été validé avant cette reprise. */
  readonly sessionReadyAccepted: true;
  /** Lie définitivement le curseur à une mission, jamais seulement à une socket. */
  readonly sessionHandle: string;
  /** Dernier owner effectivement activé par ready/route_recovered. */
  readonly missionConnectionEpoch: number;
  /** Une mission déjà close ne peut accepter aucun nouvel événement. */
  readonly closed?: boolean;
  /** Un takeover durable a commencé, mais son nouvel owner n'est pas encore activé. */
  readonly recoveryPending?: true;
  /** Génération exacte annoncée par route_recovering, nécessaire pour valider l'annulation. */
  readonly recoveryCancellationGeneration?: number;
  /** L'éventuelle annulation corrélée a déjà été réduite avant la persistance du curseur. */
  readonly recoveryCancellationAccepted?: true;
}

function validNextSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= UINT32_MAX + 1;
}

function validCancellationGeneration(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= UINT32_MAX;
}

function validResume(value: unknown): value is MistralConversationEventStreamResume {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  const hasClosed = Object.prototype.hasOwnProperty.call(candidate, 'closed');
  const hasRecoveryPending = Object.prototype.hasOwnProperty.call(candidate, 'recoveryPending');
  const hasRecoveryCancellationGeneration = Object.prototype.hasOwnProperty.call(
    candidate,
    'recoveryCancellationGeneration',
  );
  const hasRecoveryCancellationAccepted = Object.prototype.hasOwnProperty.call(
    candidate,
    'recoveryCancellationAccepted',
  );
  return keys.every((key) => (
    key === 'nextServerSequence'
    || key === 'sessionReadyAccepted'
    || key === 'sessionHandle'
    || key === 'missionConnectionEpoch'
    || key === 'closed'
    || key === 'recoveryPending'
    || key === 'recoveryCancellationGeneration'
    || key === 'recoveryCancellationAccepted'
  ))
    && keys.length === 4
      + Number(hasClosed)
      + Number(hasRecoveryPending)
      + Number(hasRecoveryCancellationGeneration)
      + Number(hasRecoveryCancellationAccepted)
    && typeof candidate.nextServerSequence === 'number'
    && validNextSequence(candidate.nextServerSequence)
    && candidate.sessionReadyAccepted === true
    && typeof candidate.sessionHandle === 'string'
    && OPAQUE_ID.test(candidate.sessionHandle)
    && typeof candidate.missionConnectionEpoch === 'number'
    && Number.isSafeInteger(candidate.missionConnectionEpoch)
    && candidate.missionConnectionEpoch >= 1
    && candidate.missionConnectionEpoch <= 0x7fff_ffff
    && (!hasClosed || typeof candidate.closed === 'boolean')
    && (!hasRecoveryPending || candidate.recoveryPending === true)
    && (!hasRecoveryCancellationGeneration
      || validCancellationGeneration(candidate.recoveryCancellationGeneration))
    && (!hasRecoveryCancellationAccepted || candidate.recoveryCancellationAccepted === true)
    && (candidate.recoveryPending === true
      ? hasRecoveryCancellationGeneration
      : !hasRecoveryCancellationGeneration && !hasRecoveryCancellationAccepted)
    && !(candidate.closed === true && candidate.recoveryPending === true);
}

function parseServerEvent(raw: unknown): MistralConversationServerEvent {
  try {
    if (
      typeof raw !== 'string'
      || raw.length === 0
      || raw.length > MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES
    ) throw new MistralConversationEventStreamError('invalid_server_frame');

    const bytes = new TextEncoder().encode(raw);
    if (bytes.byteLength > MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES) {
      throw new MistralConversationEventStreamError('invalid_server_frame');
    }
    return decodeMistralConversationServerEvent(raw);
  } catch (error) {
    if (error instanceof MistralConversationEventStreamError) throw error;
    throw new MistralConversationEventStreamError('invalid_server_frame');
  }
}

/**
 * Frontière ordonnée des événements WSS Mistral v2.
 *
 * WebSocket préserve l'ordre sur une connexion, mais une reprise durable peut rejouer des
 * événements déjà vus. Les doublons sont donc ignorés avant tout reducer/callback, tandis qu'un
 * trou ferme la route : appliquer N+1 sans N pourrait déclencher une navigation, un transcript ou
 * un état audio sur une mission locale incomplète.
 */
export class MistralConversationServerEventStream {
  private nextSequence = 0;
  private readyAccepted = false;
  private terminal = false;
  private missionHandle: string | null = null;
  private activeMissionConnectionEpoch = 0;
  private recoveryPending = false;
  private recoveryCancellationGeneration: number | null = null;
  private recoveryCancellationAccepted = false;

  constructor(resume?: MistralConversationEventStreamResume) {
    if (resume !== undefined) {
      if (!validResume(resume)) {
        throw new MistralConversationEventStreamError('invalid_server_handshake');
      }
      this.nextSequence = resume.nextServerSequence;
      this.readyAccepted = true;
      this.terminal = resume.closed === true;
      this.missionHandle = resume.sessionHandle;
      this.activeMissionConnectionEpoch = resume.missionConnectionEpoch;
      this.recoveryPending = resume.recoveryPending === true;
      this.recoveryCancellationGeneration = resume.recoveryCancellationGeneration ?? null;
      this.recoveryCancellationAccepted = resume.recoveryCancellationAccepted === true;
    }
  }

  get nextServerSequence(): number {
    return this.nextSequence;
  }

  get sessionReadyAccepted(): boolean {
    return this.readyAccepted;
  }

  get closed(): boolean {
    return this.terminal;
  }

  get sessionHandle(): string | null {
    return this.missionHandle;
  }

  get missionConnectionEpoch(): number {
    return this.activeMissionConnectionEpoch;
  }

  accept(raw: unknown): MistralConversationEventAcceptance {
    const event = parseServerEvent(raw);

    if (event.serverSequence < this.nextSequence) {
      if (
        event.type === 'session.ready'
        && (
          event.sessionHandle !== this.missionHandle
          || event.missionConnectionEpoch > this.activeMissionConnectionEpoch
        )
      ) throw new MistralConversationEventStreamError('invalid_server_handshake');
      if (
        event.type === 'session.route_recovered'
        && event.missionConnectionEpoch > this.activeMissionConnectionEpoch
      ) throw new MistralConversationEventStreamError('invalid_server_handshake');
      return { kind: 'duplicate', serverSequence: event.serverSequence };
    }
    if (event.serverSequence > this.nextSequence) {
      throw new MistralConversationEventStreamError('server_sequence_gap');
    }
    if (this.terminal) {
      throw new MistralConversationEventStreamError('server_event_after_close');
    }
    if (!this.readyAccepted && (event.serverSequence !== 0 || event.type !== 'session.ready')) {
      throw new MistralConversationEventStreamError('invalid_server_handshake');
    }
    if (this.readyAccepted && event.type === 'session.ready') {
      throw new MistralConversationEventStreamError('invalid_server_handshake');
    }
    if (this.recoveryPending) {
      if (event.type === 'turn.cancelled') {
        if (
          this.recoveryCancellationAccepted
          || event.cancellationGeneration !== this.recoveryCancellationGeneration
        ) throw new MistralConversationEventStreamError('invalid_server_handshake');
      } else if (event.type === 'session.route_recovered') {
        if (event.missionConnectionEpoch !== this.activeMissionConnectionEpoch + 1) {
          throw new MistralConversationEventStreamError('invalid_server_handshake');
        }
      } else {
        throw new MistralConversationEventStreamError('invalid_server_handshake');
      }
    }

    if (event.type === 'session.ready') {
      this.missionHandle = event.sessionHandle;
      this.activeMissionConnectionEpoch = event.missionConnectionEpoch;
    } else if (event.type === 'session.route_recovering') {
      this.recoveryPending = true;
      this.recoveryCancellationGeneration = event.cancellationGeneration;
      this.recoveryCancellationAccepted = false;
    } else if (event.type === 'turn.cancelled' && this.recoveryPending) {
      this.recoveryCancellationAccepted = true;
    } else if (event.type === 'session.route_recovered') {
      if (
        !this.recoveryPending
        || event.missionConnectionEpoch !== this.activeMissionConnectionEpoch + 1
      ) {
        throw new MistralConversationEventStreamError('invalid_server_handshake');
      }
      this.activeMissionConnectionEpoch = event.missionConnectionEpoch;
      this.recoveryPending = false;
      this.recoveryCancellationGeneration = null;
      this.recoveryCancellationAccepted = false;
    }

    this.nextSequence += 1;
    this.readyAccepted = true;
    if (event.type === 'session.closed') this.terminal = true;
    return { kind: 'accepted', event };
  }

  snapshot(): MistralConversationEventStreamResume | null {
    if (!this.readyAccepted || this.nextSequence === 0 || !this.missionHandle) return null;
    return {
      nextServerSequence: this.nextSequence,
      sessionReadyAccepted: true,
      sessionHandle: this.missionHandle,
      missionConnectionEpoch: this.activeMissionConnectionEpoch,
      ...(this.terminal ? { closed: true } : {}),
      ...(this.recoveryPending ? {
        recoveryPending: true as const,
        recoveryCancellationGeneration: this.recoveryCancellationGeneration!,
        ...(this.recoveryCancellationAccepted
          ? { recoveryCancellationAccepted: true as const }
          : {}),
      } : {}),
    };
  }

  /**
   * ACK uniquement à un point stable : jamais au milieu du batch de takeover.
   *
   * `session.closed` ferme définitivement l'entrée métier, mais son curseur terminal doit encore
   * être ACKé : une reprise `replay_only` attend précisément cette preuve avant de libérer sa
   * capability one-shot. L'ACK reste une projection pure et idempotente du curseur ; un retry
   * produit donc exactement la même trame, sans rouvrir le flux ni avancer la séquence.
   *
   * L'appelant doit l'émettre après avoir réduit l'événement accepté dans sa projection locale.
   */
  acknowledgement(): Extract<MistralConversationClientControl, { readonly type: 'events.ack' }> | null {
    if (!this.readyAccepted || this.recoveryPending || this.activeMissionConnectionEpoch < 1) {
      return null;
    }
    return {
      type: 'events.ack',
      missionConnectionEpoch: this.activeMissionConnectionEpoch,
      nextServerSequence: this.nextSequence,
    };
  }
}
