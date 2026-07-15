import type { MistralRealtimeGatewayProvider } from './mistral-realtime-gateway';
import {
  MistralRealtimeTranscriptionConnection,
  type MistralRealtimeTranscriptionSettings,
} from './mistral-realtime-transcription';
import type { RealtimeVoiceSettings } from './realtime.types';

type ConnectTranscription = typeof MistralRealtimeTranscriptionConnection.connect;

/**
 * Adaptateur sortant du gateway Bob vers Voxtral Realtime.
 *
 * La clé Mistral est capturée au composition root et n'est jamais exposée au noyau de session,
 * au ticket, au mobile ou aux événements wire. La durée demandée par le gateway ne peut que
 * réduire la borne configurée côté serveur.
 */
export class MistralRealtimeGatewayProviderAdapter implements MistralRealtimeGatewayProvider {
  private readonly baseSettings: Omit<MistralRealtimeTranscriptionSettings, 'maxSessionSeconds'>;

  constructor(
    settings: RealtimeVoiceSettings,
    private readonly connectTranscription: ConnectTranscription =
      MistralRealtimeTranscriptionConnection.connect,
  ) {
    if (
      !settings.enabled
      || settings.provider !== 'mistral'
      || !settings.apiKey
      || typeof this.connectTranscription !== 'function'
    ) throw new Error('Mistral realtime gateway provider is unavailable.');
    this.baseSettings = Object.freeze({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      targetDelayMs: settings.mistralTargetDelayMs,
      connectTimeoutMs: settings.providerTimeoutMs,
    });
  }

  connect(input: { readonly maxSessionSeconds: number; readonly signal: AbortSignal }) {
    if (
      !Number.isSafeInteger(input.maxSessionSeconds)
      || input.maxSessionSeconds < 60
      || input.maxSessionSeconds > 900
      || !(input.signal instanceof AbortSignal)
      || input.signal.aborted
    ) return Promise.reject(new Error('Mistral realtime gateway connection rejected.'));

    return this.connectTranscription(
      { ...this.baseSettings, maxSessionSeconds: input.maxSessionSeconds },
      { signal: input.signal },
    );
  }
}
