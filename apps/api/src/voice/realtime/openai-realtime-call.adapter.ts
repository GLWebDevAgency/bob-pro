import type {
  OpenAiRealtimeCallInput,
  OpenAiRealtimeCallOutput,
  OpenAiRealtimeCallProvider,
  RealtimeVoiceSettings,
} from './realtime.types';

const MAX_PROVIDER_SDP_BYTES = 256 * 1024;
const CALL_ID = /^rtc_[A-Za-z0-9_-]{1,200}$/;
const SAFE_ANSWER_ERROR_CLASSES = new Set([
  'provider_response_too_large',
  'provider_invalid_sdp',
  'bootstrap_aborted',
]);
const SAFE_CALLBACK_ERROR_CLASSES = new Set([
  'bootstrap_aborted',
  'realtime_admission_bind_rejected',
  'realtime_admission_bind_expired',
  'realtime_admission_bind_unavailable',
]);

export type RealtimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * L'appel provider existe déjà, mais son bind durable ou son SDP n'a pas pu être accepté et le
 * hangup compensatoire a lui-même échoué. Les deux classes sont bornées et ne transportent ni
 * SDP, ni call_id, ni secret.
 */
export class RealtimeProviderCleanupError extends Error {
  readonly sourceErrorClass: string;
  readonly cleanupErrorClass: string;
  readonly providerTermination = 'unconfirmed' as const;

  constructor(sourceErrorClass: string, cleanupErrorClass: string) {
    // Le message reste l'erreur fonctionnelle initiale : les mappings existants conservent leur
    // comportement, tandis que la classe dédiée permet une alerte explicite sur l'orphelin possible.
    super(sourceErrorClass);
    this.name = 'RealtimeProviderCleanupError';
    this.sourceErrorClass = sourceErrorClass;
    this.cleanupErrorClass = cleanupErrorClass;
  }
}

/**
 * Erreur postérieure à la création fournisseur dont le hangup compensatoire a été confirmé.
 * Le service peut donc libérer son bail durable sans rappeler le endpoint de hangup.
 */
export class RealtimeProviderCallCompensatedError extends Error {
  readonly sourceErrorClass: string;
  readonly providerTermination = 'confirmed' as const;

  constructor(sourceErrorClass: string) {
    super(sourceErrorClass);
    this.name = 'RealtimeProviderCallCompensatedError';
    this.sourceErrorClass = sourceErrorClass;
  }
}

function answerErrorClass(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return SAFE_ANSWER_ERROR_CLASSES.has(value) ? value : 'provider_response_read_error';
}

function callbackErrorClass(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return SAFE_CALLBACK_ERROR_CLASSES.has(value) ? value : 'provider_create_callback_failed';
}

function cleanupErrorClass(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return /^provider_hangup_[a-z0-9_]+$/.test(value) ? value : 'provider_hangup_failed';
}

function throwIfBootstrapAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('bootstrap_aborted');
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const announcedLength = response.headers.get('content-length');
  if (announcedLength !== null) {
    const length = Number(announcedLength);
    if (!Number.isFinite(length) || length < 0 || length > maxBytes) {
      throw new Error('provider_response_too_large');
    }
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  const cancelOnAbort = () => {
    void reader.cancel('bootstrap-aborted').catch(() => undefined);
  };
  signal?.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    throwIfBootstrapAborted(signal);
    let part = await reader.read();
    while (!part.done) {
      throwIfBootstrapAborted(signal);
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel('bounded-response');
        throw new Error('provider_response_too_large');
      }
      text += decoder.decode(part.value, { stream: true });
      part = await reader.read();
    }
    throwIfBootstrapAborted(signal);
    text += decoder.decode();
    return text;
  } finally {
    signal?.removeEventListener('abort', cancelOnAbort);
    reader.releaseLock();
  }
}

function callIdFromLocation(location: string | null): string {
  const callId = location?.split('/').filter(Boolean).at(-1) ?? '';
  if (!CALL_ID.test(callId)) throw new Error('provider_call_id_missing');
  return callId;
}

function assertAnswerSdp(answerSdp: string): void {
  if (
    answerSdp.length < 16
    || answerSdp.includes('\u0000')
    || !answerSdp.startsWith('v=0')
    || !/(?:^|\r?\n)m=audio\s/m.test(answerSdp)
  ) {
    throw new Error('provider_invalid_sdp');
  }
}

export class OpenAiRealtimeCallAdapter implements OpenAiRealtimeCallProvider {
  private readonly hangupsInFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly settings: Pick<RealtimeVoiceSettings, 'apiKey' | 'baseUrl' | 'providerTimeoutMs'>,
    private readonly fetchImpl: RealtimeFetch = fetch,
  ) {}

  async createCall(input: OpenAiRealtimeCallInput): Promise<OpenAiRealtimeCallOutput> {
    if (!this.settings.apiKey) throw new Error('provider_not_configured');
    const form = new FormData();
    form.set('sdp', input.offerSdp);
    form.set('session', JSON.stringify(input.session));

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.settings.baseUrl}/realtime/calls`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.settings.apiKey}`,
          'OpenAI-Safety-Identifier': input.safetyIdentifier,
        },
        body: form,
        signal: AbortSignal.timeout(this.settings.providerTimeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error('provider_timeout');
      throw new Error('provider_network_error');
    }

    if (!response.ok) {
      // Le corps fournisseur peut contenir des détails sensibles : il n'est ni lu ni journalisé.
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`provider_http_${Math.floor(response.status / 100)}xx`);
    }

    // Le provider peut avoir créé l'appel avant que son corps SDP soit lu. Capturer le call_id en
    // premier est indispensable pour pouvoir compenser toute réponse invalide ou surdimensionnée.
    const callId = callIdFromLocation(response.headers.get('location'));
    try {
      throwIfBootstrapAborted(input.signal);
      // La persistance précède volontairement la lecture du corps : si le process tombe ou si le
      // body reste bloqué, le reaper dispose déjà du call_id nécessaire au hangup.
      await input.onCallCreated(callId);
      throwIfBootstrapAborted(input.signal);
    } catch (error) {
      return this.compensateCreatedCall(callId, callbackErrorClass(error));
    }

    try {
      const answerSdp = await readBoundedText(response, MAX_PROVIDER_SDP_BYTES, input.signal);
      assertAnswerSdp(answerSdp);
      return { answerSdp, callId };
    } catch (error) {
      return this.compensateCreatedCall(callId, answerErrorClass(error));
    }
  }

  private async compensateCreatedCall(callId: string, sourceErrorClass: string): Promise<never> {
    try {
      await this.hangupCall(callId);
    } catch (cleanupError) {
      throw new RealtimeProviderCleanupError(sourceErrorClass, cleanupErrorClass(cleanupError));
    }
    throw new RealtimeProviderCallCompensatedError(sourceErrorClass);
  }

  async hangupCall(callId: string): Promise<void> {
    if (!this.settings.apiKey) throw new Error('provider_not_configured');
    if (!CALL_ID.test(callId)) throw new Error('provider_call_id_invalid');
    const existing = this.hangupsInFlight.get(callId);
    if (existing) return existing;

    const hangup = this.performHangup(callId);
    this.hangupsInFlight.set(callId, hangup);
    try {
      await hangup;
    } finally {
      if (this.hangupsInFlight.get(callId) === hangup) this.hangupsInFlight.delete(callId);
    }
  }

  private async performHangup(callId: string): Promise<void> {
    let lastError = 'provider_hangup_failed';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetchImpl(
          `${this.settings.baseUrl}/realtime/calls/${encodeURIComponent(callId)}/hangup`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${this.settings.apiKey}` },
            signal: AbortSignal.timeout(Math.min(this.settings.providerTimeoutMs, 3_000)),
          },
        );
        await response.body?.cancel().catch(() => undefined);
        if (response.ok || response.status === 404 || response.status === 409) return;
        lastError = `provider_hangup_http_${Math.floor(response.status / 100)}xx`;
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) {
        lastError = error instanceof DOMException && error.name === 'TimeoutError'
          ? 'provider_hangup_timeout'
          : 'provider_hangup_network_error';
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
    throw new Error(lastError);
  }
}
