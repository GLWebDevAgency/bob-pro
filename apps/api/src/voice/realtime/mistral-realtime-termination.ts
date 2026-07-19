import {
  isRealtimeDatabaseHardExpiryProof,
  isRealtimeProviderCallId,
  type RealtimeDatabaseHardExpiryProof,
} from './realtime-admission';
import type { MistralRealtimeGatewayProviderConnection } from './mistral-realtime-gateway';

const MAX_TRACKED_CONNECTIONS = 20_000;
const TERMINAL_PROOF_RETENTION_MS = 60_000;
const MAX_TERMINAL_PROOF_RETENTION_MS = 16 * 60_000;

interface TrackedConnection {
  readonly providerSessionId: string;
  readonly close: () => Promise<void>;
  readonly hardExpiresAt: number;
  closePromise: Promise<void> | null;
  terminal: boolean;
}

export interface MistralRealtimeConnectionRegistration {
  readonly providerSessionId: string;
  /** Ferme via la même autorité single-flight que les hangups explicites et le reaper. */
  close(): Promise<void>;
}

export class MistralRealtimeTerminationError extends Error {
  readonly code:
    | 'invalid_connection'
    | 'duplicate_connection'
    | 'connection_capacity_exceeded'
    | 'connection_not_local'
    | 'connection_close_unconfirmed'
    | 'invalid_hard_expiry_proof';

  constructor(code: MistralRealtimeTerminationError['code']) {
    super(`mistral_realtime_${code}`);
    this.name = 'MistralRealtimeTerminationError';
    this.code = code;
  }
}

/**
 * Autorité process-locale des WebSockets Voxtral.
 *
 * Mistral ne propose pas d'endpoint REST de terminaison : une réplique peut donc confirmer un
 * hangup avant le hard cap uniquement lorsqu'elle possède réellement la connexion. Après le hard
 * cap, une preuve issue de l'horloge DB permet au reaper de terminer le bail sans inventer d'egress.
 */
export class MistralRealtimeTerminationAuthority {
  readonly providerId = 'mistral' as const;
  private readonly connections = new Map<string, TrackedConnection>();
  private readonly terminalProofs = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  register(input: {
    readonly connection: Pick<MistralRealtimeGatewayProviderConnection, 'providerSessionId' | 'close'>;
    readonly hardExpiresAt: string;
  }): MistralRealtimeConnectionRegistration {
    const providerSessionId = input.connection.providerSessionId;
    const hardExpiresAt = Date.parse(input.hardExpiresAt);
    const now = this.safeNow();
    this.prune(now);
    if (
      !isRealtimeProviderCallId(providerSessionId)
      || typeof input.connection.close !== 'function'
      || !Number.isFinite(hardExpiresAt)
      || new Date(hardExpiresAt).toISOString() !== input.hardExpiresAt
      || hardExpiresAt <= now
    ) throw new MistralRealtimeTerminationError('invalid_connection');
    if (this.connections.has(providerSessionId) || this.terminalProofs.has(providerSessionId)) {
      throw new MistralRealtimeTerminationError('duplicate_connection');
    }
    if (this.connections.size >= MAX_TRACKED_CONNECTIONS) {
      throw new MistralRealtimeTerminationError('connection_capacity_exceeded');
    }

    const tracked: TrackedConnection = {
      providerSessionId,
      close: input.connection.close.bind(input.connection),
      hardExpiresAt,
      closePromise: null,
      terminal: false,
    };
    this.connections.set(providerSessionId, tracked);
    return Object.freeze({
      providerSessionId,
      close: () => this.closeTracked(tracked),
    });
  }

  async hangupCall(
    providerSessionId: string,
    hardExpiryProof?: RealtimeDatabaseHardExpiryProof,
  ): Promise<void> {
    if (!isRealtimeProviderCallId(providerSessionId)) {
      throw new MistralRealtimeTerminationError('invalid_connection');
    }
    if (hardExpiryProof !== undefined && !this.validProof(providerSessionId, hardExpiryProof)) {
      throw new MistralRealtimeTerminationError('invalid_hard_expiry_proof');
    }
    const now = this.safeNow();
    this.prune(now);
    if (this.terminalProofs.has(providerSessionId)) return;

    const tracked = this.connections.get(providerSessionId);
    if (tracked) {
      try {
        await this.closeTracked(tracked);
        return;
      } catch (error) {
        if (hardExpiryProof === undefined) throw error;
        // Le hard cap DB est une preuve terminale suffisante même si l'observation de fermeture
        // distante n'est plus disponible. La tentative locale a néanmoins été faite en premier.
        this.markTerminal(tracked, now);
        return;
      }
    }

    if (hardExpiryProof === undefined) {
      throw new MistralRealtimeTerminationError('connection_not_local');
    }
    this.rememberTerminal(providerSessionId, now);
  }

  /** Projection sans identifiant distant, réservée aux tests et diagnostics de capacité. */
  state(): { readonly activeConnections: number; readonly terminalProofs: number } {
    this.prune(this.safeNow());
    return {
      activeConnections: this.connections.size,
      terminalProofs: this.terminalProofs.size,
    };
  }

  private async closeTracked(tracked: TrackedConnection): Promise<void> {
    if (tracked.terminal) return;
    if (this.connections.get(tracked.providerSessionId) !== tracked) {
      if (this.terminalProofs.has(tracked.providerSessionId)) return;
      throw new MistralRealtimeTerminationError('connection_not_local');
    }
    if (tracked.closePromise) return tracked.closePromise;

    const close = Promise.resolve()
      .then(() => tracked.close())
      .then(() => {
        this.markTerminal(tracked, this.safeNow());
      })
      .catch(() => {
        throw new MistralRealtimeTerminationError('connection_close_unconfirmed');
      });
    tracked.closePromise = close;
    try {
      await close;
    } finally {
      if (tracked.closePromise === close) tracked.closePromise = null;
    }
  }

  private markTerminal(tracked: TrackedConnection, now: number): void {
    tracked.terminal = true;
    if (this.connections.get(tracked.providerSessionId) === tracked) {
      this.connections.delete(tracked.providerSessionId);
    }
    const retentionUntil = Math.min(
      Math.max(tracked.hardExpiresAt, now) + TERMINAL_PROOF_RETENTION_MS,
      now + MAX_TERMINAL_PROOF_RETENTION_MS,
    );
    this.terminalProofs.set(tracked.providerSessionId, retentionUntil);
  }

  private rememberTerminal(providerSessionId: string, now: number): void {
    this.terminalProofs.set(providerSessionId, now + TERMINAL_PROOF_RETENTION_MS);
  }

  private validProof(
    providerSessionId: string,
    proof: RealtimeDatabaseHardExpiryProof,
  ): boolean {
    return isRealtimeDatabaseHardExpiryProof(proof)
      && proof.providerId === 'mistral'
      && proof.providerCallId === providerSessionId;
  }

  private prune(now: number): void {
    for (const [providerSessionId, expiresAt] of this.terminalProofs) {
      if (expiresAt <= now) this.terminalProofs.delete(providerSessionId);
    }
  }

  private safeNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new MistralRealtimeTerminationError('invalid_connection');
    }
    return now;
  }
}
