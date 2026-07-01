import { type TtsPort, type TtsResult } from './tts-port';

/** TTS déterministe (dev/CI/offline) : ne synthétise aucun octet, marque le texte comme « parlé » nativement. */
export class DemoTtsAdapter implements TtsPort {
  readonly id = 'demo';
  async synthesize(_text: string): Promise<TtsResult> {
    return { audioBase64: null, mimeType: null, model: 'demo' };
  }
  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}
