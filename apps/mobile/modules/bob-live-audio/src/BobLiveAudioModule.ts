import { NativeModule, requireOptionalNativeModule } from 'expo';

import type {
  BobLiveAudioCapabilities,
  BobLiveAudioModuleEvents,
} from './BobLiveAudio.types';

export declare class BobLiveAudioNativeModule extends NativeModule<BobLiveAudioModuleEvents> {
  /** Prépare la génération et retourne son captureId sans encore ouvrir le flux PCM. */
  prepareAsync(sessionId: string, maxCaptureDurationMs?: number): Promise<BobLiveAudioCapabilities>;
  /** Démarre uniquement la génération préparée, une fois les listeners et le decoder installés. */
  startPreparedAsync(sessionId: string, captureId: string): Promise<void>;
  /**
   * Acquitte cumulativement les trames effectivement prises en charge par le transport.
   * L'appelant doit acquitter dans l'ordre; sans acquittement la capture s'arrete apres
   * `maxInFlightFrames` afin qu'un gel JS ne laisse jamais le micro emettre sans borne.
   */
  acknowledgePcmAsync(
    sessionId: string,
    captureId: string,
    throughSequence: number,
  ): Promise<void>;
  stopAsync(sessionId: string, captureId: string): Promise<void>;
}

/** `null` dans Expo Go/web : l'appelant doit alors dégrader honnêtement vers le mode texte. */
export default requireOptionalNativeModule<BobLiveAudioNativeModule>('BobLiveAudio');
