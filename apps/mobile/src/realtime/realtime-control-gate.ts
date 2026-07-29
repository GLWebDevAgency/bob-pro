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
const CONTROL_ACK_MAX_ATTEMPTS = 3;
const CONTROL_ACK_RETRY_DELAYS_MS = [100, 250] as const;

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
  private readonly inFlight = new Map<
    string,
    {
      readonly abort: AbortController;
      readonly promise: Promise<RealtimeAgentControl | null>;
    }
  >();
  private closed = false;

  constructor(
    private readonly client: ControlClient,
    private readonly currentFence: () => RealtimePublishedContextFence | null,
  ) {}

  acknowledge(
    reference: RealtimeAgentControlReference | RealtimeVoiceControlReference,
  ): Promise<RealtimeAgentControl | null> {
    if (this.closed) return Promise.resolve(null);
    // Une metadata provider ne prouve pas que l'audio correspondant a réellement été
    // délivré. Seule la référence retournée après l'ACK acoustique durable porte cet ID.
    // WebRTC direct reste donc lecture/parole seule tant qu'il n'offre pas ce reçu.
    if (!('acknowledgementId' in reference)) return Promise.resolve(null);
    const fence = this.currentFence();
    if (!fence || !fenceMatches(fence, fence.sessionHandle, reference)) {
      return Promise.resolve(null);
    }

    const sessionHandle = fence.sessionHandle;
    const flightKey = JSON.stringify([
      sessionHandle,
      reference.turnId,
      reference.acknowledgementId,
      reference.contextRevision,
      reference.contextDigest,
    ]);
    const existing = this.inFlight.get(flightKey);
    if (existing !== undefined) return existing.promise;

    const abort = new AbortController();
    const generation = this.generation;
    const promise: Promise<RealtimeAgentControl | null> = this.runAcknowledgement(
      sessionHandle,
      reference,
      abort,
      generation,
    ).finally(() => {
      const current = this.inFlight.get(flightKey);
      if (current?.promise === promise) this.inFlight.delete(flightKey);
    });
    this.inFlight.set(flightKey, { abort, promise });
    return promise;
  }

  private async runAcknowledgement(
    sessionHandle: string,
    reference: RealtimeVoiceControlReference,
    abort: AbortController,
    generation: number,
  ): Promise<RealtimeAgentControl | null> {
    for (let attempt = 0; attempt < CONTROL_ACK_MAX_ATTEMPTS; attempt += 1) {
      let result: Awaited<ReturnType<ControlClient['acknowledgeRealtimeVoiceControl']>> | null;
      try {
        result = await this.client.acknowledgeRealtimeVoiceControl(
          sessionHandle,
          reference,
          abort.signal,
        );
      } catch {
        result = null;
      }
      if (
        this.closed
        || abort.signal.aborted
        || generation !== this.generation
        || !fenceMatches(this.currentFence(), sessionHandle, reference)
      ) return null;
      if (result?.ok) {
        if (!sameReference(result.value, reference)) return null;
        return this.approvedControl(result.value);
      }
      const retryable = result === null
        || result.error.kind === 'unavailable'
        || (result.error.kind === 'dependency' && result.error.port === 'api');
      if (!retryable || attempt === CONTROL_ACK_MAX_ATTEMPTS - 1) return null;
      if (!await this.waitForRetry(
        abort.signal,
        CONTROL_ACK_RETRY_DELAYS_MS[attempt] ?? 250,
      )) return null;
    }
    return null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    for (const flight of this.inFlight.values()) flight.abort.abort();
    this.inFlight.clear();
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

  private waitForRetry(signal: AbortSignal, delayMs: number): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (continueRetry: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(continueRetry);
      };
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(!signal.aborted), delayMs);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}
