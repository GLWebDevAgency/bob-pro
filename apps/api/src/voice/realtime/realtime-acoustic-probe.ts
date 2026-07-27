import { createCanonicalSpeechEnvelope } from '@bob/ai';
import type { LocalWhisperAuditDeploymentProbePort } from '../../ai/providers';
import {
  realtimeSpeechEnvelopeDigests,
  type RealtimeSpeechRenderInput,
  type RealtimeSpeechRenderOutcome,
} from './realtime-speech-renderer';

/**
 * Phrase diagnostique fixe, sans donnée utilisateur. Le montant artificiel exerce réellement
 * l'extraction/comparaison de faits du renderer au lieu de valider seulement un texte vide de fait.
 */
export const BOB_LIVE_ACOUSTIC_PROBE_TEXT = 'Bob vérifie le montant de 42 euros.';

const PROBE_ENVELOPE = createCanonicalSpeechEnvelope(BOB_LIVE_ACOUSTIC_PROBE_TEXT);
const PROBE_DIGESTS = realtimeSpeechEnvelopeDigests(PROBE_ENVELOPE);
const PROBE_CONTEXT = Object.freeze({
  contextRevision: 1,
  contextDigest: '0'.repeat(64),
});
const PROBE_BINDING = Object.freeze({
  sessionId: 'bob-live-acoustic-probe',
  turnId: 'bob-live-acoustic-probe-turn',
  ...PROBE_CONTEXT,
});

export interface BobLiveAcousticProofPort {
  prove(signal: AbortSignal): Promise<{ readonly healthy: boolean }>;
}

export interface RealtimeSpeechRenderPort {
  render(input: RealtimeSpeechRenderInput): Promise<RealtimeSpeechRenderOutcome>;
}

/**
 * Preuve end-to-end en mémoire : frontière HTTP négative, TTS actif, WAV, Whisper indépendant,
 * puis exactement les validateurs acoustiques et canoniques du chemin de publication.
 */
export class RealtimeSpeechAcousticProbe implements BobLiveAcousticProofPort {
  constructor(
    private readonly renderer: RealtimeSpeechRenderPort,
    private readonly deploymentControls: LocalWhisperAuditDeploymentProbePort,
  ) {}

  async prove(signal: AbortSignal): Promise<{ readonly healthy: boolean }> {
    let outcome: RealtimeSpeechRenderOutcome | null = null;
    try {
      signal.throwIfAborted();
      const controls = await this.deploymentControls.proveDeploymentControls({ signal });
      if (!controls.healthy) return { healthy: false };
      signal.throwIfAborted();
      outcome = await this.renderer.render({
        envelope: PROBE_ENVELOPE,
        binding: PROBE_BINDING,
        signal,
        revalidateContext: async (contextSignal) => {
          contextSignal.throwIfAborted();
          return PROBE_CONTEXT;
        },
      });
      if (outcome.status !== 'ready') return { healthy: false };
      const { metadata } = outcome.artifact;
      return {
        healthy:
          metadata.source === 'synthesized_audited'
          && metadata.classification === 'dynamic_sensitive'
          && metadata.textSha256 === PROBE_DIGESTS.textSha256
          && metadata.factsSha256 === PROBE_DIGESTS.factsSha256
          && metadata.synthesisTrustDomain.length > 0
          && metadata.auditTrustDomain !== null
          && metadata.synthesisTrustDomain !== metadata.auditTrustDomain
          && metadata.auditTranscriptSha256 !== null,
      };
    } catch {
      return { healthy: false };
    } finally {
      if (outcome?.status === 'ready') outcome.artifact.audioBytes.fill(0);
    }
  }
}
