/**
 * Référence non autoritative transportée par les metadata du fournisseur.
 *
 * Elle ne contient volontairement aucun effet UI. Le mobile doit l'échanger contre un
 * `RealtimeVoiceControlAcknowledgement` opaque auprès de notre API avant toute navigation
 * ou proposition. Les metadata Realtime restent donc un simple signal de disponibilité.
 */
export interface RealtimeAgentControlReference {
  readonly turnId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
}

/** Contrôle autoritatif retourné exclusivement par l'ACK one-shot de notre API. */
export interface RealtimeAgentControl {
  readonly turnId: string;
  readonly kind: 'answer' | 'proposed' | 'done' | 'failed';
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly navigate?: string;
  readonly proposalId?: string;
  readonly proposalExpiresAt?: string;
}

export type DecodedRealtimeEvent =
  | { type: 'session_ready' }
  | { type: 'response_started'; controlReference?: RealtimeAgentControlReference }
  | { type: 'speech_started' }
  | { type: 'speech_stopped' }
  | { type: 'audio_signal'; source: 'delta' | 'buffer_started' }
  | { type: 'audio_stopped' }
  | { type: 'audio_cleared' }
  | { type: 'response_done'; status: 'completed' | 'cancelled' | 'failed' | 'incomplete' }
  | { type: 'user_transcript'; text: string; final: boolean }
  | { type: 'bob_transcript'; text: string; final: boolean }
  | { type: 'provider_error'; code: string }
  | { type: 'protocol_error'; code: string }
  | { type: 'ignored' };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.slice(0, 4_000);
  return text.length > 0 ? text : null;
}

function boundedCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value)
    ? value
    : 'realtime_provider_error';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_RESPONSE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const PROVIDER_RESPONSE_IDS = new WeakMap<object, string>();

function providerResponseId(value: unknown): string | null {
  return typeof value === 'string' && PROVIDER_RESPONSE_ID.test(value) ? value : null;
}

function withProviderResponseId<T extends DecodedRealtimeEvent>(event: T, responseId: string): T {
  PROVIDER_RESPONSE_IDS.set(event, responseId);
  return event;
}

/** Corrélation interne pour les annulations OOB ; l'identifiant n'est jamais sérialisé ni émis. */
export function realtimeProviderResponseId(event: DecodedRealtimeEvent): string | null {
  return PROVIDER_RESPONSE_IDS.get(event) ?? null;
}

function decodeAgentControlReference(response: unknown): RealtimeAgentControlReference | null {
  const metadata = record(record(response)?.metadata);
  if (!metadata) return null;
  const allowed = new Set([
    'bob_response_nonce',
    'bob_turn_id',
    'bob_turn_kind',
    'bob_navigate',
    'bob_proposal_id',
    'bob_proposal_expires_at',
    'bob_context_revision',
    'bob_context_digest',
  ]);
  if (Object.keys(metadata).some((key) => !allowed.has(key))) return null;
  const turnId = metadata.bob_turn_id;
  const contextRevisionValue = metadata.bob_context_revision;
  const contextDigest = metadata.bob_context_digest;
  if (
    typeof turnId !== 'string'
    || !UUID.test(turnId)
    || typeof contextRevisionValue !== 'string'
    || !/^[1-9][0-9]{0,9}$/.test(contextRevisionValue)
    || Number(contextRevisionValue) > 2_147_483_647
    || typeof contextDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(contextDigest)
  ) return null;
  const contextRevision = Number(contextRevisionValue);
  return {
    turnId,
    contextRevision,
    contextDigest,
  };
}

/** Décode sans conserver audio base64, SDP, IDs provider ni objets d'usage bruts. */
export function decodeRealtimeServerEvent(raw: unknown): DecodedRealtimeEvent {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > 256 * 1024) return { type: 'protocol_error', code: 'event_too_large' };
    try {
      value = JSON.parse(raw);
    } catch {
      return { type: 'protocol_error', code: 'invalid_json' };
    }
  }
  const event = record(value);
  if (!event || typeof event.type !== 'string') return { type: 'protocol_error', code: 'invalid_event' };
  switch (event.type) {
    case 'session.created':
    case 'session.updated':
      return { type: 'session_ready' };
    case 'response.created': {
      const responseId = providerResponseId(record(event.response)?.id);
      if (!responseId) return { type: 'protocol_error', code: 'invalid_response_id' };
      const controlReference = decodeAgentControlReference(event.response);
      return withProviderResponseId(
        { type: 'response_started', ...(controlReference ? { controlReference } : {}) },
        responseId,
      );
    }
    case 'input_audio_buffer.speech_started':
      return { type: 'speech_started' };
    case 'input_audio_buffer.speech_stopped':
      return { type: 'speech_stopped' };
    case 'response.output_audio.delta': {
      const responseId = providerResponseId(event.response_id);
      return responseId
        ? withProviderResponseId({ type: 'audio_signal', source: 'delta' }, responseId)
        : { type: 'protocol_error', code: 'invalid_response_id' };
    }
    case 'output_audio_buffer.started': {
      const responseId = providerResponseId(event.response_id);
      return responseId
        ? withProviderResponseId({ type: 'audio_signal', source: 'buffer_started' }, responseId)
        : { type: 'protocol_error', code: 'invalid_response_id' };
    }
    case 'output_audio_buffer.stopped': {
      const responseId = providerResponseId(event.response_id);
      return responseId
        ? withProviderResponseId({ type: 'audio_stopped' }, responseId)
        : { type: 'protocol_error', code: 'invalid_response_id' };
    }
    case 'output_audio_buffer.cleared': {
      const responseId = providerResponseId(event.response_id);
      return responseId
        ? withProviderResponseId({ type: 'audio_cleared' }, responseId)
        : { type: 'protocol_error', code: 'invalid_response_id' };
    }
    case 'response.done': {
      const response = record(event.response);
      const responseId = providerResponseId(response?.id);
      if (!responseId) return { type: 'protocol_error', code: 'invalid_response_id' };
      const status = response?.status;
      if (status !== 'completed' && status !== 'cancelled' && status !== 'failed' && status !== 'incomplete') {
        return { type: 'protocol_error', code: 'invalid_response_status' };
      }
      return withProviderResponseId(
        { type: 'response_done', status },
        responseId,
      );
    }
    case 'conversation.item.input_audio_transcription.delta': {
      const text = boundedText(event.delta);
      return text ? { type: 'user_transcript', text, final: false } : { type: 'ignored' };
    }
    case 'conversation.item.input_audio_transcription.completed': {
      const text = boundedText(event.transcript);
      return text ? { type: 'user_transcript', text, final: true } : { type: 'ignored' };
    }
    case 'response.output_audio_transcript.delta': {
      const text = boundedText(event.delta);
      return text ? { type: 'bob_transcript', text, final: false } : { type: 'ignored' };
    }
    case 'response.output_audio_transcript.done': {
      const text = boundedText(event.transcript);
      return text ? { type: 'bob_transcript', text, final: true } : { type: 'ignored' };
    }
    case 'error': {
      const error = record(event.error);
      return { type: 'provider_error', code: boundedCode(error?.code) };
    }
    default:
      return { type: 'ignored' };
  }
}
