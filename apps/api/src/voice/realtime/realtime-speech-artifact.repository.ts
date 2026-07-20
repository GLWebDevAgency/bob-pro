import type {
  RealtimeSpeechArtifactClaim,
  RealtimeSpeechArtifactClaimInput,
  RealtimeSpeechArtifactFinalizeResult,
  RealtimeSpeechArtifactReadyInput,
  RealtimeSpeechArtifactRepositoryPort,
} from './realtime-speech-publisher';

/**
 * Adapter fail-closed du mode mémoire : il ne fabrique jamais un faux artefact audité. Le runtime
 * de démonstration peut démarrer, mais toute tentative de publication reste indisponible.
 */
export class DisabledRealtimeSpeechArtifactRepository implements RealtimeSpeechArtifactRepositoryPort {
  async claimRender(_input: RealtimeSpeechArtifactClaimInput): Promise<RealtimeSpeechArtifactClaim> {
    return { status: 'unavailable' };
  }

  async finalizeReady(
    _input: RealtimeSpeechArtifactReadyInput,
  ): Promise<RealtimeSpeechArtifactFinalizeResult> {
    return { status: 'unavailable' };
  }

  async failRender(_input: Parameters<RealtimeSpeechArtifactRepositoryPort['failRender']>[0]): Promise<void> {
    // Aucun claim ne peut être émis par cet adapter.
  }

  async cancel(_input: Parameters<RealtimeSpeechArtifactRepositoryPort['cancel']>[0]): Promise<void> {
    // Aucun claim ne peut être émis par cet adapter.
  }
}
