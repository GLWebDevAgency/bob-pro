import type { Metrics } from '../../observability/metrics';
import type { AppLogger } from '../../observability/logger';
import type {
  RealtimeAdmissionMutationResult,
  RealtimeAdmissionPort,
  RealtimeLeaseCredential,
} from './realtime-admission';

interface RealtimeLocalCallTerminationPort {
  hangupCall(providerCallId: string): Promise<void>;
}

export type RealtimeCallTerminationReason =
  | 'user'
  | 'kill_switch'
  | 'lease_lost'
  | 'hard_expiry'
  | 'max_duration'
  | 'superseded'
  | 'bootstrap_failed'
  | 'shutdown';

export type RealtimeCallTerminationOutcome = 'confirmed' | 'pending_reaper';

type LifecycleMetrics = Pick<Metrics, 'bobLiveProviderErrors'>;
type LifecycleLogger = Pick<AppLogger, 'audit' | 'warn'>;

export interface RealtimeCallLifecycleOptions {
  admission: RealtimeAdmissionPort;
  /** Adapter exact qui a créé cet appel local ; le lifecycle n'a pas besoin du port de création. */
  provider: RealtimeLocalCallTerminationPort;
  lease: RealtimeLeaseCredential;
  providerCallId: string;
  hardExpiresAt: string;
  heartbeatSeconds: number;
  metrics?: LifecycleMetrics;
  logger?: LifecycleLogger;
  /** Horloge injectable pour les certifications déterministes ; la production utilise Date.now. */
  now?: () => number;
}

function mutationReason(reason: string | null): string {
  return reason ?? 'rejected';
}

/**
 * Propriétaire unique du cycle de vie d'un appel provider déjà lié à un bail durable.
 *
 * - aucune I/O provider ne s'exécute dans une transaction d'admission ;
 * - les heartbeats sont récursifs, donc jamais chevauchants ;
 * - toute terminaison est single-flight ;
 * - un bail n'est libéré qu'après un hangup provider confirmé/idempotent ;
 * - en cas d'incertitude, le bail reste durablement visible pour le reaper.
 */
export class RealtimeCallLifecycle {
  private readonly admission: RealtimeAdmissionPort;
  private readonly provider: RealtimeLocalCallTerminationPort;
  private readonly lease: RealtimeLeaseCredential;
  private readonly providerCallId: string;
  private readonly hardExpiresAt: string;
  private readonly heartbeatMs: number;
  private readonly metrics?: LifecycleMetrics;
  private readonly logger?: LifecycleLogger;
  private readonly now: () => number;

  private activationPromise: Promise<void> | null = null;
  private terminationPromise: Promise<RealtimeCallTerminationOutcome> | null = null;
  private activated = false;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private hardExpiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RealtimeCallLifecycleOptions) {
    if (!Number.isInteger(options.heartbeatSeconds) || options.heartbeatSeconds <= 0) {
      throw new Error('realtime_lifecycle_invalid_heartbeat');
    }
    const hardExpiryMs = Date.parse(options.hardExpiresAt);
    if (!Number.isFinite(hardExpiryMs)) throw new Error('realtime_lifecycle_invalid_hard_expiry');

    this.admission = options.admission;
    this.provider = options.provider;
    this.lease = { ...options.lease };
    this.providerCallId = options.providerCallId;
    this.hardExpiresAt = options.hardExpiresAt;
    this.heartbeatMs = options.heartbeatSeconds * 1_000;
    this.metrics = options.metrics;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;

    const delayMs = Math.max(0, hardExpiryMs - this.now());
    this.hardExpiryTimer = setTimeout(() => {
      this.hardExpiryTimer = null;
      void this.terminate('hard_expiry');
    }, delayMs);
  }

  /** CAS bound -> active. Un appel répété partage exactement la même activation. */
  activate(): Promise<void> {
    if (this.terminationPromise) return Promise.reject(new Error('realtime_lifecycle_terminating'));
    if (this.activationPromise) return this.activationPromise;
    // Différer l'exécution d'une microtask permet de publier le fence single-flight avant que
    // l'adapter injecté ne puisse provoquer une réentrance synchrone.
    this.activationPromise = Promise.resolve().then(() => this.performActivation());
    return this.activationPromise;
  }

  /**
   * Ferme localement le cycle, puis exige la confirmation provider avant toute libération DB.
   * Cette méthode ne rejette pas : `pending_reaper` signifie que la preuve durable doit rester.
   */
  terminate(reason: RealtimeCallTerminationReason): Promise<RealtimeCallTerminationOutcome> {
    if (this.terminationPromise) return this.terminationPromise;
    this.stopTimers();
    this.terminationPromise = Promise.resolve().then(() => this.performTermination(reason));
    return this.terminationPromise;
  }

  /**
   * Transfère irrévocablement la terminaison au reaper/claim durable. Le lifecycle local ne doit
   * ensuite ni raccrocher le provider, ni appeler `release` avec l’ancien lease token.
   */
  fenceAfterDurableTerminationClaim(): void {
    if (this.terminationPromise) return;
    this.stopTimers();
    this.activated = false;
    this.terminationPromise = Promise.resolve('pending_reaper');
  }

  private async performActivation(): Promise<void> {
    let result: RealtimeAdmissionMutationResult;
    try {
      result = await this.admission.activate(this.lease);
    } catch {
      result = { ok: false, reason: 'unavailable' as const };
    }

    if (!result.ok) {
      this.warn(`bob.live.lifecycle.activate_failed class=${mutationReason(result.reason)}`);
      await this.terminate('lease_lost');
      throw new Error(`realtime_lifecycle_activate_${mutationReason(result.reason)}`);
    }
    if (this.terminationPromise) throw new Error('realtime_lifecycle_terminating');

    this.activated = true;
    this.audit('bob.live.lifecycle.activated', {});
    this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    if (!this.activated || this.terminationPromise || this.heartbeatTimer) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      void this.heartbeat();
    }, this.heartbeatMs);
  }

  private async heartbeat(): Promise<void> {
    if (!this.activated || this.terminationPromise) return;
    let result;
    try {
      result = await this.admission.renew(this.lease);
    } catch {
      result = { ok: false, reason: 'unavailable' as const };
    }

    if (this.terminationPromise) return;
    if (!result.ok) {
      this.warn(`bob.live.lifecycle.renew_failed class=${mutationReason(result.reason)}`);
      await this.terminate('lease_lost');
      return;
    }
    this.scheduleHeartbeat();
  }

  private async performTermination(reason: RealtimeCallTerminationReason): Promise<RealtimeCallTerminationOutcome> {
    this.activated = false;
    try {
      await this.provider.hangupCall(this.providerCallId);
    } catch {
      this.metricProviderError('lifecycle_hangup_failed');
      this.warn(`bob.live.lifecycle.termination_pending reason=${reason} class=hangup_failed`);
      this.audit('bob.live.lifecycle.terminated', { reason, outcome: 'pending_reaper' });
      return 'pending_reaper';
    }

    let released: RealtimeAdmissionMutationResult;
    try {
      released = await this.admission.release({
        ...this.lease,
        providerTermination: 'confirmed',
      });
    } catch {
      released = { ok: false, reason: 'unavailable' as const };
    }
    if (!released.ok) {
      this.warn(`bob.live.lifecycle.release_pending class=${mutationReason(released.reason)}`);
      this.audit('bob.live.lifecycle.terminated', { reason, outcome: 'pending_reaper' });
      return 'pending_reaper';
    }

    this.audit('bob.live.lifecycle.terminated', { reason, outcome: 'confirmed' });
    return 'confirmed';
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.hardExpiryTimer) clearTimeout(this.hardExpiryTimer);
    this.heartbeatTimer = null;
    this.hardExpiryTimer = null;
  }

  private metricProviderError(errorClass: string): void {
    try {
      this.metrics?.bobLiveProviderErrors.inc({ class: errorClass });
    } catch {
      // L'observabilité ne doit jamais modifier le résultat du protocole de terminaison.
    }
  }

  private warn(message: string): void {
    try {
      this.logger?.warn(message, 'BobLive');
    } catch {
      // Même invariant : un sink de logs indisponible ne possède pas le cycle de vie provider.
    }
  }

  private audit(action: string, data: Record<string, unknown>): void {
    try {
      this.logger?.audit(action, data);
    } catch {
      // L'audit est best effort ici ; les baux DB restent la preuve opérationnelle autoritative.
    }
  }
}
