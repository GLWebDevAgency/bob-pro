export interface TtsResult {
  /** Audio synthétisé (base64) à lire côté client ; null si la synthèse est NATIVE (l'appareil parle directement). */
  audioBase64: string | null;
  mimeType: string | null;
  model: string;
}

/**
 * Port de synthèse vocale (Text-To-Speech) — miroir de SttPort. Deux familles d'adapters :
 * - NATIF (sur l'appareil, expo-speech) : gratuit, hors-ligne, par défaut ; l'appareil PARLE (audioBase64 = null).
 * - CLOUD (Mistral **Voxtral TTS** — modèle voxtral-mini-tts, endpoint /v1/audio/speech, souverain FR/EU, réservé au palier Pro) :
 *   voix premium ; renvoie l'audio à lire côté client. ⚠️ Produit DISTINCT des modèles Voxtral STT/compréhension
 *   (voxtral-mini/small-transcribe) : ceux-là écoutent, Voxtral TTS parle. Usage commercial = API payante (poids = CC BY-NC).
 * Provider-agnostique : Bob formule une réponse TEXTE (issue du domaine, jamais un montant inventé) -> le port la vocalise.
 */
export interface TtsPort {
  readonly id: string;
  synthesize(text: string, options?: { readonly signal?: AbortSignal }): Promise<TtsResult>;
  health(): Promise<{ healthy: boolean }>;
}
