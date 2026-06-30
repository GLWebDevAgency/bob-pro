import { type SttPort, type SttResult } from './stt-port';

/** STT déterministe (dev/CI/offline) : renvoie une transcription fixe sans réseau. */
export class DemoSttAdapter implements SttPort {
  readonly id = 'demo';
  async transcribe(): Promise<SttResult> {
    return { text: 'encaisse la facture 2026-014', model: 'demo' };
  }
  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}
