import { createHash } from 'node:crypto';
import { createCanonicalSpeechEnvelope, FIXED_SAFE_SPEECH } from '@bob/ai';
import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeSpeechRenderer,
  type RealtimeFixedSpeechPort,
  type RealtimeRenderedAudio,
  type RealtimeSpeechAuditPort,
  type RealtimeSpeechContextVersion,
  type RealtimeSpeechRenderInput,
  type RealtimeSpeechRendererDependencies,
  type RealtimeSpeechSynthesisPort,
} from './realtime-speech-renderer';

const CONTEXT: RealtimeSpeechContextVersion = {
  contextRevision: 7,
  contextDigest: 'a'.repeat(64),
};

function mp3Audio(
  byteLength = 2_048,
  overrides: Partial<RealtimeRenderedAudio> = {},
): RealtimeRenderedAudio {
  const audioBytes = new Uint8Array(byteLength);
  if (byteLength >= 3) audioBytes.set([0x49, 0x44, 0x33]);
  return {
    audioBytes,
    mimeType: 'audio/mpeg',
    estimatedDurationMs: 1_000,
    ...overrides,
  };
}

function harness(
  transcript: string,
  overrides: {
    readonly synthesize?: RealtimeSpeechSynthesisPort['synthesize'];
    readonly transcribe?: RealtimeSpeechAuditPort['transcribe'];
    readonly fixedSpeech?: RealtimeFixedSpeechPort;
    readonly synthesizerTrustDomain?: string;
    readonly auditorTrustDomain?: string;
    readonly limits?: RealtimeSpeechRendererDependencies['limits'];
  } = {},
) {
  const synthesize = vi.fn<RealtimeSpeechSynthesisPort['synthesize']>(
    overrides.synthesize ?? (async () => mp3Audio()),
  );
  const transcribe = vi.fn<RealtimeSpeechAuditPort['transcribe']>(
    overrides.transcribe ?? (async () => ({ text: transcript })),
  );
  const synthesizer: RealtimeSpeechSynthesisPort = {
    id: 'tts-test',
    trustDomain: overrides.synthesizerTrustDomain ?? 'tts.example',
    synthesize,
  };
  const auditor: RealtimeSpeechAuditPort = {
    id: 'asr-test',
    trustDomain: overrides.auditorTrustDomain ?? 'asr.example',
    transcribe,
  };
  return {
    renderer: new RealtimeSpeechRenderer({
      synthesizer,
      auditor,
      ...(overrides.fixedSpeech === undefined ? {} : { fixedSpeech: overrides.fixedSpeech }),
      ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
    }),
    synthesize,
    transcribe,
  };
}

function input(
  text: string,
  overrides: Partial<RealtimeSpeechRenderInput> = {},
): RealtimeSpeechRenderInput {
  return {
    envelope: createCanonicalSpeechEnvelope(text),
    binding: {
      sessionId: 'session_01',
      turnId: 'turn_01',
      contextRevision: CONTEXT.contextRevision,
      contextDigest: CONTEXT.contextDigest,
    },
    signal: new AbortController().signal,
    revalidateContext: async () => CONTEXT,
    ...overrides,
  };
}

describe('RealtimeSpeechRenderer — audit acoustique fail-closed', () => {
  it('audite aussi une phrase dynamique sans chiffre avant de libérer ses octets', async () => {
    const text = 'Bonjour, je peux t’aider sur ce devis.';
    const fixedSpeech: RealtimeFixedSpeechPort = {
      load: vi.fn(async () => ({
        ...mp3Audio(),
        approvedTextSha256: 'b'.repeat(64),
      })),
    };
    const h = harness(text, { fixedSpeech });

    const result = await h.renderer.render(input(text));

    expect(result.status).toBe('ready');
    expect(h.synthesize).toHaveBeenCalledOnce();
    expect(h.transcribe).toHaveBeenCalledOnce();
    expect(fixedSpeech.load).not.toHaveBeenCalled();
    if (result.status === 'ready') {
      expect(result.artifact.metadata).toMatchObject({
        source: 'synthesized_audited',
        classification: 'dynamic_sensitive',
        mimeType: 'audio/mpeg',
        byteLength: 2_048,
        synthesisAdapterId: 'tts-test',
        synthesisTrustDomain: 'tts.example',
        auditAdapterId: 'asr-test',
        auditTrustDomain: 'asr.example',
        auditTranscriptSha256: createHash('sha256').update(text).digest('hex'),
      });
      expect(result.artifact.metadata.factsSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(result.artifact.metadata)).not.toContain(text);
    }
  });

  it('possède une copie du texte, des faits et du fence avant le premier await', async () => {
    const text = 'Le reste dû est de 1 320 €.';
    const canonical = createCanonicalSpeechEnvelope(text);
    const mutableEnvelope = { ...canonical, facts: [...canonical.facts] };
    const mutableBinding = {
      sessionId: 'session_01',
      turnId: 'turn_01',
      contextRevision: CONTEXT.contextRevision,
      contextDigest: CONTEXT.contextDigest,
    };
    const h = harness(text, {
      synthesize: async ({ text: synthesizedText }) => {
        expect(synthesizedText).toBe(text);
        mutableEnvelope.canonicalText = 'Le reste dû est de 9 999 €.';
        mutableEnvelope.facts = [];
        mutableBinding.contextRevision = 99;
        mutableBinding.contextDigest = 'f'.repeat(64);
        return mp3Audio();
      },
    });

    const result = await h.renderer.render(input(text, {
      envelope: mutableEnvelope,
      binding: mutableBinding,
    }));

    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.artifact.metadata.contextRevision).toBe(CONTEXT.contextRevision);
      expect(result.artifact.metadata.contextDigest).toBe(CONTEXT.contextDigest);
      expect(result.artifact.metadata.textSha256)
        .toBe(createHash('sha256').update(text).digest('hex'));
    }
  });

  it.each([
    {
      label: 'homophone',
      expected: 'Ce devis est sans réserve.',
      heard: 'Ce devis est cent réserve.',
      code: 'SPEECH_TEXT_MISMATCH',
    },
    {
      label: 'chiffre',
      expected: 'Le reste dû est de 1 320 €.',
      heard: 'Le reste dû est de 1 321 €.',
      code: 'SPEECH_FACT_MISMATCH',
    },
    {
      label: 'IBAN',
      expected: 'L’IBAN est FR76 3000 6000 0112 3456 7890 189.',
      heard: 'L’IBAN est FR14 2004 1010 0505 0001 3M02 606.',
      code: 'SPEECH_FACT_MISMATCH',
    },
    {
      label: 'statut',
      expected: 'La facture est payée.',
      heard: 'La facture est impayée.',
      code: 'SPEECH_FACT_MISMATCH',
    },
  ] as const)('rejette une altération $label sans retourner la phrase', async ({ expected, heard, code }) => {
    const h = harness(heard);

    const result = await h.renderer.render(input(expected));

    expect(result).toEqual({ status: 'rejected', code });
    expect(JSON.stringify(result)).not.toContain(expected);
    expect(JSON.stringify(result)).not.toContain(heard);
  });

  it('rejette un auditeur dans le même domaine de confiance que le TTS', async () => {
    const text = 'Réponse dynamique.';
    const h = harness(text, {
      synthesizerTrustDomain: 'same-provider.example',
      auditorTrustDomain: 'same-provider.example',
    });

    await expect(h.renderer.render(input(text))).resolves.toEqual({
      status: 'rejected',
      code: 'AUDITOR_NOT_INDEPENDENT',
    });
    expect(h.synthesize).not.toHaveBeenCalled();
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it('propage physiquement le timeout à l’ASR et n’attend pas une promesse récalcitrante', async () => {
    const text = 'Réponse dynamique.';
    let auditSignal: AbortSignal | undefined;
    const h = harness(text, {
      transcribe: async ({ signal }) => {
        auditSignal = signal;
        return new Promise(() => undefined);
      },
      limits: { asrTimeoutMs: 10 },
    });

    const result = await h.renderer.render(input(text));

    expect(result).toEqual({ status: 'rejected', code: 'ASR_TIMEOUT' });
    expect(auditSignal?.aborted).toBe(true);
  });

  it('borne aussi le TTS et interrompt physiquement son travail au timeout', async () => {
    const text = 'Réponse dynamique.';
    let synthesisSignal: AbortSignal | undefined;
    const h = harness(text, {
      synthesize: async ({ signal }) => {
        synthesisSignal = signal;
        return new Promise(() => undefined);
      },
      limits: { ttsTimeoutMs: 10 },
    });

    const result = await h.renderer.render(input(text));

    expect(result).toEqual({ status: 'rejected', code: 'TTS_TIMEOUT' });
    expect(synthesisSignal?.aborted).toBe(true);
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it('propage une interruption externe pendant l’ASR et ne libère aucun artefact', async () => {
    const text = 'Réponse dynamique.';
    const controller = new AbortController();
    let auditSignal: AbortSignal | undefined;
    let started: (() => void) | undefined;
    const auditStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = harness(text, {
      transcribe: async ({ signal }) => {
        auditSignal = signal;
        started?.();
        return new Promise(() => undefined);
      },
    });

    const rendering = h.renderer.render(input(text, { signal: controller.signal }));
    await auditStarted;
    controller.abort(new Error('raison locale potentiellement sensible'));

    await expect(rendering).resolves.toEqual({ status: 'aborted', code: 'ABORTED' });
    expect(auditSignal?.aborted).toBe(true);
  });

  it.each([
    {
      label: 'MIME non autorisé',
      output: mp3Audio(2_048, { mimeType: 'audio/mpeg; charset=binary' }),
      code: 'AUDIO_MIME_REJECTED',
      limits: undefined,
    },
    {
      label: 'taille trop petite',
      output: mp3Audio(128),
      code: 'AUDIO_SIZE_REJECTED',
      limits: undefined,
    },
    {
      label: 'taille trop grande',
      output: mp3Audio(2_048),
      code: 'AUDIO_SIZE_REJECTED',
      limits: { maxAudioBytes: 1_024 },
    },
    {
      label: 'signature incohérente',
      output: { ...mp3Audio(), audioBytes: new Uint8Array(2_048) },
      code: 'AUDIO_FORMAT_MISMATCH',
      limits: undefined,
    },
    {
      label: 'durée excessive',
      output: mp3Audio(2_048, { estimatedDurationMs: 45_001 }),
      code: 'AUDIO_DURATION_REJECTED',
      limits: undefined,
    },
  ] as const)('rejette $label avant l’ASR', async ({ output, code, limits }) => {
    const text = 'Réponse dynamique.';
    const h = harness(text, {
      synthesize: async () => output,
      ...(limits === undefined ? {} : { limits }),
    });

    const result = await h.renderer.render(input(text));

    expect(result).toEqual({ status: 'rejected', code });
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it('fence le contexte après le TTS et n’envoie pas l’audio à l’ASR si l’écran a changé', async () => {
    const text = 'Réponse dynamique.';
    const revalidateContext = vi.fn<RealtimeSpeechRenderInput['revalidateContext']>()
      .mockResolvedValueOnce(CONTEXT)
      .mockResolvedValueOnce({ ...CONTEXT, contextRevision: CONTEXT.contextRevision + 1 });
    const h = harness(text);

    const result = await h.renderer.render(input(text, { revalidateContext }));

    expect(result).toEqual({ status: 'rejected', code: 'CONTEXT_STALE' });
    expect(h.synthesize).toHaveBeenCalledOnce();
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(revalidateContext).toHaveBeenCalledTimes(2);
  });

  it('refence le contexte après l’ASR avant de rendre l’artefact persistant', async () => {
    const text = 'Réponse dynamique.';
    const revalidateContext = vi.fn<RealtimeSpeechRenderInput['revalidateContext']>()
      .mockResolvedValueOnce(CONTEXT)
      .mockResolvedValueOnce(CONTEXT)
      .mockResolvedValueOnce({ ...CONTEXT, contextDigest: 'b'.repeat(64) });
    const h = harness(text);

    const result = await h.renderer.render(input(text, { revalidateContext }));

    expect(result).toEqual({ status: 'rejected', code: 'CONTEXT_STALE' });
    expect(h.transcribe).toHaveBeenCalledOnce();
    expect(revalidateContext).toHaveBeenCalledTimes(3);
  });

  it('ne retourne jamais la cause fournisseur ni une représentation base64', async () => {
    const sensitive = 'Durand FR7630006000011234567890189 c2VjcmV0';
    const h = harness('Réponse dynamique.', {
      synthesize: async () => {
        throw new Error(sensitive);
      },
    });

    const result = await h.renderer.render(input('Réponse dynamique.'));

    expect(result).toEqual({ status: 'rejected', code: 'TTS_FAILED' });
    expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(result).not.toHaveProperty('audioBase64');
  });
});

describe('RealtimeSpeechRenderer — allowlist statique et artefact', () => {
  it('autorise la phrase statique exacte avec son clip préapprouvé et sans TTS/ASR', async () => {
    const text = FIXED_SAFE_SPEECH.checking;
    const expectedTextDigest = createHash('sha256').update(text).digest('hex');
    const fixedSpeech: RealtimeFixedSpeechPort = {
      load: vi.fn(async ({ phraseId, textSha256 }) => {
        expect(phraseId).toBe('checking');
        expect(textSha256).toBe(expectedTextDigest);
        return { ...mp3Audio(), approvedTextSha256: expectedTextDigest };
      }),
    };
    const h = harness(text, { fixedSpeech });

    const result = await h.renderer.render(input(text));

    expect(result.status).toBe('ready');
    expect(fixedSpeech.load).toHaveBeenCalledOnce();
    expect(h.synthesize).not.toHaveBeenCalled();
    expect(h.transcribe).not.toHaveBeenCalled();
    if (result.status === 'ready') {
      expect(result.artifact.metadata).toMatchObject({
        source: 'preapproved_static',
        classification: 'fixed_safe',
        textSha256: expectedTextDigest,
        audioSha256: createHash('sha256').update(mp3Audio().audioBytes).digest('hex'),
        synthesisAdapterId: 'preapproved-static',
        synthesisTrustDomain: 'bob-pro',
        auditAdapterId: null,
        auditTrustDomain: null,
        auditTranscriptSha256: null,
      });
      expect(result.artifact.audioBytes).toBeInstanceOf(Uint8Array);
    }
  });

  it('fait repasser toute variante de l’allowlist par TTS puis ASR', async () => {
    const text = `${FIXED_SAFE_SPEECH.checking} `;
    const fixedSpeech: RealtimeFixedSpeechPort = {
      load: vi.fn(async () => ({ ...mp3Audio(), approvedTextSha256: 'b'.repeat(64) })),
    };
    const h = harness(text, { fixedSpeech });

    const result = await h.renderer.render(input(text));

    expect(result.status).toBe('ready');
    expect(fixedSpeech.load).not.toHaveBeenCalled();
    expect(h.synthesize).toHaveBeenCalledOnce();
    expect(h.transcribe).toHaveBeenCalledOnce();
  });

  it('rejette une enveloppe forgée qui prétend rendre une phrase dynamique statique', async () => {
    const dynamic = createCanonicalSpeechEnvelope('La facture est payée.');
    const forged = {
      ...dynamic,
      classification: 'fixed_safe',
      fixedPhraseId: 'checking',
    } as unknown as RealtimeSpeechRenderInput['envelope'];
    const h = harness(dynamic.text);

    const result = await h.renderer.render(input(dynamic.text, { envelope: forged }));

    expect(result).toEqual({ status: 'rejected', code: 'INVALID_ENVELOPE' });
    expect(h.synthesize).not.toHaveBeenCalled();
    expect(h.transcribe).not.toHaveBeenCalled();
  });
});
