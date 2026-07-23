import { describe, expect, it } from 'vitest';
import {
  BOB_REALTIME_BOOTSTRAP_INSTRUCTIONS,
  BOB_REALTIME_NATIVE_BOOTSTRAP_INSTRUCTIONS,
  BOB_REALTIME_TRANSCRIPTION_PROMPT,
  buildOpenAiNativeRealtimeSessionConfig,
  buildOpenAiRealtimeSessionConfig,
} from './realtime-session-config';

const SETTINGS = {
  model: 'gpt-realtime-2.1',
  voice: 'marin' as const,
};

describe('configuration des sessions OpenAI Realtime', () => {
  it('préserve exactement le bootstrap audité texte, inerte et sans outil', () => {
    expect(buildOpenAiRealtimeSessionConfig(SETTINGS)).toEqual({
      type: 'realtime',
      model: 'gpt-realtime-2.1',
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
            create_response: false,
            interrupt_response: true,
          },
        },
        output: {
          format: { type: 'audio/pcm', rate: 24_000 },
          voice: 'marin',
          speed: 1,
        },
      },
      max_output_tokens: 1,
      tools: [],
      tool_choice: 'none',
      tracing: null,
    });
  });

  it('construit le bootstrap natif audio sans réponse automatique, outil ni autorité métier', () => {
    const config = buildOpenAiNativeRealtimeSessionConfig(SETTINGS);

    expect(config).toEqual({
      type: 'realtime',
      model: 'gpt-realtime-2.1',
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
            interrupt_response: false,
          },
        },
        output: {
          format: { type: 'audio/pcm', rate: 24_000 },
          voice: 'marin',
          speed: 1,
        },
      },
      max_output_tokens: 4_096,
      tools: [],
      tool_choice: 'none',
      tracing: null,
    });
    expect(config.instructions).toContain('réponses hors conversation explicitement approuvées par le serveur');
    expect(config.instructions).toContain('N’appelle aucun outil et n’exécute aucune action.');
    expect(config.instructions).not.toContain('company');
    expect(config.instructions).not.toContain('user');
  });
});
