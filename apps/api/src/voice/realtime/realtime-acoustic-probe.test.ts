import { describe, expect, it, vi } from 'vitest';
import type { LocalWhisperAuditDeploymentProbePort } from '../../ai/providers';
import {
  BOB_LIVE_ACOUSTIC_PROBE_TEXT,
  RealtimeSpeechAcousticProbe,
  type RealtimeSpeechRenderPort,
} from './realtime-acoustic-probe';
import {
  RealtimeSpeechRenderer,
  type RealtimeSpeechRenderOutcome,
} from './realtime-speech-renderer';

function wave(durationMs = 500): Uint8Array {
  const sampleRate = 16_000;
  const dataBytes = Math.round(sampleRate * 2 * durationMs / 1_000);
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, bytes.byteLength - 8, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, dataBytes, true);
  return bytes;
}

function controls(healthy = true): LocalWhisperAuditDeploymentProbePort {
  return {
    proveDeploymentControls: vi.fn(async () => ({ healthy })),
  };
}

function renderer(transcript = BOB_LIVE_ACOUSTIC_PROBE_TEXT): RealtimeSpeechRenderer {
  return new RealtimeSpeechRenderer({
    synthesizer: {
      id: 'openai-realtime-tts',
      trustDomain: 'openai.com',
      synthesize: vi.fn(async () => ({
        audioBytes: wave(),
        mimeType: 'audio/wav',
        estimatedDurationMs: 500,
      })),
    },
    auditor: {
      id: 'local-whisper',
      trustDomain: 'bob.local-whisper',
      transcribe: vi.fn(async () => ({ text: transcript })),
    },
  });
}

describe('preuve acoustique Bob Live', () => {
  it('rejoue les contrôles puis le renderer exact sans retourner de contenu', async () => {
    const deploymentControls = controls();
    const proof = new RealtimeSpeechAcousticProbe(renderer(), deploymentControls);

    const result = await proof.prove(new AbortController().signal);
    await expect(proof.prove(new AbortController().signal))
      .resolves.toEqual({ healthy: true });

    expect(result).toEqual({ healthy: true });
    expect(Object.keys(result)).toEqual(['healthy']);
    expect(deploymentControls.proveDeploymentControls).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(/42|audio|transcript|token|http/iu);
  });

  it.each([
    ['texte différent', 'Bob vérifie le montant de 43 euros.'],
    ['fait écrit autrement', 'Bob vérifie un montant de quarante-deux euros.'],
  ])('ferme sur un %s', async (_case, transcript) => {
    const proof = new RealtimeSpeechAcousticProbe(renderer(transcript), controls());

    await expect(proof.prove(new AbortController().signal))
      .resolves.toEqual({ healthy: false });
  });

  it('ferme avant le TTS si les refus réseau ne sont pas prouvés', async () => {
    const render = vi.fn();
    const proof = new RealtimeSpeechAcousticProbe(
      { render } as unknown as RealtimeSpeechRenderPort,
      controls(false),
    );

    await expect(proof.prove(new AbortController().signal))
      .resolves.toEqual({ healthy: false });
    expect(render).not.toHaveBeenCalled();
  });

  it('ferme lorsque TTS et ASR appartiennent au même domaine de confiance', async () => {
    const correlated = new RealtimeSpeechRenderer({
      synthesizer: {
        id: 'openai-realtime-tts',
        trustDomain: 'openai.com',
        synthesize: vi.fn(async () => ({
          audioBytes: wave(),
          mimeType: 'audio/wav',
          estimatedDurationMs: 500,
        })),
      },
      auditor: {
        id: 'openai-realtime-audit-whisper',
        trustDomain: 'openai.com',
        transcribe: vi.fn(async () => ({ text: BOB_LIVE_ACOUSTIC_PROBE_TEXT })),
      },
    });

    await expect(new RealtimeSpeechAcousticProbe(correlated, controls())
      .prove(new AbortController().signal)).resolves.toEqual({ healthy: false });
  });

  it('efface le buffer audio possédé après le verdict', async () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    const render = vi.fn(async () => ({
      status: 'ready' as const,
      artifact: {
        audioBytes: audio,
        metadata: {
          version: 1 as const,
          sessionId: 'bob-live-acoustic-probe',
          turnId: 'bob-live-acoustic-probe-turn',
          contextRevision: 1,
          contextDigest: '0'.repeat(64),
          classification: 'dynamic_sensitive' as const,
          source: 'synthesized_audited' as const,
          mimeType: 'audio/wav' as const,
          byteLength: audio.byteLength,
          estimatedDurationMs: 100,
          textSha256: '1'.repeat(64),
          factsSha256: '2'.repeat(64),
          audioSha256: '3'.repeat(64),
          synthesisAdapterId: 'openai-realtime-tts',
          synthesisTrustDomain: 'openai.com',
          auditAdapterId: 'local-whisper',
          auditTrustDomain: 'bob.local-whisper',
          auditTranscriptSha256: '4'.repeat(64),
        },
      },
    } satisfies RealtimeSpeechRenderOutcome));
    const proof = new RealtimeSpeechAcousticProbe({ render }, controls());

    await expect(proof.prove(new AbortController().signal))
      .resolves.toEqual({ healthy: false });
    expect([...audio]).toEqual([0, 0, 0, 0]);
  });

  it('refuse immédiatement un signal déjà annulé', async () => {
    const deploymentControls = controls();
    const proof = new RealtimeSpeechAcousticProbe(renderer(), deploymentControls);

    await expect(proof.prove(AbortSignal.abort())).resolves.toEqual({ healthy: false });
    expect(deploymentControls.proveDeploymentControls).not.toHaveBeenCalled();
  });
});
