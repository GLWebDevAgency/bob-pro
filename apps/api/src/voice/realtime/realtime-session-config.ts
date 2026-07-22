import type {
  OpenAiAuditedRealtimeSessionConfig,
  OpenAiNativeRealtimeSessionConfig,
  RealtimeVoiceSettings,
} from './realtime.types';

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

/**
 * Prompt dédié à la restitution native. Il ne contient aucune donnée utilisateur et ne confère
 * aucune autorité métier au provider : le texte à prononcer est injecté dans une réponse OOB par
 * le serveur, après ses propres contrôles de contexte et de sécurité.
 */
export const BOB_REALTIME_NATIVE_BOOTSTRAP_INSTRUCTIONS = [
  'Tu es uniquement la voix française de Bob Pro.',
  'Ne réponds jamais de ta propre initiative et ne prends aucune décision.',
  'Prononce exactement et uniquement les réponses hors conversation explicitement approuvées par le serveur Bob.',
  'N’ajoute, ne retire et ne reformule aucun chiffre, nom, date, engagement, action ou avertissement.',
  'N’appelle aucun outil et n’exécute aucune action.',
  'Sans réponse hors conversation explicitement créée par le serveur, reste silencieux.',
].join(' ');

export function buildOpenAiRealtimeSessionConfig(
  settings: Pick<RealtimeVoiceSettings, 'model' | 'voice'>,
): OpenAiAuditedRealtimeSessionConfig {
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

export function buildOpenAiNativeRealtimeSessionConfig(
  settings: Pick<RealtimeVoiceSettings, 'model' | 'voice'>,
): OpenAiNativeRealtimeSessionConfig {
  return {
    type: 'realtime',
    model: settings.model,
    // La piste descendante est nécessaire au plein duplex natif. Le VAD ne crée pourtant aucune
    // réponse : seul le sideband pourra déclencher une réponse OOB canonique et approuvée.
    output_modalities: ['audio'],
    instructions: BOB_REALTIME_NATIVE_BOOTSTRAP_INSTRUCTIONS,
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
          create_response: false,
          // Les réponses OOB sont interrompues explicitement via response.cancel puis clear.
          interrupt_response: false,
        },
      },
      output: {
        format: { type: 'audio/pcm', rate: 24_000 },
        voice: settings.voice,
        speed: 1,
      },
    },
    max_output_tokens: 4_096,
    tools: [],
    tool_choice: 'none',
    tracing: null,
  };
}
