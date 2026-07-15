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

function wav(dataByteLength = 32_000): Uint8Array {
  const bytes = new Uint8Array(44 + dataByteLength);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from('RIFF'), 0);
  view.setUint32(4, 36 + dataByteLength, true);
  bytes.set(Buffer.from('WAVE'), 8);
  bytes.set(Buffer.from('fmt '), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(Buffer.from('data'), 36);
  view.setUint32(40, dataByteLength, true);
  return bytes;
}

describe('adaptateurs provider du rendu Bob Live', () => {
  it('refuse de déclarer indépendants des ports fournisseur non qualifiés', () => {
    const tts = {
      id: 'openai-tts',
      synthesisTrustDomain: 'openai.com',
      synthesize: async () => ({ audioBase64: null, mimeType: null, model: 'x' }),
      health: async () => ({ healthy: true }),
    } satisfies TtsPort & { readonly synthesisTrustDomain: 'openai.com' };
    const stt = {
      id: 'mistral-voxtral-stt',
      transcribe: async () => ({ text: '', model: 'x' }),
      health: async () => ({ healthy: true }),
    } satisfies SttPort;

    expect(() => new BobAiRealtimeSpeechSynthesisAdapter(tts)).toThrow(/qualified realtime/);
    expect(() => new BobAiRealtimeSpeechAuditAdapter(stt)).toThrow(/qualified independent/);
  });

  it('décode strictement le MP3 TTS et dérive sa durée du conteneur', async () => {
    const synthesize = vi.fn(async () => ({
      audioBase64: Buffer.from(mp3()).toString('base64'),
      mimeType: 'audio/mpeg',
      model: 'voxtral-test',
    }));
    const tts: TtsPort & { readonly synthesisTrustDomain: 'mistral.ai' } = {
      id: 'mistral-voxtral-tts',
      synthesisTrustDomain: 'mistral.ai',
      synthesize,
      health: async () => ({ healthy: true }),
    };
    const adapter = new BobAiRealtimeSpeechSynthesisAdapter(tts);
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
    const tts: TtsPort & { readonly synthesisTrustDomain: 'mistral.ai' } = {
      id: 'mistral-voxtral-tts',
      synthesisTrustDomain: 'mistral.ai',
      synthesize: async () => ({ ...output, model: 'test' }),
      health: async () => ({ healthy: true }),
    };
    const adapter = new BobAiRealtimeSpeechSynthesisAdapter(tts);

    await expect(adapter.synthesize({
      text: 'Bonjour.',
      signal: new AbortController().signal,
    })).rejects.toThrow(/realtime_tts_invalid/);
  });

  it('qualifie la sortie WAV OpenAI et fixe son domaine de confiance', async () => {
    const bytes = wav();
    const synthesize = vi.fn(async () => ({
      audioBase64: Buffer.from(bytes).toString('base64'),
      mimeType: 'audio/wav',
      model: 'gpt-4o-mini-tts-2025-12-15',
    }));
    const tts: TtsPort & { readonly synthesisTrustDomain: 'openai.com' } = {
      id: 'openai-realtime-tts',
      synthesisTrustDomain: 'openai.com',
      synthesize,
      health: async () => ({ healthy: true }),
    };
    const adapter = new BobAiRealtimeSpeechSynthesisAdapter(tts);
    const signal = new AbortController().signal;

    const output = await adapter.synthesize({ text: 'Bonjour.', signal });

    expect(output).toMatchObject({ mimeType: 'audio/wav', estimatedDurationMs: 1_000 });
    expect(output.audioBytes).toHaveLength(32_044);
    expect(synthesize).toHaveBeenCalledWith('Bonjour.', { signal });
    expect(adapter.trustDomain).toBe('openai.com');
  });

  it.each([
    { id: 'openai-realtime-tts', synthesisTrustDomain: 'mistral.ai' },
    { id: 'mistral-voxtral-tts', synthesisTrustDomain: 'openai.com' },
    { id: 'openai-tts', synthesisTrustDomain: 'openai.com' },
  ])('refuse un port TTS qui ment sur son identité ou son domaine', (identity) => {
    const tts = {
      ...identity,
      synthesize: async () => ({ audioBase64: '', mimeType: 'audio/wav', model: 'x' }),
      health: async () => ({ healthy: true }),
    } satisfies TtsPort & { readonly synthesisTrustDomain: string };

    expect(() => new BobAiRealtimeSpeechSynthesisAdapter(tts)).toThrow(/qualified realtime/);
  });

  it('transmet un binaire borné à l’ASR indépendant et propage le signal', async () => {
    const transcribe = vi.fn(async () => ({ text: 'Bonjour.', model: 'gpt-4o-transcribe' }));
    const stt: SttPort & { readonly auditTrustDomain: 'openai.com' } = {
      id: 'openai-realtime-audit-whisper',
      auditTrustDomain: 'openai.com',
      transcribe,
      health: async () => ({ healthy: true }),
    };
    const adapter = new BobAiRealtimeSpeechAuditAdapter(stt);
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

  it('qualifie Whisper local avec un domaine indépendant figé', async () => {
    const transcribe = vi.fn(async () => ({ text: 'Bonjour.', model: 'whisper-local' }));
    const stt: SttPort & { readonly auditTrustDomain: 'bob.local-whisper' } = {
      id: 'local-whisper',
      auditTrustDomain: 'bob.local-whisper',
      transcribe,
      health: async () => ({ healthy: true }),
    };
    const adapter = new BobAiRealtimeSpeechAuditAdapter(stt);

    await expect(adapter.transcribe({
      audioBytes: mp3(),
      mimeType: 'audio/mpeg',
      signal: new AbortController().signal,
    })).resolves.toEqual({ text: 'Bonjour.' });
    expect(adapter.trustDomain).toBe('bob.local-whisper');
  });

  it('refuse une identité locale qui ment sur son domaine de confiance', () => {
    const stt: SttPort & { readonly auditTrustDomain: 'mistral.ai' } = {
      id: 'local-whisper',
      auditTrustDomain: 'mistral.ai',
      transcribe: async () => ({ text: '', model: 'x' }),
      health: async () => ({ healthy: true }),
    };
    expect(() => new BobAiRealtimeSpeechAuditAdapter(stt)).toThrow(/qualified independent/);
  });
});
