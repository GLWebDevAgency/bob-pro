import type {
  BobClient,
  RealtimeVoiceControlAcknowledgement,
  RealtimeVoiceControlReference,
} from '@bob/api-client';
import type { RealtimeAgentControl, RealtimeAgentControlReference } from './realtime-event-codecs';

export interface RealtimePublishedContextFence {
  readonly sessionHandle: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
}

type ControlClient = Pick<BobClient, 'acknowledgeRealtimeVoiceControl'>;

function sameReference(
  left: RealtimeVoiceControlReference,
  right: RealtimeVoiceControlReference,
): boolean {
  return left.turnId === right.turnId
    && left.acknowledgementId === right.acknowledgementId
    && left.contextRevision === right.contextRevision
    && left.contextDigest === right.contextDigest;
}

function fenceMatches(
  fence: RealtimePublishedContextFence | null,
  sessionHandle: string,
  reference: RealtimeVoiceControlReference,
): boolean {
  return fence !== null
    && fence.sessionHandle === sessionHandle
    && fence.contextRevision === reference.contextRevision
    && fence.contextDigest === reference.contextDigest;
}

/**
 * Échange une référence provider non fiable contre un contrôle one-shot de notre API.
 *
 * La classe ne produit aucun effet UI. Elle abandonne silencieusement dès qu'un handle ou
 * contexte change, y compris après la réponse HTTP. Un ACK consommé mais devenu obsolète est
 * donc perdu de façon sûre plutôt que rejoué sur un autre écran.
 */
export class RealtimeControlAcknowledgementGate {
  private generation = 0;
  private inFlight: AbortController | null = null;
  private closed = false;

  constructor(
    private readonly client: ControlClient,
    private readonly currentFence: () => RealtimePublishedContextFence | null,
  ) {}

  async acknowledge(
    reference: RealtimeAgentControlReference | RealtimeVoiceControlReference,
  ): Promise<RealtimeAgentControl | null> {
    if (this.closed) return null;
    // Une metadata provider ne prouve pas que l'audio correspondant a réellement été
    // délivré. Seule la référence retournée après l'ACK acoustique durable porte cet ID.
    // WebRTC direct reste donc lecture/parole seule tant qu'il n'offre pas ce reçu.
    if (!('acknowledgementId' in reference)) return null;
    const fence = this.currentFence();
    if (!fence || !fenceMatches(fence, fence.sessionHandle, reference)) return null;

    this.inFlight?.abort();
    const abort = new AbortController();
    this.inFlight = abort;
    const generation = ++this.generation;
    const sessionHandle = fence.sessionHandle;

    try {
      const result = await this.client.acknowledgeRealtimeVoiceControl(
        sessionHandle,
        reference,
        abort.signal,
      );
      if (
        this.closed
        || abort.signal.aborted
        || generation !== this.generation
        || !result.ok
        || !sameReference(result.value, reference)
        || !fenceMatches(this.currentFence(), sessionHandle, reference)
      ) return null;
      return this.approvedControl(result.value);
    } catch {
      return null;
    } finally {
      if (this.inFlight === abort) this.inFlight = null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.inFlight?.abort();
    this.inFlight = null;
  }

  private approvedControl(
    value: RealtimeVoiceControlAcknowledgement,
  ): RealtimeAgentControl {
    return {
      turnId: value.turnId,
      kind: value.kind,
      contextRevision: value.contextRevision,
      contextDigest: value.contextDigest,
      ...(value.navigate !== undefined ? { navigate: value.navigate } : {}),
      ...(value.proposalId !== undefined ? { proposalId: value.proposalId } : {}),
      ...(value.proposalExpiresAt !== undefined
        ? { proposalExpiresAt: value.proposalExpiresAt }
        : {}),
    };
  }
}
