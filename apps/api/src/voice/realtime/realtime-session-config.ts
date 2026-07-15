import type { OpenAiRealtimeSessionConfig, RealtimeVoiceSettings } from './realtime.types';

/**
 * Prompt de bootstrap sans donnée métier ni PII. Le contexte d'écran et les outils seront
 * fournis par le canal sideband serveur ; ils ne doivent jamais devenir une autorité client.
 */
export const BOB_REALTIME_BOOTSTRAP_INSTRUCTIONS = [
  'Tu es uniquement le capteur vocal montant de Bob Pro.',
  'Transcris la parole utilisateur en français, sans jamais répondre ni générer de contenu.',
  'Ne produis aucun texte assistant, aucun audio descendant, aucun appel d’outil et aucune action.',
  'Le cerveau Bob et la restitution vocale auditée sont exclusivement exécutés côté serveur.',
].join(' ');

export const BOB_REALTIME_TRANSCRIPTION_PROMPT = [
  'Conversation professionnelle en français pour un indépendant ou un cabinet comptable.',
  'Vocabulaire attendu : devis, facture, acompte, TVA, trésorerie, dépense, relance, client, chantier et document.',
].join(' ');

export function buildOpenAiRealtimeSessionConfig(
  settings: Pick<RealtimeVoiceSettings, 'model' | 'voice'>,
): OpenAiRealtimeSessionConfig {
  return {
    type: 'realtime',
    model: settings.model,
    // OpenAI impose une modalité de sortie dans la session, même avec create_response=false.
    // `text` retire la voix provider de la piste WebRTC ; tout événement response.* est en plus
    // traité comme une violation fatale par le sideband.
    output_modalities: ['text'],
    instructions: BOB_REALTIME_BOOTSTRAP_INSTRUCTIONS,
    include: [],
    truncation: 'auto',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24_000 },
        noise_reduction: { type: 'near_field' },
        transcription: {
          model: 'gpt-4o-mini-transcribe',
          language: 'fr',
          prompt: BOB_REALTIME_TRANSCRIPTION_PROMPT,
        },
        turn_detection: {
          type: 'semantic_vad',
          eagerness: 'auto',
          // Le VAD commit l'audio. Aucun acteur — mobile, provider ou sideband — ne crée de
          // réponse provider : Bob parle via l'artefact TTS audité hors WebRTC.
          create_response: false,
          // Défense en profondeur si un client obsolète a déjà ouvert une réponse avant que le
          // sideband ne déclenche le kill-switch ; ce champ ne crée aucune réponse.
          interrupt_response: true,
        },
      },
      output: {
        format: { type: 'audio/pcm', rate: 24_000 },
        voice: settings.voice,
        speed: 1,
      },
    },
    max_output_tokens: 1,
    tools: [],
    tool_choice: 'none',
    tracing: null,
  };
}
