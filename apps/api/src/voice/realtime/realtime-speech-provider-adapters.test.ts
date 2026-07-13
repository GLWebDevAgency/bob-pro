import type { SttPort, TtsPort } from '@bob/ai';
import { describe, expect, it, vi } from 'vitest';
import {
  BobAiRealtimeSpeechAuditAdapter,
  BobAiRealtimeSpeechSynthesisAdapter,
} from './realtime-speech-provider-adapters';

function mp3(byteLength = 16_000): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  // MPEG-1 Layer III, 128 kbps, 44,1 kHz.
  bytes.set([0xff, 0xfb, 0x90, 0x00]);
  return bytes;
}

describe('adaptateurs provider du rendu Bob Live', () => {
  it('refuse de déclarer indépendants des ports fournisseur non qualifiés', () => {
    const tts = {
      id: 'openai-tts',
      synthesize: async () => ({ audioBase64: null, mimeType: null, model: 'x' }),
      health: async () => ({ healthy: true }),
    } satisfies TtsPort;
    const stt = {
      id: 'mistral-voxtral-stt',
      transcribe: async () => ({ text: '', model: 'x' }),
      health: async () => ({ healthy: true }),
    } satisfies SttPort;

    expect(() => new BobAiRealtimeSpeechSynthesisAdapter(tts)).toThrow(/qualified Mistral/);
    expect(() => new BobAiRealtimeSpeechAuditAdapter(stt)).toThrow(/qualified OpenAI/);
  });

  it('décode strictement le MP3 TTS et dérive sa durée du conteneur', async () => {
    const synthesize = vi.fn(async () => ({
      audioBase64: Buffer.from(mp3()).toString('base64'),
      mimeType: 'audio/mpeg',
      model: 'voxtral-test',
    }));
    const adapter = new BobAiRealtimeSpeechSynthesisAdapter({
      id: 'mistral-voxtral-tts',
      synthesize,
      health: async () => ({ healthy: true }),
    } satisfies TtsPort);
    const signal = new AbortController().signal;

    const output = await adapter.synthesize({ text: 'Bonjour.', signal });

    expect(output).toMatchObject({ mimeType: 'audio/mpeg', estimatedDurationMs: 1_000 });
    expect(output.audioBytes).toHaveLength(16_000);
    expect(synthesize).toHaveBeenCalledWith('Bonjour.', { signal });
    expect(adapter.trustDomain).toBe('mistral.ai');
  });

  it.each([
    { audioBase64: '!!!!', mimeType: 'audio/mpeg' },
    { audioBase64: Buffer.from(new Uint8Array(1_000)).toString('base64'), mimeType: 'audio/mpeg' },
    { audioBase64: Buffer.from(mp3()).toString('base64'), mimeType: 'audio/ogg' },
  ])('rejette une sortie TTS non canonique ou un conteneur illisible', async (output) => {
    const adapter = new BobAiRealtimeSpeechSynthesisAdapter({
      id: 'mistral-voxtral-tts',
      synthesize: async () => ({ ...output, model: 'test' }),
      health: async () => ({ healthy: true }),
    });

    await expect(adapter.synthesize({
      text: 'Bonjour.',
      signal: new AbortController().signal,
    })).rejects.toThrow(/realtime_tts_invalid/);
  });

  it('transmet un binaire borné à l’ASR indépendant et propage le signal', async () => {
    const transcribe = vi.fn(async () => ({ text: 'Bonjour.', model: 'gpt-4o-transcribe' }));
    const adapter = new BobAiRealtimeSpeechAuditAdapter({
      id: 'whisper',
      transcribe,
      health: async () => ({ healthy: true }),
    } satisfies SttPort);
    const bytes = mp3();
    const signal = new AbortController().signal;

    await expect(adapter.transcribe({ audioBytes: bytes, mimeType: 'audio/mpeg', signal }))
      .resolves.toEqual({ text: 'Bonjour.' });
    expect(transcribe).toHaveBeenCalledWith(
      Buffer.from(bytes).toString('base64'),
      'audio/mpeg',
      { signal },
    );
    expect(adapter.trustDomain).toBe('openai.com');
  });
});
