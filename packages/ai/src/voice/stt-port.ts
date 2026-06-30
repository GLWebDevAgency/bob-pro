export interface SttResult {
  text: string;
  model: string;
}

/**
 * Port de reconnaissance vocale (Speech-To-Text). Deux familles d'adapters :
 * - NATIF (sur l'appareil) : gratuit, privé, par défaut — implémenté côté mobile (build natif requis).
 * - CLOUD (Whisper/Deepgram/Voxtral) : plus précis — implémenté côté backend, où la clé est sécurisée.
 * Le port reste provider-agnostique ; la voix n'est qu'un canal d'entrée -> texte -> MÊME cerveau Bob.
 */
export interface SttPort {
  readonly id: string;
  transcribe(audioBase64: string, mimeType: string): Promise<SttResult>;
  health(): Promise<{ healthy: boolean }>;
}
