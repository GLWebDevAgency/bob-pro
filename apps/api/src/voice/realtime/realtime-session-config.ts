import type { OpenAiRealtimeSessionConfig, RealtimeVoiceSettings } from './realtime.types';

/**
 * Prompt de bootstrap sans donnée métier ni PII. Le contexte d'écran et les outils seront
 * fournis par le canal sideband serveur ; ils ne doivent jamais devenir une autorité client.
 */
export const BOB_REALTIME_BOOTSTRAP_INSTRUCTIONS = [
  'Tu es Bob, l’assistant vocal professionnel de Bob Pro.',
  'Réponds en français naturel, chaleureux et concis, avec une phrase courte à la fois.',
  'N’invente jamais un montant, une identité, un statut comptable ni une information absente.',
  'Ce canal ne peut exécuter aucune action métier. Explique que la validation sécurisée est nécessaire pour agir.',
  'Quand le contexte métier manque, dis-le clairement et demande une précision courte.',
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
    output_modalities: ['audio'],
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
          // Le VAD commit l'audio, mais seul le sideband serveur est autorisé à créer
          // une réponse. Cela rend détectable puis bloquable tout response.create client.
          create_response: false,
          interrupt_response: true,
        },
      },
      output: {
        format: { type: 'audio/pcm', rate: 24_000 },
        voice: settings.voice,
        speed: 1,
      },
    },
    max_output_tokens: 1_024,
    tools: [],
    tool_choice: 'none',
    tracing: null,
  };
}
